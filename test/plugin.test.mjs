import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "skills", "trackerboard", "scripts", "trackerboard.mjs");
const COMMANDS = path.join(ROOT, "commands");

// One /trackerboard:<action> command per CLI action. Adding a CLI action
// means adding its command file here with its own argument-hint.
const ACTIONS = [
  "backend", "bind", "boards", "check", "create", "delete", "dep", "github", "import", "insert", "link", "log",
  "migrate", "page", "pull", "push", "refresh", "refresh-prs", "remove", "render", "sdoc", "serve", "show", "synced",
  "tree", "unbind", "update",
];

test("the plugin manifest names the plugin trackerboard", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.name, "trackerboard");
  const market = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.deepEqual(market.plugins.map((p) => p.name), ["trackerboard"]);
});

test("every CLI action has a command file with its own hint and description", () => {
  const files = fs.readdirSync(COMMANDS).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(files, ACTIONS);
  const help = execFileSync("node", [CLI, "help"], { encoding: "utf8" });
  const descriptions = new Set();
  for (const action of ACTIONS) {
    const text = fs.readFileSync(path.join(COMMANDS, `${action}.md`), "utf8");
    const front = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(front, `${action}: frontmatter`);
    const description = front[1].match(/^description: (\S.*)$/m);
    assert.ok(description, `${action}: description`);
    descriptions.add(description[1]);
    const hint = front[1].match(/^argument-hint: (.+)$/m);
    assert.ok(hint, `${action}: argument-hint`);
    // The command runs exactly its own action, with the typed arguments.
    assert.ok(text.includes(`trackerboard.mjs" ${action} $ARGUMENTS`), `${action}: runs its action`);
    assert.match(help, new RegExp(`^\\s+${action.replace("-", "\\-")}\\b`, "m"), `${action}: in CLI help`);
  }
  assert.equal(descriptions.size, ACTIONS.length, "every action has its own description");
});

import { spawnSync } from "node:child_process";
import os from "node:os";
import { ALLOWED_TOOLS, expected, table } from "../scripts/gen-commands.mjs";

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

test("commands/ is exactly what scripts/gen-commands.mjs renders from scripts/commands.json", () => {
  for (const [file, text] of expected()) assert.equal(read("commands", file), text, `${file} is stale; run node scripts/gen-commands.mjs`);
  assert.deepEqual(table().map((e) => e.action).sort(), [...ACTIONS].sort());
});

test("commands pre-approve only the trackerboard script and never arbitrary node", () => {
  for (const action of ACTIONS) {
    const front = read("commands", `${action}.md`).match(/^---\n([\s\S]*?)\n---\n/)[1];
    assert.equal(front.match(/^allowed-tools: (.+)$/m)[1], ALLOWED_TOOLS, action);
  }
  assert.doesNotMatch(ALLOWED_TOOLS, /node:\*|Bash\(node \*\)/);
  // The pattern the commands approve must cover the exact line they run.
  const body = read("commands", "show.md").match(/^node ".*$/m)[0].replace("${CLAUDE_PLUGIN_ROOT}", "/some/plugin/root").replace(" $ARGUMENTS", " --json");
  assert.match(body, /^node "\/some\/plugin\/root\/skills\/trackerboard\/scripts\/trackerboard\.mjs" show --json$/);
  assert.ok(fs.existsSync(path.join(ROOT, "skills", "trackerboard", "scripts", "trackerboard.mjs")), "the script the commands run exists");
});

test("destructive commands cannot be invoked by the model", () => {
  const userOnly = ACTIONS.filter((a) => /^disable-model-invocation: true$/m.test(read("commands", `${a}.md`)));
  assert.deepEqual(userOnly, ["delete", "migrate", "pull", "remove"]);
});

test("the SessionStart hook points at a script that exists", () => {
  const hooks = JSON.parse(read("hooks", "hooks.json"));
  const command = hooks.hooks.SessionStart[0].hooks[0].command;
  const script = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/)[1];
  assert.ok(fs.existsSync(path.join(ROOT, script)), script);
});

function depsFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-deps-"));
  const root = path.join(dir, "root");
  const data = path.join(dir, "data");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"x"}');
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  const calls = path.join(dir, "calls");
  const npm = path.join(dir, "fake-npm");
  fs.writeFileSync(npm, `#!/bin/sh\necho "$@" >> "${calls}"\nif [ -n "$FAIL" ]; then exit 1; fi\nmkdir -p node_modules/elkjs\n`, { mode: 0o755 });
  const run = (extra = {}) => spawnSync("node", [path.join(ROOT, "scripts", "ensure-deps.mjs")], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, TRACKERBOARD_NPM: npm, ...extra },
  });
  return { root, data, calls, run, installs: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").length : 0) };
}

test("ensure-deps installs once into the data dir, links node_modules, and survives a plugin update", () => {
  const f = depsFixture();
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.readlinkSync(path.join(f.root, "node_modules")), path.join(f.data, "node_modules"));
  assert.ok(fs.existsSync(path.join(f.root, "node_modules", "elkjs")));
  assert.equal(f.installs(), 1);
  assert.equal(f.run().status, 0);
  assert.equal(f.installs(), 1, "unchanged dependencies are not reinstalled");
  // A plugin update replaces the root directory (link gone) but keeps the data dir.
  fs.rmSync(path.join(f.root, "node_modules"));
  f.run();
  assert.equal(f.installs(), 1, "relinks without reinstalling");
  assert.ok(fs.existsSync(path.join(f.root, "node_modules", "elkjs")));
  // New dependencies reinstall.
  fs.writeFileSync(path.join(f.root, "package-lock.json"), '{"changed":true}');
  f.run();
  assert.equal(f.installs(), 2);
});

test("ensure-deps leaves a real node_modules alone and never fails the session", () => {
  const real = depsFixture();
  fs.mkdirSync(path.join(real.root, "node_modules", "mine"), { recursive: true });
  assert.equal(real.run().status, 0);
  assert.equal(real.installs(), 0);
  assert.ok(fs.existsSync(path.join(real.root, "node_modules", "mine")));
  const broken = depsFixture();
  const r = broken.run({ FAIL: "1" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /could not install dependencies/);
  assert.ok(!fs.existsSync(path.join(broken.root, "node_modules")));
});

test("install.sh refuses Node older than 24 before touching anything", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "tb-node-"));
  fs.writeFileSync(path.join(bin, "node"), '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v20.1.0; exit 0; fi\nexit 1\n', { mode: 0o755 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-home-"));
  const r = spawnSync("bash", [path.join(ROOT, "install.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, TRACKERBOARD_BIN_DIR: path.join(home, "bin") },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /needs Node 24 or newer \(found v20\.1\.0\)/);
  assert.ok(!fs.existsSync(path.join(home, "bin")), "nothing installed");
});
