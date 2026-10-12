import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { STATUSES } from "../skills/trackerboard/scripts/lib/board.mjs";
import {
  MAX_GITHUB_BYTES,
  createGitHubProjectBackend,
  verifyGitHubCli,
} from "../skills/trackerboard/scripts/lib/backends/github-project.mjs";

const repoUrl = "git@github.com:acme/roadmap.git";

function makeBoard(phases = [{ id: "P1", title: "First phase" }]) {
  return {
    schema: 1,
    name: "release-plan",
    title: "Release Plan",
    subtitle: "Quarterly work",
    lede: "What ships next",
    notes: "Board notes",
    repoUrl: "https://github.com/acme/roadmap",
    waves: [{
      id: "W1",
      title: "Wave One",
      prefix: "P",
      notes: "Wave details",
      phases: phases.map((phase, index) => ({
        id: phase.id,
        title: phase.title ?? `Phase ${phase.id}`,
        lane: phase.lane ?? "core",
        owner: phase.owner ?? "alex",
        status: phase.status ?? "todo",
        note: phase.note ?? "short note",
        req: phase.req ?? "R-1",
        issue: phase.issue ?? "#10",
        pr: phase.pr ?? "#11",
        review: phase.review ?? "review notes",
        notes: phase.notes ?? "longer details",
        deps: phase.deps ?? (index ? [phases[index - 1].id] : []),
      })),
    }],
    log: [{ at: "2026-10-01T12:00:00.000Z", text: "board created" }],
    updatedAt: "2026-10-01T12:00:00.000Z",
  };
}

class MockGitHub {
  constructor({
    privateFailure = false,
    failAfterDraftCreate = false,
    failAfterProjectCreate = false,
    failAfterItemDelete = false,
    authScopes = ["repo", "project"],
    projectListFailure = false,
  } = {}) {
    this.calls = [];
    this.projects = new Map();
    this.nextProject = 1;
    this.nextField = 1;
    this.nextItem = 1;
    this.privateFailure = privateFailure;
    this.failAfterDraftCreate = failAfterDraftCreate;
    this.failAfterProjectCreate = failAfterProjectCreate;
    this.failAfterItemDelete = failAfterItemDelete;
    this.authScopes = authScopes;
    this.projectListFailure = projectListFailure;
  }

