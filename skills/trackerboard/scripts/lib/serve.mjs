import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOARD_FIELDS, PHASE_FIELDS, STATUSES, WAVE_FIELDS, normalizeStatus } from "./board.mjs";

const DEFAULT_EDITOR_HTML = fileURLToPath(new URL("../../assets/editor.html", import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 20_000;
const MAX_ID_LENGTH = 120;

export class EditorInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "EditorInputError";
    this.status = 400;
  }
}

export class EditorRevisionConflict extends Error {
  constructor(message = "board changed while this edit was being saved") {
    super(message);
    this.name = "EditorRevisionConflict";
    this.code = "TRACKERBOARD_REVISION_CONFLICT";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value, label) {
  if (!isRecord(value)) throw new EditorInputError(`${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new EditorInputError(`${label} contains unsupported field(s): ${unknown.join(", ")}`);
}

function text(value, label, max = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") throw new EditorInputError(`${label} must be a string`);
  if (value.length > max) throw new EditorInputError(`${label} exceeds ${max} characters`);
  return value;
}

function identifier(value, label) {
  const result = text(value, label, MAX_ID_LENGTH);
  if (!result.trim()) throw new EditorInputError(`${label} is required`);
  if (/[\u0000-\u001f\u007f]/.test(result)) throw new EditorInputError(`${label} contains control characters`);
  return result;
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.length > 500) throw new EditorInputError(`${label} must be a list of at most 500 strings`);
  return value.map((item, index) => identifier(item, `${label}[${index}]`));
}

const FIELD_LIMITS = {
  title: 1_000,
  subtitle: 1_000,
  lede: 10_000,
  notes: MAX_TEXT_LENGTH,
  repoUrl: 2_048,
  prefix: 120,
  lane: 120,
  owner: 300,
  status: 32,
  note: 4_000,
  req: MAX_TEXT_LENGTH,
  issue: 1_000,
  pr: 1_000,
  review: MAX_TEXT_LENGTH,
};

function validateFields(value, allowed, label, { allowDeps = false } = {}) {
  const fields = record(value, `${label} fields`);
  const permitted = allowDeps ? allowed : allowed.filter((field) => field !== "deps");
  exactKeys(fields, permitted, `${label} fields`);
  if (!Object.keys(fields).length) throw new EditorInputError(`${label} fields cannot be empty`);
  const result = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (key === "deps") {
      result.deps = stringList(raw, `${label} deps`);
      continue;
    }
    const value = text(raw, `${label} ${key}`, FIELD_LIMITS[key] ?? MAX_TEXT_LENGTH);
    if (key === "status") {
      try { result.status = normalizeStatus(value); }
      catch { throw new EditorInputError(`status must be one of: ${STATUSES.join(", ")}`); }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function validateCommand(raw) {
  const command = record(raw, "command");
  if (typeof command.type !== "string") throw new EditorInputError("command type is required");
  switch (command.type) {
    case "board.update":
      exactKeys(command, ["type", "fields"], "board.update");
      return { type: command.type, fields: validateFields(command.fields, BOARD_FIELDS, "board") };
    case "wave.create": {
      exactKeys(command, ["type", "id", "fields", "after"], "wave.create");
      const result = { type: command.type, id: identifier(command.id, "wave id") };
      if (command.fields !== undefined) result.fields = validateFields(command.fields, WAVE_FIELDS, "wave");
      if (command.after !== undefined) result.after = identifier(command.after, "wave after");
      return result;
    }
    case "wave.update": {
      exactKeys(command, ["type", "id", "fields", "rename"], "wave.update");
      const result = { type: command.type, id: identifier(command.id, "wave id") };
      if (command.fields !== undefined) result.fields = validateFields(command.fields, WAVE_FIELDS, "wave");
      if (command.rename !== undefined) result.rename = identifier(command.rename, "new wave id");
      if (!result.fields && !result.rename) throw new EditorInputError("wave.update needs fields or rename");
      return result;
    }
    case "wave.delete":
      exactKeys(command, ["type", "id", "force"], "wave.delete");
      if (command.force !== undefined && typeof command.force !== "boolean") throw new EditorInputError("wave.delete force must be a boolean");
      return { type: command.type, id: identifier(command.id, "wave id"), ...(command.force === undefined ? {} : { force: command.force }) };
    case "phase.create": {
      exactKeys(command, ["type", "id", "wave", "fields"], "phase.create");
      const result = { type: command.type, id: identifier(command.id, "phase id") };
      if (command.wave !== undefined) result.wave = identifier(command.wave, "wave id");
      if (command.fields !== undefined) result.fields = validateFields(command.fields, PHASE_FIELDS, "phase", { allowDeps: true });
      return result;
    }
    case "phase.update": {
      exactKeys(command, ["type", "id", "wave", "fields", "rename", "toWave"], "phase.update");
      const result = { type: command.type, id: identifier(command.id, "phase id") };
      if (command.wave !== undefined) result.wave = identifier(command.wave, "wave id");
      if (command.fields !== undefined) result.fields = validateFields(command.fields, PHASE_FIELDS, "phase", { allowDeps: true });
      if (command.rename !== undefined) result.rename = identifier(command.rename, "new phase id");
      if (command.toWave !== undefined) result.toWave = identifier(command.toWave, "destination wave id");
      if (!result.fields && !result.rename && !result.toWave) throw new EditorInputError("phase.update needs fields, rename, or toWave");
      return result;
    }
    case "phase.delete": {
      exactKeys(command, ["type", "id", "wave"], "phase.delete");
      const result = { type: command.type, id: identifier(command.id, "phase id") };
      if (command.wave !== undefined) result.wave = identifier(command.wave, "wave id");
      return result;
    }
    case "dependency.set":
    case "dependency.add":
    case "dependency.remove":
      exactKeys(command, ["type", "phase", "deps"], command.type);
      return { type: command.type, phase: identifier(command.phase, "phase id"), deps: stringList(command.deps, "dependencies") };
    case "dependency.clear":
      exactKeys(command, ["type", "phase"], command.type);
      return { type: command.type, phase: identifier(command.phase, "phase id") };
    case "log.append":
      exactKeys(command, ["type", "text"], "log.append");
      return { type: command.type, text: text(command.text, "log text", MAX_TEXT_LENGTH) };
    default:
      throw new EditorInputError(`unsupported command type: ${command.type}`);
  }
}

function constantTimeMatch(actual, expected) {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(JSON.stringify(value));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.resume();
        reject(new EditorInputError(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new EditorInputError("request body must be valid JSON")); }
    });
    request.on("error", reject);
  });
}

function isRevisionConflict(error) {
  return error instanceof EditorRevisionConflict || [
    "TRACKERBOARD_REVISION_CONFLICT", "REVISION_CONFLICT", "ERR_REVISION_CONFLICT",
  ].includes(error?.code);
}

function snapshotShape(snapshot) {
  return isRecord(snapshot) && isRecord(snapshot.board) && Object.hasOwn(snapshot, "revision");
}

function validateRevision(value) {
  if (value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) {
    throw new EditorInputError("expectedRevision must be a string, integer, or null");
  }
}

function requestPath(request) {
  try { return new URL(request.url, "http://127.0.0.1").pathname; }
  catch { return ""; }
}

function normalizeRoutePrefix(routePrefix) {
  if (routePrefix === undefined || routePrefix === null || routePrefix === "" || routePrefix === "/") return "";
  if (typeof routePrefix !== "string") throw new TypeError("routePrefix must be a URL path prefix");
  if (/[?#\\\u0000-\u001f\u007f]/.test(routePrefix)) throw new TypeError("routePrefix must not contain a query, fragment, backslash, or control character");
  const parts = routePrefix.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new TypeError("routePrefix must not contain dot segments");
  return parts.length ? `/${parts.join("/")}` : "";
}

function routeOrigin(getOrigin) {
  let value;
  try { value = getOrigin(); }
  catch { return null; }
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return { origin: parsed.origin, authority: parsed.host };
  } catch {
    return null;
  }
}

/**
 * Create a capability-protected editor route for a shared HTTP server.
 *
 * `routePrefix` scopes the handler beneath a caller-owned path. The editor page
 * keeps the complete path as its API base, so the capability remains the final
 * path segment and the page needs no mount-specific configuration. Its bearer
 * value is the complete mounted path, matching the page's pathname-derived
 * value. `getOrigin` is called for each request so a shared listener can supply
 * its origin after it binds. Return `true` when the pathname is inside this
 * route's prefix and the handler has produced a response, or `false` when
 * another route may own it.
 */
export function createEditorRouteHandler({
  boardName,
  token,
  routePrefix = "",
  getOrigin,
  loadSnapshot,
  applyCommand,
  editorHtmlPath = DEFAULT_EDITOR_HTML,
  isRevisionCurrent = Object.is,
} = {}) {
  if (typeof boardName !== "string" || !boardName.trim()) throw new TypeError("boardName is required");
  if (typeof token !== "string" || !token.trim() || /[/?#\\\u0000-\u001f\u007f]/.test(token)) throw new TypeError("token must be a non-empty URL path segment");
  if (typeof getOrigin !== "function") throw new TypeError("getOrigin must be a function");
  if (typeof loadSnapshot !== "function" || typeof applyCommand !== "function") throw new TypeError("loadSnapshot and applyCommand callbacks are required");
  if (typeof isRevisionCurrent !== "function") throw new TypeError("isRevisionCurrent must be a function");

  const prefix = normalizeRoutePrefix(routePrefix);
  const editorPath = `${prefix}/${token}`;
  const bearerCapability = editorPath.slice(1);
  const editorHtml = fs.readFileSync(path.resolve(editorHtmlPath), "utf8");

  return async function handleEditorRoute(request, response) {
    const pathname = requestPath(request);
    if (prefix && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;

    const binding = routeOrigin(getOrigin);
    if (!binding) {
      sendJson(response, 503, { error: "editor listener origin is not available" });
      return true;
    }
    if (request.headers.host !== binding.authority) {
      sendJson(response, 421, { error: "request Host does not match this editor" });
      return true;
    }

    if (pathname === editorPath && request.method === "GET") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(editorHtml);
      return true;
    }

    if (pathname === `${editorPath}/api/snapshot` && request.method === "GET") {
      try {
        const snapshot = await loadSnapshot();
        if (!snapshotShape(snapshot)) throw new TypeError("loadSnapshot must return {board, revision}");
        sendJson(response, 200, snapshot);
      } catch {
        sendJson(response, 500, { error: "could not load the current board snapshot" });
      }
      return true;
    }

    if (pathname !== `${editorPath}/api/command`) {
      sendJson(response, 404, { error: "not found" });
      return true;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "method not allowed" });
      return true;
    }
    if (!constantTimeMatch(request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "", bearerCapability)) {
      sendJson(response, 401, { error: "a valid bearer capability is required" });
      return true;
    }
    if (request.headers.origin !== binding.origin) {
      sendJson(response, 403, { error: "write Origin must exactly match this editor" });
      return true;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
      sendJson(response, 415, { error: "Content-Type must be application/json" });
      return true;
    }

    try {
      const body = record(await readJsonBody(request), "request body");
      exactKeys(body, ["expectedRevision", "command"], "request body");
      if (!Object.hasOwn(body, "expectedRevision")) throw new EditorInputError("expectedRevision is required");
      validateRevision(body.expectedRevision);
      const command = validateCommand(body.command);
      const current = await loadSnapshot();
      if (!snapshotShape(current)) throw new TypeError("loadSnapshot must return {board, revision}");
      if (!await isRevisionCurrent(body.expectedRevision, current.revision)) {
        sendJson(response, 409, { error: "board changed since this editor loaded it", snapshot: current });
        return true;
      }
      const next = await applyCommand(command, body.expectedRevision);
      if (!snapshotShape(next)) throw new TypeError("applyCommand must return {board, revision}");
      sendJson(response, 200, next);
    } catch (error) {
      if (isRevisionConflict(error)) {
        try {
          const snapshot = await loadSnapshot();
          sendJson(response, 409, { error: "board changed while this edit was being saved", snapshot: snapshotShape(snapshot) ? snapshot : null });
        } catch {
          sendJson(response, 409, { error: "board changed while this edit was being saved", snapshot: null });
        }
      } else if (error instanceof EditorInputError) {
        sendJson(response, error.status, { error: error.message });
      } else if (error?.status >= 400 && error.status < 500) {
        sendJson(response, 422, { error: String(error.message || "command could not be applied") });
      } else {
        sendJson(response, 500, { error: "could not apply this board command" });
      }
    }
    return true;
  };
}

/**
 * Start a capability-protected, IPv4 loopback editor server.
 *
 * `loadSnapshot()` returns `{board, revision}`. `applyCommand(command,
 * expectedRevision)` must acquire the shared store/backend lock, recheck the
 * revision while holding it, apply this already validated command, then return
 * the new `{board, revision}`. Throw `EditorRevisionConflict` for a failed
 * compare-and-swap so a race that occurs after the HTTP precheck returns 409.
 * `isRevisionCurrent(expected, current)` defaults to strict equality; a remote
 * adapter can accept a best-effort revision here and let applyCommand perform
 * its backend-specific reconcile/conflict check under the shared lock.
 */
export async function startEditorServer({ boardName, port = 0, loadSnapshot, applyCommand, editorHtmlPath = DEFAULT_EDITOR_HTML, isRevisionCurrent = Object.is } = {}) {
  if (typeof boardName !== "string" || !boardName.trim()) throw new TypeError("boardName is required");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("port must be an integer from 0 through 65535");
  const token = randomBytes(32).toString("base64url");

  let origin;
  let authority;
  const handleEditorRoute = createEditorRouteHandler({
    boardName,
    token,
    routePrefix: "",
    getOrigin: () => origin,
    loadSnapshot,
    applyCommand,
    editorHtmlPath,
    isRevisionCurrent,
  });
  const server = http.createServer(async (request, response) => {
    if (request.headers.host !== authority) {
      sendJson(response, 421, { error: "request Host does not match this loopback editor" });
      return;
    }
    await handleEditorRoute(request, response);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("editor server failed to bind exclusively to 127.0.0.1");
  }
  port = address.port;
  authority = `127.0.0.1:${port}`;
  origin = `http://${authority}`;
  const url = `${origin}/${token}`;
  return {
    server,
    port,
    origin,
    token,
    url,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
