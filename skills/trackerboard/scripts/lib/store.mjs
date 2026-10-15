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

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoardError, newBoard, validate } from "./board.mjs";
import { dataHome, resolveConfig } from "./config.mjs";
import { initializeBackendFactories, openBackend } from "./backend.mjs";
import { canonicalizeBinding, normalizeRepositoryUrl, resolveStorageTarget, sanitizeRepositoryUrl } from "./backend-target.mjs";
import { createBackendTargetInspector } from "./backend-target-inspection.mjs";
import { createStoreLock } from "./store-lock.mjs";
import "./backends/json.mjs";

const backendInstances = new Map();
const boardSnapshots = new WeakMap();
const latestSnapshots = new Map();
let initialization;

export async function initializeBackends() {
  if (!initialization) {
    initialization = (async () => {
      for (const module of ["./backends/sqlite.mjs", "./backends/github-project.mjs"]) {
        try { await import(module); }
        catch (error) {
          if (error.code !== "ERR_MODULE_NOT_FOUND" || !error.message.includes(module.slice(2))) throw error;
        }
      }
      await initializeBackendFactories();
    })();
  }
  return initialization;
}

export function home() {
  return process.env.TRACKERBOARD_HOME || path.join(os.homedir(), ".trackerboard");
}

export const withLock = createStoreLock(home);
export const tryWithLock = withLock.try;

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

function boardRepoUrl(name) {
  try { return readJson(boardPath(name), null)?.repoUrl || ""; }
  catch { return ""; }
}

function resolveTarget(name, options = {}, local = loadLocal(name)) {
  return resolveStorageTarget({
    name,
    local,
    ...(Object.hasOwn(options, "bindingKey") ? { bindingKey: options.bindingKey } : {}),
    ...(options.binding ? { binding: options.binding } : {}),
    repoUrl: options.repoUrl || "",
    boardRepoUrl: boardRepoUrl(name),
    allowAmbiguous: !!options.allowAmbiguous,
  });
}

export function repositoryBindingKey(name) {
  return backendConfig(name).bindingKey;
}

export function backendConfig(name, options = {}) {
  const checked = checkName(name);
  // Older callers passed CWD here. Ignore it: backend resolution is anchored
  // to the saved board target, never whichever directory launched the process.
  if (typeof options === "string") options = {};
  const local = loadLocal(checked);
  let target = resolveTarget(checked, { ...options, allowAmbiguous: true }, local);
  const config = resolveConfig({ bindingKey: target.bindingKey, boardOverride: local.backendOverride || {} });
  // A legacy JSON board stays on JSON until a verified migration pins a new
  // backend. Machine defaults cannot silently make its source disappear.
  if (local.backendOverride?.backend == null && fs.existsSync(boardPath(checked))) config.backend = "json";
  if (target.ambiguousBindings.length && config.backend !== "json") {
    throw new BoardError("board " + checked + " has multiple possible backend bindings (" + target.ambiguousBindings.join(", ") + "); select one with trackerboard backend --set-binding <key>");
  }
  if (!new Set(["json", "sqlite", "github"]).has(config.backend)) {
    throw new BoardError("unknown backend " + JSON.stringify(config.backend) + " for board " + checked + "; expected json, sqlite, or github");
  }
  if (config.backend === "github") {
    const githubTarget = config.github || {};
    const savedProject = local.githubProject || {};
    const configuredProject = githubTarget.projectId || githubTarget.projectNumber;
    const savedProjectRef = savedProject.projectId || savedProject.projectNumber;
    if (!target.bindingKey && !configuredProject && !savedProjectRef) {
      throw new BoardError("GitHub Projects for unbound board " + checked + " needs an explicit binding or a previously configured Project; --repo-url alone is not enough");
    }
    if (!target.bindingKey && !target.repoUrl) {
      throw new BoardError("GitHub Projects for unbound board " + checked + " needs a saved repository identity; bind the board or save a repository URL before setup");
    }
    if (!target.repoRoot && !githubTarget.owner && !savedProject.owner) {
      throw new BoardError("GitHub Projects for unbound board " + checked + " needs an explicit owner or saved repository identity");
    }
  }
  if (config.backend === "sqlite" && local.backendOverride?.backend === "sqlite" &&
      !target.bindingKey && !local.storageTarget?.sqlitePath && !local.backendOverride?.sqlite?.path) {
    throw new BoardError("board " + checked + " needs-binding: its previous SQLite target is not recorded; add/select an existing binding instead of opening an empty store");
  }
  if (config.backend === "sqlite" && !target.bindingKey && !config.sqlite?.path && !local.storageTarget?.sqlitePath) {
    throw new BoardError("unbound SQLite board " + checked + " needs an explicit sqlite.path in backend configuration");
  }
  if (config.backend === "sqlite") {
    const explicitlyDifferentBinding = options.bindingKey != null && target.bindingKey !== local.storageBindingKey;
    const configuredPath = !explicitlyDifferentBinding && local.storageTarget?.sqlitePath
      ? local.storageTarget.sqlitePath
      : config.sqlite?.path
        ? path.resolve(dataHome(), config.sqlite.path)
        : path.join(dataHome(), "repos", target.bindingKey + ".sqlite");
    config.sqlite = { ...(config.sqlite || {}), path: configuredPath };
    target = { ...target, sqlitePath: configuredPath };
  }
  return { ...config, bindingKey: target.bindingKey, storageTarget: target };
}

