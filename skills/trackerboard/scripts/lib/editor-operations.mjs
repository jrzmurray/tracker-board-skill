import * as B from "./board.mjs";
import * as S from "./store.mjs";
import { createHash } from "node:crypto";

const boardFields = new Set(B.BOARD_FIELDS);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new B.BoardError(`${label} must be an object`);
  return value;
}

function requireFields(value, allowed, label) {
  requireObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new B.BoardError(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function basePhase(board, id, wave) {
  try { return B.locatePhase(board, id, wave); }
  catch { return null; }
}

function changedInboundDependencies(base, current, phaseIds) {
  const ids = new Set(phaseIds.map((id) => id.toLowerCase()));
  const oldPhases = new Map(B.allPhases(base).map(({ phase }) => [phase.id.toLowerCase(), phase]));
  for (const { phase } of B.allPhases(current)) {
    if (ids.has(phase.id.toLowerCase())) continue;
    const before = oldPhases.get(phase.id.toLowerCase());
    for (const dependency of phase.deps) {
      if (ids.has(dependency.toLowerCase()) && !before?.deps.some((item) => item.toLowerCase() === dependency.toLowerCase())) return true;
    }
  }
  return false;
}

function logOperationHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function rebaseCommand(command, base, current, conflict) {
  const next = structuredClone(command);
  switch (next.type) {
    case "wave.create":
      if (B.findWave(current, next.id)) throw conflict();
      return next;
    case "phase.create":
      if (B.allPhases(current).some(({ phase }) => phase.id.toLowerCase() === next.id.toLowerCase())) throw conflict();
      return next;
    case "board.update":
      next.fields = Object.fromEntries(Object.entries(next.fields).filter(([key, value]) => !same(String(base[key] ?? ""), String(value))));
      return Object.keys(next.fields).length ? next : null;
    case "wave.update": {
      const oldWave = B.findWave(base, next.id), liveWave = B.findWave(current, next.id);
      if (!oldWave || !liveWave) throw conflict();
      next.fields = Object.fromEntries(Object.entries(next.fields || {}).filter(([key, value]) => !same(oldWave[key] ?? "", value)));
      if (next.rename && next.rename.toLowerCase() === oldWave.id.toLowerCase()) delete next.rename;
      if (!Object.keys(next.fields).length && !next.rename) return null;
      return next;
    }
    case "phase.update": {
      const old = basePhase(base, next.id, next.wave), live = basePhase(current, next.id, next.wave);
      if (!old || !live) throw conflict();
      next.fields = Object.fromEntries(Object.entries(next.fields || {}).filter(([key, value]) => !same(old.phase[key] ?? "", value)));
      if (next.rename && next.rename.toLowerCase() === old.phase.id.toLowerCase()) delete next.rename;
      if (next.toWave && next.toWave.toLowerCase() === old.wave.id.toLowerCase()) delete next.toWave;
      if (!Object.keys(next.fields).length && !next.rename && !next.toWave) return null;
      return next;
    }
    case "phase.delete": {
      const old = basePhase(base, next.id, next.wave), live = basePhase(current, next.id, next.wave);
      if (!old || !live || !same(old.phase, live.phase) || changedInboundDependencies(base, current, [old.phase.id])) throw conflict();
      return next;
    }
    case "wave.delete": {
      const old = B.findWave(base, next.id), live = B.findWave(current, next.id);
      const phaseIds = old?.phases.map((phase) => phase.id) || [];
      if (!old || !live || !same(old, live) || changedInboundDependencies(base, current, phaseIds)) throw conflict();
      return next;
    }
    case "dependency.set": {
      const old = basePhase(base, next.phase), live = basePhase(current, next.phase);
      if (!old || !live) throw conflict();
      if (same(old.phase.deps, next.deps)) return null;
      if (!same(old.phase.deps, live.phase.deps)) throw conflict();
      return next;
    }
    default:
      return next;
  }
}

export function createEditorCallbacks({
  boardName,
  revisionConflict,
  expectedTargetIdentity = null,
  store = S,
  remoteCacheMs = 60_000,
  now = Date.now,
}) {
  let remoteSnapshot = null;
  let remoteSnapshotAt = 0;
  let remoteRead = null;
  const remoteBases = new Map();

  function rememberRemote(snapshot) {
    if (snapshot.revision != null) {
      remoteBases.set(snapshot.revision, structuredClone(snapshot.board));
      while (remoteBases.size > 20) remoteBases.delete(remoteBases.keys().next().value);
    }
  }

  function remote() {
    return store.backendConfig(boardName).backend === "github";
  }

  function assertTargetCurrent() {
    if (!store.boardExists(boardName)) throw revisionConflict("board was removed; reload the Trackerboard index");
    if (!expectedTargetIdentity) return;
    const current = store.backendTargetInfo(boardName).identity;
    if (JSON.stringify(current) !== JSON.stringify(expectedTargetIdentity)) {
      throw revisionConflict("board backend changed; reload the Trackerboard index");
    }
  }

  async function loadSnapshot() {
    assertTargetCurrent();
    if (remote()) {
      if (remoteSnapshot && now() - remoteSnapshotAt < remoteCacheMs) return structuredClone(remoteSnapshot);
      if (!remoteRead) {
        remoteRead = Promise.resolve().then(() => {
          assertTargetCurrent();
          return Promise.resolve(store.loadBoard(boardName)).then((board) => ({ board, revision: store.getRevision(boardName) }));
        });
      }
      try {
        const snapshot = await remoteRead;
        remoteSnapshot = snapshot;
        remoteSnapshotAt = now();
        rememberRemote(snapshot);
        return structuredClone(snapshot);
      } finally {
        remoteRead = null;
      }
    }
    const board = await store.loadBoard(boardName);
    return { board, revision: store.getRevision(boardName) };
  }

  async function applyCommand(command, expectedRevision) {
    const mutate = async () => {
      // A route can outlive a migration until the next discovery scan. Recheck
      // the pinned backend under the same lock as the read-modify-write so an
      // old capability cannot write into the new target (or recreate removal).
      assertTargetCurrent();
      const isRemote = remote();
      const before = store.loadBoard(boardName);
      const revision = store.getRevision(boardName);
      if (!isRemote && expectedRevision != null && revision != null && expectedRevision !== revision) {
        throw revisionConflict();
      }
      const baseline = isRemote && expectedRevision != null ? remoteBases.get(expectedRevision) : before;
      if (isRemote && expectedRevision != null && !baseline && revision !== expectedRevision) throw revisionConflict();
      requireObject(command, "command");
      const args = isRemote ? rebaseCommand(command, baseline || before, before, revisionConflict) : command;
      if (!args) return { board: before, revision };
      const board = structuredClone(before);
      let duplicateOperation = false;
      try {
        switch (args.type) {
        case "board.update":
          requireFields(args.fields, boardFields, "board.update fields");
          for (const [key, value] of Object.entries(args.fields)) board[key] = String(value);
          break;
        case "wave.create":
          requireFields(args, new Set(["type", "id", "fields", "after"]), "wave.create");
          B.insertWave(board, args.id, args.fields || {}, { after: args.after });
          break;
        case "wave.update":
          requireFields(args, new Set(["type", "id", "fields", "rename"]), "wave.update");
          B.updateWave(board, args.id, args.fields || {}, { rename: args.rename });
          break;
        case "wave.delete":
          requireFields(args, new Set(["type", "id", "force"]), "wave.delete");
          B.deleteWave(board, args.id, { force: args.force });
          break;
        case "phase.create":
          requireFields(args, new Set(["type", "id", "wave", "fields"]), "phase.create");
          B.insertPhase(board, args.id, args.fields || {}, { wave: args.wave });
          break;
        case "phase.update":
          requireFields(args, new Set(["type", "id", "wave", "fields", "rename", "toWave"]), "phase.update");
          B.updatePhase(board, args.id, args.fields || {}, { wave: args.wave, rename: args.rename, toWave: args.toWave });
          break;
        case "phase.delete":
          requireFields(args, new Set(["type", "id", "wave"]), "phase.delete");
          B.deletePhase(board, args.id, args.wave);
          break;
        case "dependency.set":
          requireFields(args, new Set(["type", "phase", "deps"]), "dependency.set");
          B.setDeps(board, args.phase, args.deps || []);
          break;
        case "dependency.add":
          requireFields(args, new Set(["type", "phase", "deps"]), "dependency.add");
          B.addDeps(board, args.phase, args.deps || []);
          break;
        case "dependency.remove":
          requireFields(args, new Set(["type", "phase", "deps"]), "dependency.remove");
          B.removeDeps(board, args.phase, args.deps || []);
          break;
        case "dependency.clear":
          requireFields(args, new Set(["type", "phase"]), "dependency.clear");
          B.setDeps(board, args.phase, []);
          break;
        case "log.append":
          requireFields(args, new Set(["type", "text", "operationId"]), "log.append");
          if (typeof args.text !== "string" || !args.text.trim()) throw new B.BoardError("log.append needs non-empty text");
          if (args.operationId !== undefined) {
            const receipt = store.getOperation?.(boardName, args.operationId);
            if (receipt) {
              if (receipt.hash !== logOperationHash(args.text)) throw new B.BoardError("log operation id was already used for different text");
              duplicateOperation = true;
              break;
            }
          }
          B.appendLog(board, args.text);
          break;
          default:
            throw new B.BoardError(`unsupported editor command ${JSON.stringify(args.type)}`);
        }
        B.validate(board);
      } catch (error) {
        if (error instanceof B.BoardError) error.status = 422;
        throw error;
      }
      if (duplicateOperation) {
        const result = { board: before, revision };
        if (remote()) {
          remoteSnapshot = result;
          remoteSnapshotAt = now();
          rememberRemote(result);
        }
        return structuredClone(result);
      }
      let nextRevision;
      try {
        nextRevision = await store.saveBoard(board, {
          previous: baseline || before,
          expectedRevision,
          ...(args.type === "log.append" && args.operationId
            ? { operation: { id: args.operationId, hash: logOperationHash(args.text) } }
            : {}),
        });
      } catch (error) {
        if (isRemote) {
          remoteSnapshot = null;
          remoteSnapshotAt = 0;
          remoteRead = null;
        }
        if (error?.code === "TRACKERBOARD_REVISION_CONFLICT") {
          throw revisionConflict();
        }
        throw error;
      }
      remoteSnapshot = null;
      remoteRead = null;
      const result = { board, revision: nextRevision };
      if (remote()) {
        remoteSnapshot = result;
        remoteSnapshotAt = now();
        rememberRemote(result);
      }
      return structuredClone(result);
    };
    const guardedMutate = async () => {
      try { return await mutate(); }
      catch (error) {
        if (error?.code === "TRACKERBOARD_REVISION_CONFLICT") {
          remoteSnapshot = null;
          remoteSnapshotAt = 0;
          remoteRead = null;
        }
        throw error;
      }
    };
    return typeof store.withBoardLock === "function"
      ? store.withBoardLock(boardName, guardedMutate)
      : store.withLock(guardedMutate);
  }

  return { loadSnapshot, applyCommand };
}
