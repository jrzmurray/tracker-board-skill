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

const [{ startSharedBoardServer, controlRequest }, S, C, serviceRuntime] = await Promise.all([
  import("../skills/trackerboard/scripts/lib/shared-server.mjs"),
  import("../skills/trackerboard/scripts/lib/store.mjs"),
  import("../skills/trackerboard/scripts/lib/config.mjs"),
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
  fs.mkdirSync(path.dirname(C.globalConfigPath()), { recursive: true });
  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "json" }));
  S.createBoard(name, { title: `${name} board` });
}

async function makeSqliteBoard(name) {
  await S.initializeBackends();
  if (S.boardExists(name)) S.removeBoard(name);
  fs.mkdirSync(path.dirname(C.globalConfigPath()), { recursive: true });
  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({
    backend: "sqlite",
    sqlite: { path: path.join(root, "shared.sqlite") },
  }));
  S.createBoard(name, { title: `${name} board` });
  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "json" }));
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
    async tryWithLock(callback) {
      lockCalls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return S.tryWithLock(callback);
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

test("discovery skips the global lock while a slow backend write holds it", async (t) => {
  await makeBoard("lock-busy");
  const server = await startServer(t);
  const originalUrl = server.boardUrl("lock-busy");
  let signalAcquired;
  const acquired = new Promise((resolve) => { signalAcquired = resolve; });
  const slowWrite = S.withLock(async () => {
    signalAcquired();
    // Backend mutations use this same lock across their read/modify/write;
    // GitHub CLI calls can keep it held while the isolated worker is blocked.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  });
  await acquired;
  await waitForDiscoveryWindow();

  const startedAt = Date.now();
  await server.rescan();
  assert.ok(Date.now() - startedAt < 250, "discovery does not wait for the remote write's global lock");
  assert.equal(server.boardUrl("lock-busy"), originalUrl, "a skipped scan preserves the active route");

  await slowWrite;
  await server.rescan();
  assert.equal(server.boardUrl("lock-busy"), originalUrl, "the next discovery refreshes after the lock is released");
});

test("discovery skips a board lock held by removal without recreating its identity file", async (t) => {
  await makeBoard("remove-discovery-race");
  let notifyAttempt;
  let attempted;
  const store = {
    ...S,
    tryWithBoardLock(name, callback) {
      if (name === "remove-discovery-race") notifyAttempt?.();
      return S.tryWithBoardLock(name, callback);
    },
  };
  const server = await startSharedBoardServer({ store });
  t.after(() => server.close());
  const originalUrl = server.boardUrl("remove-discovery-race");
  assert.ok(originalUrl);
  await waitForDiscoveryWindow();
  attempted = new Promise((resolve) => { notifyAttempt = resolve; });

  await S.withBoardLock("remove-discovery-race", async () => {
    const scan = server.rescan();
    await attempted;
    S.removeBoard("remove-discovery-race");
    await scan;
    assert.equal(server.boardUrl("remove-discovery-race"), originalUrl, "a busy board keeps its prior published route during removal");
  });

  assert.equal(S.boardExists("remove-discovery-race"), false);
  assert.equal(fs.existsSync(path.join(S.home(), "boards", "remove-discovery-race.local.json")), false);
  await waitForDiscoveryWindow();
  await server.rescan();
  assert.equal(server.boardUrl("remove-discovery-race"), null);
  assert.equal((await fetch(originalUrl)).status, 410);
});

test("discovery rechecks existence after listing before recreating removed board identity", async (t) => {
  await makeBoard("stale-discovery-race");
  let removeAfterListing = false;
  const store = {
    ...S,
    async tryWithBoardLock(name, callback) {
      if (name === "stale-discovery-race" && removeAfterListing) {
        removeAfterListing = false;
        await S.withBoardLock(name, () => S.removeBoard(name));
      }
      return S.tryWithBoardLock(name, callback);
    },
  };
  const server = await startSharedBoardServer({ store });
  t.after(() => server.close());
  const originalUrl = server.boardUrl("stale-discovery-race");
  assert.ok(originalUrl);

  removeAfterListing = true;
  await waitForDiscoveryWindow();
  await server.rescan();

  assert.equal(S.boardExists("stale-discovery-race"), false);
  assert.equal(fs.existsSync(path.join(S.home(), "boards", "stale-discovery-race.local.json")), false);
  assert.equal(server.boardUrl("stale-discovery-race"), null);
  assert.equal((await fetch(originalUrl)).status, 410);
});

test("a newly detected duplicate backend target revokes the existing edit route", async (t) => {
  await makeBoard();
  await makeBoard("same-target");
  let duplicate = false;
  const store = {
    ...S,
    backendTargetInfo(name) {
      const info = S.backendTargetInfo(name);
      return duplicate ? { ...info, identity: { backend: "json", file: "/tmp/shared-board.json" } } : info;
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

test("shared service registers JSON, SQLite, and GitHub independently and isolates a delayed Project", async (t) => {
  await makeBoard("json-board");
  await makeSqliteBoard("sqlite-board");
  await makeBoard("github-board");

  const callsFile = path.join(root, "fake-gh-calls.log");
  const fakeGh = path.join(root, "slow-gh.sh");
  fs.writeFileSync(fakeGh, `#!/bin/sh\nprintf 'call\\n' >> ${JSON.stringify(callsFile)}\nsleep 2\nexit 1\n`);
  fs.chmodSync(fakeGh, 0o700);
  const local = S.loadLocal("github-board");
  local.backendOverride = {
    backend: "github",
    github: { owner: "acme", projectId: "PVT_slow", executable: fakeGh },
  };
  local.githubProject = {
    owner: "acme",
    projectId: "PVT_slow",
    projectNumber: 12,
    repoUrl: "https://github.com/acme/roadmap",
    boardId: local.boardId,
    bootstrapComplete: true,
  };
  S.saveLocal("github-board", local);

  const server = await startServer(t);
  const initialIndex = await (await fetch(server.indexUrl)).text();
  assert.match(initialIndex, /json-board/);
  assert.match(initialIndex, /sqlite/);
  assert.match(initialIndex, /github/);
  assert.ok(server.boardUrl("json-board"));
  assert.ok(server.boardUrl("sqlite-board"));
  assert.ok(server.boardUrl("github-board"));
  assert.equal(fs.existsSync(callsFile), false, "GitHub discovery does not read the remote Project");

  const jsonSnapshot = await getSnapshot(server.boardUrl("json-board"));
  const sqliteSnapshot = await getSnapshot(server.boardUrl("sqlite-board"));
  assert.equal(jsonSnapshot.response.status, 200);
  assert.equal(sqliteSnapshot.response.status, 200);
  assert.equal(sqliteSnapshot.body.board.title, "sqlite-board board");

  const githubRequest = getSnapshot(server.boardUrl("github-board"));
  const waitUntilGhStarted = async () => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !fs.existsSync(callsFile)) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(callsFile), "the isolated GitHub worker started its fake gh call");
  };
  await waitUntilGhStarted();
  const start = Date.now();
  const stillResponsive = await Promise.all([
    getSnapshot(server.boardUrl("json-board")),
    getSnapshot(server.boardUrl("sqlite-board")),
  ]);
  assert.ok(Date.now() - start < 1_000, "a delayed GitHub CLI call does not block local board routes");
  assert.deepEqual(stillResponsive.map(({ response }) => response.status), [200, 200]);

  const remoteFailure = await githubRequest;
  assert.equal(remoteFailure.response.status, 500);
  assert.equal(fs.readFileSync(callsFile, "utf8").trim().split("\n").length, 1);
  assert.equal((await getSnapshot(server.boardUrl("github-board"))).response.status, 500);
  assert.equal(fs.readFileSync(callsFile, "utf8").trim().split("\n").length, 1, "a failed remote board backs off independently");

  const before = await getSnapshot(server.boardUrl("sqlite-board"));
  const stale = await fetch(`${server.boardUrl("sqlite-board")}/api/command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${editorBearer(server.boardUrl("sqlite-board"))}`,
      Origin: server.origin,
    },
    body: JSON.stringify({
      expectedRevision: before.body.revision - 1,
      command: { type: "board.update", fields: { title: "stale" } },
    }),
  });
  assert.equal(stale.status, 409, "SQLite retains expected-revision conflict behavior through the worker");
  const saved = await fetch(`${server.boardUrl("sqlite-board")}/api/command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${editorBearer(server.boardUrl("sqlite-board"))}`,
      Origin: server.origin,
    },
    body: JSON.stringify({
      expectedRevision: before.body.revision,
      command: { type: "board.update", fields: { title: "SQLite edited" } },
    }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, before.body.revision + 1);
});

test("a command queued before board removal cannot recreate the removed board", async (t) => {
  await makeBoard("remove-race");
  const server = await startServer(t);
  const url = server.boardUrl("remove-race");
  const snapshot = await getSnapshot(url);

  let pendingWrite;
  await S.withBoardLock("remove-race", async () => {
    pendingWrite = fetch(`${url}/api/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${editorBearer(url)}`,
        Origin: server.origin,
      },
      body: JSON.stringify({
        expectedRevision: snapshot.body.revision,
        command: { type: "board.update", fields: { title: "must not return" } },
      }),
    });
    // Give the isolated worker time to receive the operation and wait on this
    // board lock before removal wins the serialized read-modify-write race.
    await new Promise((resolve) => setTimeout(resolve, 100));
    S.removeBoard("remove-race");
  });

  const response = await pendingWrite;
  assert.equal(response.status, 409);
  assert.equal(S.boardExists("remove-race"), false);
  await waitForDiscoveryWindow();
  await server.rescan();
  assert.equal(server.boardUrl("remove-race"), null);
  assert.equal((await fetch(url)).status, 410);
});

