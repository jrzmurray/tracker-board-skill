import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "trackerboard", "scripts", "trackerboard.mjs");

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-")));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const run = (args, { cwd = repo, ok = true, env: extra = {} } = {}) => {
    const env = { ...process.env, TRACKERBOARD_HOME: home, ...extra };
    delete env.TRACKERBOARD_BOARD;
    const r = spawnSync("node", [CLI, ...args], { cwd, env, encoding: "utf8" });
    if (ok && r.status !== 0) throw new Error(`${args.join(" ")} failed: ${r.stderr}`);
    return r;
  };
  return { dir, home, repo, git, run };
}

test("board resolves from the cwd, worktrees included, and throws when ambiguous", () => {
  const { dir, repo, git, run } = sandbox();
  run(["create", "alpha"]);
  run(["insert", "--phase", "P1", "--title", "first"]);
  fs.mkdirSync(path.join(repo, "sub"));
  assert.match(run(["show"], { cwd: path.join(repo, "sub") }).stdout, /P1 +todo +first/);

  git("worktree", "add", "-q", path.join(dir, "wt"), "-b", "feature");
  assert.match(run(["show"], { cwd: path.join(dir, "wt") }).stdout, /^alpha:/);

  run(["create", "beta"]);
  const r = run(["show"], { ok: false });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /2 boards resolve.*alpha, beta/);
  assert.match(run(["show", "--board", "beta"]).stdout, /^beta:/);
});

test("a branch binding is more specific than a repo binding", () => {
  const { dir, git, run } = sandbox();
  run(["create", "repo-wide"]);
  git("worktree", "add", "-q", path.join(dir, "wt"), "-b", "feature");
  run(["create", "feature-only", "--branch"], { cwd: path.join(dir, "wt") });
  assert.match(run(["show"], { cwd: path.join(dir, "wt") }).stdout, /^feature-only:/);
  assert.match(run(["show"]).stdout, /^repo-wide:/);
});

test("unbound directory errors with guidance", () => {
  const { dir, run } = sandbox();
  run(["create", "x", "--no-bind"]);
  const r = run(["show"], { cwd: dir, ok: false });
  assert.match(r.stderr, /no board is bound/);
});

test("delete accepts a positional phase; update rejects unknown flags", () => {
  const { run } = sandbox();
  run(["create", "b"]);
  run(["insert", "--wave", "A", "--title", "Wave A"]);
  run(["insert", "--wave", "A", "--phase", "A1"]);
  run(["insert", "--wave", "A", "--phase", "A2", "--deps", "A1"]);
  assert.match(run(["delete", "--wave", "A", "A1"]).stdout, /removed deps A2 -> A1/);
  const r = run(["update", "--phase", "A2", "--colour", "red"], { ok: false });
  assert.match(r.stderr, /unexpected option\(s\): --colour/);
});

test("push prints an ArtifactData call pinned to the recorded version", () => {
  const { home, run } = sandbox();
  run(["create", "b"]);
  run(["insert", "--phase", "P1"]);
  run(["link", "--url", "https://claude.ai/artifact/abc123"]);
  let out = run(["push"]).stdout;
  let call = JSON.parse(out.match(/ArtifactData (\{.*\})/)[1]);
  assert.equal(call.if_version, undefined);
  assert.equal(call.collection, "board");
  assert.equal(call.doc_id, "state");
  assert.equal(JSON.parse(fs.readFileSync(call.file_path, "utf8")).waves[0].phases[0].id, "P1");
  assert.ok(call.file_path.startsWith(home));

  run(["synced", "--version", "7"]);
  out = run(["update", "--phase", "P1", "--status", "done"]).stdout;
  call = JSON.parse(out.match(/ArtifactData (\{.*\})/)[1]);
  assert.equal(call.if_version, 7);
  assert.equal(JSON.parse(fs.readFileSync(call.file_path, "utf8")).waves[0].phases[0].status, "done");

  out = run(["insert", "--phase", "P2", "--deps", "P1"]).stdout;
  call = JSON.parse(out.match(/ArtifactData (\{.*\})/)[1]);
  const doc = JSON.parse(fs.readFileSync(call.file_path, "utf8"));
  assert.equal(doc.layout.engine, "elk-layered");
  assert.deepEqual(doc.layout.edges.map((e) => [e.from, e.to]), [["P1", "P2"]]);
});

