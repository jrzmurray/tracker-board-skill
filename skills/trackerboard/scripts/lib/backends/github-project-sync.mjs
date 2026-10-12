import { BoardError } from "../board.mjs";
import {
  MAX_NODE_ID_BYTES, PROJECT_FIELDS, assertSizes, draftItemId, fieldByName,
  isDraftItem, itemBody, itemId, itemTitle, makeMetadata, readmeOf,
  revisionToken, run, statusValue, valueOf, withMetadata,
} from "./github-project-core.mjs";

export function createGitHubProjectSynchronizer({ client, readRemote, rereadBeforeMutation, assertNoConflicts, managedItems, setCachedRevision }) {
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
    const finalMetadata = makeMetadata(desired, boardId, phaseItems, stillDeleting, true);
    writeReadme(ref, fieldState, finalMetadata, previous, desired);
    const after = readRemote(ref);
    const nextRevision = revisionToken(after?.loaded?.board, after?.metadata);
    setCachedRevision(nextRevision);
    return nextRevision;
  }
  return { syncBoard, deletionManifest };
}