  run(args, options = {}) {
    this.calls.push({ args: [...args], input: options.input });
    const [root, command, ...tail] = args;
    if (root === "--version") return "gh version v2.96.0 (test)\n";
    if (root === "auth" && command === "status") {
      return JSON.stringify({ hosts: { "github.com": [{ active: true, login: "octocat", state: "success", scopes: this.authScopes }] } });
    }
    if (root === "project" && command === "list") {
      if (this.projectListFailure) throw new Error("project capability denied");
      return JSON.stringify({ projects: [...this.projects.values()].map((project) => this.projectSummary(project)) });
    }
    if (root === "project" && command === "create") {
      const project = {
        number: this.nextProject++,
        id: `PROJECT-${this.nextProject - 1}`,
        title: this.flag(tail, "--title"),
        owner: this.flag(tail, "--owner"),
        public: true,
        createdAt: new Date().toISOString(),
        readme: "",
        fields: [{
          id: `DEFAULT-STATUS-${this.nextProject - 1}`,
          name: "Status",
          dataType: "SINGLE_SELECT",
          options: ["Todo", "In Progress", "Done"].map((name) => ({ id: `DEFAULT-${name}`, name })),
        }],
        items: [],
      };
      this.projects.set(project.number, project);
      if (this.failAfterProjectCreate) {
        this.failAfterProjectCreate = false;
        throw new Error("simulated lost project-create response");
      }
      return JSON.stringify(this.projectSummary(project));
    }
    if (root === "project" && command === "view") {
      const project = this.project(tail);
      return JSON.stringify(this.projectSummary(project));
    }
    if (root === "api" && command === "graphql") {
      const payload = JSON.parse(options.input);
      const input = payload.variables?.input;
      if (input?.fieldId) {
        const field = this.findField(input.fieldId);
        field.options = input.singleSelectOptions.map((option) => ({ id: `${field.id}-OPTION-${option.name}`, name: option.name }));
        return JSON.stringify({ data: { updateProjectV2Field: { projectV2Field: field } } });
      }
      const project = this.findProject(payload.variables.id);
      if (payload.query.includes("fields(first: 100)")) {
        return JSON.stringify({ data: { node: { fields: { nodes: project.fields } } } });
      }
      return JSON.stringify({ data: { node: { id: project.id, number: project.number, title: project.title, public: project.public, readme: project.readme, createdAt: project.createdAt } } });
    }
    if (root === "project" && command === "field-list") {
      return JSON.stringify(this.project(tail).fields);
    }
    if (root === "project" && command === "field-create") {
      const project = this.project(tail);
      const type = this.flag(tail, "--data-type");
      const field = { id: `FIELD-${this.nextField++}`, name: this.flag(tail, "--name"), dataType: type, options: [] };
      if (type === "SINGLE_SELECT") {
        field.options = this.flag(tail, "--single-select-options").split(",").map((name) => ({ id: `${field.id}-OPTION-${name}`, name }));
      }
      project.fields.push(field);
      return JSON.stringify(field);
    }
    if (root === "project" && command === "item-list") {
      return JSON.stringify(this.project(tail).items);
    }
    if (root === "project" && command === "item-create") {
      const project = this.project(tail);
      const item = {
        id: `ITEM-${this.nextItem++}`,
        type: "DraftIssue",
        title: this.flag(tail, "--title"),
        body: this.flag(tail, "--body"),
        fieldValues: [],
      };
      item.content = { id: `DRAFT-${item.id}`, type: "DraftIssue", title: item.title, body: item.body };
      project.items.push(item);
      if (this.failAfterDraftCreate) {
        this.failAfterDraftCreate = false;
        throw new Error("simulated interrupted response");
      }
      return JSON.stringify(item);
    }
    if (root === "project" && command === "item-edit") {
      const project = [...this.projects.values()].find((entry) => entry.id === this.flag(tail, "--project-id"));
      const item = project?.items.find((entry) => entry.id === this.flag(tail, "--id") || entry.content?.id === this.flag(tail, "--id"));
      if (!item) throw new Error("missing item");
      for (const key of ["--title", "--body"]) if (tail.includes(key)) {
        item[key.slice(2)] = this.flag(tail, key);
        if (item.content) item.content[key.slice(2)] = item[key.slice(2)];
      }
      if (tail.includes("--field-id")) {
        const field = project.fields.find((entry) => entry.id === this.flag(tail, "--field-id"));
        const before = item.fieldValues.find((entry) => entry.fieldId === field.id);
        if (tail.includes("--clear")) {
          item.fieldValues = item.fieldValues.filter((entry) => entry.fieldId !== field.id);
        } else {
          const value = tail.includes("--text") ? this.flag(tail, "--text")
            : tail.includes("--number") ? Number(this.flag(tail, "--number"))
              : field.options.find((option) => option.id === this.flag(tail, "--single-select-option-id"))?.name;
          const next = { fieldId: field.id, fieldName: field.name };
          if (field.dataType === "TEXT") next.text = String(value);
          else if (field.dataType === "NUMBER") next.number = value;
          else next.name = value;
          if (before) Object.assign(before, next);
          else item.fieldValues.push(next);
        }
      }
      return JSON.stringify(item);
    }
    if (root === "project" && command === "item-delete") {
      const project = this.project(tail);
      const id = this.flag(tail, "--id");
      project.items = project.items.filter((item) => item.id !== id);
      if (this.failAfterItemDelete) {
        this.failAfterItemDelete = false;
        throw new Error("simulated lost item-delete response");
      }
      return "";
    }
    if (root === "project" && command === "edit") {
      const project = this.project(tail);
      if (tail.includes("--visibility")) {
        if (!this.privateFailure) project.public = this.flag(tail, "--visibility") !== "PRIVATE";
      }
      if (tail.includes("--title")) project.title = this.flag(tail, "--title");
      if (tail.includes("--readme")) project.readme = this.flag(tail, "--readme");
      return JSON.stringify(this.projectSummary(project));
    }
    if (root === "project" && command === "delete") {
      const project = this.project(tail);
      this.projects.delete(project.number);
      return "";
    }
    throw new Error(`Unexpected mock command: ${args.join(" ")}`);
  }

