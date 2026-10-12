import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("backend configuration merges global, repository, then board values key-by-key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-config-"));
  process.env.TRACKERBOARD_DATA_HOME = path.join(root, "state");
  const C = await import("../skills/trackerboard/scripts/lib/config.mjs");
  fs.mkdirSync(C.dataHome(), { recursive: true });
  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "sqlite", sqlite: { path: "global.sqlite", journalMode: "delete" } }));
  C.writeRepoConfig("abc123", { sqlite: { path: "repo.sqlite" }, github: { owner: "team" } });
  assert.deepEqual(C.resolveConfig({ bindingKey: "abc123", boardOverride: { backend: "github", github: { projectNumber: 7 } } }), {
    backend: "github",
    sqlite: { path: "repo.sqlite", journalMode: "delete" },
    github: { owner: "team", projectNumber: 7 },
  });
  assert.deepEqual(C.resolveConfig({ bindingKey: "missing" }), {
    backend: "sqlite",
    sqlite: { path: "global.sqlite", journalMode: "delete" },
  });
  fs.rmSync(root, { recursive: true, force: true });
});
