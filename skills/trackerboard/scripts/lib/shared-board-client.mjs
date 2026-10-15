import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EditorRevisionConflict } from "./serve.mjs";

const WORKER = fileURLToPath(new URL("./shared-board-worker.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reviveError(value = {}) {
  if (value.code === "TRACKERBOARD_REVISION_CONFLICT") return new EditorRevisionConflict(value.message);
  return Object.assign(new Error(value.message || "board operation failed"), {
    name: value.name || "Error",
    ...(value.code ? { code: value.code } : {}),
    ...(Number.isInteger(value.status) ? { status: value.status } : {}),
  });
}

function shouldBackoff(error) {
  return !(
    (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) ||
    error?.code === "TRACKERBOARD_REVISION_CONFLICT"
  );
}

/**
 * A board gets its own process because backend adapters, especially gh, use
 * synchronous CLI calls. The parent HTTP process never waits synchronously on
 * one board's backend.
 */
export function createSharedBoardClient({
  boardName,
  targetIdentity,
  onSuccess = () => {},
  onFailure = () => {},
  spawnWorker = fork,
  now = Date.now,
  random = Math.random,
} = {}) {
  if (typeof boardName !== "string" || !boardName) throw new TypeError("boardName is required");
  const remoteTarget = targetIdentity?.backend === "github";
  let child = null;
  let nextId = 0;
  let failureCount = 0;
  let retryAt = 0;
  let snapshotInFlight = null;
  let closing = false;
  let closed = false;
  let closePromise = null;
  const pending = new Map();

  function failPending(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function ensureWorker() {
    if (child || closed || closing) return child;
    const worker = spawnWorker(WORKER, [], {
      execArgv: [],
      env: {
        ...process.env,
        TRACKERBOARD_SHARED_WORKER_BOARD: boardName,
        TRACKERBOARD_SHARED_WORKER_TARGET: JSON.stringify(targetIdentity || null),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child = worker;
    worker.on("message", (message) => {
      const request = pending.get(message?.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve(message.result);
      else request.reject(reviveError(message.error));
    });
    worker.on("error", (error) => {
      failPending(error);
      if (child === worker) child = null;
    });
    worker.on("exit", (code, signal) => {
      const error = new Error(`board worker exited (${signal || code || "unknown"})`);
      failPending(error);
      if (child === worker) child = null;
      if (closing) closed = true;
    });
    return worker;
  }

  function rawRequest(op, payload = {}) {
    if (closing || closed) return Promise.reject(new Error("board worker is no longer active"));
    const worker = ensureWorker();
    if (!worker?.connected) return Promise.reject(new Error("board worker is unavailable"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.send({ id, op, ...payload }, (error) => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  }

  async function request(op, payload) {
    if (now() < retryAt) {
      throw Object.assign(new Error("backend is temporarily unavailable; retry after the per-board backoff"), { code: "TRACKERBOARD_BACKEND_BACKOFF" });
    }
    try {
      const result = await rawRequest(op, payload);
      failureCount = 0;
      retryAt = 0;
      onSuccess(result);
      return result;
    } catch (error) {
      if (remoteTarget && shouldBackoff(error)) {
        failureCount = Math.min(failureCount + 1, 16);
        const base = Math.min(60_000, 2_000 * (2 ** (failureCount - 1)));
        const jittered = Math.round(base * (0.9 + random() * 0.2));
        retryAt = now() + Math.min(60_000, jittered);
        onFailure(error, { retryAt, failureCount });
      }
      throw error;
    }
  }

  function snapshot() {
    if (snapshotInFlight) return snapshotInFlight;
    snapshotInFlight = request("snapshot").finally(() => { snapshotInFlight = null; });
    return snapshotInFlight;
  }

  function applyCommand(command, expectedRevision) {
    return request("command", { command, expectedRevision });
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    const worker = child;
    closePromise = (async () => {
      if (!worker) { closed = true; return; }
      const exited = new Promise((resolve) => worker.once("exit", resolve));
      if (worker.connected) {
        try { worker.send({ op: "shutdown" }); } catch {}
      }
      await Promise.race([exited, sleep(1_000)]);
      if (child === worker && !closed) {
        worker.kill();
        await Promise.race([exited, sleep(500)]);
      }
      closed = true;
      child = null;
      failPending(new Error("board worker was retired"));
    })();
    return closePromise;
  }

  return { snapshot, applyCommand, close, get retryAt() { return retryAt; } };
}
