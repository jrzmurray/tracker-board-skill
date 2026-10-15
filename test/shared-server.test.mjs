import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-shared-server-"));
const previousHome = process.env.TRACKERBOARD_HOME;
const previousDataHome = process.env.TRACKERBOARD_DATA_HOME;
process.env.TRACKERBOARD_HOME = path.join(root, "home");
process.env.TRACKERBOARD_DATA_HOME = path.join(root, "data");

const [{ startSharedBoardServer }, S, serviceRuntime] = await Promise.all([
  import("../skills/trackerboard/scripts/lib/shared-server.mjs"),
  import("../skills/trackerboard/scripts/lib/store.mjs"),
  import("../skills/trackerboard/scripts/lib/service-runtime.mjs"),
]);

test.after(async () => {
  try {
    const { stopService } = await import("../skills/trackerboard/scripts/lib/service-runtime.mjs");
    await stopService();
  } catch {}
  if (previousHome === undefined) delete process.env.TRACKERBOARD_HOME;
  else process.env.TRACKERBOARD_HOME = previousHome;
  if (previousDataHome === undefined) delete process.env.TRACKERBOARD_DATA_HOME;
  else process.env.TRACKERBOARD_DATA_HOME = previousDataHome;
  fs.rmSync(root, { recursive: true, force: true });
});

async function makeBoard(name = "demo") {
  await S.initializeBackends();
  if (S.boardExists(name)) S.removeBoard(name);
  S.createBoard(name, { title: `${name} board` });
}

async function startServer(t) {
  const server = await startSharedBoardServer({ store: S });
  t.after(() => server.close());
  return server;
}

async function getSnapshot(url) {
  const response = await fetch(`${url}/api/snapshot`);
  return { response, body: await response.json() };
}

function editorBearer(url) {
  return new URL(url).pathname.slice(1);
}

const waitForDiscoveryWindow = () => new Promise((resolve) => setTimeout(resolve, 2_050));

