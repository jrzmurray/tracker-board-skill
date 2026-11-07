import { createHash } from "node:crypto";
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
    const env = { ...process.env, TRACKERBOARD_HOME: home, TRACKERBOARD_PUBLISHER: "1", ...extra };
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

test("backend --set-binding validates a saved alias before changing the active target", () => {
  const state = sandbox();
  const other = path.join(state.dir, "other-repo");
  fs.mkdirSync(other);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: other });
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: other });
  state.run(["create", "select-me"]);
  state.run(["bind", "--board", "select-me"], { cwd: other });
  const localPath = path.join(state.home, "boards", "select-me.local.json");
  const before = JSON.parse(fs.readFileSync(localPath, "utf8"));
  const selected = before.bindings.find((binding) => binding.root === other);
  assert.ok(selected);

  const refused = state.run(["backend", "--board", "select-me", "--set-binding", "missing"], { ok: false });
  assert.equal(refused.status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(localPath, "utf8")), before);
  assert.match(state.run(["backend", "--board", "select-me", "--set-binding", selected.key]).stdout, /now uses saved binding/);
  assert.equal(JSON.parse(fs.readFileSync(localPath, "utf8")).storageBindingKey, selected.key);
  assert.match(state.run(["show", "--board", "select-me"]).stdout, /^select-me:/);
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

// Parses the printed `publish_files` step into { slug, base_version, file_path }.
function publishState(out) {
  const call = JSON.parse(out.match(/publish: publish_files (\{.*\})/)[1]);
  assert.deepEqual(call.files.map((f) => f.as), ["state.json"]);
  return { slug: call.slug, base_version: call.base_version, file_path: call.files[0].path };
}

test("push prints a publish_files call pinned to the recorded version", () => {
  const { home, run } = sandbox();
  run(["create", "b"]);
  run(["insert", "--phase", "P1"]);
  run(["link", "--url", "https://claude.ai/artifact/abc123"]);
  // An unchecked board never prints a publish: it could replace someone's board.
  const unchecked = run(["push"]).stdout;
  assert.match(unchecked, /publish: not yet/);
  assert.doesNotMatch(unchecked, /publish_files \{/);
  run(["check", "--version", "v0", "--sha", "none"]);
  let out = run(["push"]).stdout;
  let call = publishState(out);
  assert.equal(call.base_version, "v0");
  assert.equal(call.slug, "abc123");
  assert.equal(JSON.parse(fs.readFileSync(call.file_path, "utf8")).waves[0].phases[0].id, "P1");
  assert.ok(call.file_path.startsWith(home));

  run(["synced", "--version", "v7"]);
  out = run(["update", "--phase", "P1", "--status", "done"]).stdout;
  call = publishState(out);
  assert.equal(call.base_version, "v7");
  assert.equal(JSON.parse(fs.readFileSync(call.file_path, "utf8")).waves[0].phases[0].status, "done");

  out = run(["insert", "--phase", "P2", "--deps", "P1"]).stdout;
  call = publishState(out);
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
  // The published page carries no board data: state.json is published beside it.
  const page = run(["page"]).stdout;
  const first = JSON.parse(page.match(/publish: publish_files (\{.*\})/)[1]);
  assert.deepEqual(first.files.map((f) => f.as), ["index.html", "state.json"]);
  const published = fs.readFileSync(first.files[0].path, "utf8");
  assert.match(published, /<script type="application\/json" id="tb-data">null<\/script>/);
  assert.doesNotMatch(published, /"phases"/);
  assert.equal(JSON.parse(fs.readFileSync(first.files[1].path, "utf8")).waves[0].phases[0].title, "</script>");
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
  const call = publishState;
  const publishRemote = (mutate) => {
    const file = path.join(home, "remote", "b", "state.json");
    const doc = JSON.parse(fs.readFileSync(path.join(home, "bases", "b.json"), "utf8"));
    mutate(doc);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc));
  };
  run(["create", "b"]);
  run(["insert", "--phase", "P1"]);
  run(["insert", "--phase", "P2", "--deps", "P1"]);
  run(["link", "--url", "https://claude.ai/artifact/abc123"]);
  run(["check", "--version", "v0", "--sha", "none"]);
  let c = call(run(["push"]).stdout);
  run(["synced", "--version", "v1", "--doc", c.file_path]);

  // Another agent publishes v2 (P1 done) while this one sets P2's owner.
  publishRemote((d) => { d.waves[0].phases[0].status = "done"; d.log.unshift({ at: "2030-01-01T00:00:00.000Z", text: "P1 merged" }); });
  run(["update", "--phase", "P2", "--owner", "me"]);
  const refreshOut = run(["refresh"]).stdout;
  assert.deepEqual(JSON.parse(refreshOut.match(/list_files (\{.*\})/)[1]), { slug: "abc123" });

  let out = run(["pull", "--version", "v2"]).stdout;
  assert.match(out, /pulled b artifact version v2 \(was v1\)/);
  assert.equal(call(out).base_version, "v2");
  assert.equal(fs.existsSync(path.join(home, "remote", "b", "state.json")), false);
  let show = run(["show"]).stdout;
  assert.match(show, /P1 +done/);
  assert.match(show, /P2 +todo .*@me/);
  assert.match(run(["pull", "--version", "v2"]).stdout, /current at artifact version v2/);
  // A moved version with no downloaded document says how to read it.
  const unread = run(["pull", "--version", "v9"], { ok: false });
  assert.match(unread.stderr, /read_file \{"slug":"abc123","paths":\["state.json"\]\}/);

  // Both sides change the same field: conflict until a side is chosen.
  run(["synced", "--version", "v3"]);
  publishRemote((d) => { d.waves[0].phases[1].owner = "other"; });
  run(["update", "--phase", "P2", "--owner", "mine"]);
  const r = run(["pull", "--version", "v4"], { ok: false });
  assert.match(r.stderr, /conflicts with unpublished changes here:\n  phase P2 owner/);
  run(["pull", "--version", "v4", "--theirs"]);
  assert.match(run(["show"]).stdout, /@other/);
});