test("target rebinding and removal retire the old route and close that board worker", async (t) => {
  const board = { name: "mutable", title: "Mutable", waves: [], log: [] };
  let target = { backend: "json", file: "/tmp/mutable.json" };
  let present = true;
  const workers = [];
  const store = {
    async withLock(callback) { return callback(); },
    listBoards() { return present ? ["mutable"] : []; },
    ensureBoardIdentity() { return { boardId: "board-id" }; },
    backendTargetInfo() { return { backend: target.backend, identity: target, unresolved: null }; },
    inspectBackendTargets() { return { collisions: [] }; },
    loadBoard() { return board; },
  };
  const server = await startSharedBoardServer({
    store,
    workerFactory({ targetIdentity }) {
      const worker = {
        closed: false,
        async snapshot() { return { board: { ...board }, revision: 1 }; },
        async applyCommand() { return { board: { ...board }, revision: 2 }; },
        async close() { this.closed = true; },
      };
      workers.push({ targetIdentity, worker });
      return worker;
    },
  });
  t.after(() => server.close());
  const oldUrl = server.boardUrl("mutable");
  assert.equal((await getSnapshot(oldUrl)).response.status, 200);
  assert.equal(workers.length, 1);

  target = { backend: "sqlite", file: "/tmp/mutable.sqlite", rowKey: "mutable" };
  await waitForDiscoveryWindow();
  await server.rescan();
  const newUrl = server.boardUrl("mutable");
  assert.ok(newUrl);
  assert.notEqual(newUrl, oldUrl);
  assert.equal(workers[0].worker.closed, true);
  assert.equal((await fetch(oldUrl)).status, 410);
  assert.equal((await getSnapshot(newUrl)).response.status, 200);

  present = false;
  await waitForDiscoveryWindow();
  await server.rescan();
  assert.equal(server.boardUrl("mutable"), null);
  assert.equal(workers[1].worker.closed, true);
  assert.equal((await fetch(newUrl)).status, 410);
});