test("shared listener exposes a protected index and mounted editable board routes", async (t) => {
  await makeBoard();
  await makeBoard("second");
  const secondBoard = S.loadBoard("second");
  secondBoard.title = "<script>alert(1)</script>";
  S.saveBoard(secondBoard);
  const server = await startServer(t);
  assert.equal(server.server.address().address, "127.0.0.1");

  const indexResponse = await fetch(server.indexUrl);
  assert.equal(indexResponse.status, 200);
  assert.equal(indexResponse.headers.get("cache-control"), "no-store");
  const indexHtml = await indexResponse.text();
  assert.match(indexHtml, /demo/);
  assert.match(indexHtml, /second/);
  assert.match(indexHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(indexHtml, /<script>alert\(1\)<\/script>/);
  assert.match(indexHtml, new RegExp(server.boardUrl("demo").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.notEqual(server.boardUrl("second"), server.boardUrl("demo"));
  assert.equal((await fetch(server.origin)).status, 404);

  const unauthenticated = await fetch(`${server.origin}/_control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "index" }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.doesNotMatch(await unauthenticated.text(), /\/i\/|\/b\//);

  const boardUrl = server.boardUrl("demo");
  assert.ok(boardUrl);
  const page = await fetch(boardUrl);
  assert.equal(page.status, 200);
  const boardPage = await page.text();
  assert.match(boardPage, /Trackerboard · local editor/);
  assert.doesNotMatch(boardPage, /<script>alert\(1\)<\/script>/);
  const initial = await getSnapshot(boardUrl);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.board.title, "demo board");

  const command = await fetch(`${boardUrl}/api/command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${editorBearer(boardUrl)}`,
      Origin: server.origin,
    },
    body: JSON.stringify({
      expectedRevision: initial.body.revision,
      command: { type: "board.update", fields: { title: "edited in browser" } },
    }),
  });
  assert.equal(command.status, 200);
  assert.equal(S.loadBoard("demo").title, "edited in browser");

  await S.withLock(() => {
    const board = S.loadBoard("demo");
    board.title = "edited by CLI";
    S.saveBoard(board);
  });
  const afterCliWrite = await getSnapshot(boardUrl);
  assert.equal(afterCliWrite.body.board.title, "edited by CLI");
});

test("board capabilities survive rescans and temporary JSON outages, then revoke on removal", async (t) => {
  await makeBoard();
  const server = await startServer(t);
  const originalUrl = server.boardUrl("demo");
  assert.ok(originalUrl);

  await waitForDiscoveryWindow();
  await server.rescan();
  assert.equal(server.boardUrl("demo"), originalUrl);

  const boardFile = path.join(S.home(), "boards", "demo.json");
  const unavailableFile = `${boardFile}.unavailable`;
  fs.renameSync(boardFile, unavailableFile);
  await waitForDiscoveryWindow();
  await server.rescan();
  assert.equal(server.boardUrl("demo"), originalUrl);
  const unavailableSnapshot = await getSnapshot(originalUrl);
  assert.equal(unavailableSnapshot.response.status, 500);
  assert.equal((await fetch(originalUrl)).status, 200);
  fs.renameSync(unavailableFile, boardFile);
  await waitForDiscoveryWindow();
  await server.rescan();
  assert.equal(server.boardUrl("demo"), originalUrl);
  assert.equal((await getSnapshot(originalUrl)).response.status, 200);

  await S.withLock(() => S.removeBoard("demo"));
  await waitForDiscoveryWindow();
  await server.rescan();
  assert.equal(server.boardUrl("demo"), null);
  assert.equal((await fetch(originalUrl)).status, 410);
});

test("discovery coalesces concurrent scans and respects its two-second bound", async (t) => {
  await makeBoard();
  let lockCalls = 0;
  const store = {
    ...S,
    async withLock(callback) {
      lockCalls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return S.withLock(callback);
    },
  };
  const server = await startSharedBoardServer({ store });
  t.after(() => server.close());
  assert.equal(lockCalls, 1);

  await server.rescan();
  assert.equal(lockCalls, 1, "a recent full scan is not repeated");
  await waitForDiscoveryWindow();
  await Promise.all([server.rescan(), server.rescan(), server.rescan()]);
  assert.equal(lockCalls, 2, "concurrent refresh requests share one full scan");
});

test("a newly detected duplicate backend target revokes the existing edit route", async (t) => {
  await makeBoard();
  let duplicate = false;
  const store = {
    ...S,
    inspectBackendTargets(names) {
      return { collisions: duplicate ? [{ boards: ["demo"], names }] : [] };
    },
  };
  const server = await startSharedBoardServer({ store });
  t.after(() => server.close());
  const originalUrl = server.boardUrl("demo");
  assert.ok(originalUrl);

  duplicate = true;
  await waitForDiscoveryWindow();
  await server.rescan();
  assert.equal(server.boardUrl("demo"), null);
  assert.equal((await fetch(originalUrl)).status, 410);
});

test("CLI serve reuses one private runtime, reports status, and stops it", async () => {
  await makeBoard();
  const cli = fileURLToPath(new URL("../skills/trackerboard/scripts/trackerboard.mjs", import.meta.url));
  const env = { ...process.env };
  const run = async (...args) => execFileAsync(process.execPath, [cli, ...args], { env, timeout: 15_000 });
  const paths = serviceRuntime.runtimePaths();
  fs.writeFileSync(paths.recordFile, "stale runtime record\n", { mode: 0o600 });

  const [first, second] = await Promise.all([
    run("serve", "--board", "demo"),
    run("serve", "--board", "demo"),
  ]);
  const firstUrl = first.stdout.match(/ok: serving demo at (http:\/\/[^\s]+)/)?.[1];
  const secondUrl = second.stdout.match(/ok: serving demo at (http:\/\/[^\s]+)/)?.[1];
  assert.ok(firstUrl, first.stdout);
  assert.equal(secondUrl, firstUrl);

  const recordStat = fs.statSync(paths.recordFile);
  assert.equal(recordStat.mode & 0o077, 0);
  const recordText = fs.readFileSync(paths.recordFile, "utf8");
  const record = JSON.parse(recordText);
  assert.equal(fs.statSync(paths.runtimeDir).mode & 0o077, 0);
  assert.equal(fs.statSync(paths.lockFile).mode & 0o077, 0);
  assert.doesNotMatch(recordText, /\/i\/|\/b\//);
  assert.ok(record.controlToken);
  const otherUniverse = serviceRuntime.runtimePaths({ boardHome: S.home(), dataRoot: path.join(root, "other-data") });
  assert.notEqual(otherUniverse.runtimeDir, paths.runtimeDir);

  let nonceRejected;
  try {
    fs.writeFileSync(paths.recordFile, `${JSON.stringify({ ...record, pid: process.pid, controlToken: "wrong-nonce" })}\n`, { mode: 0o600 });
    nonceRejected = await serviceRuntime.serviceStatus().then(() => null, (error) => error);
  } finally {
    fs.writeFileSync(paths.recordFile, recordText, { mode: 0o600 });
  }
  assert.ok(nonceRejected);
  assert.match(nonceRejected.message, /holds the Trackerboard service lock but authenticated health checks failed/);
  assert.equal((await run("serve", "status")).stdout.trim(), `service: running at ${record.origin}`);

  const mismatch = await run("serve", "--port", record.port === 1 ? 2 : 1).then(() => null, (error) => error);
  assert.ok(mismatch);
  assert.match(mismatch.stderr, new RegExp(record.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const stopped = await run("serve", "stop");
  assert.match(stopped.stdout, /stopped shared Trackerboard service/);
  assert.equal((await run("serve", "status")).stdout.trim(), "service: stopped");
  assert.equal(fs.existsSync(paths.recordFile), false);

  const occupied = http.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const occupiedPort = occupied.address().port;
  try {
    const conflict = await run("serve", "--port", String(occupiedPort)).then(() => null, (error) => error);
    assert.ok(conflict);
    assert.match(conflict.stderr, /port .* may be occupied/);
  } finally {
    await new Promise((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});
