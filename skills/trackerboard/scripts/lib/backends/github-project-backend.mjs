import { randomUUID } from "node:crypto";
import { BoardError, SCHEMA, normalizeBoard } from "../board.mjs";
import { mergeBoards } from "../merge.mjs";
import * as core from "./github-project-core.mjs";
import { createGitHubProjectFieldManager } from "./github-project-fields.mjs";
import { projectItemsByIds } from "./github-project-items.mjs";
import { createGitHubProjectSynchronizer } from "./github-project-sync.mjs";
import { sanitizeRepositoryUrl } from "../backend-target.mjs";
import { appendOperation, assertOperationMatch, findOperation } from "../operation-receipts.mjs";

const {
  AUTH_RECOVERY, GENERIC_PROJECT_TITLE, MIN_GH_VERSION, PROJECT_FIELDS,
  assertSizes, conflicts, createGitHubClient, draftItemId, fieldByName,
  graphql, isDraftItem, isPrivate, itemBody, itemId, itemTitle,
  listFromJson, parseGitHubRepo, parseJson, phaseDataFromBody,
  projectDetails, projectId, projectNumber, readMetadata, readmeOf, revisionConflict,
  revisionToken, run, statusValue, valueOf, verifyGitHubCli,
} = core;
export function createGitHubProjectBackend(context, client = createGitHubClient(context?.config?.github?.executable || process.env.TRACKERBOARD_GH || "gh")) {
  let local = { ...(context?.local || {}) };
  let cachedRevision = null;
  let cachedOperations = [];
  let ready = false;
  const cfg = context?.config?.github || {};
  const sourceUrl = context?.repoUrl || context?.config?.repoUrl || "";
  const parsedRepo = parseGitHubRepo(sourceUrl);

  function safeBoard(input) {
    const board = normalizeBoard(input);
    if (board.repoUrl) board.repoUrl = sanitizeRepositoryUrl(board.repoUrl);
    return board;
  }

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
    const owner = ownerFor(board);
    if (!number && id) {
      const data = graphql(client,
        "query($id: ID!) { node(id: $id) { ... on ProjectV2 { id number } } }",
        { id });
      const resolved = data?.node;
      const resolvedNumber = projectNumber(resolved);
      if (!resolvedNumber) throw new BoardError(`Configured GitHub Project ID ${id} could not be resolved to a Project number for gh CLI operations.`);
      return { owner, number: resolvedNumber, id: projectId(resolved) || id };
    }
    return { owner, number: Number(number), id: id || null };
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
    // `gh project item-list` includes Project field values in JSON output.
    // GitHub CLI rejects combining --format json with --field-id/--field,
    // so keep the read as one JSON request and resolve values by field name.
    const itemArgs = ["project", "item-list", String(ref.number), "--owner", ref.owner, "--limit", "1000", "--format", "json"];
    const itemsParsed = parseJson(run(client, itemArgs), "project items");
    const items = listFromJson(itemsParsed, ["items", "projectItems"]);
    const metadata = readMetadata(readmeOf(details));
    const visibleIds = new Set(items.map(itemId).filter(Boolean).map(String));
    const mappedIds = Object.values(metadata?.phaseItems || {})
      .map(String)
      .filter((id) => id && !visibleIds.has(id));
    for (const item of projectItemsByIds(client, mappedIds)) {
      if (String(item.project?.id || "") !== String(details.id || "")) continue;
      if (!isDraftItem(item)) throw new BoardError("Trackerboard metadata maps a phase to a non-draft GitHub Project item; refusing to treat a repository Issue or PR as a phase.");
      if (!visibleIds.has(String(itemId(item)))) {
        items.push(item);
        visibleIds.add(String(itemId(item)));
      }
    }
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

  function mergeIndependentChanges(previous, desired, remote) {
    if (!previous || !desired || !remote) return;
    assertNoConflicts(previous, desired, remote);
    const result = mergeBoards(previous, desired, remote);
    if (result.conflicts.length) throw revisionConflict(`GitHub Project changed in the same fields: ${result.conflicts.join(", ")}. Reload the board and retry.`);
    const updatedAt = desired.updatedAt;
    for (const key of Object.keys(desired)) delete desired[key];
    Object.assign(desired, result.board);
    if (updatedAt) desired.updatedAt = updatedAt;
  }

  function rereadBeforeMutation(ref, previous, desired) {
    const latest = readRemote(ref, { allowMissing: true });
    if (previous && desired && latest?.loaded?.board) {
      mergeIndependentChanges(previous, desired, latest.loaded.board);
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
      repoUrl: repoUrl ? sanitizeRepositoryUrl(repoUrl) : "",
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
    if (previous && desired && beforeEdit?.loaded?.board) mergeIndependentChanges(previous, desired, beforeEdit.loaded.board);
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

  const { ensureFields } = createGitHubProjectFieldManager({ client, readRemote, rereadBeforeMutation });

  const { syncBoard, deletionManifest } = createGitHubProjectSynchronizer({
    client,
    readRemote,
    rereadBeforeMutation,
    assertNoConflicts,
    managedItems,
    setCachedRevision(value) { cachedRevision = value; },
  });
  function create(boardInput) {
    ensureReady();
    const board = safeBoard(boardInput);
    const saved = record();
    if (saved.bootstrapComplete) throw new BoardError("GitHub Project already contains a completed Trackerboard board; use save instead of create.");
    const boardId = saved.boardId || context?.local?.boardId || randomUUID();
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
      const phaseIds = Array.isArray(snapshot.metadata.phaseIds) ? snapshot.metadata.phaseIds : [];
      const legacyComplete = snapshot.metadata.bootstrapComplete == null
        && !snapshot.metadata.pendingDelete?.length
        && phaseIds.every((phaseId) => snapshot.metadata.phaseItems?.[phaseId]);
      if (snapshot.metadata.bootstrapComplete === true || legacyComplete) {
        throw new BoardError("GitHub Project already contains completed Trackerboard metadata; use save instead of create.");
      }
    }
    snapshot = ensureFields(project.ref, null, board);
    // Check exact encoded metadata size against the IDs already reconciled.
    assertSizes(board, project.boardId, snapshot?.loaded?.phaseItems || {});
    syncBoard(project.ref, project.boardId, board, { starting: snapshot, operations: [] });
    saveRecord({ ...record(), bootstrapComplete: true });
    return board;
  }

  function load() {
    ensureReady();
    const ref = refFor();
    if (!ref) return null;
    const snapshot = readRemote(ref, { allowMissing: true });
    if (snapshot.ref.id) saveRecord({ ...record(), owner: snapshot.ref.owner, projectNumber: snapshot.ref.number, projectId: snapshot.ref.id });
    cachedRevision = revisionToken(snapshot.loaded?.board, snapshot.metadata);
    cachedOperations = snapshot.metadata?.operations || [];
    return snapshot.loaded?.board || null;
  }

  function save(boardInput, { previous: previousInput, expectedRevision, operation } = {}) {
    ensureReady();
    const desired = safeBoard(boardInput);
    const previous = previousInput ? normalizeBoard(previousInput) : null;
    const ref = refFor(desired);
    if (!ref) throw new BoardError("GitHub Project is not set up for this board; run create first.");
    let snapshot = readRemote(ref, { allowMissing: true });
    if (!snapshot.metadata || !snapshot.loaded?.board) throw new BoardError("GitHub Project has no Trackerboard metadata; run create first.");
    if (context?.name && snapshot.metadata.name !== context.name) throw new BoardError(`GitHub Project is bound to Trackerboard board ${snapshot.metadata.name}.`);
    const observedRevision = revisionToken(snapshot.loaded.board, snapshot.metadata);
    let operations = Array.isArray(snapshot.metadata.operations) ? [...snapshot.metadata.operations] : [];
    if (operation !== undefined) {
      const existing = assertOperationMatch(operations, operation);
      if (existing) {
        cachedRevision = observedRevision;
        cachedOperations = operations;
        return observedRevision;
      }
      operations = appendOperation(operations, operation);
    }
    if (previous && expectedRevision != null && expectedRevision !== observedRevision) {
      // Field-level comparison below distinguishes harmless independent edits.
      assertNoConflicts(previous, desired, snapshot.loaded.board);
    } else if (!previous && expectedRevision != null && expectedRevision !== observedRevision) {
      throw revisionConflict("GitHub Project changed since the expected revision; reload and retry.");
    }
    mergeIndependentChanges(previous, desired, snapshot.loaded.board);
    const boardId = snapshot.metadata.boardId;
    const wantedIds = new Set(desired.waves.flatMap((wave) => wave.phases.map((phase) => phase.id)));
    const pendingDelete = deletionManifest(snapshot, wantedIds, snapshot.loaded.phaseItems || {});
    assertSizes(desired, boardId, snapshot.loaded.phaseItems, pendingDelete, operations);
    ensurePrivate(ref, { previous, desired });
    snapshot = ensureFields(ref, previous, desired);
    assertSizes(desired, boardId, snapshot.loaded?.phaseItems || {}, pendingDelete, operations);
    const nextRevision = syncBoard(ref, boardId, desired, { previous, starting: snapshot, operations });
    cachedOperations = operations;
    saveRecord({ ...record(), bootstrapComplete: true });
    return nextRevision;
  }

  function revision() {
    return cachedRevision;
  }

  function getOperation(id) {
    return findOperation(cachedOperations, id);
  }

  function remove() {
    ensureReady();
    const ref = refFor();
    if (!ref) {
      clearRecord();
      cachedRevision = null;
      cachedOperations = [];
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
    cachedOperations = [];
  }

  return { load, create, save, revision, getOperation, remove };
}
