import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { STATUSES } from "../skills/trackerboard/scripts/lib/board.mjs";
import { MAX_GITHUB_BYTES, createGitHubClient, createGitHubProjectBackend, verifyGitHubCli } from "../skills/trackerboard/scripts/lib/backends/github-project.mjs";
import { graphql, run as runGitHub } from "../skills/trackerboard/scripts/lib/backends/github-project-core.mjs";
import {
  MockGitHub, fieldValue, hasIssueWrite, harness, makeBoard, metadataOf,
  phasesOf, replacePhaseDependencies,
} from "./github-project-fixtures.mjs";
test("GitHub CLI version, login, and project scope are checked with precise recovery", () => {
  const fake = (version, status) => ({ run(args) { return args[0] === "--version" ? version : JSON.stringify(status); } });
  assert.throws(() => verifyGitHubCli(fake("gh version 2.95.9", {})), /requires gh 2\.96\.0 or newer/);
  assert.throws(() => verifyGitHubCli(fake("gh version 2.96.0", { hosts: { "github.com": [{ active: true, login: "octocat", scopes: ["repo"] }] } })), /gh auth refresh -s project/);
  assert.throws(() => verifyGitHubCli({ run(args) { if (args[0] === "--version") return "gh version 2.96.0"; throw new Error("not logged in"); } }), /gh auth login.*gh auth refresh -s project/);
  assert.equal(verifyGitHubCli(fake("gh version 2.102.0", { hosts: { "github.com": [{ active: true, scopes: ["project"] }] } })), true);
});

test("GitHub query failures are not misreported as missing Project scope", () => {
  const syntaxError = 'Expected COLON, actual: RPAREN ("") at [1, 74]';
  const processFailure = new Error("gh failed");
  processFailure.stderr = `gh: ${syntaxError}`;
  assert.throws(
    () => runGitHub({ run() { throw processFailure; } }, ["api", "graphql"]),
    (error) => error.message.includes(syntaxError) && !error.message.includes("auth refresh"),
  );
  assert.throws(
    () => graphql({ run() { return JSON.stringify({ errors: [{ message: syntaxError }] }); } }, "query { viewer { login } }", {}),
    (error) => error.message.includes(syntaxError) && !error.message.includes("auth refresh"),
  );
  assert.throws(
    () => graphql({ run() { return JSON.stringify({ errors: [{ message: "Resource not accessible by integration" }] }); } }, "query { viewer { login } }", {}),
    /auth refresh -s project/,
  );
  const fakeCredential = "gho_abcdefghijklmnopqrstuvwxyz0123456789";
  assert.throws(
    () => graphql({ run() { return JSON.stringify({ errors: [{ message: `Bad request ${fakeCredential}` }] }); } }, "query { viewer { login } }", {}),
    (error) => error.message.includes("[redacted]") && !error.message.includes(fakeCredential),
  );
});

test("GitHub CLI commands have a finite timeout", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-gh-timeout-"));
  const executable = path.join(directory, "hung-gh");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(executable, "#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n");
  fs.chmodSync(executable, 0o700);

  const started = Date.now();
  assert.throws(() => createGitHubClient(executable, { timeoutMs: 40 }).run(["project", "view"]), /timed out after 40ms/);
  assert.ok(Date.now() - started < 2_000, "a hung CLI process is killed within the configured bound");
});

test("unknown OAuth scopes are checked through Project capability before setup", () => {
  const mock = new MockGitHub({ authScopes: [], projectListFailure: true });
  const { backend } = harness(mock);
  assert.throws(() => backend.create(makeBoard()), /gh auth refresh -s project/);
  assert.deepEqual(mock.calls.filter(({ args }) => args[0] === "project").map(({ args }) => args[1]), ["list"]);
  assert.equal(mock.writes().length, 0);
  assert.equal(mock.calls.some(({ args }) => args[0] === "auth" && args[1] === "token"), false);
});

