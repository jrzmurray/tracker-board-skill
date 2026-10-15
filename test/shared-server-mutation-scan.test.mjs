import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-mutation-scan-"));
const previousHome = process.env.TRACKERBOARD_HOME;
const previousDataHome = process.env.TRACKERBOARD_DATA_HOME;
process.env.TRACKERBOARD_HOME = path.join(root, "home");
process.env.TRACKERBOARD_DATA_HOME = path.join(root, "data");

const [{ startSharedBoardServer }, S, C] = await Promise.all([
  import("../skills/trackerboard/scripts/lib/shared-server.mjs"),
  import("../skills/trackerboard/scripts/lib/store.mjs"),
  import("../skills/trackerboard/scripts/lib/config.mjs"),
]);

test.after(async () => {
  try {
    await S.initializeBackends();
  } catch {}
  if (previousHome === undefined) delete process.env.TRACKERBOARD_HOME;
  else process.env.TRACKERBOARD_HOME = previousHome;
  if (previousDataHome === undefined) delete process.env.TRACKERBOARD_DATA_HOME;
  else process.env.TRACKERBOARD_DATA_HOME = previousDataHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const editorBearer = (url) => new URL(url).pathname.slice(1);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("discovery stays responsive and preserves the route during a slow GitHub mutation", async (t) => {
  await S.initializeBackends();
  fs.mkdirSync(path.dirname(C.globalConfigPath()), { recursive: true });
  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "json" }));
  const name = "slow-github-mutation";
  if (S.boardExists(name)) S.removeBoard(name);
  S.createBoard(name, { title: "GitHub mutation board" });

  let mutationActive = false;
  let finishMutation;
  let signalMutationStarted;
  const mutationGate = new Promise((resolve) => { finishMutation = resolve; });
  const mutationStarted = new Promise((resolve) => { signalMutationStarted = resolve; });
  let board = { name, title: "GitHub mutation board", waves: [], log: [] };
  let revision = 1;
  const target = { backend: "github", owner: "octo", projectId: "PVT_slow" };
  const store = {
    ...S,
    backendTargetInfo(candidate) {
      if (candidate === name) return { backend: "github", identity: target, unresolved: null };
      return S.backendTargetInfo(candidate);
    },
  };

  const server = await startSharedBoardServer({
    store,
    workerFactory() {
      return {
        async snapshot() { return { board, revision }; },
        async applyCommand(command, expectedRevision) {
          assert.equal(expectedRevision, revision);
          // The remote call is represented by the gate; hold the real shared
          // board lock while it is pending, as the GitHub backend does.
          return S.withBoardLock(name, async () => {
            mutationActive = true;
            signalMutationStarted();
            try {
              await mutationGate;
              board = { ...board, title: command.fields.title };
              revision++;
              return { board, revision };
            } finally {
              mutationActive = false;
            }
          });
        },
        async close() {},
      };
    },
  });
  t.after(async () => {
    finishMutation();
    await server.close();
  });

  const url = server.boardUrl(name);
  assert.ok(url);
  const initial = await (await fetch(`${url}/api/snapshot`)).json();
  const mutation = fetch(`${url}/api/command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${editorBearer(url)}`,
      Origin: server.origin,
    },
    body: JSON.stringify({
      expectedRevision: initial.revision,
      command: { type: "board.update", fields: { title: "GitHub mutation finished" } },
    }),
  });
  await mutationStarted;
  await sleep(2_050);

  const startedAt = Date.now();
  await server.rescan();
  assert.ok(Date.now() - startedAt < 250, "discovery must not wait for the remote mutation");
  assert.equal(server.boardUrl(name), url, "a busy board retains its existing capability route");
  assert.equal(mutationActive, true, "the simulated remote write remains in flight during discovery");

  finishMutation();
  const saved = await mutation;
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).board.title, "GitHub mutation finished");
  await sleep(2_050);
  await server.rescan();
  assert.equal(server.boardUrl(name), url, "the completed mutation keeps the same route on the next scan");
});
