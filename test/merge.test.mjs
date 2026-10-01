import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeBoards } from "../skills/trackerboard/scripts/lib/merge.mjs";
import * as B from "../skills/trackerboard/scripts/lib/board.mjs";

function board() {
  const b = B.newBoard("m");
  B.insertWave(b, "A", {});
  B.insertPhase(b, "P1", { title: "one" });
  B.insertPhase(b, "P2", { title: "two", deps: "P1" });
  B.insertPhase(b, "P3", { title: "three" });
  return b;
}
const clone = (v) => JSON.parse(JSON.stringify(v));
const ph = (b, id) => B.locatePhase(b, id).phase;

test("independent edits on both sides are kept", () => {
  const base = board(), local = clone(base), remote = clone(base);
  B.updatePhase(local, "P1", { status: "done" });
  B.insertPhase(local, "P1.1", { title: "local add" });
  B.updatePhase(remote, "P2", { owner: "x" });
  B.insertPhase(remote, "P4", { title: "remote add" });
  B.deletePhase(remote, "P3");
  B.appendLog(remote, "remote");
  B.appendLog(local, "local");
  const { board: m, conflicts, notes } = mergeBoards(base, local, remote);
  assert.deepEqual(conflicts, []);
  assert.equal(ph(m, "P1").status, "done");
  assert.equal(ph(m, "P2").owner, "x");
  assert.deepEqual(m.waves[0].phases.map((p) => p.id), ["P1", "P1.1", "P2", "P4"]);
  assert.deepEqual(m.log.map((e) => e.text).sort(), ["local", "remote"]);
  assert.deepEqual(notes, []);
  B.validate(m);
});

test("dependency lists merge as sets", () => {
  const base = board(), local = clone(base), remote = clone(base);
  B.addDeps(local, "P3", "P1");
  B.addDeps(remote, "P3", "P2");
  B.removeDeps(local, "P2", "P1");
  const { board: m } = mergeBoards(base, local, remote);
  assert.deepEqual(ph(m, "P3").deps, ["P2", "P1"]);
  assert.deepEqual(ph(m, "P2").deps, []);
});

test("the same field changed on both sides is a conflict unless a side is preferred", () => {
  const base = board(), local = clone(base), remote = clone(base);
  B.updatePhase(local, "P1", { status: "done" });
  B.updatePhase(remote, "P1", { status: "blocked" });
  assert.deepEqual(mergeBoards(base, local, remote).conflicts, ["phase P1 status"]);
  assert.equal(ph(mergeBoards(base, local, remote, { prefer: "local" }).board, "P1").status, "done");
  assert.equal(ph(mergeBoards(base, local, remote, { prefer: "remote" }).board, "P1").status, "blocked");
});

test("delete on one side and edit on the other conflicts; a plain delete wins", () => {
  const base = board(), local = clone(base), remote = clone(base);
  B.deletePhase(local, "P3");
  B.updatePhase(remote, "P3", { note: "still needed" });
  assert.deepEqual(mergeBoards(base, local, remote).conflicts, ["phase P3 deleted here, changed in the artifact"]);
  const r2 = clone(base);
  B.updatePhase(r2, "P1", { note: "x" });
  const { board: m, conflicts } = mergeBoards(base, local, r2);
  assert.deepEqual(conflicts, []);
  assert.equal(B.allPhases(m).some(({ phase }) => phase.id === "P3"), false);
});

test("a remote delete drops local deps on it, and moves follow the wave", () => {
  const base = board(), local = clone(base), remote = clone(base);
  B.insertWave(local, "B", {});
  B.updatePhase(local, "P3", {}, { toWave: "B" });
  B.addDeps(local, "P3", "P2");
  B.deletePhase(remote, "P2");
  const { board: m, conflicts, notes } = mergeBoards(base, local, remote);
  assert.deepEqual(conflicts, []);
  assert.equal(B.locatePhase(m, "P3").wave.id, "B");
  assert.deepEqual(ph(m, "P3").deps, []);
  assert.match(notes[0], /P3 -> P2/);
  B.validate(m);
});
