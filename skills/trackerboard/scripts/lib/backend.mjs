import { BoardError } from "./board.mjs";

// Adapters register as a module side effect. initialize() is the one-time
// process setup hook (for example, loading sql.js); open() is then synchronous
// and returns a synchronous CRUD adapter. Its context is:
// {name, bindingKey, config, cwd, repoRoot, repoUrl, local, loadLocal, saveLocal,
//  boardPath, dataHome}. The adapter methods are load() -> canonical board,
// create(board), save(board, {previous, expectedRevision}) -> revision,
// revision() -> opaque token, and remove(). `revision` is monotonic for local
// backends; a remote backend can provide a best-effort token or null if its
// service offers no compare-and-swap. Remote saves reread and reconcile before
// applying narrow mutations; they never replace the whole board blindly.
const factories = new Map();
const initialized = new Set();

export function registerBackendFactory(kind, factory) {
  if (!kind || typeof factory?.open !== "function") throw new TypeError("backend factory needs a kind and open(context) function");
  if (factories.has(kind)) throw new TypeError(`backend factory already registered for ${kind}`);
  factories.set(kind, factory);
}

export async function initializeBackendFactories() {
  for (const [kind, factory] of factories) {
    if (initialized.has(kind)) continue;
    await factory.initialize?.();
    initialized.add(kind);
  }
}

export function openBackend(kind, context) {
  const factory = factories.get(kind);
  if (!factory) throw new BoardError(`backend adapter "${kind}" is unavailable`);
  if (!initialized.has(kind)) throw new BoardError(`backend adapter "${kind}" has not been initialized`);
  const adapter = factory.open(context);
  for (const method of ["load", "create", "save", "revision", "remove"]) {
    if (typeof adapter?.[method] !== "function") throw new TypeError(`${kind} backend is missing ${method}()`);
  }
  return adapter;
}