test("check compares the published hash and reads nothing", () => {
  const { run } = sandbox();
  run(["create", "b"]);
  run(["insert", "--phase", "P1"]);
  run(["link", "--url", "https://claude.ai/artifact/abc123"]);
  run(["check", "--version", "v0", "--sha", "none"]);
  const c = publishState(run(["push"]).stdout);
  run(["synced", "--version", "v1", "--doc", c.file_path]);
  const sha = createHash("sha256").update(fs.readFileSync(c.file_path)).digest("hex");
  assert.match(run(["show"]).stdout, /last pushed 0m ago/);

  // Same hash, new version (e.g. a page republish): current, no pull.
  assert.match(run(["check", "--version", "v2", "--sha", sha]).stdout, /is current \(version v2\)/);
  // Another writer changed state.json: stop without reading it.
  const other = "f".repeat(64);
  const r = run(["check", "--version", "v3", "--sha", other]);
  assert.match(r.stdout, /diverged: .*Nothing was overwritten/);
  assert.match(r.stdout, /--overwrite/);
  // Accepting the overwrite pins the next push to the live version.
  const o = run(["check", "--version", "v3", "--sha", other, "--overwrite"]).stdout;
  assert.match(o, /will overwrite/);
  assert.equal(publishState(o).base_version, "v3");
  run(["check", "--version", "v3", "--sha", "nope"], { ok: false });
});

