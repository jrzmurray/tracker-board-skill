import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { createEditorCallbacks } from "./editor-operations.mjs";
import { EditorRevisionConflict, createEditorRouteHandler } from "./serve.mjs";

const capability = () => randomBytes(32).toString("base64url");
const encode = (value) => Buffer.from(JSON.stringify(value));

function tokenMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(encode(value));
}

function readControlBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        request.resume();
        reject(new Error("control request too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("control request must be JSON")); }
    });
    request.on("error", reject);
  });
}

function page(entries) {
  const rows = entries.length ? entries.map((entry) => {
    const label = entry.title && entry.title !== entry.name ? `${entry.title} (${entry.name})` : entry.name;
    const link = entry.url
      ? `<a href="${escapeHtml(entry.url)}">${escapeHtml(label)}</a>`
      : escapeHtml(label);
    return `<tr><td>${link}</td><td>${escapeHtml(entry.backend)}</td><td>${escapeHtml(entry.status)}</td></tr>`;
  }).join("") : '<tr><td colspan="3">No boards found.</td></tr>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Trackerboard</title><style>body{font:16px system-ui,sans-serif;max-width:900px;margin:3rem auto;padding:0 1rem;color:#202124}h1{font-size:1.5rem}table{border-collapse:collapse;width:100%}th,td{padding:.65rem;text-align:left;border-bottom:1px solid #ddd}th{font-weight:600}a{color:#075cc8}</style></head><body><h1>Trackerboard</h1><table><thead><tr><th>Board</th><th>Backend</th><th>Availability</th></tr></thead><tbody>${rows}</tbody></table><script>setInterval(()=>location.reload(),10_000)</script></body></html>`;
}

function availability(error) {
  if (!error) return "available";
  if (/needs-binding|binding|ambiguous|configured|target/i.test(error.message || "")) return "needs binding";
  return "unavailable";
}

function routePrefix(boardId) {
  return `/b/${encodeURIComponent(boardId)}`;
}

/**
 * Start one shared loopback listener. The caller owns process singleton
 * management and supplies a private control capability for CLI-only actions.
 */
