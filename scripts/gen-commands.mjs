#!/usr/bin/env node
// Renders commands/<action>.md from scripts/commands.json so the slash
// commands cannot drift. `node scripts/gen-commands.mjs` writes them;
// `--check` exits 1 when a committed file differs from the table.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "skills/trackerboard/scripts/trackerboard.mjs";
// Only this script is pre-approved, never arbitrary `node`. The trackerboard
// binary on PATH is the same CLI.
export const ALLOWED_TOOLS = `Bash(node "*/${SCRIPT}" *), Bash(trackerboard *)`;

const yamlString = (s) => (s.includes('"') ? `'${s.replaceAll("'", "''")}'` : JSON.stringify(s));

export function table() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "commands.json"), "utf8"));
}

export function render({ action, description, hint, note, userOnly }) {
  return [
    "---",
    `description: ${description}`,
    `argument-hint: ${yamlString(hint)}`,
    `allowed-tools: ${ALLOWED_TOOLS}`,
    ...(userOnly ? ["disable-model-invocation: true"] : []),
    "---",
    "",
    `Run the trackerboard \`${action}\` action with Bash and follow its output:`,
    "",
    "```",
    `node "\${CLAUDE_PLUGIN_ROOT}/${SCRIPT}" ${action} $ARGUMENTS`,
    "```",
    "",
    `If \`trackerboard\` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.${note ? ` ${note}` : ""}`,
    "",
  ].join("\n");
}

export function expected() {
  return new Map(table().map((entry) => [`${entry.action}.md`, render(entry)]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.join(ROOT, "commands");
  const want = expected();
  if (process.argv.includes("--check")) {
    const have = new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".md")));
    const stale = [...want].filter(([f, text]) => !have.has(f) || fs.readFileSync(path.join(dir, f), "utf8") !== text).map(([f]) => f);
    const extra = [...have].filter((f) => !want.has(f));
    if (stale.length || extra.length) {
      console.error(`commands/ is out of date with scripts/commands.json: ${[...stale, ...extra].join(", ")}. Run node scripts/gen-commands.mjs`);
      process.exit(1);
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, text] of want) fs.writeFileSync(path.join(dir, f), text);
  }
}