export function getRevision(name) {
  return backendFor(name).revision();
}

function backendFor(name) {
  const checked = checkName(name);
  const config = backendConfig(checked);
  const cacheKey = `${checked}\0${config.backend}\0${JSON.stringify(config)}`;
  if (backendInstances.has(cacheKey)) return backendInstances.get(cacheKey);
  const adapter = openBackendFor(checked, config);
  backendInstances.set(cacheKey, adapter);
  return adapter;
}

export function openBackendFor(name, config, options = {}) {
  const checked = checkName(name);
  const local = loadLocal(checked);
  const targetOptions = { ...options };
  if (!Object.hasOwn(targetOptions, "bindingKey") && config.bindingKey != null) targetOptions.bindingKey = config.bindingKey;
  const target = config.storageTarget || resolveTarget(checked, targetOptions, local);
  const repoUrl = target.repoUrl || options.repoUrl || boardRepoUrl(checked);
  return openBackend(config.backend, {
    name: checked,
    bindingKey: target.bindingKey,
    config,
    cwd: target.repoRoot || undefined,
    repoRoot: target.repoRoot,
    repoUrl: normalizeRepositoryUrl(repoUrl),
    storageTarget: target,
    local,
    loadLocal: () => loadLocal(checked),
    saveLocal: (next) => saveLocal(checked, next),
    boardPath: boardPath(checked),
    dataHome: dataHome(),
  });
}

export function loadBoard(name, options = {}) {
  const checked = checkName(name);
  if (!boardExists(checked)) throw new BoardError(`board "${checked}" not found; boards: ${listBoards().join(", ") || "(none)"}`);
  const board = backendFor(checked).load();
  if (board?.repoUrl) board.repoUrl = sanitizeRepositoryUrl(board.repoUrl);
  const snapshot = structuredClone(board);
  boardSnapshots.set(board, snapshot);
  latestSnapshots.set(checked, snapshot);
  return board;
}

export function saveBoard(board, { expectedRevision, previous } = {}) {
  validate(board);
  const name = checkName(board.name);
  if (board.repoUrl) board.repoUrl = sanitizeRepositoryUrl(board.repoUrl);
  const adapter = backendFor(name);
  const before = previous || boardSnapshots.get(board) || latestSnapshots.get(name) || null;
  board.updatedAt = new Date().toISOString();
  const revision = adapter.save(board, { previous: before, expectedRevision });
  const snapshot = structuredClone(board);
  boardSnapshots.set(board, snapshot);
  latestSnapshots.set(name, snapshot);
  return revision;
}