export async function startSharedBoardServer({ store, port = 0, controlToken = capability(), onStop = () => {} } = {}) {
  if (!store) throw new TypeError("store is required");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("port must be an integer from 0 through 65535");

  const indexToken = capability();
  const active = new Map();
  const retired = new Set();
  let entries = [];
  let origin = "";
  let authority = "";
  let lastScanAt = 0;
  let scanPromise = null;
  let stopping = false;
  let timer;

  const indexUrl = () => `${origin}/i/${indexToken}`;
  const boardUrl = (entry) => entry?.route ? `${origin}${entry.route}` : null;

  async function scan() {
    if (scanPromise) return scanPromise;
    if (Date.now() - lastScanAt < 2_000) return entries;
    scanPromise = (async () => {
      const result = await store.withLock(() => {
        const names = store.listBoards();
        const records = [];
        for (const name of names) {
          try {
            const identity = store.ensureBoardIdentity(name);
            const info = store.backendTargetInfo(name);
            records.push({ name, boardId: identity.boardId, info });
          } catch (error) {
            records.push({ name, error });
          }
        }
        const inspection = store.inspectBackendTargets(names);
        return { records, collisions: inspection.collisions };
      });
      const collisionNames = new Set(result.collisions.flatMap((collision) => collision.boards));
      const nextEntries = [];
      const seen = new Set();
      for (const item of result.records) {
        let status = item.error ? availability(item.error) : "available";
        const backend = item.info?.backend || "unknown";
        const identityKey = item.info?.identity ? JSON.stringify(item.info.identity) : "";
        if (collisionNames.has(item.name)) status = "duplicate storage target";
        else if (!identityKey) status = "needs binding";
        else if (backend !== "json") status = "backend not enabled by this service";

        const old = item.boardId ? active.get(item.boardId) : null;
        const sameTarget = old && old.name === item.name && old.identityKey === identityKey;
        const entry = {
          name: item.name,
          title: old?.title || item.name,
          boardId: item.boardId || "",
          backend,
          status,
          identityKey,
          route: null,
          handle: null,
        };
        if (status === "available" && backend === "json") {
          try {
            // Phase 2 registers JSON boards only. Loading here catches corrupt
            // boards independently without preventing other entries from serving.
            const board = item.info && store.loadBoard(item.name);
            entry.title = board?.title || item.name;
            const baseRoute = routePrefix(entry.boardId);
            entry.route = sameTarget ? old.route : `${baseRoute}/${capability()}`;
            entry.handle = sameTarget ? old.handle : null;
            if (!entry.handle) {
              const callbacks = createEditorCallbacks({
                boardName: entry.name,
                revisionConflict: () => new EditorRevisionConflict(),
              });
              entry.handle = createEditorRouteHandler({
                boardName: entry.name,
                token: entry.route.split("/").at(-1),
                routePrefix: baseRoute,
                getOrigin: () => origin,
                ...callbacks,
                isRevisionCurrent: (expected, current) => Object.is(expected, current),
              });
            }
            entry.status = "available";
          } catch {
            entry.status = "unavailable";
            if (sameTarget) {
              entry.route = old.route;
              entry.handle = old.handle;
            }
          }
        } else if (sameTarget && status === "unavailable") {
          // Outages do not revoke a capability. The handler will recover when
          // the underlying target becomes readable again.
          entry.route = old.route;
          entry.handle = old.handle;
        }

        if (item.boardId) seen.add(item.boardId);
        if (old && old.route && (!sameTarget || (!entry.route && status !== "unavailable"))) retired.add(old.route);
        if (entry.boardId) active.set(entry.boardId, entry);
        nextEntries.push(entry);
      }
      for (const [boardId, previous] of active) {
        if (!seen.has(boardId)) {
          if (previous.route) retired.add(previous.route);
          active.delete(boardId);
        }
      }
      entries = nextEntries;
      lastScanAt = Date.now();
      return entries;
    })().finally(() => { scanPromise = null; });
    return scanPromise;
  }

  function boardEntries() {
    return entries.map((entry) => ({
      name: entry.name,
      title: entry.title,
      backend: entry.backend,
      status: entry.status,
      route: entry.route,
      url: boardUrl(entry),
    }));
  }

  async function control(request, response) {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    const authorization = request.headers.authorization;
    const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!tokenMatches(supplied, controlToken)) {
      sendJson(response, 401, { error: "authenticated control capability required" });
      return;
    }
    let body;
    try { body = await readControlBody(request); }
    catch (error) { sendJson(response, 400, { error: error.message }); return; }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.op !== "string") {
      sendJson(response, 400, { error: "control operation is required" });
      return;
    }
    if (body.op === "status") {
      if (Object.keys(body).some((key) => key !== "op")) { sendJson(response, 400, { error: "status accepts no extra fields" }); return; }
      sendJson(response, 200, { running: true, origin, port: Number(authority.split(":").at(-1)) });
      return;
    }
    if (body.op === "index") {
      if (Object.keys(body).some((key) => key !== "op")) { sendJson(response, 400, { error: "index accepts no extra fields" }); return; }
      await scan();
      sendJson(response, 200, { url: indexUrl() });
      return;
    }
    if (body.op === "board") {
      if (Object.keys(body).some((key) => !["op", "name"].includes(key))) { sendJson(response, 400, { error: "board lookup accepts only a name" }); return; }
      if (typeof body.name !== "string" || !body.name.trim()) {
        sendJson(response, 400, { error: "board name is required" });
        return;
      }
      await scan();
      const found = entries.find((entry) => entry.name === body.name);
      if (!found) { sendJson(response, 404, { error: `board ${body.name} not found` }); return; }
      if (!found.route) { sendJson(response, 409, { error: `board ${body.name} is ${found.status}` }); return; }
      sendJson(response, 200, { url: boardUrl(found) });
      return;
    }
    if (body.op === "stop") {
      if (Object.keys(body).some((key) => key !== "op")) { sendJson(response, 400, { error: "stop accepts no extra fields" }); return; }
      sendJson(response, 200, { stopping: true });
      if (!stopping) {
        stopping = true;
        setImmediate(() => onStop());
      }
      return;
    }
    sendJson(response, 400, { error: "unsupported control operation" });
  }

  const server = http.createServer(async (request, response) => {
    const pathname = (() => {
      try { return new URL(request.url, "http://127.0.0.1").pathname; }
      catch { return ""; }
    })();
    if (request.headers.host !== authority) {
      sendJson(response, 421, { error: "request Host does not match this loopback server" });
      return;
    }
    if (pathname === "/_control") return control(request, response);
    if (pathname === `/i/${indexToken}` && request.method === "GET") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(page(boardEntries()));
      return;
    }
    for (const entry of active.values()) {
      if (entry.route && entry.handle && (pathname === entry.route || pathname.startsWith(`${entry.route}/`))) {
        try {
          if (await entry.handle(request, response)) return;
        } catch {
          sendJson(response, 500, { error: "could not handle this board request" });
          return;
        }
      }
    }
    if ([...retired].some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
      sendJson(response, 410, { error: "this board URL has been revoked" });
      return;
    }
    sendJson(response, 404, { error: "not found" });
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
    throw new Error("shared Trackerboard server failed to bind exclusively to 127.0.0.1");
  }
  authority = `127.0.0.1:${address.port}`;
  origin = `http://${authority}`;
  await scan();
  timer = setInterval(() => { scan().catch(() => {}); }, 10_000);
  timer.unref();

  return {
    server,
    port: address.port,
    origin,
    controlToken,
    indexToken,
    indexUrl: indexUrl(),
    boardUrl(name) { return boardUrl(entries.find((entry) => entry.name === name)); },
    async rescan() { return scan(); },
    close() {
      clearInterval(timer);
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function controlRequest({ origin, token, op, name, timeoutMs = 3_000 }) {
  const url = new URL("/_control", origin);
  const body = JSON.stringify({ op, ...(name ? { name } : {}) });
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: "POST",
      headers: {
        Host: url.host,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let result;
        try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { reject(new Error("shared Trackerboard control response was invalid")); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(Object.assign(new Error(result.error || "shared Trackerboard control request failed"), { status: response.statusCode }));
          return;
        }
        resolve(result);
      });
    });
    request.on("timeout", () => request.destroy(new Error("shared Trackerboard control request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}