  projectSummary(project) {
    return { number: project.number, id: project.id, title: project.title, public: project.public, readme: project.readme, createdAt: project.createdAt, url: `https://github.com/users/${project.owner}/projects/${project.number}` };
  }

  project(args) {
    const number = Number(args[0]);
    const project = this.projects.get(number);
    if (!project) throw new Error(`missing project ${number}`);
    return project;
  }

  findProject(id) {
    const project = [...this.projects.values()].find((entry) => entry.id === id);
    if (!project) throw new Error(`missing project ${id}`);
    return project;
  }

  findField(id) {
    for (const project of this.projects.values()) {
      const field = project.fields.find((entry) => entry.id === id);
      if (field) return field;
    }
    throw new Error(`missing field ${id}`);
  }

  flag(args, key) {
    const index = args.indexOf(key);
    return index < 0 ? "" : args[index + 1];
  }

  mutateField(phaseId, name, value) {
    const project = [...this.projects.values()][0];
    const idField = project.fields.find((field) => field.name === "Trackerboard ID");
    const item = project.items.find((entry) => entry.fieldValues.some((field) => field.fieldId === idField.id && field.text === phaseId));
    const field = project.fields.find((entry) => entry.name === name);
    const previous = item.fieldValues.find((entry) => entry.fieldId === field.id);
    const next = { fieldId: field.id, fieldName: field.name };
    if (field.dataType === "SINGLE_SELECT") next.name = value;
    else if (field.dataType === "NUMBER") next.number = value;
    else next.text = value;
    if (previous) Object.assign(previous, next);
    else item.fieldValues.push(next);
  }

  writes() {
    return this.calls.filter(({ args }) => args[0] === "project" && (
      ["create", "edit", "field-create", "item-create", "item-edit", "item-delete", "delete", "item-add"].includes(args[1])
    ));
  }
}

function harness(mock = new MockGitHub()) {
  const localWrites = [];
  const context = {
    name: "release-plan",
    bindingKey: "repo-key",
    config: { github: {} },
    cwd: "/work/roadmap",
    repoRoot: "/work/roadmap",
    repoUrl,
    local: { bindings: [], artifactUrl: "" },
    saveLocal(value) { localWrites.push(structuredClone(value)); context.local = structuredClone(value); },
    boardPath: "/tmp/release-plan.json",
    dataHome: "/tmp/trackerboard",
  };
  return { backend: createGitHubProjectBackend(context, mock), context, localWrites, mock };
}

function phasesOf(board) {
  return board.waves.flatMap((wave) => wave.phases);
}

function metadataOf(project) {
  const encoded = project.readme.match(/<!-- trackerboard:metadata:v1:([A-Za-z0-9+/=]+) -->/)?.[1];
  return encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : null;
}

function fieldValue(item, field) {
  return item.fieldValues.find((value) => value.fieldName === field);
}

function replacePhaseDependencies(project, phaseId, deps) {
  const item = project.items.find((entry) => fieldValue(entry, "Trackerboard ID")?.text === phaseId);
  const encoded = item.body.match(/<!-- trackerboard:phase:v1:([A-Za-z0-9+/=]+) -->/)[1];
  const bodyData = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  bodyData.details.deps = deps;
  item.body = `<!-- trackerboard:phase:v1:${Buffer.from(JSON.stringify(bodyData)).toString("base64")} -->`;
  item.content.body = item.body;
}

function hasIssueWrite(mock) {
  return mock.calls.some(({ args }) => args[0] === "issue" || (args[0] === "project" && args[1] === "item-add"));
}

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

test("remove deletes the private Project and draft items without repository Issue create or close calls", () => {
  const { backend, mock } = harness();
  backend.create(makeBoard());
  backend.remove();
  assert.equal(mock.projects.size, 0);
  assert.equal(mock.calls.some(({ args }) => args[0] === "project" && ["close", "item-add"].includes(args[1])), false);
  assert.equal(hasIssueWrite(mock), false);
});
