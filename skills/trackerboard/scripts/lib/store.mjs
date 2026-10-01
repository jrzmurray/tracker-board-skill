// Board storage and CWD -> board resolution.
//
// Layout under $TRACKERBOARD_HOME (default ~/.trackerboard):
//   boards/<name>.json        board data (the source of truth)
//   boards/<name>.local.json  machine-local state: bindings, artifact url, db version
//   out/<name>.doc.json       the db document body, written by `push`
//   out/<name>.html           static render, written by `render`

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoardError, newBoard, validate } from "./board.mjs";

export function home() {
  return process.env.TRACKERBOARD_HOME || path.join(os.homedir(), ".trackerboard");
}

const boardsDir = () => path.join(home(), "boards");
export const outDir = () => path.join(home(), "out");
const boardPath = (name) => path.join(boardsDir(), `${name}.json`);
const localPath = (name) => path.join(boardsDir(), `${name}.local.json`);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export function checkName(name) {
  if (!name || !NAME_RE.test(name)) throw new BoardError(`invalid board name "${name}" (letters, digits, . _ -)`);
  return name;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" && fallback !== undefined) return fallback;
    throw e;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function listBoards() {
  let files = [];
  try {
    files = fs.readdirSync(boardsDir());
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return files.filter((f) => f.endsWith(".json") && !f.endsWith(".local.json")).map((f) => f.slice(0, -5)).sort();
}

export function boardExists(name) {
  return fs.existsSync(boardPath(checkName(name)));
}

export function loadBoard(name) {
  if (!boardExists(name)) throw new BoardError(`board "${name}" not found; boards: ${listBoards().join(", ") || "(none)"}`);
  return readJson(boardPath(name));
}

export function saveBoard(board) {
  validate(board);
  board.updatedAt = new Date().toISOString();
  writeJson(boardPath(checkName(board.name)), board);
}

export function createBoard(name, opts) {
  if (boardExists(name)) throw new BoardError(`board "${name}" already exists`);
  const board = newBoard(name, opts);
  saveBoard(board);
  saveLocal(name, { bindings: [], artifactUrl: "", dbVersion: null });
  return board;
}

export function removeBoard(name) {
  for (const f of [boardPath(name), localPath(name)]) fs.rmSync(f, { force: true });
}

export function loadLocal(name) {
  return readJson(localPath(checkName(name)), { bindings: [], artifactUrl: "", dbVersion: null });
}

export function saveLocal(name, local) {
  writeJson(localPath(checkName(name)), local);
}

// ---------- CWD context ----------

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// The scope a directory belongs to. Inside git, every worktree of one
// repository shares a root (the main worktree, found via the common git dir),
// so agents in sibling worktrees resolve the same board.
export function context(cwd = process.cwd()) {
  const real = fs.realpathSync(cwd);
  const common = git(real, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return { kind: "dir", root: real, branch: null };
  const root = path.basename(common) === ".git" ? path.dirname(common) : common;
  const branch = git(real, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return { kind: "git", root, branch };
}

export function bindingKey(root, branch) {
  return createHash("sha256").update(`${root}\0${branch || "*"}`).digest("hex").slice(0, 12);
}

export function makeBinding(ctx, { branch = false } = {}) {
  const b = branch ? ctx.branch : null;
  if (branch && !b) throw new BoardError("HEAD is detached; cannot bind to a branch");
  return { key: bindingKey(ctx.root, b), root: ctx.root, branch: b };
}

function matches(binding, ctx) {
  if (ctx.kind === "git") {
    return binding.root === ctx.root && (binding.branch == null || binding.branch === ctx.branch);
  }
  return ctx.root === binding.root || ctx.root.startsWith(binding.root + path.sep);
}

// Specificity: a branch binding beats a repo-wide binding, and a deeper
// directory binding beats a shallower one.
function score(binding) {
  return binding.root.length * 2 + (binding.branch ? 1 : 0);
}

export function resolveCandidates(ctx) {
  const hits = [];
  for (const name of listBoards()) {
    for (const b of loadLocal(name).bindings || []) {
      if (matches(b, ctx)) hits.push({ name, binding: b, score: score(b) });
    }
  }
  return hits;
}

export function resolveBoardName(explicit, cwd) {
  if (explicit) return checkName(explicit);
  if (process.env.TRACKERBOARD_BOARD) return checkName(process.env.TRACKERBOARD_BOARD);
  const ctx = context(cwd);
  const hits = resolveCandidates(ctx);
  if (!hits.length) {
    throw new BoardError(`no board is bound to ${ctx.root}${ctx.branch ? ` (branch ${ctx.branch})` : ""}; pass --board or run \`trackerboard bind --board <name>\``);
  }
  const best = Math.max(...hits.map((h) => h.score));
  const top = [...new Set(hits.filter((h) => h.score === best).map((h) => h.name))];
  if (top.length > 1) {
    throw new BoardError(`${top.length} boards resolve from ${ctx.root}: ${top.join(", ")}; pass --board`);
  }
  return top[0];
}
