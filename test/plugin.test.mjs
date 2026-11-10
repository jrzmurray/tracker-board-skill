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
  "migrate", "page", "pull", "push", "refresh", "refresh-prs", "remove", "render", "serve", "show", "synced",
  "unbind", "update",
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
