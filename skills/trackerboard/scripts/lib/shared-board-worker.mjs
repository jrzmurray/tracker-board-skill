import { EditorRevisionConflict } from "./serve.mjs";
import { createEditorCallbacks } from "./editor-operations.mjs";
import * as S from "./store.mjs";

const boardName = process.env.TRACKERBOARD_SHARED_WORKER_BOARD;
let expectedTargetIdentity;
try {
  expectedTargetIdentity = JSON.parse(process.env.TRACKERBOARD_SHARED_WORKER_TARGET || "null");
} catch {
  expectedTargetIdentity = null;
}

let callbacksPromise;
let queue = Promise.resolve();
let shuttingDown = false;

function serializeError(error) {
  return {
    name: String(error?.name || "Error"),
    message: String(error?.message || "board operation failed"),
    ...(error?.code ? { code: String(error.code) } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  };
}

async function callbacks() {
  if (!callbacksPromise) {
    callbacksPromise = (async () => {
      await S.initializeBackends();
      return createEditorCallbacks({
        boardName,
        expectedTargetIdentity,
        revisionConflict: (message) => new EditorRevisionConflict(message),
      });
    })();
  }
  return callbacksPromise;
}

async function processRequest(message) {
  try {
    if (typeof boardName !== "string" || !boardName) throw new Error("board worker has no board name");
    const editor = await callbacks();
    const result = message.op === "snapshot"
      ? await editor.loadSnapshot()
      : message.op === "command"
        ? await editor.applyCommand(message.command, message.expectedRevision)
        : (() => { throw new Error("unsupported board worker operation"); })();
    process.send?.({ id: message.id, ok: true, result });
  } catch (error) {
    process.send?.({ id: message.id, ok: false, error: serializeError(error) });
  }
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.op === "shutdown") {
    if (shuttingDown) return;
    shuttingDown = true;
    queue.finally(() => process.disconnect());
    return;
  }
  if (shuttingDown) {
    process.send?.({ id: message.id, ok: false, error: serializeError(new Error("board worker is shutting down")) });
    return;
  }
  queue = queue.then(() => processRequest(message)).catch(() => {});
});
