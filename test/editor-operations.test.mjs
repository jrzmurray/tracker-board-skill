import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initializeBackends, createBoard, loadBoard } from "../skills/trackerboard/scripts/lib/store.mjs";
import { createEditorCallbacks } from "../skills/trackerboard/scripts/lib/editor-operations.mjs";

const CLI = fileURLToPath(new URL("../skills/trackerboard/scripts/trackerboard.mjs", import.meta.url));

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
  const initial = callbacks.loadSnapshot();
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
  const polled = callbacks.loadSnapshot();
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
