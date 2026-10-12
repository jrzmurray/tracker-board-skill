import { BoardError } from "./board.mjs";

// Adapters are registered by their module and share this synchronous contract
// after initializeBackends() has completed. `revision` is an opaque token:
// JSON/SQLite use monotonic integers; remote backends may use a best-effort
// token or null when the service has no compare-and-swap primitive.
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

