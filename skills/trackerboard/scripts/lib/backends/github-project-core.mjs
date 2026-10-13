import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { BoardError, STATUSES } from "../board.mjs";

export const MIN_GH_VERSION = "2.96.0";
export const MAX_GITHUB_BYTES = 60 * 1024;
export const GENERIC_PROJECT_TITLE = "Trackerboard Setup";
export const MAX_NODE_ID_BYTES = 128;
export const AUTH_RECOVERY = "Run `gh auth refresh -s project` and retry.";
export const PROJECT_FIELDS = [
  { name: "Trackerboard ID", type: "TEXT" },
  { name: "Status", type: "SINGLE_SELECT", options: STATUSES },
  { name: "Wave", type: "TEXT" },
  { name: "Lane", type: "TEXT" },
  { name: "Owner", type: "TEXT" },
  { name: "Order", type: "NUMBER" },
];
const DETAIL_FIELDS = ["note", "req", "issue", "pr", "review", "notes", "deps"];
const PHASE_MARKER = /<!-- trackerboard:phase:v(\d+):([A-Za-z0-9+/=]+) -->/;
const META_MARKER = /<!-- trackerboard:metadata:v(\d+):([A-Za-z0-9+/=]+) -->/g;

function commandLabel(args) {
  return `gh ${args.slice(0, 2).join(" ")}`.trim();
}

export function createGitHubClient(executable = "gh") {
  return {
    run(args, { input } = {}) {
      try {
        return execFileSync(executable, args, {
          encoding: "utf8",
          input,
          stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
      } catch (error) {
        const status = Number.isInteger(error.status) ? ` (exit ${error.status})` : "";
        throw new BoardError(`${commandLabel(args)} failed${status}. ${AUTH_RECOVERY}`);
      }
    },
  };
}

export function run(client, args, options) {
  try {
    return String(client.run(args, options) ?? "");
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError(`${commandLabel(args)} failed. ${AUTH_RECOVERY}`);
  }
}

export function parseJson(raw, label) {
  try {
    return JSON.parse(String(raw).trim());
  } catch {
    throw new BoardError(`GitHub returned invalid ${label} JSON.`);
  }
}

function versionParts(value) {
  const match = String(value).match(/(?:gh\s+)?version\s+v?(\d+)\.(\d+)\.(\d+)/i) || String(value).match(/v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function authEntries(value) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node) && ("login" in node || "scopes" in node || "active" in node || "state" in node)) found.push(node);
    if (Array.isArray(node)) node.forEach(walk);
    else Object.values(node).forEach(walk);
  };
  walk(value?.hosts ?? value);
  return found;
}

