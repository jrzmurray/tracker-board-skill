import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { initializeBackendFactories, openBackend } from "../skills/trackerboard/scripts/lib/backend.mjs";
import "../skills/trackerboard/scripts/lib/backends/sqlite.mjs";

await initializeBackendFactories();

function setup(t, { name = "sample", config = { sqlite: {} } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-sqlite-"));
  const dataHome = path.join(root, "data");
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = {
    name,
    bindingKey: "test-binding",
    config,
    cwd: repoRoot,
    repoRoot,
    repoUrl: "https://example.test/team/repo",
    local: {},
    saveLocal() {},
    boardPath: path.join(repoRoot, `${name}.json`),
    dataHome,
  };
  return { root, context, backend: openBackend("sqlite", context) };
}

function sampleBoard(name = "sample") {
  return {
    schema: 1,
    name,
    title: "SQLite adapter",
    subtitle: "Round-trip ✓",
    lede: "Preserve the canonical board object.",
    notes: "",
    repoUrl: "https://example.test/team/repo",
    waves: [{
      id: "P0",
      title: "First wave",
      prefix: "P0",
      notes: "wave notes",
      phases: [{
        id: "P0.1",
        title: "Write adapter",
        lane: "storage",
        owner: "agent",
        status: "active",
        note: "keep fields intact",
        req: "",
        issue: "#42",
        pr: "",
        review: "",
        notes: "nested text",
        deps: [],
      }],
    }],
    log: [{ at: "2026-10-12T12:00:00.000Z", text: "started" }],
    updatedAt: "2026-10-12T12:00:00.000Z",
  };
}

test("SQLite backend round-trips canonical board data into the configured data home", (t) => {
  const { context, backend } = setup(t);
  const board = sampleBoard();
  const expectedPath = path.join(context.dataHome, "repos", `${context.bindingKey}.sqlite`);

  assert.equal(backend.load(), null);
  assert.equal(backend.create(board), 1);
  assert.deepEqual(backend.load(), board);
  assert.equal(backend.revision(), 1);
  assert.equal(fs.existsSync(expectedPath), true);
  assert.equal(fs.existsSync(context.boardPath), false);
});

test("configured relative SQLite path is resolved under dataHome and can hold multiple boards", (t) => {
  const { context, backend } = setup(t, { config: { sqlite: { path: "shared/boards.sqlite" } } });
  const otherContext = { ...context, name: "other" };
  const other = openBackend("sqlite", otherContext);
  const expectedPath = path.join(context.dataHome, "shared", "boards.sqlite");

  backend.create(sampleBoard());
  other.create(sampleBoard("other"));
  assert.equal(fs.existsSync(expectedPath), true);
  assert.deepEqual(backend.load(), sampleBoard());
  assert.deepEqual(other.load(), sampleBoard("other"));
  assert.throws(() => openBackend("sqlite", {
    ...context,
    config: { sqlite: { path: path.join(context.repoRoot, "local.sqlite") } },
  }), /outside the repository/);
});

test("revisions increase across create, save, remove, and recreate", (t) => {
  const { backend } = setup(t);
  const board = sampleBoard();

  assert.equal(backend.create(board), 1);
  assert.equal(backend.save({ ...board, title: "saved" }, { expectedRevision: 1 }), 2);
  backend.remove();
  assert.equal(backend.load(), null);
  assert.equal(backend.revision(), 3);
  assert.equal(backend.create(board), 4);
  assert.equal(backend.revision(), 4);
});

test("save rejects stale expected revisions without changing the board", (t) => {
  const { backend } = setup(t);
  const board = sampleBoard();
  backend.create(board);
  const saved = { ...board, title: "current" };
  backend.save(saved, { expectedRevision: 1 });

  assert.throws(
    () => backend.save({ ...board, title: "stale" }, { expectedRevision: 1 }),
    /changed \(expected revision 1, current 2\)/,
  );
  assert.equal(backend.revision(), 2);
  assert.deepEqual(backend.load(), saved);
});

test("failed atomic replacement leaves the prior database readable and removes the temp file", (t) => {
  const { context, backend } = setup(t);
  const board = sampleBoard();
  backend.create(board);
  const database = path.join(context.dataHome, "repos", `${context.bindingKey}.sqlite`);
  const before = fs.readFileSync(database);
  const rename = fs.renameSync;

  fs.renameSync = function (from, to, ...args) {
    if (path.resolve(to) === database) throw Object.assign(new Error("simulated replacement failure"), { code: "EIO" });
    return rename.call(this, from, to, ...args);
  };
  try {
    assert.throws(() => backend.save({ ...board, title: "not committed" }, { expectedRevision: 1 }), /simulated replacement failure/);
  } finally {
    fs.renameSync = rename;
  }

  assert.deepEqual(fs.readFileSync(database), before);
  assert.deepEqual(backend.load(), board);
  assert.equal(backend.revision(), 1);
  assert.equal(fs.readdirSync(path.dirname(database)).some((file) => file.endsWith(".tmp")), false);
});

test("separate processes serialize writers and reject the stale concurrent save", async (t) => {
  const { context, backend } = setup(t);
  const board = sampleBoard();
  backend.create(board);
  const args = {
    context: { ...context, saveLocal: undefined },
    board: { ...board, title: "concurrent writer" },
    expectedRevision: 1,
  };
  const backendUrl = pathToFileURL(path.resolve("skills/trackerboard/scripts/lib/backend.mjs")).href;
  const adapterUrl = pathToFileURL(path.resolve("skills/trackerboard/scripts/lib/backends/sqlite.mjs")).href;
  const program = `
    import ${JSON.stringify(adapterUrl)};
    import { initializeBackendFactories, openBackend } from ${JSON.stringify(backendUrl)};
    const { context, board, expectedRevision } = JSON.parse(process.argv[1]);
    await initializeBackendFactories();
    const backend = openBackend("sqlite", context);
    try {
      const revision = backend.save(board, { expectedRevision });
      process.stdout.write("saved:" + revision);
    } catch (error) {
      if (/changed/.test(error.message)) process.stdout.write("conflict");
      else { process.stderr.write(error.stack || String(error)); process.exitCode = 1; }
    }
  `;
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program, JSON.stringify(args)], { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  const results = await Promise.all([launch(), launch()]);
  assert.deepEqual(results.map((result) => result.code), [0, 0]);
  assert.deepEqual(results.map((result) => result.stdout).sort(), ["conflict", "saved:2"]);
  assert.equal(backend.revision(), 2);
});
