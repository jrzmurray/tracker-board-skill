import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BoardError } from "./board.mjs";

const realPathOrResolved = (value) => {
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); }
  catch { return canonicalDataPath(resolved); }
};

export function normalizeRepositoryUrl(value) {
  let source = String(value || "").trim();
  if (!source) return "";
  const scp = source.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
  if (scp && !source.includes("://")) source = "https://" + scp[1] + "/" + scp[2];
  try {
    const url = new URL(source);
    if (!new Set(["http:", "https:", "ssh:"]).has(url.protocol)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    parts[parts.length - 1] = parts.at(-1).replace(/\.git$/i, "");
    if (!parts.at(-1)) return "";
    return "https://" + url.host.toLowerCase() + "/" + parts.join("/");
  } catch {
    return "";
  }
}

export function sanitizeRepositoryUrl(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  const normalized = normalizeRepositoryUrl(source);
  if (!normalized) throw new BoardError("repository URL must be an HTTP(S), SSH, or Git remote URL with an owner and repository path");
  return normalized;
}

export function bindingKeyFor(root, branch) {
  return createHash("sha256").update(String(root) + "\0" + (branch || "*")).digest("hex").slice(0, 12);
}

export function canonicalBindingKey(root) {
  return bindingKeyFor(root, null);
}

export function canonicalizeBinding(binding) {
  if (!binding?.root) return null;
  const root = realPathOrResolved(binding.root);
  return { key: canonicalBindingKey(root), root, branch: null };
}

function repositoryUrlForTarget(root, candidates, preferRemote) {
  const sources = [...candidates];
  if (root) {
    try {
      const remote = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (preferRemote && sources.length > 1) sources.splice(1, 0, remote);
      else sources.push(remote);
    } catch {}
  }
  return sources.map(normalizeRepositoryUrl).find(Boolean) || "";
}

export function resolveStorageTarget({ name, local = {}, bindingKey: explicitKey, binding: explicitBinding, repoUrl = "", boardRepoUrl = "", allowAmbiguous = false }) {
  const aliases = Array.isArray(local.bindings) ? local.bindings : [];
  const saved = local.storageTarget || {};
  const explicitlySelected = explicitKey != null || explicitBinding != null;
  let binding = explicitBinding || null;

  if (explicitKey != null) {
    binding ||= aliases.find((candidate) => candidate.key === explicitKey)
      || aliases.find((candidate) => canonicalizeBinding(candidate)?.key === explicitKey)
      || null;
    if (!binding && local.storageBindingKey !== explicitKey) {
      const choices = [...new Set(aliases.map((candidate) => candidate.key).filter(Boolean))];
      const available = choices.length ? "; choose one of: " + choices.join(", ") : "";
      throw new BoardError("binding " + explicitKey + " is not saved for board " + name + available);
    }
  } else if (!binding && local.storageBindingKey) {
    binding = aliases.find((candidate) => canonicalizeBinding(candidate)?.key === local.storageBindingKey)
      || (saved.repoRoot ? { key: local.storageBindingKey, root: saved.repoRoot, branch: null } : null);
    explicitKey = local.storageBindingKey;
  }

  if (!binding && explicitKey == null && !local.storageBindingKey && !local.storageTarget) {
    const roots = new Map();
    for (const candidate of aliases) {
      if (!candidate?.root) continue;
      const root = realPathOrResolved(candidate.root);
      roots.set(root, { ...candidate, root });
    }
    if (roots.size > 1 && !allowAmbiguous) {
      const choices = [...roots.values()].map((candidate) => candidate.key);
      throw new BoardError("board " + name + " has multiple possible backend bindings (" + choices.join(", ") + "); select one with trackerboard backend --set-binding <key>");
    }
    if (roots.size === 1) binding = roots.values().next().value;
  }

  const canonical = canonicalizeBinding(binding);
  const selectedKey = canonical?.key || explicitKey || local.storageBindingKey || null;
  const root = canonical?.root || (saved.repoRoot ? realPathOrResolved(saved.repoRoot) : "");
  return {
    bindingKey: selectedKey,
    repoRoot: root,
    repoUrl: repositoryUrlForTarget(
      root,
      [repoUrl, local.githubProject?.repoUrl, boardRepoUrl, saved.repoUrl],
      explicitlySelected && !!binding,
    ),
    binding: binding ? structuredClone(binding) : null,
    ambiguousBindings: !binding && !local.storageBindingKey && !explicitlySelected
      ? [...new Set(aliases.filter((candidate) => candidate?.root).map((candidate) => canonicalizeBinding(candidate)?.key).filter(Boolean))]
      : [],
  };
}

export function canonicalDataPath(file) {
  const resolved = path.resolve(file);
  let cursor = resolved;
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    return path.resolve(fs.realpathSync(cursor), ...suffix);
  } catch {
    return resolved;
  }
}

export function backendTargetIdentity({ backend, file, boardName, projectId }) {
  if (backend === "json" && file) return { backend, file: canonicalDataPath(file) };
  if (backend === "sqlite" && file && boardName) {
    return { backend, file: canonicalDataPath(file), rowKey: boardName };
  }
  if (backend === "github" && projectId) return { backend, projectId: String(projectId) };
  return null;
}
