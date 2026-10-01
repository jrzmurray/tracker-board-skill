import assert from "node:assert/strict";
import { test } from "node:test";
import * as B from "../skills/trackerboard/scripts/lib/board.mjs";

const ids = (w) => w.phases.map((p) => p.id);

function board(...phaseIds) {
  const b = B.newBoard("t");
  for (const id of phaseIds) B.insertPhase(b, id);
  return b;
}

test("sub-phase lands after its parent even when the next phase exists", () => {
  const b = board("P0", "P1", "P2");
  B.insertPhase(b, "P0.1");
  B.insertPhase(b, "P0-2");
  B.insertPhase(b, "p1.1");
  assert.deepEqual(ids(b.waves[0]), ["P0", "P0.1", "P0-2", "P1", "p1.1", "P2"]);
});

test("siblings under a parent keep natural order, nested ids go inside their block", () => {
  const b = board("P0", "P1");
  B.insertPhase(b, "P0.2");
  B.insertPhase(b, "P0.10");
  B.insertPhase(b, "P0.1");
  B.insertPhase(b, "P0.1.1");
  assert.deepEqual(ids(b.waves[0]), ["P0", "P0.1", "P0.1.1", "P0.2", "P0.10", "P1"]);
});

test("top-level ids slot by natural order within their stem; other stems append", () => {
  const b = board("A-1", "A-3", "G1");
  B.insertPhase(b, "A-2");
  B.insertPhase(b, "A-10");
  B.insertPhase(b, "X1");
  assert.deepEqual(ids(b.waves[0]), ["A-1", "A-2", "A-3", "A-10", "G1", "X1"]);
});

test("insert never overwrites", () => {
  const b = board("P0");
  assert.throws(() => B.insertPhase(b, "p0"), /already exists/);
});

test("wave inference: parent, prefix, single wave, ambiguity", () => {
  const b = B.newBoard("t");
  B.insertWave(b, "A", { prefix: "A-" });
  B.insertWave(b, "B", { prefix: "B-" });
  assert.equal(B.insertPhase(b, "A-1").wave.id, "A");
  assert.equal(B.insertPhase(b, "B-1").wave.id, "B");
  assert.equal(B.insertPhase(b, "A-1.1").wave.id, "A");
  assert.throws(() => B.insertPhase(b, "Z9"), /pass --wave/);
  assert.equal(B.insertPhase(b, "Z9", {}, { wave: "B" }).wave.id, "B");
  assert.equal(B.insertPhase(b, "Z10").wave.id, "B", "same stem as an existing phase");
});

test("phase ids are unique across waves", () => {
  const b = B.newBoard("t");
  B.insertPhase(b, "P1", {}, { wave: "1" });
  assert.throws(() => B.insertPhase(b, "P1", {}, { wave: "2" }), /unique per board/);
});

test("fields: status aliases and unknown fields", () => {
  const b = board("P0");
  B.updatePhase(b, "P0", { status: "merged", pr: "#12" });
  assert.equal(b.waves[0].phases[0].status, "done");
  assert.throws(() => B.updatePhase(b, "P0", { status: "meh" }), /unknown status/);
  assert.throws(() => B.updatePhase(b, "P0", { colour: "x" }), /unknown phase field/);
});

test("dependency graph: add, cycle refusal, rename rewrites, delete cleans", () => {
  const b = board("P0", "P1", "P2");
  B.addDeps(b, "P1", "P0");
  B.addDeps(b, "P2", ["P1", "p0"]);
  assert.deepEqual(b.waves[0].phases[2].deps, ["P1", "P0"]);
  assert.throws(() => B.addDeps(b, "P0", "P2"), /cycle/);
  assert.throws(() => B.addDeps(b, "P0", "P9"), /not a phase/);
  B.updatePhase(b, "P1", {}, { rename: "P1.5" });
  assert.deepEqual(b.waves[0].phases.find((p) => p.id === "P2").deps, ["P1.5", "P0"]);
  const { removedDeps } = B.deletePhase(b, "P0");
  assert.deepEqual(removedDeps, ["P1.5 -> P0", "P2 -> P0"]);
  B.validate(b);
});

test("setDeps is atomic on failure", () => {
  const b = board("P0", "P1", "P2");
  B.addDeps(b, "P1", "P0");
  assert.throws(() => B.setDeps(b, "P1", "P2,P9"));
  assert.deepEqual(b.waves[0].phases[1].deps, ["P0"]);
});

