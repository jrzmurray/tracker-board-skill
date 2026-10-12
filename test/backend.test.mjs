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
        remove() { board = null; },
      };
    },
  });
  await initializeBackendFactories();
  await initializeBackendFactories();
  assert.equal(initialized, 1);
  const backend = openBackend("contract-test", {});
  assert.deepEqual(Object.keys(backend).sort(), ["create", "load", "remove", "revision", "save"]);
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
  assert.ok(fs.existsSync(path.join(root, "legacy-home", "boards", "default-json.json")));
  fs.rmSync(root, { recursive: true, force: true });
});