test("page and render embed the board safely", () => {
  const { home, run } = sandbox();
  run(["create", "b", "--title", "</script><b>x"]);
  run(["insert", "--phase", "P1", "--title", "</script>"]);
  run(["render"]);
  const html = fs.readFileSync(path.join(home, "out", "b.html"), "utf8");
  assert.match(html, /<title>&lt;\/script&gt;&lt;b&gt;x<\/title>/);
  const data = html.match(/<script type="application\/json" id="tb-data">(.*?)<\/script>/s)[1];
  assert.equal(JSON.parse(data).waves[0].phases[0].title, "</script>");
  assert.match(run(["page"]).stdout, /"capabilities":\{"db"/);
});

test("field values can come from a file", () => {
  const { dir, run } = sandbox();
  const f = path.join(dir, "req.md");
  fs.writeFileSync(f, "line one\n\n- a\n- b\n");
  run(["create", "b"]);
  run(["insert", "--phase", "P1", "--req", `@${f}`]);
  assert.match(run(["show", "--phase", "P1"]).stdout, /req: line one\n\n- a\n- b/);
});

test("import creates a board from JSON and refuses to overwrite", () => {
  const { dir, run } = sandbox();
  run(["create", "src", "--no-bind"]);
  run(["insert", "--board", "src", "--phase", "P1", "--deps", ""]);
  run(["insert", "--board", "src", "--phase", "P2", "--deps", "P1"]);
  const file = path.join(dir, "b.json");
  fs.writeFileSync(file, run(["show", "--board", "src", "--json"]).stdout);
  assert.match(run(["import", "copy", "--from", file]).stdout, /imported copy \(2 phases\)/);
  assert.match(run(["show"]).stdout, /P2 +todo +← P1/);
  assert.match(run(["import", "copy", "--from", file], { ok: false }).stderr, /already exists/);
});

test("owner is a phase field: set, shown, cleared", () => {
  const { run } = sandbox();
  run(["create", "b"]);
  run(["insert", "--phase", "P1", "--title", "first", "--owner", "builder-3"]);
  assert.match(run(["show"]).stdout, /P1 +todo +first +@builder-3/);
  assert.match(run(["show", "--phase", "P1"]).stdout, /owner builder-3/);
  run(["update", "--phase", "P1", "--owner", ""]);
  assert.doesNotMatch(run(["show"]).stdout, /@builder-3/);
});

test("refresh/pull merges a concurrent publish with unpublished local changes", () => {
  const { home, run } = sandbox();
  const call = (out) => JSON.parse(out.match(/ArtifactData (\{.*\})/)[1]);
  const publishRemote = (mutate) => {
    const file = path.join(home, "remote", "b", "board", "state.json");
    const doc = JSON.parse(fs.readFileSync(path.join(home, "boards", "b.base.json"), "utf8"));
    mutate(doc);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc));
  };
  run(["create", "b"]);
  run(["insert", "--phase", "P1"]);
  run(["insert", "--phase", "P2", "--deps", "P1"]);
  run(["link", "--url", "https://claude.ai/artifact/abc123"]);
  let c = call(run(["push"]).stdout);
  run(["synced", "--version", "1", "--doc", c.file_path]);

  // Another agent publishes v2 (P1 done) while this one sets P2's owner.
  publishRemote((d) => { d.waves[0].phases[0].status = "done"; d.log.unshift({ at: "2030-01-01T00:00:00.000Z", text: "P1 merged" }); });
  run(["update", "--phase", "P2", "--owner", "me"]);
  c = call(run(["refresh"]).stdout);
  assert.equal(c.action, "get");
  assert.equal(c.out_dir, path.join(home, "remote", "b"));

  let out = run(["pull", "--version", "2"]).stdout;
  assert.match(out, /pulled b db version 2 \(was 1\)/);
  assert.equal(call(out).if_version, 2);
  let show = run(["show"]).stdout;
  assert.match(show, /P1 +done/);
  assert.match(show, /P2 +todo .*@me/);
  assert.match(run(["pull", "--version", "2"]).stdout, /current at db version 2/);

  // Both sides change the same field: conflict until a side is chosen.
  run(["synced", "--version", "3"]);
  publishRemote((d) => { d.waves[0].phases[1].owner = "other"; });
  run(["update", "--phase", "P2", "--owner", "mine"]);
  const r = run(["pull", "--version", "4"], { ok: false });
  assert.match(r.stderr, /conflicts with unpublished changes here:\n  phase P2 owner/);
  run(["pull", "--version", "4", "--theirs"]);
  assert.match(run(["show"]).stdout, /@other/);
});

test("writes to a linked board need a recent refresh", () => {
  const { run } = sandbox();
  run(["create", "b"]);
  run(["link", "--url", "https://claude.ai/artifact/abc123"]);
  run(["synced", "--version", "1"]);
  const stale = { env: { TRACKERBOARD_FRESH_SECONDS: "-1" } };
  const r = run(["insert", "--phase", "P1"], { ...stale, ok: false });
  assert.match(r.stderr, /last checked against its artifact .*\nrefresh: ArtifactData \{"action":"get"/);
  assert.match(run(["show"], stale).stdout, /note: last checked against the artifact/);
  run(["insert", "--phase", "P1"]);
});