export function createBoard(name, opts, { binding = null } = {}) {
  opts ||= {};
  const exists = boardExists(name);
  const resumeGithubBootstrap = exists && !fs.existsSync(boardPath(name)) &&
    backendConfig(name, binding ? { binding } : {}).backend === "github" && !!loadLocal(name).githubProject?.boardId &&
    loadLocal(name).githubProject?.bootstrapComplete !== true;
  if (exists && !resumeGithubBootstrap) throw new BoardError(`board "${name}" already exists`);
  const board = newBoard(name, opts);
  if (opts.repoUrl) board.repoUrl = sanitizeRepositoryUrl(opts.repoUrl);
  if (!resumeGithubBootstrap) {
    const local = { bindings: [], artifactUrl: "", dbVersion: null, revision: 0, backendOverride: {} };
    local.boardId = randomUUID();
    if (binding) {
      local.bindings.push(structuredClone(binding));
      const canonical = canonicalizeBinding(binding);
      local.storageBindingKey = canonical.key;
      local.storageTarget = {
        repoRoot: canonical.root,
        ...(board.repoUrl ? { repoUrl: normalizeRepositoryUrl(board.repoUrl) } : {}),
      };
    }
    if (board.repoUrl) local.storageTarget = { ...(local.storageTarget || {}), repoUrl: board.repoUrl };
    saveLocal(name, local);
  }
  try {
    let config = backendConfig(name, binding ? { binding } : {});
    if (!resumeGithubBootstrap) {
      const current = loadLocal(name);
      const target = config.storageTarget;
      const savedTarget = {
        ...(target.repoRoot ? { repoRoot: target.repoRoot } : {}),
        ...(target.repoUrl ? { repoUrl: target.repoUrl } : {}),
        ...(target.sqlitePath ? { sqlitePath: target.sqlitePath } : {}),
      };
      saveLocal(name, {
        ...current,
        ...(target.bindingKey ? { storageBindingKey: target.bindingKey } : {}),
        ...(Object.keys(savedTarget).length ? { storageTarget: savedTarget } : {}),
        backendOverride: { ...(current.backendOverride || {}), backend: config.backend },
      });
      config = backendConfig(name, binding ? { binding } : {});
    }
    openBackendFor(name, config, binding ? { binding } : {}).create(board);
    latestSnapshots.set(name, structuredClone(board));
  } catch (error) {
    const resumable = loadLocal(name).backendOverride?.backend === "github" && !!loadLocal(name).githubProject?.boardId;
    if (!resumable) fs.rmSync(localPath(name), { force: true });
    fs.rmSync(boardPath(name), { force: true });
    throw error;
  }
  return board;
}

export function selectStorageBinding(name, key) {
  const checked = checkName(name);
  if (!boardExists(checked)) throw new BoardError("board " + checked + " not found");
  const local = loadLocal(checked);
  const config = backendConfig(checked, { bindingKey: key });
  const target = config.storageTarget;
  const adapter = openBackendFor(checked, config, { bindingKey: key });
  const board = adapter.load();
  if (!board) throw new BoardError("binding " + key + " has no existing " + config.backend + " data for board " + checked);
  validate(board);
  if (board.name !== checked) throw new BoardError("selected backend contains a different board name");
  const next = {
    ...local,
    storageBindingKey: target.bindingKey,
    storageTarget: {
      ...(target.repoRoot ? { repoRoot: target.repoRoot } : {}),
      ...(target.repoUrl ? { repoUrl: target.repoUrl } : {}),
      ...(target.sqlitePath ? { sqlitePath: target.sqlitePath } : {}),
    },
  };
  saveLocal(checked, next);
  for (const cacheKey of backendInstances.keys()) if (cacheKey.startsWith(checked + "\0")) backendInstances.delete(cacheKey);
  latestSnapshots.set(checked, structuredClone(board));
  return { config, target, board };
}