test("ready phases have every dependency done", () => {
  const b = board("P0", "P1", "P2");
  B.addDeps(b, "P1", "P0");
  B.addDeps(b, "P2", "P1");
  B.updatePhase(b, "P0", { status: "done" });
  assert.deepEqual(B.readyPhases(b), ["P1"]);
});

test("wave delete needs --force when non-empty and cleans deps", () => {
  const b = B.newBoard("t");
  B.insertPhase(b, "A1", {}, { wave: "A" });
  B.insertPhase(b, "B1", { deps: "A1" }, { wave: "B" });
  assert.throws(() => B.deleteWave(b, "A"), /--force/);
  B.deleteWave(b, "A", { force: true });
  assert.deepEqual(b.waves.map((w) => w.id), ["B"]);
  assert.deepEqual(b.waves[0].phases[0].deps, []);
});

test("mermaid ids do not collide for P0.1 and P0-1", () => {
  const b = board("P0", "P0.1", "P0-1");
  B.addDeps(b, "P0-1", "P0.1");
  assert.match(B.toMermaid(b), /n1 --> n2/);
});

test("log is newest first and capped", () => {
  const b = B.newBoard("t");
  for (let i = 0; i < B.LOG_LIMIT + 5; i++) B.appendLog(b, `e${i}`);
  assert.equal(b.log.length, B.LOG_LIMIT);
  assert.equal(b.log[0].text, `e${B.LOG_LIMIT + 4}`);
});

test("ELK layout: null without deps, non-overlapping nodes, edges touch their nodes, wave groups", async () => {
  const { layoutBoard } = await import("../skills/trackerboard/scripts/lib/layout.mjs");
  const b = B.newBoard("l");
  B.insertWave(b, "A", { title: "Wave A", prefix: "A-" });
  B.insertPhase(b, "A-1", { title: "first" });
  assert.equal(await layoutBoard(b), null);
  B.insertPhase(b, "A-2", { deps: ["A-1"] });
  B.insertPhase(b, "A-3", { deps: ["A-1"] });
  B.insertWave(b, "B", { prefix: "B-" });
  B.insertPhase(b, "B-1", { deps: ["A-2", "A-3"] });
  const L = await layoutBoard(b);
  assert.equal(L.engine, "elk-layered");
  assert.deepEqual(L.groups.map((g) => g.wave), ["A", "B"]);
  assert.equal(L.nodes.length, 4);
  for (const a of L.nodes) for (const z of L.nodes) {
    if (a === z) continue;
    assert.ok(a.x + a.w <= z.x || z.x + z.w <= a.x || a.y + a.h <= z.y || z.y + z.h <= a.y, `${a.id} overlaps ${z.id}`);
  }
  const node = new Map(L.nodes.map((n) => [n.id, n]));
  const on = (n, [x, y]) => x >= n.x - 0.5 && x <= n.x + n.w + 0.5 && y >= n.y - 0.5 && y <= n.y + n.h + 0.5;
  assert.equal(L.edges.length, 4);
  for (const e of L.edges) {
    assert.ok(on(node.get(e.from), e.points[0]), `edge ${e.from}->${e.to} starts on its source`);
    assert.ok(on(node.get(e.to), e.points.at(-1)), `edge ${e.from}->${e.to} ends on its target`);
  }
  for (const n of L.nodes) assert.ok(n.x + n.w <= L.width && n.y + n.h <= L.height);
});

test("HTML <code> and <strong> spans in text fields are stored as markdown backticks", () => {
  assert.equal(B.htmlToMarkdown("via <code>claimWorkers</code> and <CODE>a &lt; b</CODE>"), "via `claimWorkers` and `a < b`");
  assert.equal(B.htmlToMarkdown("<code>x`y</code>"), "`` x`y ``");
  assert.equal(B.htmlToMarkdown("already `code`"), "already `code`");
  assert.equal(B.htmlToMarkdown("<strong>JR ratifies</strong> it"), "**JR ratifies** it");
  const b = B.newBoard("t");
  B.insertPhase(b, "P1", { notes: "wire <code>gate:census-diff</code>" });
  assert.equal(B.allPhases(b)[0].phase.notes, "wire `gate:census-diff`");
  B.appendLog(b, "set <code>X</code>");
  assert.equal(b.log[0].text, "set `X`");
});