test("review regressions: first publish, overwrite then merge, no base, late edits, legacy page", () => {
  const { home, run } = sandbox();
  const remote = path.join(home, "remote", "b", "state.json");
  let cached = null;
  const putRemote = (mutate) => {
    try { cached = fs.readFileSync(path.join(home, "bases", "b.json"), "utf8"); } catch {}
    const doc = JSON.parse(cached);
    mutate(doc);
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    fs.writeFileSync(remote, JSON.stringify(doc));
  };
  run(["create", "b"]);
  run(["insert", "--phase", "P1"]);
  run(["link", "--url", "https://claude.ai/artifact/abc123"]);

  // 1. An artifact that already holds a state.json is never published over blind.
  const other = "a".repeat(64);
  assert.match(run(["check", "--version", "v1", "--sha", other]).stdout, /diverged:/);
  assert.doesNotMatch(run(["push"]).stdout, /publish_files \{/);

  // 4. A legacy artifact (no state.json): the page is republished with one.
  run(["check", "--version", "v1", "--sha", "none"]);
  const page = JSON.parse(run(["page"]).stdout.match(/publish: publish_files (\{.*\})/)[1]);
  assert.deepEqual(page.files.map((f) => f.as), ["index.html", "state.json"]);
  const c = publishState(run(["push"]).stdout);
  run(["synced", "--version", "v2", "--doc", c.file_path]);

  // 5. An edit made after the snapshot is not lost by synced.
  run(["update", "--phase", "P1", "--owner", "late"]);
  const snap = publishState(run(["push"]).stdout);
  run(["update", "--phase", "P1", "--owner", "later"]);
  assert.match(run(["synced", "--version", "v3", "--doc", snap.file_path]).stdout, /edits were made after that snapshot[^]*publish_files/);

  // 2. --overwrite, then a deliberate merge at the same version still merges.
  putRemote((d) => { d.waves[0].phases[0].status = "done"; });
  run(["check", "--version", "v4", "--sha", "b".repeat(64), "--overwrite"]);
  const pulled = run(["pull", "--version", "v4"]).stdout;
  assert.match(pulled, /pulled b artifact version v4/);
  assert.match(run(["show"]).stdout, /P1 +done/);

  // 3. No merge base: a differing board is never replaced silently.
  run(["link", "--url", "https://claude.ai/artifact/other"]);
  run(["update", "--phase", "P1", "--owner", "mine"]);
  putRemote((d) => { d.waves[0].phases[0].owner = "theirs"; });
  const nb = run(["pull", "--version", "v1"], { ok: false });
  assert.match(nb.stderr, /no merge base is recorded/);
  assert.match(run(["show"]).stdout, /@mine/);
  run(["pull", "--version", "v1", "--theirs"]);
  assert.match(run(["show"]).stdout, /@theirs/);
});

test("stale edits to a linked board apply; only Claude harnesses see publish steps", () => {
  const { run } = sandbox();
  run(["create", "b"]);
  run(["link", "--url", "https://claude.ai/artifact/abc123"]);
  run(["synced", "--version", "v1"]);
  const stale = { env: { TRACKERBOARD_FRESH_SECONDS: "-1" } };
  // A stale check no longer blocks an edit; the publish is the guarded step.
  const r = run(["insert", "--phase", "P1"], stale);
  assert.match(r.stdout, /publish: publish_files/);
  assert.match(r.stdout, /safe: .*refused, never overwritten/);
  assert.match(run(["show"], stale).stdout, /note: last checked against the artifact/);
  // Any other agent just edits: no refresh or publish steps, no complaint.
  const other = { env: { TRACKERBOARD_PUBLISHER: "0" } };
  const o = run(["insert", "--phase", "P2"], other).stdout;
  assert.match(o, /saved locally\. Nothing else to do/);
  assert.doesNotMatch(o, /publish_files|refresh|list_files/);
  assert.doesNotMatch(run(["show"], { env: { TRACKERBOARD_PUBLISHER: "0", TRACKERBOARD_FRESH_SECONDS: "-1" } }).stdout, /note: last checked/);
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

test("github overlays PRs and open issues without advancing phase status", () => {
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
  assert.match(run(["github", "--dry-run"], env).stdout, /R-1: pr #41, issue #40\ndry run/);
  assert.match(run(["show", "--phase", "R-1"]).stdout, /\[todo\]/);
  assert.match(run(["github"], env).stdout, /1 phase\(s\) linked from 1 PRs and 1 open issues in acme\/widgets/);
  assert.match(run(["show", "--phase", "R-1"]).stdout, /\[todo\][\s\S]*issue: #40[\s\S]*pr: #41/);
  assert.match(fs.readFileSync(path.join(dir, "gh.log"), "utf8"), /pr list --json .*closingIssuesReferences --repo acme\/widgets --state all/);
  assert.match(run(["github"], env).stdout, /no changes/);

  // --file overlays a generated file, so a regenerate + import does not undo the overlay.
  const file = path.join(dir, "gen.json");
  fs.writeFileSync(file, JSON.stringify({ repoUrl: "https://github.com/acme/widgets", waves: [{ id: "main", phases: [{ id: "R-1" }, { id: "R-2" }] }] }));
  assert.match(run(["github", "--file", file], env).stdout, /1 phase\(s\) in .*gen\.json updated/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).waves[0].phases[0].status, "todo");
  assert.match(run(["import", "b", "--from", file, "--replace"]).stdout, /already matches/);
});

test("migration verifies SQLite, detaches Claude publishing, and exports active data back to JSON", () => {
  const state = sandbox();
  const backendHome = path.join(state.dir, "backend-data");
  const env = { env: { TRACKERBOARD_DATA_HOME: backendHome } };
  state.run(["create", "migrate-me"]);
  const initialBoardId = JSON.parse(fs.readFileSync(path.join(state.home, "boards", "migrate-me.local.json"), "utf8")).boardId;
  state.run(["insert", "--phase", "P1", "--title", "before migration"]);
  state.run(["link", "--url", "https://claude.ai/artifact/abc123"]);
  state.run(["synced", "--version", "v1"]);

  fs.mkdirSync(backendHome, { recursive: true });
  fs.writeFileSync(path.join(backendHome, "config.json"), JSON.stringify({ backend: "github" }));
  assert.equal(JSON.parse(state.run(["backend", "--json"], env).stdout).backend, "json");

  assert.match(state.run(["migrate", "--to", "sqlite", "--dry-run"], env).stdout, /dry run: migrate-me \(1 phases, .*\) json@[^ ]+ → sqlite@[^;]+/);
  assert.equal(fs.existsSync(path.join(backendHome, "repos")), false);

  const moved = state.run(["migrate", "--to", "sqlite"], env);
  assert.match(moved.stdout, /read-back verified/);
  assert.match(state.run(["migrate", "--to", "sqlite"], env).stdout, /already uses sqlite/);
  const recovery = moved.stdout.match(/recovery: (.+)/)[1];
  assert.equal(path.dirname(recovery), path.join(state.home, "recovery"));
  assert.equal(fs.statSync(recovery).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(recovery, "utf8")).waves[0].phases[0].title, "before migration");
  assert.equal(JSON.parse(state.run(["backend", "--json"], env).stdout).backend, "sqlite");
  assert.equal(JSON.parse(fs.readFileSync(path.join(state.home, "boards", "migrate-me.local.json"), "utf8")).boardId, initialBoardId);
  assert.match(state.run(["show"], env).stdout, /P1 +todo +before migration/);

  state.run(["update", "--phase", "P1", "--title", "edited in SQLite"], env);
  const detached = state.run(["refresh"], { ...env, ok: false });
  assert.equal(detached.status, 1);
  assert.match(detached.stderr, /artifact was detached.*unavailable/);

  const exported = state.run(["migrate", "--to", "json"], env);
  assert.match(exported.stdout, /read-back verified/);
  assert.equal(JSON.parse(state.run(["backend", "--json"], env).stdout).backend, "json");
  assert.equal(JSON.parse(fs.readFileSync(path.join(state.home, "boards", "migrate-me.local.json"), "utf8")).boardId, initialBoardId);
  assert.match(state.run(["show"], env).stdout, /P1 +todo +edited in SQLite/);
  assert.match(state.run(["migrate", "--to", "json"], env).stdout, /already uses json/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state.home, "boards", "migrate-me.json"), "utf8")).waves[0].phases[0].title, "edited in SQLite");
});

