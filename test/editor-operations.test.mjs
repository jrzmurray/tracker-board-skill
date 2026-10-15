import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { newBoard } from "../skills/trackerboard/scripts/lib/board.mjs";
import { initializeBackends, createBoard, loadBoard, withBoardLock } from "../skills/trackerboard/scripts/lib/store.mjs";
import { createEditorCallbacks } from "../skills/trackerboard/scripts/lib/editor-operations.mjs";

const CLI = fileURLToPath(new URL("../skills/trackerboard/scripts/trackerboard.mjs", import.meta.url));
const execFileAsync = promisify(execFile);

test("editor commands use board operations and reject stale revisions under the shared lock", async (t) => {
  const oldHome = process.env.TRACKERBOARD_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-editor-ops-"));
  process.env.TRACKERBOARD_HOME = root;
  t.after(() => {
    if (oldHome === undefined) delete process.env.TRACKERBOARD_HOME;
    else process.env.TRACKERBOARD_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await initializeBackends();
  createBoard("editor-contract", { title: "Editor" });

  class RevisionConflict extends Error {
    constructor() { super("stale revision"); this.code = "TRACKERBOARD_REVISION_CONFLICT"; }
  }
  const callbacks = createEditorCallbacks({ boardName: "editor-contract", revisionConflict: () => new RevisionConflict() });
  const initial = await callbacks.loadSnapshot();
  const wave = await callbacks.applyCommand({ type: "wave.create", id: "P0", fields: { title: "First wave" } }, initial.revision);
  const phase = await callbacks.applyCommand({ type: "phase.create", id: "P0.1", wave: "P0", fields: { title: "Editable", status: "active" } }, wave.revision);
  const next = await callbacks.applyCommand({ type: "log.append", text: "edited in browser" }, phase.revision);

  assert.equal(next.revision, phase.revision + 1);
  assert.equal(next.board.waves[0].phases[0].status, "active");
  assert.equal(next.board.log[0].text, "edited in browser");
  const cliWrite = spawnSync(process.execPath, [CLI, "update", "--board", "editor-contract", "--title", "Changed from CLI"], {
    encoding: "utf8",
    env: { ...process.env, TRACKERBOARD_HOME: root },
  });
  assert.equal(cliWrite.status, 0, cliWrite.stderr);
  const polled = await callbacks.loadSnapshot();
  assert.equal(polled.revision, next.revision + 1);
  assert.equal(polled.board.title, "Changed from CLI");
  await assert.rejects(
    callbacks.applyCommand({ type: "board.update", fields: { title: "stale" } }, initial.revision),
    { code: "TRACKERBOARD_REVISION_CONFLICT" },
  );
  assert.equal(loadBoard("editor-contract").title, "Changed from CLI");
  await assert.rejects(
    callbacks.applyCommand({ type: "board.replace", board: {} }, polled.revision),
    /unsupported editor command/,
  );
});

test("a delayed fake GitHub editor write does not block another board editor write", async (t) => {
  const oldHome = process.env.TRACKERBOARD_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-editor-isolation-"));
  process.env.TRACKERBOARD_HOME = root;
  t.after(() => {
    if (oldHome === undefined) delete process.env.TRACKERBOARD_HOME;
    else process.env.TRACKERBOARD_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const boards = {
    "gh-write": newBoard("gh-write", { title: "GitHub" }),
    "json-write": newBoard("json-write", { title: "JSON" }),
  };
  const revisions = { "gh-write": "remote-1", "json-write": 1 };
  let finishRemoteWrite;
  let startedRemoteWrite;
  const remoteStarted = new Promise((resolve) => { startedRemoteWrite = resolve; });
  const store = {
    backendConfig: (name) => ({ backend: name === "gh-write" ? "github" : "json" }),
    boardExists: () => true,
    backendTargetInfo: () => ({ identity: { backend: "github", projectId: "PVT_test" } }),
    loadBoard: (name) => structuredClone(boards[name]),
    getRevision: (name) => revisions[name],
    withBoardLock: (name, callback) => withBoardLock(name, callback),
    saveBoard(board) {
      if (board.name !== "gh-write") {
        boards[board.name] = structuredClone(board);
        revisions[board.name]++;
        return revisions[board.name];
      }
      startedRemoteWrite();
      return new Promise((resolve) => {
        finishRemoteWrite = () => {
          boards[board.name] = structuredClone(board);
          revisions[board.name] = "remote-2";
          resolve(revisions[board.name]);
        };
      });
    },
  };
  const remote = createEditorCallbacks({
    boardName: "gh-write",
    revisionConflict: () => Object.assign(new Error("stale"), { code: "TRACKERBOARD_REVISION_CONFLICT" }),
    store,
  });
  const local = createEditorCallbacks({
    boardName: "json-write",
    revisionConflict: () => Object.assign(new Error("stale"), { code: "TRACKERBOARD_REVISION_CONFLICT" }),
    store,
  });
  const [remoteSnapshot, localSnapshot] = await Promise.all([remote.loadSnapshot(), local.loadSnapshot()]);
  const slowWrite = remote.applyCommand({ type: "board.update", fields: { title: "GitHub saved" } }, remoteSnapshot.revision);
  await remoteStarted;

  const start = Date.now();
  const localResult = await local.applyCommand({ type: "board.update", fields: { title: "JSON saved" } }, localSnapshot.revision);
  assert.ok(Date.now() - start < 250, "a different board can mutate while the GitHub lock is held");
  assert.equal(localResult.board.title, "JSON saved");

  finishRemoteWrite();
  const remoteResult = await slowWrite;
  assert.equal(remoteResult.board.title, "GitHub saved");
});

test("CLI writes share the board lock with editor writes but not with other boards", async (t) => {
  const oldHome = process.env.TRACKERBOARD_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-cli-board-lock-"));
  process.env.TRACKERBOARD_HOME = root;
  t.after(() => {
    if (oldHome === undefined) delete process.env.TRACKERBOARD_HOME;
    else process.env.TRACKERBOARD_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await initializeBackends();
  createBoard("held-board", { title: "Held" });
  createBoard("free-board", { title: "Free" });
  const env = { ...process.env, TRACKERBOARD_HOME: root };
  let sameBoardFinished = false;
  let sameBoardWrite;
  await withBoardLock("held-board", async () => {
    sameBoardWrite = execFileAsync(process.execPath, [CLI, "update", "--board", "held-board", "--title", "CLI held"], { env })
      .then((result) => { sameBoardFinished = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const independent = await execFileAsync(process.execPath, [CLI, "update", "--board", "free-board", "--title", "CLI free"], { env });
    assert.equal(independent.stderr, "");
    assert.equal(sameBoardFinished, false, "CLI edit waits for the in-flight editor write on the same board");
  });
  await sameBoardWrite;
  assert.equal(sameBoardFinished, true);
  assert.equal(loadBoard("held-board").title, "CLI held");
  assert.equal(loadBoard("free-board").title, "CLI free");
});

test("GitHub snapshot reads coalesce and stay cached for the configured window", async () => {
  let now = 1_000;
  let reads = 0;
  let finishRead;
  const identity = { backend: "github", projectId: "PVT_remote" };
  const board = { name: "remote-board", title: "Remote" };
  const store = {
    backendConfig: () => ({ backend: "github" }),
    boardExists: () => true,
    backendTargetInfo: () => ({ identity }),
    loadBoard: async () => {
      reads++;
      await new Promise((resolve) => { finishRead = resolve; });
      return structuredClone(board);
    },
    getRevision: () => "remote-revision",
    withLock: (callback) => callback(),
    saveBoard: () => "remote-revision-2",
  };
  const callbacks = createEditorCallbacks({
    boardName: board.name,
    expectedTargetIdentity: identity,
    revisionConflict: (message) => Object.assign(new Error(message), { code: "TRACKERBOARD_REVISION_CONFLICT" }),
    store,
    now: () => now,
  });

  const first = callbacks.loadSnapshot();
  const second = callbacks.loadSnapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, "concurrent callers share one remote load");
  finishRead();
  assert.deepEqual(await Promise.all([first, second]), [
    { board, revision: "remote-revision" },
    { board, revision: "remote-revision" },
  ]);
  await callbacks.loadSnapshot();
  assert.equal(reads, 1, "the successful snapshot is cached");
  now += 60_001;
  const refreshed = callbacks.loadSnapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2, "the next read refreshes after the cache window");
  finishRead();
  await refreshed;
});

test("GitHub write conflicts invalidate the cached snapshot before returning it", async () => {
  const identity = { backend: "github", projectId: "PVT_conflict" };
  let board = newBoard("conflict-board", { title: "Before" });
  let revision = "remote-1";
  let reads = 0;
  const store = {
    backendConfig: () => ({ backend: "github" }),
    boardExists: () => true,
    backendTargetInfo: () => ({ identity }),
    loadBoard: () => { reads++; return structuredClone(board); },
    getRevision: () => revision,
    withBoardLock: (_name, callback) => callback(),
    saveBoard: () => { throw Object.assign(new Error("remote write conflict"), { code: "TRACKERBOARD_REVISION_CONFLICT" }); },
  };
  const callbacks = createEditorCallbacks({
    boardName: board.name,
    expectedTargetIdentity: identity,
    revisionConflict: (message) => Object.assign(new Error(message), { code: "TRACKERBOARD_REVISION_CONFLICT" }),
    store,
  });
  const initial = await callbacks.loadSnapshot();
  board = newBoard("conflict-board", { title: "Remote winner" });
  revision = "remote-2";

  await assert.rejects(
    callbacks.applyCommand({ type: "board.update", fields: { title: "Local edit" } }, initial.revision),
    { code: "TRACKERBOARD_REVISION_CONFLICT" },
  );
  const refreshed = await callbacks.loadSnapshot();
  assert.equal(refreshed.revision, "remote-2");
  assert.equal(refreshed.board.title, "Remote winner");
  assert.equal(reads, 3, "the conflict follow-up bypasses the old successful cache entry");
});

test("a retried log.append is idempotent after GitHub saved its manifest but lost the response", async () => {
  const identity = { backend: "github", projectId: "PVT_partial" };
  let board = newBoard("partial-board", { title: "Partial save" });
  let revision = "remote-1";
  let operations = [];
  let saves = 0;
  const store = {
    backendConfig: () => ({ backend: "github" }),
    boardExists: () => true,
    backendTargetInfo: () => ({ identity }),
    loadBoard: () => structuredClone(board),
    getRevision: () => revision,
    getOperation: (_name, id) => operations.find((receipt) => receipt.id === id) || null,
    withBoardLock: (_name, callback) => callback(),
    saveBoard(nextBoard, { operation }) {
      saves++;
      const existing = operations.find((receipt) => receipt.id === operation.id);
      if (existing) return revision;
      board = structuredClone(nextBoard);
      operations = [...operations, operation];
      revision = "remote-2";
      throw new Error("simulated lost response after README manifest save");
    },
  };
  const callbacks = createEditorCallbacks({
    boardName: board.name,
    expectedTargetIdentity: identity,
    revisionConflict: (message) => Object.assign(new Error(message), { code: "TRACKERBOARD_REVISION_CONFLICT" }),
    store,
  });
  const initial = await callbacks.loadSnapshot();
  const command = { type: "log.append", text: "once after a partial save", operationId: "operation-id-00000001" };
  await assert.rejects(callbacks.applyCommand(command, initial.revision), /lost response/);

  const afterPartialSave = await callbacks.loadSnapshot();
  assert.equal(afterPartialSave.revision, "remote-2", "a generic remote save error invalidates the old snapshot cache");
  assert.equal(afterPartialSave.board.log.filter((entry) => entry.text === command.text).length, 1);
  const retry = await callbacks.applyCommand(command, afterPartialSave.revision);
  assert.equal(retry.board.log.filter((entry) => entry.text === command.text).length, 1);
  assert.equal(saves, 1, "the receipt suppresses the duplicate remote save");
});

test("editor callbacks reject a removed or rebound board before reading or writing", async () => {
  let exists = true;
  let currentIdentity = { backend: "json", file: "/tmp/board.json" };
  let reads = 0;
  const store = {
    backendConfig: () => ({ backend: "json" }),
    boardExists: () => exists,
    backendTargetInfo: () => ({ identity: currentIdentity }),
    loadBoard: () => { reads++; return { name: "guarded", title: "Guarded" }; },
    getRevision: () => 1,
    withLock: (callback) => callback(),
    saveBoard: () => 2,
  };
  const callbacks = createEditorCallbacks({
    boardName: "guarded",
    expectedTargetIdentity: { backend: "json", file: "/tmp/board.json" },
    revisionConflict: (message) => Object.assign(new Error(message), { code: "TRACKERBOARD_REVISION_CONFLICT" }),
    store,
  });
  currentIdentity = { backend: "json", file: "/tmp/rebound.json" };
  await assert.rejects(callbacks.loadSnapshot(), { code: "TRACKERBOARD_REVISION_CONFLICT" });
  await assert.rejects(callbacks.applyCommand({ type: "board.update", fields: { title: "stale" } }, 1), { code: "TRACKERBOARD_REVISION_CONFLICT" });
  assert.equal(reads, 0);
  exists = false;
  currentIdentity = { backend: "json", file: "/tmp/board.json" };
  await assert.rejects(callbacks.loadSnapshot(), /removed/);
});