test("rescan and control remain responsive while retired workers close asynchronously", async (t) => {
  await makeBoard("retire-one");
  await makeBoard("retire-two");
  let present = true;
  let releaseClose;
  let closeStarted = 0;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const store = { ...S, listBoards: () => present ? ["retire-one", "retire-two"] : [] };
  const server = await startSharedBoardServer({
    store,
    workerFactory({ boardName }) {
      return {
        async snapshot() { return { board: { name: boardName, title: boardName }, revision: 1 }; },
        async applyCommand() { return { board: { name: boardName, title: boardName }, revision: 2 }; },
        async close() { closeStarted++; await closeGate; },
      };
    },
  });
  t.after(async () => { releaseClose(); await server.close(); });
  const oldUrls = [server.boardUrl("retire-one"), server.boardUrl("retire-two")];
  await Promise.all(oldUrls.map((url) => getSnapshot(url)));

  present = false;
  await waitForDiscoveryWindow();
  const scan = server.rescan();
  const scanFinished = await Promise.race([
    scan.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  assert.equal(scanFinished, true, "rescan publishes route revocation without waiting for close");
  assert.equal(server.boardUrl("retire-one"), null);
  assert.equal(server.boardUrl("retire-two"), null);
  assert.equal(closeStarted, 2);
  assert.deepEqual(await controlRequest({ origin: server.origin, token: server.controlToken, op: "index" }), { url: server.indexUrl });
  assert.deepEqual(await Promise.all(oldUrls.map(async (url) => (await fetch(url)).status)), [410, 410]);

  releaseClose();
  await scan;
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
