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
