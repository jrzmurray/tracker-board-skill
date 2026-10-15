import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("shared store lock recovers immediately when its owner process exited", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-store-lock-"));
  const previousHome = process.env.TRACKERBOARD_HOME;
  process.env.TRACKERBOARD_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.TRACKERBOARD_HOME;
    else process.env.TRACKERBOARD_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const storeUrl = pathToFileURL(path.resolve("skills/trackerboard/scripts/lib/store.mjs")).href;
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `const { withLock } = await import(${JSON.stringify(storeUrl)}); await withLock(() => process.exit(0));`,
  ], { encoding: "utf8", env: { ...process.env, TRACKERBOARD_HOME: home } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.existsSync(path.join(home, ".lock", "owner")), true);

  const { withLock } = await import(storeUrl);
  assert.equal(await withLock(() => "acquired"), "acquired");
  assert.equal(fs.existsSync(path.join(home, ".lock")), false);
});

test("board discovery excludes snapshots without reserving valid board-name suffixes", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-board-discovery-"));
  const previousHome = process.env.TRACKERBOARD_HOME;
  process.env.TRACKERBOARD_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.TRACKERBOARD_HOME;
    else process.env.TRACKERBOARD_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const boards = path.join(home, "boards");
  fs.mkdirSync(boards, { recursive: true });
  const recoveryName = "active.recovery-2026-10-15T15-33-19-434Z";
  const validRecoveryName = "legit.recovery-2026-10-15T15-33-19-434Z";
  const contents = {
    "active.json": { name: "active" },
    "legacy-unbound.json": { name: "legacy-unbound" },
    "active.local.json": {},
    "active.base.json": { name: "active" },
    [`${recoveryName}.json`]: { name: "active" },
    [`${recoveryName}.local.json`]: {},
    "legit.base.json": { name: "legit.base" },
    [`${validRecoveryName}.json`]: { name: validRecoveryName },
    "legit.base.local.json": {},
    [`${validRecoveryName}.local.json`]: {},
  };
  for (const [name, value] of Object.entries(contents)) {
    fs.writeFileSync(path.join(boards, name), JSON.stringify(value));
  }

  const storeUrl = pathToFileURL(path.resolve("skills/trackerboard/scripts/lib/store.mjs")).href;
  const { boardExists, createBoard, listBoards } = await import(storeUrl);
  assert.deepEqual(listBoards(), ["active", "legacy-unbound", "legit.base", validRecoveryName]);
  assert.equal(boardExists(recoveryName), false);
  assert.equal(boardExists("legit.base"), true);
  assert.equal(boardExists(validRecoveryName), true);
  const snapshotPath = path.join(boards, `${recoveryName}.json`);
  const snapshotBefore = fs.readFileSync(snapshotPath, "utf8");
  assert.throws(() => createBoard(recoveryName), /contains an inactive snapshot for a different board/);
  assert.equal(fs.readFileSync(snapshotPath, "utf8"), snapshotBefore, "a name collision must not delete the snapshot");
});

test("board locks serialize one board while allowing independent boards to proceed", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-board-lock-"));
  const previousHome = process.env.TRACKERBOARD_HOME;
  process.env.TRACKERBOARD_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.TRACKERBOARD_HOME;
    else process.env.TRACKERBOARD_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const { withBoardLock } = await import(pathToFileURL(path.resolve("skills/trackerboard/scripts/lib/store.mjs")).href);

  let releaseFirst;
  let firstAcquired;
  const acquired = new Promise((resolve) => { firstAcquired = resolve; });
  const first = withBoardLock("one", async () => {
    firstAcquired();
    await new Promise((resolve) => { releaseFirst = resolve; });
  });
  await acquired;

  let sameStarted = false;
  const same = withBoardLock("one", () => { sameStarted = true; });
  const independent = withBoardLock("two", () => "independent");
  assert.equal(await independent, "independent");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sameStarted, false, "same-board writes wait for one another");

  releaseFirst();
  await Promise.all([first, same]);
  assert.equal(sameStarted, true);
});
