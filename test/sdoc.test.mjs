import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSdoc, sdocBoards } from "../skills/trackerboard/scripts/lib/sdoc.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "trackerboard", "scripts", "trackerboard.mjs");

const DOC = `[DOCUMENT]
TITLE: Sample requirements

[GRAMMAR]
ELEMENTS:
- TAG: REQUIREMENT
  FIELDS:
  - TITLE: UID
    TYPE: String
    REQUIRED: True
  RELATIONS:
  - TYPE: Parent

[REQUIREMENT]
UID: R-AAA-001
STATUS: done
TITLE: First
STATEMENT: >>>
The first requirement.
Second line.
<<<
LEG: G1
PRIORITY: P1
PROOF_PRS: 12

[REQUIREMENT]
UID: R-AAA-002
STATUS: in_progress
TITLE: Second
STATEMENT: >>>
Depends on the first and on one elsewhere.
<<<
LEG: G1
RELATIONS:
- TYPE: Parent
  VALUE: R-AAA-001
- TYPE: Parent
  VALUE: R-BBB-001
- TYPE: File
  VALUE: src/a.py

[[SECTION]]
TITLE: Later
[REQUIREMENT]
UID: R-BBB-001
STATUS: dropped
STATEMENT: >>>
Dropped work.
<<<
LEG: G2
[[/SECTION]]
`;

test("parseSdoc reads fields, multi-line statements, relations, sections; skips the grammar", () => {
  const doc = parseSdoc(DOC, "x.sdoc");
  assert.equal(doc.title, "Sample requirements");
  assert.equal(doc.elements.length, 3);
  const [a, b, c] = doc.elements;
  assert.equal(a.fields.STATEMENT, "The first requirement.\nSecond line.");
  assert.equal(a.fields.PROOF_PRS, "12");
  assert.deepEqual(b.relations, [
    { type: "Parent", value: "R-AAA-001" },
    { type: "Parent", value: "R-BBB-001" },
    { type: "File", value: "src/a.py" },
  ]);
  assert.deepEqual(c.sections, ["Later"]);
  assert.equal(a.fields.UID, "R-AAA-001"); // the grammar's "UID" field entry is not an element
});

test("sdocBoards builds a hierarchy; Parent is a dependency; dropped is not counted", () => {
  const boards = sdocBoards([parseSdoc(DOC, "x.sdoc")], { root: "r", groupBy: ["LEG", "domain"] });
  assert.deepEqual(boards.map((b) => b.name).sort(), ["r", "r-g1", "r-g1-aaa", "r-g2", "r-g2-bbb"]);
  const lane = boards.find((b) => b.name === "r-g1-aaa");
  assert.equal(lane.parent, "r-g1");
  const [p1, p2] = lane.waves[0].phases;
  assert.equal(p1.status, "done");
  assert.equal(p2.status, "active");
  assert.deepEqual(p2.deps, ["R-AAA-001"]);
  assert.match(p2.notes, /Also depends on: R-BBB-001/);
  assert.match(p2.notes, /File: src\/a\.py/);
  const root = boards.find((b) => b.name === "r");
  assert.deepEqual(root.waves[0].phases.map((p) => [p.id, p.status, p.note]), [["G1", "active", "1/2 done"], ["G2", "planned", "0/0 done"]]);
});

test("sdoc command writes importable boards and rolls up with dropped excluded", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-sdoc-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-sdoc-in-"));
  fs.writeFileSync(path.join(dir, "a.sdoc"), DOC);
  const outDir = path.join(dir, "boards");
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, TRACKERBOARD_HOME: home } });
  const made = run(["sdoc", dir, "--root", "r", "--out", outDir, "--group-by", "LEG,domain"]);
  assert.equal(made.status, 0, made.stderr);
  for (const f of ["r", ...fs.readdirSync(outDir).map((n) => n.replace(/\.json$/, "")).filter((n) => n !== "r")]) {
    const imp = run(["import", f, "--from", path.join(outDir, `${f}.json`), "--no-bind"]);
    assert.equal(imp.status, 0, imp.stderr);
  }
  assert.match(run(["tree", "--all"]).stdout, /^r +1\/2 done \(50%\)/m);
});

test("sdoc rejects duplicate UIDs and files without elements", () => {
  assert.throws(() => sdocBoards([parseSdoc(DOC, "a"), parseSdoc(DOC, "b")], { root: "r" }), /duplicate UID/);
  assert.throws(() => sdocBoards([parseSdoc("[DOCUMENT]\nTITLE: x\n", "e")], { root: "r" }), /no elements/);
});

test("RST escapes and wrapped multi-line statements are undone on import", () => {
  const text = `[DOCUMENT]
TITLE: t

[REQUIREMENT]
UID: R-ZZZ-001
STATUS: planned
TITLE: Use \\[x:\\*\\] and a\\\\b and snake\\_
STATEMENT: >>>
Use [x:\\*] and a\\\\b and snake\\_ in a long
wrapped statement.
<<<
`;
  const [b] = sdocBoards([parseSdoc(text, "e")], { root: "r" }).filter((x) => x.name !== "r");
  const p = b.waves[0].phases[0];
  assert.equal(p.title, "Use \\[x:*\\] and a\\b and snake_");
  assert.equal(p.req, "Use [x:*] and a\\b and snake_ in a long wrapped statement.");
});
