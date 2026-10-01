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
  // markdown-it is inlined, once, and cannot close its own script element
  const md = html.match(/<script id="tb-md">(.*?)<\/script>/s)[1];
  assert.match(md, /markdownit/);
  assert.doesNotMatch(md, /<\/script|sourceMappingURL/i);
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
  run(["update", "--phase", "P1", "--issue", "#77"]);
  assert.match(run(["show", "--phase", "P1"]).stdout, /issue: #77/);
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

test("show filters by lane, status and owner, and lists ids or PRs", () => {
  const { run } = sandbox();
  run(["create", "b"]);
  run(["insert", "--phase", "P1", "--lane", "A", "--status", "done", "--pr", "#11"]);
  run(["insert", "--phase", "P2", "--lane", "A", "--pr", "—"]);
  run(["insert", "--phase", "P3", "--lane", "B", "--status", "blocked", "--owner", "x", "--pr", "#13"]);
  run(["insert", "--phase", "P4"]);
  const all = run(["show"]).stdout;
  assert.match(all, /lane A  1\/2 done\n    P1 /);
  assert.match(all, /lane B  0\/1 done\n    P3 /);
  assert.match(all, /no lane  0\/1 done\n    P4 /);
  assert.equal(run(["show", "--lane", "a", "--ids"]).stdout, "P1\nP2\n");
  assert.equal(run(["show", "--lane", "", "--ids"]).stdout, "P4\n");
  assert.equal(run(["show", "--status", "todo,blocked", "--ids"]).stdout, "P2\nP3\nP4\n");
  assert.equal(run(["show", "--owner", "x", "--ids"]).stdout, "P3\n");
  assert.match(run(["show", "--pr-list"]).stdout, /^P1  done +#11\nP3  blocked +#13\n$/);
  const lane = run(["show", "--lane", "B"]).stdout;
  assert.doesNotMatch(lane, /P1|P4/);
  assert.deepEqual(JSON.parse(run(["show", "--lane", "B", "--json"]).stdout).map((p) => [p.id, p.wave]), [["P3", "main"]]);
  assert.match(run(["show", "--lane", "Z"], { ok: false }).stderr, /no lane "Z"; lanes: A, B, ""/);
});

test("import --replace updates a board from regenerated JSON and logs the changes", () => {
  const { dir, run } = sandbox();
  const file = path.join(dir, "gen.json");
  const gen = (phases) => fs.writeFileSync(file, JSON.stringify({ title: "Gen", waves: [{ id: "G1", title: "Leg one", phases }] }));
  gen([{ id: "R-1", status: "planned" }, { id: "R-2", deps: ["R-1"] }]);
  run(["import", "gen", "--from", file]);
  run(["update", "--phase", "R-1", "--owner", "agent-7"]);
  gen([{ id: "R-1", status: "done", owner: "" }, { id: "R-3", status: "in_progress" }]);
  const r = run(["import", "--from", file, "--replace", "--keep", "owner"]);
  assert.match(r.stdout, /replaced gen .*\(1 changed, 1 added, 1 removed\)/);
  const show = run(["show"]).stdout;
  assert.match(show, /R-1 +done .*@agent-7/);
  assert.match(show, /R-3 +active/);
  assert.doesNotMatch(show, /R-2 /);
  assert.match(JSON.parse(run(["show", "--json"]).stdout).log[0].text, /import: 1 status change\(s\): R-1 todo → done; 1 added: R-3; 1 removed: R-2/);
  assert.match(run(["import", "--from", file, "--replace", "--keep", "owner"]).stdout, /already matches/);
  assert.match(run(["import", "gen", "--from", file], { ok: false }).stderr, /already exists; pass --replace/);
  assert.match(run(["import", "--from", file], { ok: false }).stderr, /import needs a board name/);
  fs.writeFileSync(file, JSON.stringify({ waves: [{ id: "G1", phases: [{ id: "R-1", leg: "x" }] }] }));
  assert.match(run(["import", "--from", file, "--replace"], { ok: false }).stderr, /phase R-1: unknown field\(s\) leg/);
});

test("github overlays open PRs and issues from gh", () => {
  const { dir, run } = sandbox();
  const gh = path.join(dir, "gh");
  fs.writeFileSync(gh, `#!/bin/sh
echo "$@" >> "${dir}/gh.log"
case "$1" in
  pr) echo '[{"number":41,"title":"feat: x (R-1)","headRefName":"b","labels":[],"isDraft":false,"closingIssuesReferences":[{"number":40}]}]' ;;
  issue) echo '[{"number":40,"title":"R-1 tracking","labels":[]}]' ;;
esac
`, { mode: 0o755 });
  const env = { env: { TRACKERBOARD_GH: gh } };
  run(["create", "b", "--repo-url", "https://github.com/acme/widgets"]);
  run(["insert", "--phase", "R-1"]);
  run(["insert", "--phase", "R-2"]);
  assert.match(run(["github", "--dry-run"], env).stdout, /R-1: todo → review, pr #41, issue #40\ndry run/);
  assert.match(run(["show", "--phase", "R-1"]).stdout, /\[todo\]/);
  assert.match(run(["github"], env).stdout, /1 phase\(s\) updated from 1 open PRs and 1 open issues in acme\/widgets/);
  assert.match(run(["show", "--phase", "R-1"]).stdout, /\[review\][\s\S]*issue: #40[\s\S]*pr: #41/);
  assert.match(fs.readFileSync(path.join(dir, "gh.log"), "utf8"), /pr list --json .*closingIssuesReferences --repo acme\/widgets --state open/);
  assert.match(run(["github"], env).stdout, /no changes/);

  // --file overlays a generated file, so a regenerate + import does not undo the overlay.
  const file = path.join(dir, "gen.json");
  fs.writeFileSync(file, JSON.stringify({ repoUrl: "https://github.com/acme/widgets", waves: [{ id: "main", phases: [{ id: "R-1" }, { id: "R-2" }] }] }));
  assert.match(run(["github", "--file", file], env).stdout, /1 phase\(s\) in .*gen\.json updated/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).waves[0].phases[0].status, "review");
  assert.match(run(["import", "b", "--from", file, "--replace"]).stdout, /already matches/);
});