export function ensureBoardIdentity(name) {
  const checked = checkName(name);
  if (!boardExists(checked)) throw new BoardError("board " + checked + " not found");
  const local = loadLocal(checked);
  let target;
  try {
    target = resolveTarget(checked, { allowAmbiguous: true }, local);
  } catch (error) {
    if (local.backendOverride?.backend !== "json" && fs.existsSync(boardPath(checked))) throw error;
    target = { bindingKey: null, repoRoot: "", repoUrl: "", ambiguousBindings: [] };
  }
  if (target.ambiguousBindings.length && local.backendOverride?.backend && local.backendOverride.backend !== "json") {
    throw new BoardError("board " + checked + " has multiple possible backend bindings (" + target.ambiguousBindings.join(", ") + "); select one with trackerboard backend --set-binding <key>");
  }
  const next = { ...local, boardId: local.boardId || randomUUID() };
  if (target.bindingKey && !next.storageBindingKey) next.storageBindingKey = target.bindingKey;
  if (target.repoRoot || target.repoUrl) {
    next.storageTarget = {
      ...(target.repoRoot ? { repoRoot: target.repoRoot } : {}),
      ...(target.repoUrl ? { repoUrl: target.repoUrl } : {}),
    };
  }
  const config = backendConfig(checked);
  if (config.backend === "sqlite" && config.storageTarget.sqlitePath) {
    next.storageTarget = {
      ...(next.storageTarget || {}),
      sqlitePath: config.storageTarget.sqlitePath,
    };
  }
  if (JSON.stringify(next) !== JSON.stringify(local)) saveLocal(checked, next);
  return { boardId: next.boardId, target, ambiguousBindings: target.ambiguousBindings || [] };
}

const targetInspector = createBackendTargetInspector({ backendConfig, loadLocal, boardPath, boardRepoUrl, checkName });
export const backendTargetInfo = (name) => targetInspector.backendTargetInfo(name);
export const inspectBackendTargets = (names = listBoards()) => targetInspector.inspectBackendTargets(names);
export const findBackendTargetCollisions = (names = listBoards()) => inspectBackendTargets(names).collisions;

export function removeBoard(name) {
  backendFor(name).remove();
  for (const f of [boardPath(name), localPath(name), basePath(name)]) fs.rmSync(f, { force: true });
  for (const key of backendInstances.keys()) if (key.startsWith(`${name}\0`)) backendInstances.delete(key);
  latestSnapshots.delete(name);
}

export function loadLocal(name) {
  return readJson(localPath(checkName(name)), { bindings: [], artifactUrl: "", dbVersion: null, revision: 0, backendOverride: {} });
}

export function saveLocal(name, local) {
  const safe = structuredClone(local);
  if (safe.storageTarget?.repoUrl) {
    const repoUrl = normalizeRepositoryUrl(safe.storageTarget.repoUrl);
    if (repoUrl) safe.storageTarget.repoUrl = repoUrl;
    else delete safe.storageTarget.repoUrl;
  }
  if (safe.githubProject?.repoUrl) {
    const repoUrl = normalizeRepositoryUrl(safe.githubProject.repoUrl);
    if (repoUrl) safe.githubProject.repoUrl = repoUrl;
    else delete safe.githubProject.repoUrl;
  }
  writeJson(localPath(checkName(name)), safe);
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
  const rootPath = path.basename(common) === ".git" ? path.dirname(common) : common;
  let root = path.resolve(rootPath);
  try { root = fs.realpathSync(root); } catch {}
  const branch = git(real, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return { kind: "git", root, branch };
}

export function bindingKey(root, branch) {
  return createHash("sha256").update(`${root}\0${branch || "*"}`).digest("hex").slice(0, 12);
}

export function makeBinding(ctx, { branch = false } = {}) {
  const b = branch ? ctx.branch : null;
  if (branch && !b) throw new BoardError("HEAD is detached; cannot bind to a branch");
  const root = path.resolve(ctx.root);
  return { key: bindingKey(root, b), root, branch: b };
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
