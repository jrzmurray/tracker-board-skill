import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createEditorRouteHandler, EditorRevisionConflict, startEditorServer } from "../skills/trackerboard/scripts/lib/serve.mjs";

function fixture() {
  return { board: { schema: 1, name: "demo", title: "Before", waves: [], log: [] }, revision: 1 };
}

async function start(t, overrides = {}) {
  let current = fixture();
  let calls = 0;
  const server = await startEditorServer({
    boardName: "demo",
    port: 0,
    loadSnapshot: async () => structuredClone(current),
    applyCommand: async (command, expectedRevision) => {
      calls++;
      if (!Object.is(expectedRevision, current.revision)) throw new EditorRevisionConflict();
      if (command.type === "board.update") current.board.title = command.fields.title;
      current.revision++;
      return structuredClone(current);
    },
    ...overrides,
  });
  t.after(() => server.close());
  return {
    server,
    get current() { return current; },
    set current(value) { current = value; },
    get calls() { return calls; },
  };
}

async function startMounted(t) {
  let current = fixture();
  let loads = 0;
  let calls = 0;
  let origin;
  const token = "mounted-board-capability";
  const routePrefix = "/shared/boards/demo/editor";
  const handler = createEditorRouteHandler({
    boardName: "demo",
    token,
    routePrefix,
    getOrigin: () => origin,
    loadSnapshot: async () => {
      loads++;
      return structuredClone(current);
    },
    applyCommand: async (command, expectedRevision) => {
      calls++;
      if (!Object.is(expectedRevision, current.revision)) throw new EditorRevisionConflict();
      if (command.type === "board.update") current.board.title = command.fields.title;
      current.revision++;
      return structuredClone(current);
    },
  });
  const listener = http.createServer(async (request, response) => {
    const handled = await handler(request, response);
    if (!handled) {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      listener.removeListener("error", reject);
      resolve();
    });
  });
  const address = listener.address();
  origin = `http://127.0.0.1:${address.port}`;
  t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
  return {
    server: { token, bearerToken: `${routePrefix.slice(1)}/${token}`, origin, url: `${origin}${routePrefix}/${token}` },
    routePrefix,
    get loads() { return loads; },
    get calls() { return calls; },
  };
}

const json = (response) => response.json();

