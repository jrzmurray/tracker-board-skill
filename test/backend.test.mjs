import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initializeBackendFactories, openBackend, registerBackendFactory } from "../skills/trackerboard/scripts/lib/backend.mjs";

test("backend factory initializes once and exposes the synchronous CRUD contract", async () => {
  let initialized = 0;
  let revision = 0;
  registerBackendFactory("contract-test", {
    async initialize() { initialized++; },
    open() {
      let board = null;
      return {
        load() { return board; },
        create(value) { board = value; },
        save(value, options = {}) {
          if (options.expectedRevision != null && options.expectedRevision !== revision) throw new Error("revision conflict");
          board = value;
          return ++revision;
        },
        revision() { return revision; },
        getOperation() { return null; },
        remove() { board = null; },
      };
    },
  });
  await initializeBackendFactories();
  await initializeBackendFactories();
  assert.equal(initialized, 1);
  const backend = openBackend("contract-test", {});
  assert.deepEqual(Object.keys(backend).sort(), ["create", "getOperation", "load", "remove", "revision", "save"]);
  backend.create({ name: "sample" });
  assert.deepEqual(backend.load(), { name: "sample" });
  assert.equal(backend.save({ name: "sample", title: "updated" }, { expectedRevision: 0 }), 1);
  assert.equal(backend.revision(), 1);
  assert.throws(() => backend.save({}, { expectedRevision: 0 }), /revision conflict/);
});

test("JSON remains the default backend and checks expected revisions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-json-"));
  process.env.TRACKERBOARD_HOME = path.join(root, "legacy-home");
  process.env.TRACKERBOARD_DATA_HOME = path.join(root, "data");
  const S = await import(`../skills/trackerboard/scripts/lib/store.mjs?test=${Date.now()}`);
  await S.initializeBackends();
  const board = S.createBoard("default-json", { title: "Default" });
  assert.equal(S.backendConfig("default-json").backend, "json");
  assert.equal(S.getRevision("default-json"), 1);
  const loaded = S.loadBoard(board.name);
  loaded.title = "Updated";
  assert.equal(S.saveBoard(loaded, { expectedRevision: 1 }), 2);
  assert.equal(S.loadBoard(board.name).title, "Updated");
  assert.throws(() => S.saveBoard({ ...loaded, title: "Stale" }, { expectedRevision: 1 }), /expected revision 1, current 2/);
  const operation = { id: "operation-id-json-test-0001", hash: "a".repeat(64) };
  const logged = S.loadBoard(board.name);
  logged.log.unshift({ at: "2026-10-14T12:00:00.000Z", text: "append once" });
  assert.equal(S.saveBoard(logged, { expectedRevision: 2, operation }), 3);
  const duplicate = structuredClone(logged);
  duplicate.log.unshift({ at: "2026-10-14T12:01:00.000Z", text: "append once" });
  assert.equal(S.saveBoard(duplicate, { expectedRevision: 2, operation }), 3, "a durable receipt suppresses replay even with the stale revision");
  assert.equal(S.loadBoard(board.name).log.filter((entry) => entry.text === "append once").length, 1);
  assert.deepEqual(S.getOperation(board.name, operation.id), operation);
  assert.ok(fs.existsSync(path.join(root, "legacy-home", "boards", "default-json.json")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("changing backend defaults does not reinterpret an existing legacy JSON board", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-legacy-default-"));
  const oldHome = process.env.TRACKERBOARD_HOME;
  const oldDataHome = process.env.TRACKERBOARD_DATA_HOME;
  t.after(() => {
    if (oldHome === undefined) delete process.env.TRACKERBOARD_HOME;
    else process.env.TRACKERBOARD_HOME = oldHome;
    if (oldDataHome === undefined) delete process.env.TRACKERBOARD_DATA_HOME;
    else process.env.TRACKERBOARD_DATA_HOME = oldDataHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.TRACKERBOARD_HOME = path.join(root, "legacy-home");
  process.env.TRACKERBOARD_DATA_HOME = path.join(root, "data");
  const S = await import(`../skills/trackerboard/scripts/lib/store.mjs?legacy-test=${Date.now()}`);
  await S.initializeBackends();
  S.createBoard("legacy-json", { title: "Original source" });

  const local = S.loadLocal("legacy-json");
  delete local.backendOverride;
  S.saveLocal("legacy-json", local);
  fs.mkdirSync(process.env.TRACKERBOARD_DATA_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.TRACKERBOARD_DATA_HOME, "config.json"), JSON.stringify({ backend: "github" }));

  assert.equal(S.backendConfig("legacy-json").backend, "json");
  assert.equal(S.loadBoard("legacy-json").title, "Original source");
});