test("unbound GitHub flows require repository identity before migration or bootstrap", () => {
  const state = sandbox();
  const backendHome = path.join(state.dir, "backend-data");
  const gh = path.join(state.dir, "gh");
  const ghLog = path.join(state.dir, "gh.log");
  const env = { env: { TRACKERBOARD_DATA_HOME: backendHome } };
  state.run(["create", "unbound-github", "--no-bind", "--repo-url", "https://github.com/acme/widgets"], env);
  state.run(["create", "unbound-github-no-repo", "--no-bind"], env);
  fs.mkdirSync(backendHome, { recursive: true });
  fs.writeFileSync(gh, `#!/bin/sh
printf '%s\\n' "$*" >> "${ghLog}"
case "$1:$2" in
  --version:) echo 'gh version v2.96.0' ;;
  auth:status) echo '{"hosts":{"github.com":[{"active":true,"scopes":["project"]}]}}' ;;
  project:list) echo '{"projects":[]}' ;;
  project:view) echo 'stopped at fake project view' >&2; exit 1 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(backendHome, "config.json"), JSON.stringify({
    backend: "github",
    github: { owner: "acme", executable: gh },
  }));

  const refused = state.run(["migrate", "--board", "unbound-github", "--to", "github"], { ...env, ok: false });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /saved repository identity and configured\/saved Project/);
  assert.equal(fs.existsSync(ghLog), false);
  assert.equal(JSON.parse(state.run(["backend", "--board", "unbound-github", "--json"], env).stdout).backend, "json");
  assert.match(state.run(["show", "--board", "unbound-github"], env).stdout, /^unbound-github:/);

  fs.writeFileSync(path.join(backendHome, "config.json"), JSON.stringify({
    backend: "github",
    github: { owner: "acme", projectNumber: 12, executable: gh },
  }));
  const refusedWithoutIdentity = state.run(["migrate", "--board", "unbound-github-no-repo", "--to", "github"], { ...env, ok: false });
  assert.equal(refusedWithoutIdentity.status, 1);
  assert.match(refusedWithoutIdentity.stderr, /saved repository identity and configured\/saved Project/);
  assert.equal(fs.existsSync(ghLog), false);
  assert.equal(JSON.parse(state.run(["backend", "--board", "unbound-github-no-repo", "--json"], env).stdout).backend, "json");

  const createRefused = state.run(["create", "unbound-github-create-no-repo", "--no-bind"], { ...env, ok: false });
  assert.equal(createRefused.status, 1);
  assert.match(createRefused.stderr, /needs a saved repository identity/);
  assert.equal(fs.existsSync(ghLog), false);
  assert.equal(fs.existsSync(path.join(state.home, "boards", "unbound-github-create-no-repo.local.json")), false);

  const createWithIdentity = state.run([
    "create", "unbound-github-create-with-repo", "--no-bind", "--repo-url", "https://github.com/acme/roadmap",
  ], { ...env, ok: false });
  assert.equal(createWithIdentity.status, 1);
  assert.doesNotMatch(createWithIdentity.stderr, /needs a saved repository identity/);
  assert.match(fs.readFileSync(ghLog, "utf8"), /api graphql/);
});

test("migration selects its destination binding without switching sources before verification", () => {
  const state = sandbox();
  const secondRepo = path.join(state.dir, "repo-second");
  fs.mkdirSync(secondRepo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: secondRepo });
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: secondRepo });
  const backendHome = path.join(state.dir, "backend-data");
  const env = { env: { TRACKERBOARD_DATA_HOME: backendHome } };
  state.run(["create", "destination-test"], env);
  state.run(["insert", "--phase", "P1", "--title", "source JSON"], env);
  const sourceLocalPath = path.join(state.home, "boards", "destination-test.local.json");
  const boardId = JSON.parse(fs.readFileSync(sourceLocalPath, "utf8")).boardId;
  state.run(["bind", "--board", "destination-test"], { ...env, cwd: secondRepo });
  const localWithBothBindings = JSON.parse(fs.readFileSync(sourceLocalPath, "utf8"));
  const destinationBinding = localWithBothBindings.bindings.find((binding) => binding.root === secondRepo);
  assert.ok(destinationBinding);
  fs.mkdirSync(path.join(backendHome, "repos"), { recursive: true });
  fs.writeFileSync(path.join(backendHome, "repos", `${destinationBinding.key}.json`), JSON.stringify({ backend: "sqlite", sqlite: { path: "destination.sqlite" } }));

  const dryRun = state.run(["migrate", "--to", "sqlite", "--binding", destinationBinding.key, "--dry-run"], env).stdout;
  assert.match(dryRun, new RegExp("json@[^ ]+ → sqlite@" + destinationBinding.key));
  assert.equal(fs.existsSync(path.join(backendHome, "destination.sqlite")), false);

  const migrated = state.run(["migrate", "--to", "sqlite", "--binding", destinationBinding.key], env);
  assert.match(migrated.stdout, /read-back verified/);
  const migratedLocal = JSON.parse(fs.readFileSync(sourceLocalPath, "utf8"));
  assert.equal(migratedLocal.storageBindingKey, destinationBinding.key);
  assert.equal(migratedLocal.boardId, boardId);
  assert.equal(JSON.parse(state.run(["backend", "--json"], env).stdout).bindingKey, destinationBinding.key);
  assert.match(state.run(["show", "--board", "destination-test"], env).stdout, /source JSON/);

  state.run(["create", "conflict-test", "--title", "source remains active"], env);
  state.run(["insert", "--board", "conflict-test", "--phase", "P1", "--title", "source phase"], env);
  state.run(["bind", "--board", "conflict-test"], { ...env, cwd: secondRepo });
  const conflictLocalPath = path.join(state.home, "boards", "conflict-test.local.json");
  const conflictBinding = JSON.parse(fs.readFileSync(conflictLocalPath, "utf8")).bindings.find((binding) => binding.root === secondRepo);
  const alternateHome = path.join(state.dir, "alternate-home");
  state.run(["create", "conflict-test", "--title", "preserve destination"], {
    env: { TRACKERBOARD_HOME: alternateHome, TRACKERBOARD_DATA_HOME: backendHome },
    cwd: secondRepo,
  });
  const refused = state.run(["migrate", "--board", "conflict-test", "--to", "sqlite", "--binding", conflictBinding.key], { ...env, ok: false });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already contains a different board/);
  assert.equal(JSON.parse(state.run(["backend", "--board", "conflict-test", "--json"], env).stdout).backend, "json");
  assert.match(state.run(["show", "--board", "conflict-test"], env).stdout, /source phase/);
  assert.match(state.run(["show", "--board", "conflict-test"], {
    env: { TRACKERBOARD_HOME: alternateHome, TRACKERBOARD_DATA_HOME: backendHome },
    cwd: secondRepo,
  }).stdout, /conflict-test: preserve destination/);
});
