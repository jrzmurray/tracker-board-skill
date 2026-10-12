// Board storage and CWD -> board resolution.
//
// Layout under $TRACKERBOARD_HOME (default ~/.trackerboard):
//   boards/<name>.json        board data (the source of truth)
//   boards/<name>.local.json  machine-local state: bindings, artifact url, db version,
//                             when the artifact was last checked
//   boards/<name>.base.json   the published document as of that db version (merge base)
//   remote/<name>/            where `refresh` asks ArtifactData to save the published document
//   out/docs/<name>-<hash>.json  db document bodies, written by every write and `push`
//   out/<name>.html           static render, written by `render`

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoardError, newBoard, validate } from "./board.mjs";
import { resolveConfig } from "./config.mjs";

export function home() {
  return process.env.TRACKERBOARD_HOME || path.join(os.homedir(), ".trackerboard");
}

const boardsDir = () => path.join(home(), "boards");
export const outDir = () => path.join(home(), "out");
const boardPath = (name) => path.join(boardsDir(), `${name}.json`);
const localPath = (name) => path.join(boardsDir(), `${name}.local.json`);
const basePath = (name) => path.join(boardsDir(), `${name}.base.json`);
export const remoteDir = (name) => path.join(home(), "remote", name);

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
  const names = new Set(files.filter((f) => f.endsWith(".json") && !f.endsWith(".local.json")).map((f) => f.slice(0, -5)));
  for (const f of files.filter((f) => f.endsWith(".local.json"))) names.add(f.slice(0, -11));
  return [...names].sort();
}

export function boardExists(name) {
  const checked = checkName(name);
  return fs.existsSync(boardPath(checked)) || fs.existsSync(localPath(checked));
}

export function repositoryBindingKey(name, cwd) {
  const ctx = context(cwd);
  if (ctx.kind === "git") return bindingKey(ctx.root, null);
  const local = loadLocal(name);
  const matching = (local.bindings || []).find((b) => matches(b, ctx));
  return matching?.key || (local.bindings || [])[0]?.key || bindingKey(ctx.root, null);
}

export function backendConfig(name, cwd) {
  const checked = checkName(name);
  const key = repositoryBindingKey(checked, cwd);
  const local = loadLocal(checked);
  const config = resolveConfig({ bindingKey: key, boardOverride: local.backendOverride || {} });
  if (!new Set(["json", "sqlite", "github"]).has(config.backend)) {
    throw new BoardError(`unknown backend ${JSON.stringify(config.backend)} for board ${checked}; expected json, sqlite, or github`);
  }
  return { ...config, bindingKey: key };
}

export function getRevision(name) {
  const local = loadLocal(name);
  return Number.isSafeInteger(local.revision) && local.revision >= 0 ? local.revision : 0;
}

export function loadBoard(name) {
  const checked = checkName(name);
  if (!boardExists(checked)) throw new BoardError(`board "${checked}" not found; boards: ${listBoards().join(", ") || "(none)"}`);
  const config = backendConfig(checked);
  if (config.backend !== "json") throw new BoardError(`the ${config.backend} backend is configured for ${checked}, but its adapter is not initialized`);
  return readJson(boardPath(checked));
}

export function saveBoard(board, { expectedRevision } = {}) {
  validate(board);
  const name = checkName(board.name);
  const config = backendConfig(name);
  if (config.backend !== "json") throw new BoardError(`the ${config.backend} backend is configured for ${name}, but its adapter is not initialized`);
  const revision = getRevision(name);
  if (expectedRevision != null && expectedRevision !== revision) {
    throw new BoardError(`board ${name} changed (expected revision ${expectedRevision}, current ${revision}); reload and retry`);
  }
  board.updatedAt = new Date().toISOString();
  writeJson(boardPath(name), board);
  saveLocal(name, { ...loadLocal(name), revision: revision + 1 });
  return revision + 1;
}

export function createBoard(name, opts) {
  if (boardExists(name)) throw new BoardError(`board "${name}" already exists`);
  const board = newBoard(name, opts);
  saveLocal(name, { bindings: [], artifactUrl: "", dbVersion: null, revision: 0, backendOverride: {} });
  saveBoard(board);
  return board;
}

export function removeBoard(name) {
  for (const f of [boardPath(name), localPath(name), basePath(name)]) fs.rmSync(f, { force: true });
}

export function loadLocal(name) {
  return readJson(localPath(checkName(name)), { bindings: [], artifactUrl: "", dbVersion: null });
}

export function saveLocal(name, local) {
  writeJson(localPath(checkName(name)), local);
}

export function loadBase(name) {
  return readJson(basePath(checkName(name)), null);
}

export function dropBase(name) {
  fs.rmSync(basePath(checkName(name)), { force: true });
}

export function saveBase(name, board) {
  writeJson(basePath(checkName(name)), board);
}

// One writer at a time across processes, so agents sharing this machine never
// lose each other's read-modify-write. Waits up to 15s; a lock older than 30s
// is treated as abandoned.
export async function withLock(fn) {
  const dir = path.join(home(), ".lock");
  fs.mkdirSync(home(), { recursive: true });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > 30000) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      } catch {}
      if (Date.now() > deadline) throw new BoardError(`another trackerboard command holds ${dir}; retry, or remove it if no command is running`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
