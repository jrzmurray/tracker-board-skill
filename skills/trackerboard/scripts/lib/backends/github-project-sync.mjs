import { BoardError } from "../board.mjs";
import {
  MAX_NODE_ID_BYTES, MIN_GH_VERSION, PROJECT_FIELDS, assertSizes, draftItemId, fieldByName,
  isDraftItem, itemBody, itemId, itemTitle, makeMetadata, readmeOf,
  revisionToken, run, statusValue, valueOf, withMetadata,
} from "./github-project-core.mjs";

const PHASE_FIELDS = ["Trackerboard ID", "Status", "Wave", "Lane", "Owner", "Order"];
const MAX_RECONCILIATION_PASSES = 4;

export function createGitHubProjectSynchronizer({ client, readRemote, rereadBeforeMutation, assertNoConflicts, managedItems, setCachedRevision }) {
  function wantedPhaseIds(board) {
    return new Set(board.waves.flatMap((wave) => wave.phases.map((phase) => phase.id)));
  }

  function phasePosition(board, phaseId) {
    for (const wave of board.waves) {
      const order = wave.phases.findIndex((phase) => phase.id === phaseId);
      if (order >= 0) return { wave, phase: wave.phases[order], order };
    }
    return null;
  }

  function updatePhaseMappings(snapshot, board, phaseItems) {
    for (const [phaseId, item] of managedItems(snapshot || { fields: [], items: [] })) {
      if (phasePosition(board, phaseId)) phaseItems[phaseId] = item.id;
    }
    return phaseItems;
  }

  function boardMetadata(snapshot, boardId, board, phaseItems, complete) {
    const ids = wantedPhaseIds(board);
    updatePhaseMappings(snapshot, board, phaseItems);
    let pendingDelete = deletionManifest(snapshot, ids, phaseItems);
    if (complete) {
      const liveItems = new Set((snapshot?.items || []).map(itemId));
      pendingDelete = pendingDelete.filter((entry) => liveItems.has(entry.itemId));
    }
    const mappings = Object.fromEntries([...ids].map((id) => [id, phaseItems[id] || "x".repeat(MAX_NODE_ID_BYTES)]));
    assertSizes(board, boardId, mappings, pendingDelete);
    return makeMetadata(board, boardId, Object.fromEntries([...ids].map((id) => [id, phaseItems[id] || ""])), pendingDelete, complete);
  }

  function writeReadme(ref, boardId, phaseItems, complete, previous, desired) {
    const latest = rereadBeforeMutation(ref, previous, desired);
    if (!latest) throw new BoardError("GitHub Project is unavailable.");
    const metadata = boardMetadata(latest, boardId, desired, phaseItems, complete);
    const currentReadme = readmeOf(latest.project);
    const next = withMetadata(currentReadme, metadata);
    if (next === currentReadme) return latest;
    run(client, ["project", "edit", String(ref.number), "--owner", ref.owner, "--readme", next]);
    return latest;
  }

  function setProjectTitle(ref, previous, desired) {
    const latest = rereadBeforeMutation(ref, previous, desired);
    const title = desired.title || desired.name;
    const current = String(latest?.project?.title || "");
    if (current === title) return;
    run(client, ["project", "edit", String(ref.number), "--owner", ref.owner, "--title", title]);
  }

  function phaseBody(boardId, phaseItems, pendingDelete, desired, phaseId) {
    const ids = wantedPhaseIds(desired);
    const mappings = Object.fromEntries([...ids].map((id) => [id, phaseItems[id] || "x".repeat(MAX_NODE_ID_BYTES)]));
    return assertSizes(desired, boardId, mappings, pendingDelete).get(phaseId);
  }

  function desiredFieldValue(desired, phaseId, fieldName) {
    const position = phasePosition(desired, phaseId);
    if (!position) return undefined;
    const { wave, phase, order } = position;
    return {
      "Trackerboard ID": phase.id,
      Status: phase.status,
      Wave: wave.id,
      Lane: phase.lane,
      Owner: phase.owner,
      Order: order,
    }[fieldName];
  }

  function setItemValue(ref, item, phaseId, fieldName, previous, desired) {
    const latest = rereadBeforeMutation(ref, previous, desired);
    if (!latest) throw new BoardError("GitHub Project is unavailable.");
    const value = desiredFieldValue(desired, phaseId, fieldName);
    if (value === undefined) return;
    const currentItem = latest.items.find((entry) => itemId(entry) === item.id) || item.item;
    const definition = PROJECT_FIELDS.find((entry) => entry.name === fieldName);
    const currentField = fieldByName(latest.fields || [], fieldName);
    if (!currentField || !definition) throw new BoardError(`GitHub Project field ${fieldName} is unavailable.`);
    const currentValue = valueOf(currentItem, currentField);
    const wanted = value === "" && definition.type === "TEXT" ? undefined : value;
    if (String(currentValue ?? "") === String(wanted ?? "")) return;
    const args = ["project", "item-edit", "--id", item.id, "--project-id", latest.ref.id || ref.id || "", "--field-id", currentField.id];
    if (definition.type === "TEXT") {
      if (value === "") args.push("--clear");
      else args.push("--text", String(value));
    } else if (definition.type === "NUMBER") args.push("--number", String(value));
    else if (definition.type === "SINGLE_SELECT") {
      const optionId = statusValue(currentField)[String(value).toLowerCase()];
      if (!optionId) throw new BoardError(`GitHub Project Status option ${value} is missing.`);
      args.push("--single-select-option-id", optionId);
    }
    run(client, args);
  }

  function updateDraftTitleOrBody(ref, item, key, phaseId, boardId, phaseItems, previous, desired) {
    const latest = rereadBeforeMutation(ref, previous, desired);
    if (!latest) throw new BoardError("GitHub Project is unavailable.");
    const position = phasePosition(desired, phaseId);
    if (!position) return;
    const pendingDelete = deletionManifest(latest, wantedPhaseIds(desired), phaseItems);
    const value = key === "title" ? position.phase.title || position.phase.id : phaseBody(boardId, phaseItems, pendingDelete, desired, phaseId);
    const latestItem = latest.items.find((entry) => itemId(entry) === item.id) || item.item;
    const current = key === "title" ? itemTitle(latestItem) : itemBody(latestItem);
    if (current === value) return;
    const draftId = draftItemId(latestItem) || item.draftId;
    if (!draftId) throw new BoardError(`GitHub did not return the draft issue ID needed to update phase ${latestItem?.title || "item"}; verify gh is ${MIN_GH_VERSION} or newer.`);
    run(client, ["project", "item-edit", "--id", draftId, "--project-id", latest.ref.id || ref.id || "", `--${key}`, value]);
  }

  function deletionManifest(snapshot, wantedIds, phaseItems) {
    const byPhase = new Map();
    for (const entry of snapshot?.metadata?.pendingDelete || []) {
      const id = String(entry?.id || "");
      if (id && entry?.itemId && !wantedIds.has(id)) byPhase.set(id, { id, itemId: String(entry.itemId) });
    }
    for (const id of snapshot?.metadata?.phaseIds || []) {
      if (wantedIds.has(id)) continue;
      const mappedId = phaseItems[id] || snapshot?.metadata?.phaseItems?.[id];
      if (mappedId) byPhase.set(String(id), { id: String(id), itemId: String(mappedId) });
    }
    return [...byPhase.values()];
  }

  function syncPass(ref, boardId, desired, { previous, starting }) {
    let current = starting || readRemote(ref);
    if (previous && current?.loaded?.board) assertNoConflicts(previous, desired, current.loaded.board);
    const phaseItems = { ...(current?.metadata?.phaseItems || {}) };
    updatePhaseMappings(current, desired, phaseItems);

    // Publish the desired manifest before item mutations. Missing mappings can
    // be recovered from the phase ID in each draft body on retry.
    writeReadme(ref, boardId, phaseItems, false, previous, desired);
    setProjectTitle(ref, previous, desired);

    const phaseIds = [...wantedPhaseIds(desired)];
    for (const phaseId of phaseIds) {
      let latest = rereadBeforeMutation(ref, previous, desired);
      if (!latest) throw new BoardError("GitHub Project is unavailable.");
      const position = phasePosition(desired, phaseId);
      if (!position) continue;
      mutationConflictState(previous, desired, latest);
      updatePhaseMappings(latest, desired, phaseItems);
      let mapped = managedItems(latest).get(phaseId);
      let itemRef = mapped ? { id: mapped.id, draftId: mapped.draftId, item: mapped.item } : null;
      const pendingDelete = deletionManifest(latest, wantedPhaseIds(desired), phaseItems);
      const body = phaseBody(boardId, phaseItems, pendingDelete, desired, phaseId);
      const title = position.phase.title || phaseId;
      if (!itemRef) {
        run(client, ["project", "item-create", String(ref.number), "--owner", ref.owner, "--title", title, "--body", body, "--format", "json"]);
        latest = readRemote(ref, { allowMissing: true });
        mapped = managedItems(latest).get(phaseId);
        if (!mapped) throw new BoardError(`GitHub draft item for phase ${phaseId} was created without a readable item ID; retry save to reconcile it.`);
        itemRef = { id: mapped.id, draftId: mapped.draftId, item: mapped.item };
        phaseItems[phaseId] = mapped.id;
      }
      const latestItem = latest.items.find((entry) => itemId(entry) === itemRef.id) || itemRef.item;
      const latestTitle = itemTitle(latestItem);
      const latestBody = itemBody(latestItem);
      if (latestTitle !== (phasePosition(desired, phaseId)?.phase.title || phaseId)) {
        updateDraftTitleOrBody(ref, itemRef, "title", phaseId, boardId, phaseItems, previous, desired);
      }
      if (latestBody !== phaseBody(boardId, phaseItems, deletionManifest(latest, wantedPhaseIds(desired), phaseItems), desired, phaseId)) {
        updateDraftTitleOrBody(ref, itemRef, "body", phaseId, boardId, phaseItems, previous, desired);
      }
      for (const fieldName of PHASE_FIELDS) setItemValue(ref, itemRef, phaseId, fieldName, previous, desired);
    }

    // Recompute the deletion set on every mutation-time read so a remotely
    // added phase merged above cannot be mistaken for a local deletion.
    let latest = readRemote(ref, { allowMissing: true });
    for (const entry of deletionManifest(latest, wantedPhaseIds(desired), phaseItems)) {
      latest = rereadBeforeMutation(ref, previous, desired);
      if (!latest) throw new BoardError("GitHub Project is unavailable.");
      const currentDeletion = deletionManifest(latest, wantedPhaseIds(desired), phaseItems).find((candidate) => candidate.itemId === entry.itemId);
      if (!currentDeletion) continue;
      const candidate = latest.items.find((item) => itemId(item) === currentDeletion.itemId);
      if (!candidate) continue;
      if (!isDraftItem(candidate)) throw new BoardError(`Refusing to remove non-draft GitHub item mapped to Trackerboard phase ${currentDeletion.id}.`);
      run(client, ["project", "item-delete", String(ref.number), "--owner", ref.owner, "--id", currentDeletion.itemId]);
      delete phaseItems[currentDeletion.id];
    }

    latest = readRemote(ref, { allowMissing: true });
    updatePhaseMappings(latest, desired, phaseItems);
    writeReadme(ref, boardId, phaseItems, true, previous, desired);
    return rereadBeforeMutation(ref, previous, desired);
  }

  function mutationConflictState(previous, desired, remote) {
    if (previous && remote?.loaded?.board) assertNoConflicts(previous, desired, remote.loaded.board);
  }

  function syncBoard(ref, boardId, desired, { previous = null, starting = null } = {}) {
    let current = starting || readRemote(ref);
    for (let pass = 0; pass < MAX_RECONCILIATION_PASSES; pass++) {
      const before = JSON.stringify(desired);
      current = syncPass(ref, boardId, desired, { previous, starting: current });
      const changedDuringPass = JSON.stringify(desired) !== before;
      if (!changedDuringPass) {
        const nextRevision = revisionToken(current?.loaded?.board, current?.metadata);
        setCachedRevision(nextRevision);
        return nextRevision;
      }
    }
    throw new BoardError("GitHub Project kept changing during save. Reload the board and retry.");
  }

  return { syncBoard, deletionManifest };
}