async function post(server, body, headers = {}) {
  return fetch(`${server.url}/api/command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${server.bearerToken ?? server.token}`,
      Origin: server.origin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function postWithHost(server, body, host) {
  const target = new URL(`${server.url}/api/command`);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: "POST",
      headers: {
        Host: host,
        "Content-Type": "application/json",
        Authorization: `Bearer ${server.bearerToken ?? server.token}`,
        Origin: server.origin,
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

test("editor binds only to IPv4 loopback and serves its capability URL", async (t) => {
  const { server } = await start(t);
  assert.deepEqual(server.server.address().address, "127.0.0.1");
  assert.equal(new URL(server.url).hostname, "127.0.0.1");
  assert.match(server.token, /^[A-Za-z0-9_-]{40,}$/);
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.match(await page.text(), /Trackerboard · local editor/);
  assert.equal((await fetch(`${server.origin}/not-the-capability`)).status, 404);
  assert.equal((await fetch(`${server.url}/api/snapshot`)).status, 200);
});

test("writes require capability bearer, exact origin, and the bound Host", async (t) => {
  const state = await start(t);
  const { server } = state;
  const body = { expectedRevision: 1, command: { type: "board.update", fields: { title: "After" } } };

  assert.equal((await post(server, body, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post(server, body, { Origin: "http://localhost" })).status, 403);
  assert.equal(await postWithHost(server, body, "example.com"), 421);
  assert.equal(state.calls, 0);

  const response = await post(server, body);
  assert.equal(response.status, 200);
  assert.equal((await json(response)).board.title, "After");
  assert.equal(state.calls, 1);
});

test("mounted editor page and snapshot stay beneath the configured route prefix", async (t) => {
  const state = await startMounted(t);
  const { server, routePrefix } = state;
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Trackerboard · local editor/);
  assert.equal(page.headers.get("cache-control"), "no-store");

  const snapshot = await fetch(`${server.url}/api/snapshot`);
  assert.equal(snapshot.status, 200);
  assert.equal((await json(snapshot)).board.title, "Before");
  const loadsBeforeMisses = state.loads;

  const wrongCapability = await fetch(`${server.origin}${routePrefix}/not-the-capability/api/snapshot`);
  const wrongCapabilityBody = await json(wrongCapability);
  assert.equal(wrongCapability.status, 404);
  assert.equal(wrongCapabilityBody.board, undefined);

  const wrongPrefix = await fetch(`${server.origin}/outside${routePrefix}/${server.token}/api/snapshot`);
  const wrongPrefixBody = await json(wrongPrefix);
  assert.equal(wrongPrefix.status, 404);
  assert.equal(wrongPrefixBody.board, undefined);
  assert.equal(state.loads, loadsBeforeMisses);
});

test("mounted editor writes retain Host, exact Origin, and bearer checks", async (t) => {
  const state = await startMounted(t);
  const { server } = state;
  const body = { expectedRevision: 1, command: { type: "board.update", fields: { title: "After mount" } } };

  assert.equal((await post(server, body, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post(server, body, { Origin: "http://localhost" })).status, 403);
  assert.equal(await postWithHost(server, body, "example.com"), 421);
  assert.equal(state.calls, 0);

  const response = await post(server, body);
  assert.equal(response.status, 200);
  assert.equal((await json(response)).board.title, "After mount");
  assert.equal(state.calls, 1);
});

test("command and field validation happens before invoking the operation callback", async (t) => {
  const state = await start(t);
  const { server } = state;
  const invalid = [
    { expectedRevision: 1, command: { type: "board.replace", board: fixture().board } },
    { expectedRevision: 1, command: { type: "board.update", fields: { title: "ok", waves: [] } } },
    { expectedRevision: 1, command: { type: "phase.update", id: "P1", fields: { status: "turbo" } } },
    { expectedRevision: 1, command: { type: "dependency.set", phase: "P1", deps: "P0" } },
    { expectedRevision: 1, command: { type: "log.append", text: "entry", extra: true } },
    { expectedRevision: 1, command: { type: "board.update", fields: { title: { unsafe: true } } } },
  ];
  for (const body of invalid) {
    const response = await post(server, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.ok((await json(response)).error);
  }
  assert.equal(state.calls, 0);
  assert.equal((await fetch(`${server.origin}/${server.token}/api/command`, { method: "PUT" })).status, 405);
});

test("stale expected revisions return 409 without applying the command", async (t) => {
  const state = await start(t);
  const { server } = state;
  const request = await post(server, { expectedRevision: 0, command: { type: "board.update", fields: { title: "stale" } } });
  const response = await json(request);
  assert.equal(request.status, 409);
  assert.equal(response.snapshot.revision, state.current.revision);
  assert.equal(response.snapshot.board.title, "Before");
  assert.equal(state.calls, 0);
});

test("a compare-and-swap race reported under the callback lock also returns 409", async (t) => {
  let current = fixture();
  const server = await startEditorServer({
    boardName: "demo",
    port: 0,
    loadSnapshot: async () => structuredClone(current),
    applyCommand: async () => {
      current = { board: { ...current.board, title: "CLI update" }, revision: 2 };
      throw new EditorRevisionConflict("revision changed while waiting for the store lock");
    },
  });
  t.after(() => server.close());
  const request = await post(server, { expectedRevision: 1, command: { type: "board.update", fields: { title: "editor update" } } });
  const response = await json(request);
  assert.equal(request.status, 409);
  assert.equal(response.snapshot.board.title, "CLI update");
  assert.equal(response.snapshot.revision, 2);
});

test("custom revision comparison can defer a remote revision check to the backend callback", async (t) => {
  let current = { ...fixture(), revision: "remote-v2" };
  let calls = 0;
  const server = await startEditorServer({
    boardName: "demo",
    port: 0,
    loadSnapshot: async () => structuredClone(current),
    isRevisionCurrent: async (expected, actual) => expected === "remote-v1" && actual === "remote-v2",
    applyCommand: async () => {
      calls++;
      throw new EditorRevisionConflict("remote reconcile found a field conflict");
    },
  });
  t.after(() => server.close());
  const request = await post(server, { expectedRevision: "remote-v1", command: { type: "board.update", fields: { title: "editor update" } } });
  const response = await json(request);
  assert.equal(request.status, 409);
  assert.equal(calls, 1);
  assert.equal(response.snapshot.revision, "remote-v2");
});

test("snapshot polling reveals a board update made outside this server", async (t) => {
  const state = await start(t);
  const url = `${state.server.url}/api/snapshot`;
  const firstResponse = await fetch(url, { cache: "no-store" });
  const first = await json(firstResponse);
  state.current = { board: { ...state.current.board, title: "Changed by trackerboard CLI" }, revision: 2 };
  const polledResponse = await fetch(url, { cache: "no-store" });
  const polled = await json(polledResponse);
  const page = await (await fetch(state.server.url)).text();

  assert.equal(first.revision, 1);
  assert.equal(polled.revision, 2);
  assert.equal(polled.board.title, "Changed by trackerboard CLI");
  assert.match(page, /setInterval\(refreshSnapshot,\s*2_000\)/);
});

test("editor saves retain edits in other forms while rebasing them onto the new snapshot", () => {
  const editorPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../skills/trackerboard/assets/editor.html");
  const html = fs.readFileSync(editorPath, "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "editor client script exists");
  assert.doesNotThrow(() => new Function(script), "editor client script parses");
  assert.match(script, /function captureDrafts\(exceptForm, command\)/);
  assert.match(script, /function restoreDrafts\(drafts\)/);
  assert.match(script, /renderBoard\(snapshot\.board, drafts\)/);
  assert.match(script, /dataset\.initialValue/);
  assert.match(script, /Other unsaved edits are still here/);
});
