import assert from "node:assert/strict";
import { test } from "node:test";
import * as B from "../skills/trackerboard/scripts/lib/board.mjs";
import { applyGithub, idPattern } from "../skills/trackerboard/scripts/lib/github.mjs";

test("ids match as whole tokens, not inside longer ids or sub-ids", () => {
  const re = idPattern("R-SEC-056");
  assert.ok(re.test("fix(identity): lock order (R-SEC-056)"));
  assert.ok(re.test("fix/r-sec-056-lock-order"));
  assert.ok(!re.test("R-SEC-0561"));
  assert.ok(!idPattern("SEC-056").test("R-SEC-056"));
  assert.ok(idPattern("P1").test("ai/p1-thing"));
  assert.ok(!idPattern("P1").test("P1.2 follow-up"));
  assert.ok(!idPattern("P1").test("P1-2"));
});

function board() {
  const b = B.newBoard("t");
  B.insertPhase(b, "R-A-001");
  B.insertPhase(b, "R-A-002", { status: "review", pr: "#5 merged" });
  B.insertPhase(b, "R-A-003", { status: "blocked" });
  B.insertPhase(b, "R-A-004", { status: "done" });
  B.insertPhase(b, "R-A-005");
  return b;
}
const phase = (b, id) => B.locatePhase(b, id).phase;

test("open PRs fill pr/issue and move status forward only", () => {
  const b = board();
  const changes = applyGithub(b, {
    prs: [
      { number: 10, title: "feat: thing (R-A-001)", isDraft: true, closingIssuesReferences: [{ number: 7 }] },
      { number: 11, title: "x", headRefName: "fix/r-a-002-y", isDraft: true },
      { number: 12, title: "R-A-003 and R-A-004", isDraft: false },
      { number: 13, title: "closes the issue", isDraft: false, closingIssuesReferences: [{ number: 8 }] },
      { number: 14, title: "unrelated", labels: [{ name: "req:R-A-001" }], isDraft: false },
    ],
    issues: [{ number: 8, title: "R-A-005 tracking issue" }],
  });
  assert.deepEqual(phase(b, "R-A-001"), { ...phase(b, "R-A-001"), pr: "#10, #14", issue: "#7", status: "review" });
  assert.equal(phase(b, "R-A-002").pr, "#5 merged, #11");
  assert.equal(phase(b, "R-A-002").status, "review"); // a draft never moves review back
  assert.equal(phase(b, "R-A-003").status, "blocked");
  assert.equal(phase(b, "R-A-004").status, "done");
  assert.deepEqual([phase(b, "R-A-005").pr, phase(b, "R-A-005").issue, phase(b, "R-A-005").status], ["#13", "#8", "review"]);
  assert.deepEqual(changes.find((c) => c.id === "R-A-001").status, ["todo", "review"]);
  // Running again changes nothing.
  assert.deepEqual(applyGithub(b, { prs: [{ number: 10, title: "R-A-001", isDraft: true }] }), []);
});

test("body is only searched when asked", () => {
  const b = board();
  const prs = [{ number: 20, title: "x", body: "Implements R-A-001", isDraft: true }];
  assert.equal(applyGithub(b, { prs }).length, 0);
  assert.equal(applyGithub(b, { prs }, { sources: ["body"] }).length, 1);
});

test("normalizeBoard fills defaults, accepts aliases and rejects unknown fields", () => {
  const b = B.normalizeBoard({ name: "g", waves: [{ id: "W1", phases: [{ id: "R-1", status: "planned", deps: "" }, { id: "R-2", status: "in_progress", deps: "R-1" }] }] });
  assert.equal(b.title, "g");
  assert.deepEqual(b.waves[0].phases.map((p) => [p.status, p.deps, p.issue]), [["todo", [], ""], ["active", ["R-1"], ""]]);
  assert.throws(() => B.normalizeBoard({ waves: [{ id: "W", phases: [{ id: "X", leg: "G1" }] }] }), /phase X: unknown field\(s\) leg/);
  assert.throws(() => B.normalizeBoard({ waves: [{ id: "W", phases: [{ id: "X", status: "nope" }] }] }), /phase X: unknown status/);
  assert.throws(() => B.normalizeBoard({ waves: [{ id: "W", phases: [{ id: "X", deps: ["Y"] }] }] }), /depends on missing "Y"/);
});