function normalizedScopes(value) {
  if (Array.isArray(value)) return value.map(String).map((scope) => scope.toLowerCase());
  if (typeof value === "string") return value.toLowerCase().split(/[\s,']+/).filter(Boolean);
  return [];
}

export function verifyGitHubCli(client) {
  let versionText;
  try {
    versionText = run(client, ["--version"]);
  } catch {
    throw new BoardError(`GitHub Projects requires gh ${MIN_GH_VERSION} or newer. Install or upgrade GitHub CLI, then retry.`);
  }
  const version = versionParts(versionText);
  if (!version || compareVersion(version, [2, 96, 0]) < 0) {
    const found = version ? version.join(".") : "unknown";
    throw new BoardError(`GitHub Projects requires gh ${MIN_GH_VERSION} or newer (found ${found}). Upgrade GitHub CLI and retry.`);
  }

  let status;
  try {
    status = parseJson(run(client, ["auth", "status", "--active", "--json", "hosts"]), "gh auth status");
  } catch {
    throw new BoardError(`GitHub CLI is not authenticated. Run \`gh auth login\`, then ${AUTH_RECOVERY}`);
  }
  const entries = authEntries(status);
  const active = entries.filter((entry) => entry.active === true || (entry.active == null && entry.state === "success"));
  if (!active.length) throw new BoardError(`GitHub CLI is not authenticated. Run \`gh auth login\`, then ${AUTH_RECOVERY}`);
  const scopes = active.flatMap((entry) => normalizedScopes(entry.scopes));
  if (scopes.length && !scopes.includes("project")) throw new BoardError(`GitHub CLI token is missing the required project scope. ${AUTH_RECOVERY}`);
  return true;
}

export function parseGitHubRepo(url) {
  if (!url) return null;
  let value = String(url).trim();
  const scp = value.match(/^(?:[^@/]+@)?github\.com:([^?#]+)$/i);
  if (scp) value = `https://github.com/${scp[1]}`;
  else if (/^git@github\.com:/i.test(value)) value = `https://github.com/${value.split(":").slice(1).join(":")}`;
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const repo = parts[1].replace(/\.git$/i, "");
    if (!repo) return null;
    return { owner: parts[0], repo, url: `https://github.com/${parts[0]}/${repo}` };
  } catch {
    return null;
  }
}

export function listFromJson(value, keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

export function projectNumber(project) {
  const direct = project?.number ?? project?.projectNumber;
  if (Number.isInteger(Number(direct)) && Number(direct) > 0) return Number(direct);
  const url = String(project?.url || project?.resourcePath || "");
  const match = url.match(/\/projects\/(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : null;
}

export function projectId(project) {
  return project?.id || project?.projectId || project?.nodeId || project?.node_id || null;
}

export function isPrivate(project) {
  if (typeof project?.public === "boolean") return !project.public;
  if (typeof project?.isPrivate === "boolean") return project.isPrivate;
  if (typeof project?.visibility === "string") return project.visibility.toUpperCase() === "PRIVATE";
  return null;
}

export function readmeOf(project) {
  return String(project?.readme ?? project?.README ?? project?.readmeContent ?? "");
}

function metadataBlock(metadata) {
  const json = JSON.stringify(metadata);
  const marker = `<!-- trackerboard:metadata:v1:${Buffer.from(json, "utf8").toString("base64")} -->`;
  if (Buffer.byteLength(marker, "utf8") > MAX_GITHUB_BYTES) {
    throw new BoardError(`Trackerboard Project README metadata exceeds the 60 KiB limit (${MAX_GITHUB_BYTES} bytes). No GitHub changes were made.`);
  }
  return marker;
}

export function readMetadata(readme) {
  const matches = [...String(readme).matchAll(META_MARKER)];
  if (matches.length > 1) throw new BoardError("Project README has multiple Trackerboard metadata blocks.");
  if (!matches.length) return null;
  const [, version, encoded] = matches[0];
  if (version !== "1") throw new BoardError(`Unsupported Trackerboard Project README metadata version ${version}.`);
  let metadata;
  try {
    metadata = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new BoardError("Project README Trackerboard metadata is invalid.");
  }
  if (metadata?.version !== 1 || !metadata.boardId) throw new BoardError("Project README Trackerboard metadata is incomplete.");
  return metadata;
}

export function withMetadata(readme, metadata) {
  const marker = metadataBlock(metadata);
  const without = String(readme).replace(META_MARKER, "").trim();
  return without ? `${without}\n\n${marker}` : marker;
}

export function phaseBody(phase) {
  const data = {
    version: 1,
    id: phase.id,
    emptyTitle: !phase.title,
    details: Object.fromEntries(DETAIL_FIELDS.map((field) => [field, phase[field]])),
  };
  const body = `<!-- trackerboard:phase:v1:${Buffer.from(JSON.stringify(data), "utf8").toString("base64")} -->`;
  if (Buffer.byteLength(body, "utf8") > MAX_GITHUB_BYTES) {
    throw new BoardError(`Phase ${phase.id} draft body exceeds the 60 KiB limit (${MAX_GITHUB_BYTES} bytes). No GitHub changes were made.`);
  }
  return body;
}

export function phaseDataFromBody(body) {
  const match = String(body || "").match(PHASE_MARKER);
  if (!match) return null;
  if (match[1] !== "1") throw new BoardError(`Unsupported Trackerboard draft body version ${match[1]}.`);
  try {
    const data = JSON.parse(Buffer.from(match[2], "base64").toString("utf8"));
    return data?.version === 1 && data.id ? data : null;
  } catch {
    throw new BoardError("Trackerboard draft item body metadata is invalid.");
  }
}

export function valueOf(item, field) {
  const fieldName = field.name.toLowerCase();
  const fieldId = field.id;
  const values = item?.fieldValues?.nodes || item?.fieldValues || item?.fields || item?.values;
  if (Array.isArray(values)) {
    const hit = values.find((entry) => String(entry?.fieldId || entry?.field?.id || "") === String(fieldId)
      || String(entry?.fieldName || entry?.name || entry?.field?.name || "").toLowerCase() === fieldName);
    if (hit) return unwrapValue(hit);
  } else if (values && typeof values === "object") {
    const key = Object.keys(values).find((name) => name.toLowerCase() === fieldName);
    if (key) return unwrapValue(values[key]);
  }
  const direct = item?.[field.name] ?? item?.[field.name[0].toLowerCase() + field.name.slice(1)];
  return direct === undefined ? undefined : unwrapValue(direct);
}

function unwrapValue(value) {
  if (value == null) return undefined;
  if (typeof value !== "object") return value;
  if (value.text !== undefined) return value.text;
  if (value.number !== undefined) return value.number;
  if (value.name !== undefined) return value.name;
  if (value.value !== undefined) return unwrapValue(value.value);
  if (value.singleSelectOptionName !== undefined) return value.singleSelectOptionName;
  if (value.option?.name !== undefined) return value.option.name;
  return undefined;
}

export function itemTitle(item) {
  return String(item?.title ?? item?.content?.title ?? item?.draftIssue?.title ?? "");
}

export function itemBody(item) {
  return String(item?.body ?? item?.content?.body ?? item?.draftIssue?.body ?? "");
}

export function isDraftItem(item) {
  const kind = String(item?.content_type || item?.contentType || item?.type || item?.content?.__typename || item?.content?.type || "").toLowerCase();
  return kind.includes("draft");
}

export function itemId(item) {
  return item?.id || item?.itemId || item?.nodeId || item?.node_id || null;
}

export function draftItemId(item) {
  return item?.content?.id || item?.draftIssue?.id || item?.draftIssueId || item?.draft_issue_id || null;
}

export function fieldType(field) {
  return String(field?.dataType || field?.data_type || field?.fieldType || field?.type || field?.__typename || "")
    .replace(/[-_ ]/g, "").toUpperCase().replace(/^PROJECTV2/, "").replace(/FIELD$/, "");
}

export function optionName(option) {
  return String(option?.name || option?.value || "");
}

export function fieldOptions(field) {
  return field?.options || field?.singleSelectOptions || field?.single_select_options || [];
}

export function fieldByName(fields, name) {
  return fields.find((field) => String(field.name || "").toLowerCase() === name.toLowerCase()) || null;
}

export function makeMetadata(board, boardId, phaseItems = {}, pendingDelete = [], bootstrapComplete = false) {
  const phaseIds = [];
  const phaseLocations = {};
  for (const wave of board.waves) {
    wave.phases.forEach((phase, order) => {
      phaseIds.push(phase.id);
      phaseLocations[phase.id] = { wave: wave.id, order };
    });
  }
  return {
    version: 1,
    bootstrapComplete,
    boardId,
    name: board.name,
    fields: Object.fromEntries(["title", "subtitle", "lede", "notes", "repoUrl"].map((key) => [key, board[key]])),
    waves: board.waves.map((wave) => ({ id: wave.id, title: wave.title, prefix: wave.prefix, notes: wave.notes })),
    phaseIds,
    phaseLocations,
    phaseItems: Object.fromEntries(phaseIds.filter((id) => phaseItems[id]).map((id) => [id, phaseItems[id]])),
    pendingDelete: pendingDelete.filter((entry) => entry?.id && entry?.itemId),
    log: board.log,
    updatedAt: board.updatedAt,
  };
}

export function assertSizes(board, boardId, phaseItems = {}, pendingDelete = []) {
  const bodies = new Map();
  for (const { phases } of board.waves) for (const phase of phases) bodies.set(phase.id, phaseBody(phase));
  const estimated = Object.fromEntries(board.waves.flatMap((wave) => wave.phases.map((phase) => [
    phase.id,
    phaseItems[phase.id] || "x".repeat(MAX_NODE_ID_BYTES),
  ])));
  metadataBlock(makeMetadata(board, boardId, estimated, pendingDelete));
  return bodies;
}

function flattenBoard(board) {
  const values = new Map();
  if (!board) return values;
  for (const field of ["name", "title", "subtitle", "lede", "notes", "repoUrl", "log"]) values.set(`board:${field}`, board[field]);
  values.set("waves:order", board.waves.map((wave) => wave.id));
  for (const wave of board.waves) {
    values.set(`wave:${wave.id}:exists`, true);
    for (const field of ["title", "prefix", "notes"]) values.set(`wave:${wave.id}:${field}`, wave[field]);
    values.set(`wave:${wave.id}:phase-order`, wave.phases.map((phase) => phase.id));
    for (const phase of wave.phases) {
      values.set(`phase:${phase.id}:exists`, true);
      values.set(`phase:${phase.id}:wave`, wave.id);
      for (const field of ["title", "lane", "owner", "status", "note", "req", "issue", "pr", "review", "notes", "deps"]) {
        values.set(`phase:${phase.id}:${field}`, phase[field]);
      }
    }
  }
  return values;
}

function changed(a, b) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function dependencyDeltas(previous, next) {
  const before = new Map((previous || []).map((id) => [String(id).toLowerCase(), String(id)]));
  const after = new Map((next || []).map((id) => [String(id).toLowerCase(), String(id)]));
  return {
    added: [...after].filter(([key]) => !before.has(key)).map(([, id]) => id),
    removed: new Set([...before.keys()].filter((key) => !after.has(key))),
  };
}

function dependencyDeltasConflict(previous, local, remote) {
  const localDelta = dependencyDeltas(previous, local);
  const remoteDelta = dependencyDeltas(previous, remote);
  const localAdded = new Set(localDelta.added.map((id) => id.toLowerCase()));
  const remoteAdded = new Set(remoteDelta.added.map((id) => id.toLowerCase()));
  return [...localAdded].some((id) => remoteDelta.removed.has(id))
    || [...remoteAdded].some((id) => localDelta.removed.has(id));
}

export function conflicts(previous, desired, remote) {
  if (!previous || !remote) return [];
  const before = flattenBoard(previous);
  const local = flattenBoard(desired);
  const observed = flattenBoard(remote);
  const keys = new Set([...before.keys(), ...local.keys(), ...observed.keys()]);
  const found = [];
  for (const key of keys) {
    const oldValue = before.get(key), localValue = local.get(key), remoteValue = observed.get(key);
    if (key.endsWith(":deps") && Array.isArray(oldValue) && Array.isArray(localValue) && Array.isArray(remoteValue)) {
      if (dependencyDeltasConflict(oldValue, localValue, remoteValue)) found.push(key);
      continue;
    }
    if (changed(oldValue, localValue) && changed(oldValue, remoteValue) && changed(localValue, remoteValue)) found.push(key);
  }
  return found;
}

export function mergeDependencyDeltas(previous, desired, remote) {
  if (!previous || !desired || !remote) return;
  const index = (board) => new Map(board.waves.flatMap((wave) => wave.phases.map((phase) => [
    String(phase.id).toLowerCase(), { phase, wave },
  ])));
  const basePhases = index(previous);
  const remotePhases = index(remote);
  for (const wave of desired.waves) for (const phase of wave.phases) {
    const baseline = basePhases.get(String(phase.id).toLowerCase())?.phase;
    const observed = remotePhases.get(String(phase.id).toLowerCase())?.phase;
    if (!baseline || !observed) continue;
    const localDelta = dependencyDeltas(baseline.deps, phase.deps);
    const merged = observed.deps.filter((id) => !localDelta.removed.has(String(id).toLowerCase()));
    for (const id of localDelta.added) {
      if (!merged.some((present) => String(present).toLowerCase() === id.toLowerCase())) merged.push(id);
    }
    phase.deps = merged;
  }
}

export function revisionConflict(message) {
  const error = new BoardError(message);
  error.code = "TRACKERBOARD_REVISION_CONFLICT";
  return error;
}

export function revisionToken(board, metadata) {
  if (!board) return null;
  return createHash("sha256").update(JSON.stringify({ board, metadata })).digest("hex");
}

export function parseProjectView(raw) {
  const parsed = parseJson(raw, "project view");
  return parsed?.project || parsed;
}

export function graphql(client, query, variables) {
  const response = parseJson(run(client, ["api", "graphql", "--input", "-"], {
    input: JSON.stringify({ query, variables }),
  }), "GraphQL");
  if (response?.errors?.length) throw new BoardError(`GitHub Projects API rejected a request. ${AUTH_RECOVERY}`);
  return response?.data;
}

export function projectDetails(client, ref) {
  const project = parseProjectView(run(client, ["project", "view", String(ref.number), "--owner", ref.owner, "--format", "json"]));
  const id = projectId(project) || ref.id;
  let details = project;
  if (id) {
    const data = graphql(client,
      "query($id: ID!) { node(id: $id) { ... on ProjectV2 { id number title public readme createdAt } } }",
      { id });
    const node = data?.node;
    if (node) details = { ...project, ...node };
  }
  return { ...details, id, number: projectNumber(details) || ref.number };
}

export function statusValue(field) {
  const options = fieldOptions(field);
  return Object.fromEntries(STATUSES.map((status) => {
    const option = options.find((entry) => optionName(entry).toLowerCase() === status);
    return [status, option?.id || null];
  }));
}
