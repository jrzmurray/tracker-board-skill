#!/usr/bin/env node
// SessionStart hook: make the plugin's npm dependencies (elkjs, markdown-it,
// sql.js) available without the user running npm inside Claude Code's plugin
// cache, which is replaced on every plugin update.
//
// Dependencies are installed once into CLAUDE_PLUGIN_DATA, which survives
// updates, and <plugin root>/node_modules is (re)linked to them. A real
// node_modules directory (a git checkout, or `claude --plugin-dir .`) is left
// alone. Never fails the session: a problem prints one line to stderr.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.CLAUDE_PLUGIN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = process.env.CLAUDE_PLUGIN_DATA;
const npm = process.env.TRACKERBOARD_NPM || "npm";
const link = path.join(root, "node_modules");

function main() {
  let existing = null;
  try { existing = fs.lstatSync(link); } catch {}
  if (existing && !existing.isSymbolicLink()) return; // a real install is already there
  if (!data) return;

  fs.mkdirSync(data, { recursive: true });
  const wanted = ["package.json", "package-lock.json"].map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\0");
  const stamp = path.join(data, ".deps-stamp");
  let current = null;
  try { current = fs.readFileSync(stamp, "utf8"); } catch {}
  const installed = fs.existsSync(path.join(data, "node_modules"));
  if (current !== wanted || !installed) {
    for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(root, f), path.join(data, f));
    const result = spawnSync(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund", "--silent"], { cwd: data, stdio: ["ignore", "ignore", "inherit"] });
    if (result.error || result.status !== 0) throw new Error(`npm ci failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
    fs.writeFileSync(stamp, wanted);
  }
  const target = path.join(data, "node_modules");
  if (existing && fs.readlinkSync(link) === target) return;
  if (existing) fs.unlinkSync(link);
  fs.symlinkSync(target, link, "dir");
}

try { main(); }
catch (error) { console.error(`trackerboard: could not install dependencies (${error.message}); page and render need elkjs and markdown-it`); }
