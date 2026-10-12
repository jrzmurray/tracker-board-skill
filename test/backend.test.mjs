import assert from "node:assert/strict";
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
