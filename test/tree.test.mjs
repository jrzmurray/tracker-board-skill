import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "trackerboard", "scripts", "trackerboard.mjs");

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tree-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tree-cwd-"));
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, TRACKERBOARD_HOME: home } });
  return { home, run };
}

test("legacy todo status migrates to planned on load", () => {
  const { home, run } = sandbox();
  assert.equal(run(["create", "b", "--no-bind"]).status, 0);
  run(["insert", "--board", "b", "--phase", "P1", "--title", "x"]);
  const file = path.join(home, "boards", "b.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.waves[0].phases[0].status = "todo";
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.match(run(["show", "--board", "b"]).stdout, /P1 +planned/);
});

test("planning and planned are distinct statuses; todo and not-started alias planned", () => {
  const { run } = sandbox();
  run(["create", "b", "--no-bind"]);
  run(["insert", "--board", "b", "--phase", "P1", "--status", "planning"]);
  run(["insert", "--board", "b", "--phase", "P2", "--status", "not-started"]);
  const out = run(["show", "--board", "b"]).stdout;
  assert.match(out, /P1 +planning/);
  assert.match(out, /P2 +planned/);
});

test("tree rolls up leaf phases and excludes dropped from the total", () => {
  const { run } = sandbox();
  for (const b of ["repo", "sprint", "lane"]) run(["create", b, "--no-bind", ...(b === "sprint" ? ["--parent", "repo"] : b === "lane" ? ["--parent", "sprint"] : [])]);
  run(["insert", "--board", "lane", "--phase", "A", "--status", "done"]);
  run(["insert", "--board", "lane", "--phase", "B", "--status", "active"]);
  run(["insert", "--board", "lane", "--phase", "C", "--status", "dropped"]);
  const out = run(["tree", "--all"]).stdout;
  assert.match(out, /^repo +1\/2 done \(50%\)/m);
  assert.match(out, /^ {2}sprint +1\/2 done/m);
  assert.match(out, /^ {4}lane +1\/2 done/m);
});

test("parent must exist and may not create a cycle", () => {
  const { run } = sandbox();
  run(["create", "a", "--no-bind"]);
  run(["create", "b", "--no-bind", "--parent", "a"]);
  assert.match(run(["update", "--board", "a", "--parent", "b"]).stderr, /cycle/);
  assert.match(run(["update", "--board", "a", "--parent", "nope"]).stderr, /not found/);
  assert.match(run(["update", "--board", "a", "--parent", "a"]).stderr, /own parent/);
});

test("session is a phase field shown by show --phase", () => {
  const { run } = sandbox();
  run(["create", "b", "--no-bind"]);
  run(["insert", "--board", "b", "--phase", "P1", "--owner", "agent-1", "--session", "https://example.com/s/1"]);
  assert.match(run(["show", "--board", "b", "--phase", "P1"]).stdout, /session https:\/\/example.com\/s\/1/);
});

test("owner without --session records the calling agent session from the environment", () => {
  const { home, run: base } = sandbox();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tb-sess-"));
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", TRACKERBOARD_SESSION: "", TRACKERBOARD_SESSION_URL: "", TRACKERBOARD_HOME: home, ...env } });
  run(["create", "b", "--no-bind"]);
  run(["insert", "--board", "b", "--phase", "P1"]);
  const sessionOf = () => JSON.parse(run(["show", "--board", "b", "--json"]).stdout).waves[0].phases[0].session;
  run(["update", "--board", "b", "--phase", "P1", "--owner", "claude"]);
  assert.equal(sessionOf(), "", "no session in the environment: nothing recorded");
  run(["update", "--board", "b", "--phase", "P1", "--owner", "claude"], { CLAUDE_CODE_SESSION_ID: "abc-123" });
  assert.equal(sessionOf(), "claude:abc-123");
  run(["update", "--board", "b", "--phase", "P1", "--owner", "claude"], { CLAUDE_CODE_SESSION_ID: "abc-123", TRACKERBOARD_SESSION_URL: "https://example.com/s/{id}" });
  assert.equal(sessionOf(), "https://example.com/s/abc-123");
  run(["update", "--board", "b", "--phase", "P1", "--owner", "claude", "--session", "https://x.test/1"], { CLAUDE_CODE_SESSION_ID: "other" });
  assert.equal(sessionOf(), "https://x.test/1", "an explicit --session wins");
  run(["update", "--board", "b", "--phase", "P1", "--owner", "codex"], { CLAUDE_CODE_SESSION_ID: "abc-123" });
  assert.equal(sessionOf(), "", "assigning to another agent never records the caller's session, and drops a stale one");
  run(["update", "--board", "b", "--phase", "P1", "--owner", "claude"], { CLAUDE_CODE_SESSION_ID: "abc-123" });
  run(["update", "--board", "b", "--phase", "P1", "--owner", ""]);
  assert.equal(sessionOf(), "", "clearing the owner clears the session");
});

test("a middle board's own phases are milestones: only its children count", () => {
  const { run } = sandbox();
  run(["create", "top", "--no-bind"]);
  run(["create", "mid", "--no-bind", "--parent", "top"]);
  run(["create", "leaf", "--no-bind", "--parent", "mid"]);
  run(["insert", "--board", "mid", "--phase", "M1", "--status", "done"]);
  run(["insert", "--board", "leaf", "--phase", "L1", "--status", "done"]);
  run(["insert", "--board", "leaf", "--phase", "L2", "--status", "active"]);
  const out = run(["tree", "--all"]).stdout;
  assert.match(out, /^ {2}mid +1\/2 done/m);
  assert.match(out, /^top +1\/2 done/m);
});