test("registered adapter initialization does not require gh until a GitHub operation", () => {
  const backendModule = new URL("../skills/trackerboard/scripts/lib/backend.mjs", import.meta.url).href;
  const githubModule = new URL("../skills/trackerboard/scripts/lib/backends/github-project.mjs", import.meta.url).href;
  const source = `
    const { initializeBackendFactories, openBackend } = await import(${JSON.stringify(backendModule)});
    await import(${JSON.stringify(githubModule)});
    await initializeBackendFactories();
    const adapter = openBackend("github", { config: { github: { executable: "/__trackerboard_missing_gh__" } }, local: {} });
    if (adapter.revision() !== null) throw new Error("unexpected initial revision");
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, TRACKERBOARD_GH: "/__trackerboard_missing_gh__" },
  }));
});

test("creates a private Project before adding board content and deletes an unverified empty placeholder", () => {
  const mock = new MockGitHub({ privateFailure: true });
  const { backend } = harness(mock);
  assert.throws(() => backend.create(makeBoard()), /still-empty setup placeholder was deleted.*gh auth refresh -s project/);
  const writes = mock.writes();
  assert.deepEqual(writes.slice(0, 2).map(({ args }) => args.slice(0, 2)), [["project", "create"], ["project", "edit"]]);
  assert.deepEqual(writes[1].args.slice(-2), ["--visibility", "PRIVATE"]);
  assert.equal(mock.projects.size, 0);
  assert.equal(writes.some(({ args }) => args[1] === "field-create" || args[1] === "item-create"), false);
  assert.equal(writes.at(-1).args[1], "delete");
});

test("maps all board fields, waves, logs, statuses, and phase details through Project metadata and draft items", () => {
  const { backend, mock } = harness();
  const board = makeBoard(STATUSES.map((status, index) => ({ id: `P${index + 1}`, status, title: `Phase ${index + 1}`, deps: index ? [`P${index}`] : [] })));
  backend.create(board);
  assert.deepEqual(backend.load(), board);
  const project = [...mock.projects.values()][0];
  assert.equal(project.public, false);
  assert.equal(project.title, board.title);
  const metadata = metadataOf(project);
  assert.equal(metadata.version, 1);
  assert.equal(metadata.bootstrapComplete, true);
  assert.ok(metadata.boardId);
  assert.deepEqual(metadata.fields, { title: board.title, subtitle: board.subtitle, lede: board.lede, notes: board.notes, repoUrl: board.repoUrl });
  assert.deepEqual(metadata.waves, [{ id: "W1", title: "Wave One", prefix: "P", notes: "Wave details" }]);
  assert.deepEqual(metadata.log, board.log);
  assert.equal(Object.keys(metadata.phaseItems).length, STATUSES.length);
  const status = project.fields.find((field) => field.name === "Status");
  assert.deepEqual(status.options.map((option) => option.name), STATUSES);
  assert.deepEqual(project.fields.map((field) => field.name).sort(), ["Lane", "Order", "Owner", "Status", "Trackerboard ID", "Wave"].sort());
  assert.equal(project.items.length, STATUSES.length);
  assert.equal(mock.writes().some(({ args }) => args[1] === "field-create" && mock.flag(args, "--name") === "Status"), false);
  for (const [index, item] of project.items.entries()) {
    assert.equal(item.type, "DraftIssue");
    assert.equal(item.title, `Phase ${index + 1}`);
    assert.equal(fieldValue(item, "Trackerboard ID").text, `P${index + 1}`);
    assert.equal(fieldValue(item, "Status").name, STATUSES[index]);
    assert.equal(fieldValue(item, "Wave").text, "W1");
    assert.equal(fieldValue(item, "Lane").text, "core");
    assert.equal(fieldValue(item, "Owner").text, "alex");
    assert.equal(fieldValue(item, "Order").number, index);
    const body = JSON.parse(Buffer.from(item.body.match(/trackerboard:phase:v1:([A-Za-z0-9+/=]+)/)[1], "base64").toString("utf8"));
    assert.deepEqual(body.details.deps, index ? [`P${index}`] : []);
    assert.equal(body.details.notes, "longer details");
  }
  assert.equal(hasIssueWrite(mock), false);
  assert.equal(mock.calls.some(({ args }) => args[0] === "project" && args[1] === "item-create"), true);
});

test("recovers a draft item by its returned ID when the Project item index is delayed", () => {
  const mock = new MockGitHub({ hideProjectItems: true });
  const { backend } = harness(mock);
  const board = makeBoard();

  backend.create(board);

  assert.deepEqual(backend.load(), board);
  assert.equal([...mock.projects.values()][0].items.length, 1);
  assert.equal(mock.calls.filter(({ args }) => args[0] === "project" && args[1] === "item-create").length, 1);
  assert.equal(mock.calls.some(({ args, input }) => args[0] === "api" && JSON.parse(input).query.includes("nodes(ids: $ids)")), true);
  assert.equal(hasIssueWrite(mock), false);
});

test("log append retries are idempotent when GitHub saved the README manifest before losing its response", () => {
  const mock = new MockGitHub();
  const { backend } = harness(mock);
  backend.create(makeBoard());
  const before = backend.load();
  const expectedRevision = backend.revision();
  const operation = {
    id: "operation-id-github-partial-01",
    hash: createHash("sha256").update("record this once", "utf8").digest("hex"),
  };
  const desired = structuredClone(before);
  desired.log.unshift({ at: "2026-10-14T12:00:00.000Z", text: "record this once" });
  mock.failAfterReadmeSave = true;

  assert.throws(
    () => backend.save(desired, { previous: before, expectedRevision, operation }),
    /project edit failed/,
  );
  const partial = backend.load();
  assert.equal(partial.log.filter((entry) => entry.text === "record this once").length, 1);
  assert.deepEqual(backend.getOperation(operation.id), operation);

  backend.save(desired, { previous: before, expectedRevision, operation });
  const retried = backend.load();
  assert.equal(retried.log.filter((entry) => entry.text === "record this once").length, 1);
});

test("strips repository URL credentials and private URL components before local and Project persistence", () => {
  const { backend, context, mock } = harness();
  const board = makeBoard();
  board.repoUrl = "https://agent:token-secret@github.com/acme/roadmap.git?access_token=query-secret#fragment-secret";
  backend.create(board);

  const project = [...mock.projects.values()][0];
  const storedUrl = "https://github.com/acme/roadmap";
  assert.equal(context.local.githubProject.repoUrl, storedUrl);
  assert.equal(metadataOf(project).fields.repoUrl, storedUrl);
  assert.doesNotMatch(project.readme, /token-secret|query-secret|fragment-secret/);
  assert.doesNotMatch(JSON.stringify(context.local), /token-secret|query-secret|fragment-secret/);
});

test("retries an interrupted draft-item create by stable phase ID without duplicating the Project item", () => {
  const mock = new MockGitHub({ failAfterDraftCreate: true });
  const { backend, context } = harness(mock);
  const board = makeBoard();
  assert.throws(() => backend.create(board), /item-create failed/);
  assert.equal([...mock.projects.values()][0].items.length, 1);
  const stableBoardId = context.local.githubProject.boardId;
  backend.create(board);
  assert.equal([...mock.projects.values()][0].items.length, 1);
  assert.equal(context.local.githubProject.boardId, stableBoardId);
  assert.deepEqual(backend.load(), board);
});

test("loads a partial Project snapshot and completes migration through save", () => {
  const mock = new MockGitHub({ failAfterDraftCreate: true });
  const { backend } = harness(mock);
  const desired = makeBoard([
    { id: "P1", deps: [] },
    { id: "P2", deps: ["P1"] },
  ]);
  assert.throws(() => backend.create(desired), /item-create failed/);

  const partial = backend.load();
  assert.deepEqual(phasesOf(partial).map((phase) => phase.id), ["P1"]);
  assert.equal(metadataOf([...mock.projects.values()][0]).bootstrapComplete, false);
  const expectedRevision = backend.revision();
  backend.save(desired, { expectedRevision });

  assert.deepEqual(backend.load(), desired);
  assert.equal(metadataOf([...mock.projects.values()][0]).bootstrapComplete, true);
});

test("reads Project items as JSON without incompatible field selectors", () => {
  const { backend, mock } = harness();
  backend.create(makeBoard());

  const itemLists = mock.calls.filter(({ args }) => args[0] === "project" && args[1] === "item-list");
  assert.ok(itemLists.length > 0);
  for (const { args } of itemLists) {
    assert.equal(args.includes("--field-id"), false);
    assert.equal(args.includes("--field"), false);
    assert.equal(args[args.indexOf("--format") + 1], "json");
  }
});

test("a second create cannot replace a completed board with an empty board", () => {
  const { backend, mock, context } = harness();
  const original = makeBoard();
  backend.create(original);
  const writesBefore = mock.writes().length;

  assert.equal(context.local.githubProject.bootstrapComplete, true);
  assert.throws(() => backend.create(makeBoard([])), /completed Trackerboard board/);
  assert.equal(mock.writes().length, writesBefore);
  assert.deepEqual(backend.load(), original);
});

test("create refuses completed remote metadata when the local completion marker is missing", () => {
  const { backend, context, mock } = harness();
  const original = makeBoard();
  backend.create(original);
  const project = [...mock.projects.values()][0];
  const metadata = metadataOf(project);
  const recoveredContext = {
    ...context,
    config: { github: { owner: "acme", projectNumber: project.number } },
    local: {
      bindings: [],
      artifactUrl: "",
      githubProject: {
        owner: "acme",
        boardId: metadata.boardId,
        repoUrl: original.repoUrl,
        projectNumber: project.number,
        projectId: project.id,
      },
    },
  };
  const recovered = createGitHubProjectBackend(recoveredContext, mock);
  const writesBefore = mock.writes().length;

  assert.throws(() => recovered.create(makeBoard([])), /completed Trackerboard metadata/);
  assert.equal(mock.writes().length, writesBefore);
  assert.deepEqual(recovered.load(), original);
});

test("reuses a generic empty Project after the create response is interrupted", () => {
  const mock = new MockGitHub({ failAfterProjectCreate: true });
  const { backend, context } = harness(mock);
  const board = makeBoard();
  assert.throws(() => backend.create(board), /project create failed/);
  const stableBoardId = context.local.githubProject.boardId;
  assert.equal(mock.projects.size, 1);
  backend.create(board);
  assert.equal(mock.projects.size, 1);
  assert.equal(context.local.githubProject.boardId, stableBoardId);
  assert.equal([...mock.projects.values()][0].public, false);
  assert.deepEqual(backend.load(), board);
  assert.equal(mock.writes().filter(({ args }) => args[1] === "create").length, 1);
});

test("resolves a configured Project ID when no numeric Project number is provided", () => {
  const { backend, context, mock } = harness();
  const board = makeBoard();
  backend.create(board);
  const project = [...mock.projects.values()][0];
  const idOnlyContext = {
    ...context,
    config: { ...context.config, github: { projectId: project.id } },
    local: { bindings: [], artifactUrl: "" },
    saveLocal(value) { this.local = structuredClone(value); },
  };
  const idOnlyBackend = createGitHubProjectBackend(idOnlyContext, mock);

  assert.deepEqual(idOnlyBackend.load(), board);
  assert.equal(idOnlyContext.local.githubProject.projectId, project.id);
  assert.equal(idOnlyContext.local.githubProject.projectNumber, project.number);
  assert.equal(mock.calls.some(({ args }) => args[0] === "project" && args[1] === "view" && args.includes("NaN")), false);
});

test("rejects oversized draft bodies and README metadata before any GitHub write", () => {
  const bodyHarness = harness();
  const tooLargeBody = makeBoard([{ id: "P1", notes: "x".repeat(MAX_GITHUB_BYTES) }]);
  assert.throws(() => bodyHarness.backend.create(tooLargeBody), /draft body exceeds the 60 KiB limit/);
  assert.equal(bodyHarness.mock.writes().length, 0);

  const metadataHarness = harness();
  const tooLargeMetadata = makeBoard();
  tooLargeMetadata.notes = "x".repeat(MAX_GITHUB_BYTES);
  assert.throws(() => metadataHarness.backend.create(tooLargeMetadata), /README metadata exceeds the 60 KiB limit/);
  assert.equal(metadataHarness.mock.writes().length, 0);
});

test("rejects an observed same-field remote conflict before writing", () => {
  const { backend, mock } = harness();
  const original = makeBoard();
  backend.create(original);
  const previous = backend.load();
  const expectedRevision = backend.revision();
  mock.mutateField("P1", "Status", "blocked");
  const desired = structuredClone(previous);
  desired.waves[0].phases[0].status = "done";
  const writesBefore = mock.writes().length;
  assert.throws(() => backend.save(desired, { previous, expectedRevision }), (error) =>
    error.code === "TRACKERBOARD_REVISION_CONFLICT" && /same fields: phase:P1:status/.test(error.message));
  assert.equal(mock.writes().length, writesBefore);
});

test("rebases independent dependency-set edits and preserves both writers' deltas", () => {
  const { backend, mock } = harness();
  backend.create(makeBoard([
    { id: "P1", deps: ["P2"] },
    { id: "P2", deps: [] },
    { id: "P3", deps: [] },
    { id: "P4", deps: [] },
  ]));
  const previous = backend.load();
  const expectedRevision = backend.revision();
  const desired = structuredClone(previous);
  desired.waves[0].phases.find((phase) => phase.id === "P1").deps = ["P2", "P3"];
  replacePhaseDependencies([...mock.projects.values()][0], "P1", ["P4"]);

  backend.save(desired, { previous, expectedRevision });

  assert.deepEqual(backend.load().waves[0].phases.find((phase) => phase.id === "P1").deps, ["P4", "P3"]);
});

test("rebases independent board-field edits without reverting the first writer", () => {
  const { backend, mock, context } = harness();
  backend.create(makeBoard());
  const writerABase = backend.load();
  const writerARevision = backend.revision();
  let secondContext;
  secondContext = {
    ...context,
    local: structuredClone(context.local),
    saveLocal(value) { secondContext.local = structuredClone(value); },
  };
  const secondWriter = createGitHubProjectBackend(secondContext, mock);
  const writerBBase = secondWriter.load();
  const writerBRevision = secondWriter.revision();

  const writerA = structuredClone(writerABase);
  writerA.notes = "notes from writer A";
  backend.save(writerA, { previous: writerABase, expectedRevision: writerARevision });

  const writerB = structuredClone(writerBBase);
  writerB.title = "Title from writer B";
  secondWriter.save(writerB, { previous: writerBBase, expectedRevision: writerBRevision });

  const finalBoard = backend.load();
  assert.equal(finalBoard.title, "Title from writer B");
  assert.equal(finalBoard.notes, "notes from writer A");
});

test("recomputes README metadata after a remote board edit observed before mutation", () => {
  const { backend, mock } = harness();
  backend.create(makeBoard());
  const previous = backend.load();
  const expectedRevision = backend.revision();
  const desired = structuredClone(previous);
  desired.notes = "local notes update";
  const originalRun = mock.run.bind(mock);
  let projectViews = 0;
  let injected = false;
  mock.run = (args, options) => {
    if (args[0] === "project" && args[1] === "view" && ++projectViews === 5) {
      const project = [...mock.projects.values()][0];
      const metadata = metadataOf(project);
      metadata.fields.title = "Remote title update";
      const marker = `<!-- trackerboard:metadata:v1:${Buffer.from(JSON.stringify(metadata)).toString("base64")} -->`;
      project.readme = project.readme.replace(/<!-- trackerboard:metadata:v1:[A-Za-z0-9+/=]+ -->/, marker);
      injected = true;
    }
    return originalRun(args, options);
  };

  backend.save(desired, { previous, expectedRevision });

  assert.equal(injected, true);
  assert.equal(backend.load().title, "Remote title update");
  assert.equal(backend.load().notes, "local notes update");
});

test("recomputes phase field values after an independent remote edit is observed mid-save", () => {
  const { backend, mock } = harness();
  backend.create(makeBoard());
  const previous = backend.load();
  const expectedRevision = backend.revision();
  const desired = structuredClone(previous);
  desired.waves[0].phases[0].notes = "local phase notes update";
  const originalRun = mock.run.bind(mock);
  let armed = false;
  let itemListsAfterManifest = 0;
  let injected = false;
  mock.run = (args, options) => {
    if (armed && !injected && args[0] === "project" && args[1] === "item-list") {
      itemListsAfterManifest += 1;
      if (itemListsAfterManifest === 3) {
        mock.mutateField("P1", "Status", "blocked");
        injected = true;
      }
    }
    const result = originalRun(args, options);
    if (args[0] === "project" && args[1] === "edit" && args.includes("--readme")) armed = true;
    return result;
  };

  backend.save(desired, { previous, expectedRevision });

  assert.equal(injected, true);
  const saved = backend.load();
  assert.equal(saved.waves[0].phases[0].status, "blocked");
  assert.equal(saved.waves[0].phases[0].notes, "local phase notes update");
});

test("expected-revision mismatch without a baseline is tagged for conflict handling", () => {
  const { backend } = harness();
  backend.create(makeBoard());
  assert.throws(() => backend.save(makeBoard(), { expectedRevision: "stale-revision" }), (error) =>
    error.code === "TRACKERBOARD_REVISION_CONFLICT" && /changed since the expected revision/.test(error.message));
});

test("updates only the affected phase body and returns a new revision", () => {
  const { backend, mock } = harness();
  const original = makeBoard();
  backend.create(original);
  const previous = backend.load();
  const revision = backend.revision();
  const desired = structuredClone(previous);
  desired.waves[0].phases[0].notes = "revised details";
  const before = mock.writes().length;
  const nextRevision = backend.save(desired, { previous, expectedRevision: revision });
  const changes = mock.writes().slice(before).filter(({ args }) => args[1] === "item-edit");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].args.includes("--body"), true);
  assert.equal(changes[0].args.includes("--field-id"), false);
  assert.notEqual(nextRevision, revision);
  assert.deepEqual(backend.load(), desired);
});

test("reconciles a lost draft-item delete response from the README pending-delete mapping", () => {
  const mock = new MockGitHub({ failAfterItemDelete: true });
  const { backend } = harness(mock);
  const original = makeBoard([
    { id: "P1", title: "Keep" },
    { id: "P2", title: "Remove", deps: [] },
  ]);
  backend.create(original);
  const previous = backend.load();
  const expectedRevision = backend.revision();
  const desired = structuredClone(previous);
  desired.waves[0].phases.pop();
  assert.throws(() => backend.save(desired, { previous, expectedRevision }), /item-delete failed/);
  assert.equal([...mock.projects.values()][0].items.length, 1);
  backend.save(desired, { previous, expectedRevision });
  assert.equal([...mock.projects.values()][0].items.length, 1);
  assert.deepEqual(backend.load(), desired);
  assert.deepEqual(metadataOf([...mock.projects.values()][0]).pendingDelete, []);
});

test("re-adding a phase cancels its pending deletion after an interrupted delete", () => {
  const mock = new MockGitHub({ failBeforeItemDelete: true });
  const { backend } = harness(mock);
  const original = makeBoard([
    { id: "P1", title: "Keep" },
    { id: "P2", title: "Can return", deps: [] },
  ]);
  backend.create(original);
  const previous = backend.load();
  const expectedRevision = backend.revision();
  const removing = structuredClone(previous);
  removing.waves[0].phases.pop();
  assert.throws(() => backend.save(removing, { previous, expectedRevision }), /item-delete failed/);

  const project = [...mock.projects.values()][0];
  const retainedItemId = project.items.find((item) => fieldValue(item, "Trackerboard ID")?.text === "P2").id;
  assert.deepEqual(metadataOf(project).pendingDelete, [{ id: "P2", itemId: retainedItemId }]);
  const deletionSnapshot = backend.load();
  const readded = structuredClone(deletionSnapshot);
  readded.waves[0].phases.push(structuredClone(original.waves[0].phases[1]));

  backend.save(readded, { previous: deletionSnapshot, expectedRevision: backend.revision() });

  assert.deepEqual(backend.load(), readded);
  assert.equal(project.items.find((item) => item.id === retainedItemId)?.id, retainedItemId);
  assert.deepEqual(metadataOf(project).pendingDelete, []);
});

test("remove deletes the private Project and draft items without repository Issue create or close calls", () => {
  const { backend, mock } = harness();
  backend.create(makeBoard());
  backend.remove();
  assert.equal(mock.projects.size, 0);
  assert.equal(mock.calls.some(({ args }) => args[0] === "project" && ["close", "item-add"].includes(args[1])), false);
  assert.equal(hasIssueWrite(mock), false);
});
