import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { STATUSES } from "../skills/trackerboard/scripts/lib/board.mjs";
import { MAX_GITHUB_BYTES, createGitHubProjectBackend, verifyGitHubCli } from "../skills/trackerboard/scripts/lib/backends/github-project.mjs";
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

test("unknown OAuth scopes are checked through Project capability before setup", () => {
  const mock = new MockGitHub({ authScopes: [], projectListFailure: true });
  const { backend } = harness(mock);
  assert.throws(() => backend.create(makeBoard()), /gh auth refresh -s project/);
  const projectListCall = mock.calls.find(({ args, input }) => args[0] === "api" && args[1] === "graphql"
    && JSON.parse(input).query.includes("projectsV2(first: 100"));
  assert.ok(projectListCall);
  const ownerQuery = JSON.parse(projectListCall.input).query;
  assert.match(ownerQuery, /repositoryOwner\(login: \$owner\)/);
  assert.doesNotMatch(ownerQuery, /user\(login: \$owner\)|organization\(login: \$owner\)/);
  assert.equal(mock.writes().length, 0);
  assert.equal(mock.calls.some(({ args }) => args[0] === "auth" && args[1] === "token"), false);
});

test("reports GitHub API rate limits without suggesting an authorization change", () => {
  const mock = new MockGitHub();
  const originalRun = mock.run.bind(mock);
  mock.run = (args, options) => {
    if (args[0] === "api" && args[1] === "graphql") {
      const error = new Error("GitHub API failed");
      error.stderr = Buffer.from("API rate limit already exceeded");
      throw error;
    }
    return originalRun(args, options);
  };
  const { backend } = harness(mock);
  assert.throws(() => backend.create(makeBoard()), /GitHub API rate limit was reached.*Wait for the limit to reset/);
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
  assert.match(JSON.parse(writes[0].input).query, /createProjectV2\(/);
  assert.equal(JSON.parse(writes[1].input).variables.input.public, false);
  assert.equal(mock.projects.size, 0);
  assert.equal(writes.some(({ args, input }) => args[0] === "api" && /createProjectV2Field|addProjectV2DraftIssue/.test(JSON.parse(input).query)), false);
  assert.match(JSON.parse(writes.at(-1).input).query, /deleteProjectV2\(/);
});

test("maps all board fields, waves, logs, statuses, and phase details through Project metadata and draft items", () => {
  const { backend, mock } = harness();
  const board = makeBoard(STATUSES.map((status, index) => ({ id: `P${index + 1}`, status, title: `Phase ${index + 1}`, deps: index ? [`P${index}`] : [] })));
  backend.create(board);
  assert.deepEqual(backend.load(), board);
  const project = [...mock.projects.values()][0];
  assert.equal(project.public, false);
  assert.equal(project.title, board.title);
  assert.equal(mock.calls.some(({ args }) => args[0] === "project" && args[1] === "item-list"), false);
  assert.ok(mock.calls.some(({ args, input }) => args[0] === "api" && args[1] === "graphql"
    && JSON.parse(input).query.includes("fieldValues(first: 100)")));
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
  assert.ok(status.options.every((option) => option.color && option.description));
  assert.equal(status.options.find((option) => option.name === "todo").id, "DEFAULT-Todo");
  assert.deepEqual(project.fields.map((field) => field.name).sort(), ["Lane", "Order", "Owner", "Status", "Trackerboard ID", "Wave"].sort());
  assert.equal(project.items.length, STATUSES.length);
  assert.equal(mock.writes().some(({ args, input }) => args[0] === "api" && /createProjectV2Field/.test(JSON.parse(input).query)
    && JSON.parse(input).variables.input.name === "Status"), false);
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
  assert.equal(mock.calls.some(({ args, input }) => args[0] === "api" && /addProjectV2DraftIssue/.test(JSON.parse(input).query)), true);
});

test("loads Project items beyond the first GraphQL page", () => {
  const { backend } = harness();
  const phases = Array.from({ length: 101 }, (_, index) => ({ id: `P${index + 1}`, title: `Phase ${index + 1}` }));
  const board = makeBoard(phases);
  backend.create(board);
  assert.deepEqual(phasesOf(backend.load()).map((phase) => phase.id), phases.map((phase) => phase.id));
});

test("retries an interrupted draft-item create by stable phase ID without duplicating the Project item", () => {
  const mock = new MockGitHub({ failAfterDraftCreate: true });
  const { backend, context } = harness(mock);
  const board = makeBoard();
  assert.throws(() => backend.create(board), /gh api graphql failed/);
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
  assert.throws(() => backend.create(desired), /gh api graphql failed/);

  const partial = backend.load();
  assert.deepEqual(phasesOf(partial).map((phase) => phase.id), ["P1"]);
  assert.equal(metadataOf([...mock.projects.values()][0]).bootstrapComplete, false);
  const expectedRevision = backend.revision();
  backend.save(desired, { expectedRevision });

  assert.deepEqual(backend.load(), desired);
  assert.equal(metadataOf([...mock.projects.values()][0]).bootstrapComplete, true);
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
  assert.throws(() => backend.create(board), /gh api graphql failed/);
  const stableBoardId = context.local.githubProject.boardId;
  assert.equal(mock.projects.size, 1);
  backend.create(board);
  assert.equal(mock.projects.size, 1);
  assert.equal(context.local.githubProject.boardId, stableBoardId);
  assert.equal([...mock.projects.values()][0].public, false);
  assert.deepEqual(backend.load(), board);
  assert.equal(mock.writes().filter(({ args, input }) => args[0] === "api" && JSON.parse(input).query.includes("createProjectV2(")).length, 1);
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
  };
  const idOnlyBackend = createGitHubProjectBackend(idOnlyContext, mock);

  assert.deepEqual(idOnlyBackend.load(), board);
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
    if (args[0] === "api" && args[1] === "graphql" && JSON.parse(options.input).query.includes("title public readme createdAt") && ++projectViews === 5) {
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
    const query = args[0] === "api" && args[1] === "graphql" ? JSON.parse(options.input).query : "";
    if (armed && !injected && query.includes("items(first: 100")) {
      itemListsAfterManifest += 1;
      if (itemListsAfterManifest === 3) {
        mock.mutateField("P1", "Status", "blocked");
        injected = true;
      }
    }
    const result = originalRun(args, options);
    if (args[0] === "api" && args[1] === "graphql" && JSON.parse(options.input).query.includes("updateProjectV2(input")) armed = true;
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
  const changes = mock.writes().slice(before).filter(({ args, input }) => args[0] === "api" && JSON.parse(input).query.includes("updateProjectV2DraftIssue"));
  assert.equal(changes.length, 1);
  assert.match(JSON.parse(changes[0].input).variables.input.body, /trackerboard:phase:v1/);
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
  assert.throws(() => backend.save(desired, { previous, expectedRevision }), /gh api graphql failed/);
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
  assert.throws(() => backend.save(removing, { previous, expectedRevision }), /gh api graphql failed/);

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
