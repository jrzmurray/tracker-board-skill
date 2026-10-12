import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { BoardError, SCHEMA, STATUSES, normalizeBoard } from "../board.mjs";
import { registerBackendFactory } from "../backend.mjs";

export const MIN_GH_VERSION = "2.96.0";
export const MAX_GITHUB_BYTES = 60 * 1024;
const GENERIC_PROJECT_TITLE = "Trackerboard Setup";
const MAX_NODE_ID_BYTES = 128;
const AUTH_RECOVERY = "Run `gh auth refresh -s project` and retry.";
const PROJECT_FIELDS = [
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

function run(client, args, options) {
  try {
    return String(client.run(args, options) ?? "");
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError(`${commandLabel(args)} failed. ${AUTH_RECOVERY}`);
  }
}

function parseJson(raw, label) {
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

function parseGitHubRepo(url) {
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

function listFromJson(value, keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function projectNumber(project) {
  const direct = project?.number ?? project?.projectNumber;
  if (Number.isInteger(Number(direct)) && Number(direct) > 0) return Number(direct);
  const url = String(project?.url || project?.resourcePath || "");
  const match = url.match(/\/projects\/(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : null;
}

function projectId(project) {
  return project?.id || project?.projectId || project?.nodeId || project?.node_id || null;
}

function isPrivate(project) {
  if (typeof project?.public === "boolean") return !project.public;
  if (typeof project?.isPrivate === "boolean") return project.isPrivate;
  if (typeof project?.visibility === "string") return project.visibility.toUpperCase() === "PRIVATE";
  return null;
}

function readmeOf(project) {
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

function readMetadata(readme) {
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

function withMetadata(readme, metadata) {
  const marker = metadataBlock(metadata);
  const without = String(readme).replace(META_MARKER, "").trim();
  return without ? `${without}\n\n${marker}` : marker;
}

function phaseBody(phase) {
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

function phaseDataFromBody(body) {
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

function valueOf(item, field) {
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

function itemTitle(item) {
  return String(item?.title ?? item?.content?.title ?? item?.draftIssue?.title ?? "");
}

function itemBody(item) {
  return String(item?.body ?? item?.content?.body ?? item?.draftIssue?.body ?? "");
}

function isDraftItem(item) {
  const kind = String(item?.content_type || item?.contentType || item?.type || item?.content?.__typename || item?.content?.type || "").toLowerCase();
  return kind.includes("draft");
}

function itemId(item) {
  return item?.id || item?.itemId || item?.nodeId || item?.node_id || null;
}

function draftItemId(item) {
  return item?.content?.id || item?.draftIssue?.id || item?.draftIssueId || item?.draft_issue_id || null;
}

function fieldType(field) {
  return String(field?.dataType || field?.data_type || field?.fieldType || field?.type || field?.__typename || "")
    .replace(/[-_ ]/g, "").toUpperCase().replace(/^PROJECTV2/, "").replace(/FIELD$/, "");
}

function optionName(option) {
  return String(option?.name || option?.value || "");
}

function fieldOptions(field) {
  return field?.options || field?.singleSelectOptions || field?.single_select_options || [];
}

function fieldByName(fields, name) {
  return fields.find((field) => String(field.name || "").toLowerCase() === name.toLowerCase()) || null;
}

function makeMetadata(board, boardId, phaseItems = {}, pendingDelete = []) {
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

function assertSizes(board, boardId, phaseItems = {}, pendingDelete = []) {
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

function conflicts(previous, desired, remote) {
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

function mergeDependencyDeltas(previous, desired, remote) {
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

function revisionConflict(message) {
  const error = new BoardError(message);
  error.code = "TRACKERBOARD_REVISION_CONFLICT";
  return error;
}

function revisionToken(board, metadata) {
  if (!board) return null;
  return createHash("sha256").update(JSON.stringify({ board, metadata })).digest("hex");
}

function parseProjectView(raw) {
  const parsed = parseJson(raw, "project view");
  return parsed?.project || parsed;
}

function graphql(client, query, variables) {
  const response = parseJson(run(client, ["api", "graphql", "--input", "-"], {
    input: JSON.stringify({ query, variables }),
  }), "GraphQL");
  if (response?.errors?.length) throw new BoardError(`GitHub Projects API rejected a request. ${AUTH_RECOVERY}`);
  return response?.data;
}

function projectDetails(client, ref) {
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

function statusValue(field) {
  const options = fieldOptions(field);
  return Object.fromEntries(STATUSES.map((status) => {
    const option = options.find((entry) => optionName(entry).toLowerCase() === status);
    return [status, option?.id || null];
  }));
}

export function createGitHubProjectBackend(context, client = createGitHubClient(context?.config?.github?.executable || process.env.TRACKERBOARD_GH || "gh")) {
  let local = { ...(context?.local || {}) };
  let cachedRevision = null;
  let ready = false;
  const cfg = context?.config?.github || {};
  const sourceUrl = context?.repoUrl || context?.config?.repoUrl || "";
  const parsedRepo = parseGitHubRepo(sourceUrl);

  function ensureReady() {
    if (ready) return;
    verifyGitHubCli(client);
    ready = true;
  }

  function ownerFor(board) {
    const record = local.githubProject || {};
    const boardRepo = parseGitHubRepo(board?.repoUrl || "");
    const owner = cfg.owner || record.owner || parsedRepo?.owner || boardRepo?.owner;
    if (!owner) throw new BoardError("GitHub Projects needs a GitHub repository remote or board repoUrl so it can determine the Project owner.");
    return owner;
  }

  function repoUrlFor(board) {
    return board?.repoUrl || sourceUrl || local.githubProject?.repoUrl || "";
  }

  function record() {
    return { ...(local.githubProject || {}) };
  }

  function saveRecord(value) {
    local = { ...local, githubProject: { ...value } };
    context?.saveLocal?.(local);
  }

  function clearRecord() {
    local = { ...local };
    delete local.githubProject;
    context?.saveLocal?.(local);
  }

  function refFor(board) {
    const saved = record();
    const number = cfg.projectNumber ?? saved.projectNumber;
    const id = cfg.projectId ?? saved.projectId;
    if (!number && !id) return null;
    return { owner: ownerFor(board), number: Number(number), id: id || null };
  }

  function runProjectList(owner) {
    const parsed = parseJson(run(client, ["project", "list", "--owner", owner, "--limit", "100", "--format", "json"]), "project list");
    return listFromJson(parsed, ["projects", "items"]);
  }

  function projectSnapshot(ref) {
    const details = projectDetails(client, ref);
    const fieldsParsed = parseJson(run(client, ["project", "field-list", String(ref.number), "--owner", ref.owner, "--limit", "100", "--format", "json"]), "project fields");
    const cliFields = listFromJson(fieldsParsed, ["fields", "items"]);
    const graphqlFields = details.id
      ? listFromJson(graphql(client,
        "query($id: ID!) { node(id: $id) { ... on ProjectV2 { fields(first: 100) { nodes { ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options { id name } } } } } } }",
        { id: details.id })?.node?.fields, ["nodes"])
      : [];
    const fields = cliFields.map((field) => ({
      ...field,
      ...(graphqlFields.find((candidate) => candidate.id === field.id) || {}),
    }));
    const itemArgs = ["project", "item-list", String(ref.number), "--owner", ref.owner, "--limit", "1000"];
    for (const field of fields) if (field.id) itemArgs.push("--field-id", String(field.id));
    itemArgs.push("--format", "json");
    const itemsParsed = parseJson(run(client, itemArgs), "project items");
    const items = listFromJson(itemsParsed, ["items", "projectItems"]);
    const metadata = readMetadata(readmeOf(details));
    return { ref: { ...ref, id: projectId(details) || ref.id, number: projectNumber(details) || ref.number }, project: details, fields, items, metadata };
  }

  function preflightOwner(owner) {
    runProjectList(owner);
  }

  function draftItems(snapshot) {
    return snapshot.items.filter(isDraftItem);
  }

  function managedItems(snapshot) {
    const idField = fieldByName(snapshot.fields, "Trackerboard ID");
    const byPhase = new Map();
    for (const item of draftItems(snapshot)) {
      const fromField = idField ? valueOf(item, idField) : undefined;
      const fromBody = phaseDataFromBody(itemBody(item))?.id;
      const phaseId = fromField || fromBody;
      if (!phaseId) continue;
      const itemNodeId = itemId(item);
      if (!itemNodeId) continue;
      const key = String(phaseId);
      if (byPhase.has(key) && byPhase.get(key).id !== itemNodeId) throw new BoardError(`More than one GitHub draft item is marked as Trackerboard phase ${key}.`);
      byPhase.set(key, { id: itemNodeId, draftId: draftItemId(item), item });
    }
    return byPhase;
  }

  function boardFromSnapshot(snapshot, { allowMissing = false } = {}) {
    const metadata = snapshot.metadata;
    if (!metadata) return null;
    if (context?.name && metadata.name && metadata.name !== context.name) throw new BoardError(`GitHub Project is already bound to Trackerboard board ${metadata.name}.`);
    const managed = managedItems(snapshot);
    const declared = Array.isArray(metadata.phaseIds) ? metadata.phaseIds.map(String) : Object.keys(metadata.phaseItems || {});
    const waves = (metadata.waves || []).map((wave) => ({ id: String(wave.id), title: String(wave.title || ""), prefix: String(wave.prefix || ""), notes: String(wave.notes || ""), phases: [] }));
    const fields = Object.fromEntries(["title", "subtitle", "lede", "notes", "repoUrl"].map((key) => [key, String(metadata.fields?.[key] || "")]));
    const locations = metadata.phaseLocations || {};
    const itemMaps = { ...(metadata.phaseItems || {}) };
    const byItemId = new Map(snapshot.items.map((item) => [itemId(item), item]));
    const fieldMap = Object.fromEntries(PROJECT_FIELDS.map((definition) => [definition.name, fieldByName(snapshot.fields, definition.name)]));

    for (const phaseId of declared) {
      const match = managed.get(phaseId);
      const mappedId = itemMaps[phaseId];
      const item = (mappedId && byItemId.get(mappedId)) || match?.item;
      if (!item || !isDraftItem(item)) {
        if (allowMissing) continue;
        throw new BoardError(`Trackerboard phase ${phaseId} has no Project draft item. Retry the last Trackerboard create/save command to reconcile its partial write.`);
      }
      const bodyData = phaseDataFromBody(itemBody(item));
      const phaseLocation = locations[phaseId] || {};
      const waveId = String((fieldMap.Wave && valueOf(item, fieldMap.Wave)) || phaseLocation.wave || "");
      let wave = waves.find((candidate) => candidate.id === waveId);
      if (!wave && waveId) {
        wave = { id: waveId, title: waveId, prefix: "", notes: "", phases: [] };
        waves.push(wave);
      }
      if (!wave) throw new BoardError(`Trackerboard phase ${phaseId} has no wave metadata.`);
      const details = bodyData?.details || {};
      const rawStatus = fieldMap.Status ? valueOf(item, fieldMap.Status) : undefined;
      const orderField = fieldMap.Order ? valueOf(item, fieldMap.Order) : undefined;
      const phase = {
        id: phaseId,
        title: bodyData?.emptyTitle ? "" : itemTitle(item),
        lane: String((fieldMap.Lane && valueOf(item, fieldMap.Lane)) || ""),
        owner: String((fieldMap.Owner && valueOf(item, fieldMap.Owner)) || ""),
        status: String(rawStatus || "todo").toLowerCase(),
        note: String(details.note || ""),
        req: String(details.req || ""),
        issue: String(details.issue || ""),
        pr: String(details.pr || ""),
        review: String(details.review || ""),
        notes: String(details.notes || ""),
        deps: Array.isArray(details.deps) ? details.deps.map(String) : [],
        _order: Number(orderField ?? phaseLocation.order ?? 0),
      };
      wave.phases.push(phase);
      itemMaps[phaseId] = itemId(item);
    }
    waves.sort((a, b) => {
      const ai = (metadata.waves || []).findIndex((entry) => entry.id === a.id);
      const bi = (metadata.waves || []).findIndex((entry) => entry.id === b.id);
      if (ai < 0) return bi < 0 ? 0 : 1;
      if (bi < 0) return -1;
      return ai - bi;
    });
    for (const wave of waves) {
      wave.phases.sort((a, b) => a._order - b._order);
      for (const phase of wave.phases) delete phase._order;
    }
    if (allowMissing) {
      const present = new Set(waves.flatMap((wave) => wave.phases.map((phase) => phase.id.toLowerCase())));
      for (const wave of waves) for (const phase of wave.phases) {
        phase.deps = phase.deps.filter((dependency) => present.has(dependency.toLowerCase()));
      }
    }
    const board = normalizeBoard({
      schema: SCHEMA,
      name: metadata.name || context?.name,
      ...fields,
      waves,
      log: metadata.log || [],
      updatedAt: metadata.updatedAt,
    });
    return { board, phaseItems: itemMaps };
  }

  function readRemote(ref = refFor(), { allowMissing = false } = {}) {
    if (!ref) return null;
    const snapshot = projectSnapshot(ref);
    return { ...snapshot, loaded: boardFromSnapshot(snapshot, { allowMissing }) };
  }

  function assertNoConflicts(previous, desired, remote) {
    const found = conflicts(previous, desired, remote);
    if (found.length) throw revisionConflict(`GitHub Project changed in the same fields: ${found.join(", ")}. Reload the board and retry.`);
  }

  function rereadBeforeMutation(ref, previous, desired) {
    const latest = readRemote(ref, { allowMissing: true });
    if (previous && desired && latest?.loaded?.board) {
      assertNoConflicts(previous, desired, latest.loaded.board);
      mergeDependencyDeltas(previous, desired, latest.loaded.board);
    }
    // Project item updates have no compare-and-swap. A same-field write that
    // lands after this read and before the next command remains last-write-wins.
    return latest;
  }

  function projectRefFromCreated(output, owner) {
    const parsed = parseJson(output, "project create");
    const project = parsed?.project || parsed;
    const number = projectNumber(project);
    if (!number) throw new BoardError("GitHub created a Project but did not return its number; rerun create to reconcile the setup placeholder.");
    return { owner, number, id: projectId(project) };
  }

  function saveBootstrapState({ owner, boardId, repoUrl, bootstrapStartedAt, ref }) {
    saveRecord({
      ...(record()),
      owner,
      boardId,
      repoUrl,
      bootstrapStartedAt,
      ...(ref ? { projectNumber: ref.number, projectId: ref.id || undefined } : {}),
    });
  }

  function cleanupUnverifiedPlaceholder(ref) {
    try {
      const latest = projectSnapshot(ref);
      if (latest.items.length !== 0) return false;
      const again = projectSnapshot(ref);
      if (again.items.length !== 0) return false;
      run(client, ["project", "delete", String(ref.number), "--owner", ref.owner]);
      return true;
    } catch {
      return false;
    }
  }

  function privacyFailure(ref, created, prefix = "Could not verify that the GitHub Project is private.") {
    const deleted = created ? cleanupUnverifiedPlaceholder(ref) : false;
    if (created) clearRecord();
    const guidance = created
      ? deleted ? "The still-empty setup placeholder was deleted. " : "No board content was written; inspect the setup Project before retrying. "
      : "No Trackerboard content was written; verify the configured Project is private before retrying. ";
    throw new BoardError(`${prefix} ${guidance}Confirm Project owner permissions, then retry. ${AUTH_RECOVERY}`);
  }

  function ensurePrivate(ref, { created = false, previous, desired } = {}) {
    let latest;
    try {
      latest = projectSnapshot(ref);
    } catch {
      privacyFailure(ref, created);
    }
    if (isPrivate(latest.project) === true) return latest;
    if (isPrivate(latest.project) !== false) {
      // Unknown visibility is treated as unsafe. The explicit edit below is
      // followed by a fresh read before any board content is written.
    }
    let beforeEdit;
    try {
      beforeEdit = readRemote(ref, { allowMissing: true });
    } catch {
      privacyFailure(ref, created);
    }
    if (previous && desired && beforeEdit?.loaded?.board) assertNoConflicts(previous, desired, beforeEdit.loaded.board);
    try {
      run(client, ["project", "edit", String(ref.number), "--owner", ref.owner, "--visibility", "PRIVATE"]);
      latest = projectSnapshot(ref);
    } catch {
      latest = null;
    }
    if (latest && isPrivate(latest.project) === true) return latest;
    privacyFailure(ref, created);
  }

  function resolveProjectFromList(owner, boardId, bootstrapStartedAt) {
    const projects = runProjectList(owner);
    const setup = projects.filter((project) => String(project.title || project.name || "") === GENERIC_PROJECT_TITLE);
    const exact = [];
    const placeholders = [];
    for (const candidate of setup) {
      const number = projectNumber(candidate);
      if (!number) continue;
      const snapshot = projectSnapshot({ owner, number, id: projectId(candidate) });
      if (snapshot.metadata?.boardId === boardId) exact.push({ ref: snapshot.ref, placeholder: false });
      else if (!snapshot.metadata && snapshot.items.length === 0) {
        const createdAt = Date.parse(snapshot.project.createdAt || candidate.createdAt || "");
        const startedAt = Date.parse(bootstrapStartedAt || "");
        if (Number.isFinite(createdAt) && Number.isFinite(startedAt) && createdAt >= startedAt - 1000) {
          placeholders.push({ ref: snapshot.ref, placeholder: true });
        }
      }
    }
    if (exact.length === 1) return exact[0];
    if (exact.length > 1 || placeholders.length > 1) throw new BoardError(`More than one empty "${GENERIC_PROJECT_TITLE}" Project exists for ${owner}; set github.projectNumber in the backend config to select one.`);
    return placeholders[0] || null;
  }

  function ensureProject(board, boardId) {
    const owner = ownerFor(board);
    const saved = record();
    const configured = refFor(board);
    const repoUrl = repoUrlFor(board);
    preflightOwner(owner);
    if (configured) {
      const snapshot = projectSnapshot(configured);
      const remoteBoardId = snapshot.metadata?.boardId;
      if (remoteBoardId && saved.boardId && remoteBoardId !== saved.boardId) throw new BoardError("Configured GitHub Project belongs to a different Trackerboard board.");
      const effectiveBoardId = remoteBoardId || saved.boardId || boardId;
      saveBootstrapState({ owner, boardId: effectiveBoardId, repoUrl, ref: snapshot.ref, bootstrapStartedAt: saved.bootstrapStartedAt });
      ensurePrivate(snapshot.ref, { created: false });
      return { ref: snapshot.ref, boardId: effectiveBoardId, created: false };
    }

    const recovered = resolveProjectFromList(owner, boardId, saved.bootstrapStartedAt);
    let ref = recovered?.ref || null;
    let created = recovered?.placeholder || false;
    if (!ref) {
      // Persist a stable board identity before the first remote write so an
      // interrupted empty-project bootstrap can be recovered on the next run.
      const started = saved.bootstrapStartedAt || new Date().toISOString();
      saveBootstrapState({ owner, boardId, repoUrl, bootstrapStartedAt: started });
      runProjectList(owner); // Re-read immediately before creating the placeholder.
      const output = run(client, ["project", "create", "--owner", owner, "--title", GENERIC_PROJECT_TITLE, "--format", "json"]);
      ref = projectRefFromCreated(output, owner);
      created = true;
      // Privacy is the very next gh command after placeholder creation.
      try {
        run(client, ["project", "edit", String(ref.number), "--owner", owner, "--visibility", "PRIVATE"]);
      } catch {
        const deleted = cleanupUnverifiedPlaceholder(ref);
        clearRecord();
        throw new BoardError(`Could not set the GitHub setup Project to private. ${deleted ? "The still-empty placeholder was deleted. " : "No board content was written; inspect the setup Project before retrying. "}Check owner permissions and retry. ${AUTH_RECOVERY}`);
      }
    }

    const privateSnapshot = ensurePrivate(ref, { created });
    const effectiveBoardId = privateSnapshot.metadata?.boardId || record().boardId || boardId;
    saveBootstrapState({ owner, boardId: effectiveBoardId, repoUrl, ref: privateSnapshot.ref, bootstrapStartedAt: record().bootstrapStartedAt });
    return { ref: privateSnapshot.ref, boardId: effectiveBoardId, created };
  }

  function updateStatusOptions(ref, field, latestFields, previous, desired) {
    const latest = rereadBeforeMutation(ref, previous, desired);
    const current = fieldByName(latest?.fields || latestFields, "Status") || field;
    const input = {
      fieldId: current.id,
      singleSelectOptions: STATUSES.map((name) => ({ name })),
    };
    graphql(client,
      "mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } } } }",
      { input });
  }

  function ensureFields(ref, previous, desired) {
    let current = readRemote(ref, { allowMissing: true });
    for (const definition of PROJECT_FIELDS) {
      let field = fieldByName(current.fields, definition.name);
      if (!field) {
        rereadBeforeMutation(ref, previous, desired);
        const args = ["project", "field-create", String(ref.number), "--owner", ref.owner, "--name", definition.name, "--data-type", definition.type];
        if (definition.options) args.push("--single-select-options", definition.options.join(","));
        run(client, args);
        current = readRemote(ref, { allowMissing: true });
        field = fieldByName(current.fields, definition.name);
      }
      if (!field) throw new BoardError(`GitHub Project field ${definition.name} was not created.`);
      if (fieldType(field) !== definition.type.replace(/_/g, "")) throw new BoardError(`GitHub Project field ${definition.name} has type ${fieldType(field)}; expected ${definition.type}.`);
      if (definition.options) {
        const names = fieldOptions(field).map((option) => optionName(option).toLowerCase());
        if (STATUSES.some((status) => !names.includes(status)) || names.length !== STATUSES.length) {
          updateStatusOptions(ref, field, current.fields, previous, desired);
          current = readRemote(ref, { allowMissing: true });
          field = fieldByName(current.fields, definition.name);
          const refreshed = fieldOptions(field).map((option) => optionName(option).toLowerCase());
          if (STATUSES.some((status) => !refreshed.includes(status)) || refreshed.length !== STATUSES.length) {
            throw new BoardError("GitHub Project Status field could not be configured with all nine canonical Trackerboard statuses.");
          }
        }
      }
    }
    return readRemote(ref, { allowMissing: true });
  }

  function privateReadmeMutation(ref, readme, previous, desired) {
    const latest = rereadBeforeMutation(ref, previous, desired);
    if (!latest) throw new BoardError("GitHub Project is unavailable.");
    const args = ["project", "edit", String(ref.number), "--owner", ref.owner, "--readme", readme];
    run(client, args);
  }

  function setProjectTitle(ref, title, previous, desired) {
    const latest = rereadBeforeMutation(ref, previous, desired);
    const current = String(latest?.project?.title || "");
    if (current === title) return;
    run(client, ["project", "edit", String(ref.number), "--owner", ref.owner, "--title", title]);
  }

  function setItemValue(ref, item, field, value, previous, desired) {
    const latest = rereadBeforeMutation(ref, previous, desired);
    const currentItem = latest?.items.find((entry) => itemId(entry) === item.id) || item.item;
    const currentField = fieldByName(latest?.fields || [], field.name) || field;
    const currentValue = valueOf(currentItem, currentField);
    const wanted = value === "" && field.type === "TEXT" ? undefined : value;
    if (String(currentValue ?? "") === String(wanted ?? "")) return;
    const args = ["project", "item-edit", "--id", item.id, "--project-id", latest?.ref.id || ref.id || "", "--field-id", currentField.id];
    if (field.type === "TEXT") {
      if (value === "") args.push("--clear");
      else args.push("--text", String(value));
    } else if (field.type === "NUMBER") args.push("--number", String(value));
    else if (field.type === "SINGLE_SELECT") {
      const optionId = statusValue(currentField)[String(value).toLowerCase()];
      if (!optionId) throw new BoardError(`GitHub Project Status option ${value} is missing.`);
      args.push("--single-select-option-id", optionId);
    }
    run(client, args);
  }

  function updateDraftTitleOrBody(ref, item, key, value, previous, desired) {
    const latest = rereadBeforeMutation(ref, previous, desired);
    const latestItem = latest?.items.find((entry) => itemId(entry) === item.id) || item.item;
    const current = key === "title" ? itemTitle(latestItem) : itemBody(latestItem);
    if (current === value) return;
    const draftId = draftItemId(latestItem) || item.draftId;
    if (!draftId) throw new BoardError(`GitHub did not return the draft issue ID needed to update phase ${latestItem?.title || "item"}; verify gh is ${MIN_GH_VERSION} or newer.`);
    run(client, ["project", "item-edit", "--id", draftId, "--project-id", latest?.ref.id || ref.id || "", `--${key}`, value]);
  }

  function mutationConflictState(previous, desired, remote) {
    if (previous && remote?.loaded?.board) assertNoConflicts(previous, desired, remote.loaded.board);
  }

  function writeReadme(ref, snapshot, metadata, previous, desired) {
    const next = withMetadata(readmeOf(snapshot.project), metadata);
    if (next === readmeOf(snapshot.project)) return;
    privateReadmeMutation(ref, next, previous, desired);
  }

  function deletionManifest(snapshot, wantedIds, phaseItems) {
    const byPhase = new Map();
    for (const entry of snapshot?.metadata?.pendingDelete || []) {
      if (entry?.id && entry?.itemId) byPhase.set(String(entry.id), { id: String(entry.id), itemId: String(entry.itemId) });
    }
    for (const id of snapshot?.metadata?.phaseIds || []) {
      if (wantedIds.has(id)) continue;
      const mappedId = phaseItems[id] || snapshot?.metadata?.phaseItems?.[id];
      if (mappedId) byPhase.set(String(id), { id: String(id), itemId: String(mappedId) });
    }
    return [...byPhase.values()];
  }

  function syncBoard(ref, boardId, desired, { previous = null, starting = null } = {}) {
    let current = starting || readRemote(ref);
    const oldBoard = current?.loaded?.board || null;
    if (previous && oldBoard) assertNoConflicts(previous, desired, oldBoard);
    const idMap = managedItems(current || { fields: [], items: [] });
    const phaseItems = { ...(current?.metadata?.phaseItems || {}) };
    for (const [phaseId, value] of idMap) phaseItems[phaseId] = value.id;
    const wantedIds = new Set(desired.waves.flatMap((wave) => wave.phases.map((phase) => phase.id)));
    const pendingDelete = deletionManifest(current, wantedIds, phaseItems);
    const sizeMappings = Object.fromEntries([...wantedIds].map((id) => [id, phaseItems[id] || "x".repeat(MAX_NODE_ID_BYTES)]));
    const bodies = assertSizes(desired, boardId, sizeMappings, pendingDelete);
    const metadata = makeMetadata(desired, boardId, Object.fromEntries([...wantedIds].map((id) => [id, phaseItems[id] || ""])), pendingDelete);

    // Publish the desired manifest before item mutations. Missing mappings can
    // be recovered from the phase ID in each draft body on retry.
    writeReadme(ref, current, metadata, previous, desired);
    setProjectTitle(ref, desired.title || desired.name, previous, desired);

    let fieldState = readRemote(ref, { allowMissing: true });
    const fieldRefs = Object.fromEntries(PROJECT_FIELDS.map((definition) => [definition.name, fieldByName(fieldState.fields, definition.name)]));
    for (const wave of desired.waves) {
      wave.phases.forEach((phase, order) => {
        let latest = rereadBeforeMutation(ref, previous, desired);
        mutationConflictState(previous, desired, latest);
        const mapped = managedItems(latest || { fields: [], items: [] }).get(phase.id);
        let itemRef = mapped ? { id: mapped.id, draftId: mapped.draftId, item: mapped.item } : null;
        const body = bodies.get(phase.id);
        const title = phase.title || phase.id;
        if (!itemRef) {
          run(client, ["project", "item-create", String(ref.number), "--owner", ref.owner, "--title", title, "--body", body, "--format", "json"]);
          latest = readRemote(ref, { allowMissing: true });
          const created = managedItems(latest).get(phase.id);
          if (!created) throw new BoardError(`GitHub draft item for phase ${phase.id} was created without a readable item ID; retry save to reconcile it.`);
          itemRef = { id: created.id, draftId: created.draftId, item: created.item };
          phaseItems[phase.id] = created.id;
        }
        const latestTitle = itemTitle(itemRef.item);
        const latestBody = itemBody(itemRef.item);
        if (latestTitle !== title) updateDraftTitleOrBody(ref, itemRef, "title", title, previous, desired);
        if (latestBody !== body) updateDraftTitleOrBody(ref, itemRef, "body", body, previous, desired);
        const values = [
          ["Trackerboard ID", phase.id],
          ["Status", phase.status],
          ["Wave", wave.id],
          ["Lane", phase.lane],
          ["Owner", phase.owner],
          ["Order", order],
        ];
        for (const [name, value] of values) {
          const field = fieldRefs[name];
          if (!field) throw new BoardError(`GitHub Project field ${name} is unavailable.`);
          setItemValue(ref, itemRef, { ...field, type: PROJECT_FIELDS.find((def) => def.name === name).type }, value, previous, desired);
        }
      });
    }

    // Remove only Trackerboard-owned draft items. The README manifest no
    // longer includes them, so an interrupted removal is safe to retry.
    for (const entry of pendingDelete) {
      const latest = rereadBeforeMutation(ref, previous, desired);
      const candidate = latest?.items.find((item) => itemId(item) === entry.itemId);
      if (!candidate) continue;
      if (!isDraftItem(candidate)) throw new BoardError(`Refusing to remove non-draft GitHub item mapped to Trackerboard phase ${entry.id}.`);
      run(client, ["project", "item-delete", String(ref.number), "--owner", ref.owner, "--id", entry.itemId]);
      delete phaseItems[entry.id];
    }

    fieldState = readRemote(ref);
    const reconciled = managedItems(fieldState);
    for (const phaseId of wantedIds) if (reconciled.has(phaseId)) phaseItems[phaseId] = reconciled.get(phaseId).id;
    const liveItems = new Set(fieldState.items.map(itemId));
    const stillDeleting = pendingDelete.filter((entry) => liveItems.has(entry.itemId));
    const finalMetadata = makeMetadata(desired, boardId, phaseItems, stillDeleting);
    writeReadme(ref, fieldState, finalMetadata, previous, desired);
    const after = readRemote(ref);
    cachedRevision = revisionToken(after?.loaded?.board, after?.metadata);
    return cachedRevision;
  }

  function create(boardInput) {
    ensureReady();
    const board = normalizeBoard(boardInput);
    const saved = record();
    const boardId = saved.boardId || randomUUID();
    // All size checks happen before project creation, field creation, or other
    // remote mutations. 128 bytes is a conservative bound for each opaque ID.
    const bodies = assertSizes(board, boardId, {});
    void bodies;
    const owner = ownerFor(board);
    const project = ensureProject(board, boardId);
    let snapshot = readRemote(project.ref, { allowMissing: true });
    if (snapshot.metadata) {
      if (snapshot.metadata.name !== board.name) throw new BoardError(`GitHub Project already stores Trackerboard board ${snapshot.metadata.name}.`);
      if (saved.boardId && snapshot.metadata.boardId !== saved.boardId) throw new BoardError("GitHub Project metadata has a different stable board ID.");
    }
    snapshot = ensureFields(project.ref, null, board);
    // Check exact encoded metadata size against the IDs already reconciled.
    assertSizes(board, project.boardId, snapshot?.loaded?.phaseItems || {});
    syncBoard(project.ref, project.boardId, board, { starting: snapshot });
    return board;
  }

  function load() {
    ensureReady();
    const ref = refFor();
    if (!ref) return null;
    const snapshot = readRemote(ref);
    cachedRevision = revisionToken(snapshot.loaded?.board, snapshot.metadata);
    return snapshot.loaded?.board || null;
  }

  function save(boardInput, { previous: previousInput, expectedRevision } = {}) {
    ensureReady();
    const desired = normalizeBoard(boardInput);
    const previous = previousInput ? normalizeBoard(previousInput) : null;
    const ref = refFor(desired);
    if (!ref) throw new BoardError("GitHub Project is not set up for this board; run create first.");
    let snapshot = readRemote(ref, { allowMissing: true });
    if (!snapshot.metadata || !snapshot.loaded?.board) throw new BoardError("GitHub Project has no Trackerboard metadata; run create first.");
    if (context?.name && snapshot.metadata.name !== context.name) throw new BoardError(`GitHub Project is bound to Trackerboard board ${snapshot.metadata.name}.`);
    const observedRevision = revisionToken(snapshot.loaded.board, snapshot.metadata);
    if (previous && expectedRevision != null && expectedRevision !== observedRevision) {
      // Field-level comparison below distinguishes harmless independent edits.
      assertNoConflicts(previous, desired, snapshot.loaded.board);
    } else if (!previous && expectedRevision != null && expectedRevision !== observedRevision) {
      throw revisionConflict("GitHub Project changed since the expected revision; reload and retry.");
    }
    assertNoConflicts(previous, desired, snapshot.loaded.board);
    mergeDependencyDeltas(previous, desired, snapshot.loaded.board);
    const boardId = snapshot.metadata.boardId;
    const wantedIds = new Set(desired.waves.flatMap((wave) => wave.phases.map((phase) => phase.id)));
    const pendingDelete = deletionManifest(snapshot, wantedIds, snapshot.loaded.phaseItems || {});
    assertSizes(desired, boardId, snapshot.loaded.phaseItems, pendingDelete);
    ensurePrivate(ref, { previous, desired });
    snapshot = ensureFields(ref, previous, desired);
    assertSizes(desired, boardId, snapshot.loaded?.phaseItems || {}, pendingDelete);
    return syncBoard(ref, boardId, desired, { previous, starting: snapshot });
  }

  function revision() {
    return cachedRevision;
  }

  function remove() {
    ensureReady();
    const ref = refFor();
    if (!ref) {
      clearRecord();
      cachedRevision = null;
      return;
    }
    const snapshot = readRemote(ref);
    const metadata = snapshot.metadata;
    const saved = record();
    if (!metadata || (saved.boardId && metadata.boardId !== saved.boardId)) {
      throw new BoardError("Refusing to remove a GitHub Project that is not bound to this Trackerboard board.");
    }
    const managed = managedItems(snapshot);
    const ownedIds = new Set(Object.values(metadata.phaseItems || {}));
    for (const item of draftItems(snapshot)) {
      const phase = [...managed.entries()].find(([, value]) => value.id === itemId(item));
      if (!phase || !ownedIds.has(itemId(item))) throw new BoardError("Refusing to remove a GitHub Project containing draft items that are not owned by this Trackerboard board.");
    }
    for (const item of snapshot.items) if (!isDraftItem(item)) {
      throw new BoardError("Refusing to remove a GitHub Project containing repository issues or pull requests. Remove those project items first; no repository issues were changed.");
    }
    const latest = projectSnapshot(ref);
    if (!latest.metadata || latest.metadata.boardId !== metadata.boardId) throw new BoardError("GitHub Project changed before removal; reload and retry.");
    run(client, ["project", "delete", String(ref.number), "--owner", ref.owner]);
    clearRecord();
    cachedRevision = null;
  }

  return { load, create, save, revision, remove };
}

registerBackendFactory("github", {
  // GitHub is opt-in. Store initialization runs every adapter factory, so the
  // CLI/auth/capability checks stay lazy until a GitHub backend operation.
  initialize() {},
  open(context) {
    const executable = context?.config?.github?.executable || process.env.TRACKERBOARD_GH || "gh";
    return createGitHubProjectBackend(context, createGitHubClient(executable));
  },
});
