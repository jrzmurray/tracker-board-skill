import { createGitHubProjectBackend } from "../skills/trackerboard/scripts/lib/backends/github-project.mjs";

const repoUrl = "https://github.com/acme/roadmap";

export function makeBoard(phases = [{ id: "P1", title: "First phase" }]) {
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

export class MockGitHub {
  constructor({
    privateFailure = false,
    failAfterDraftCreate = false,
    failAfterProjectCreate = false,
    failAfterReadmeSave = false,
    failAfterItemDelete = false,
    failBeforeItemDelete = false,
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
    this.failAfterReadmeSave = failAfterReadmeSave;
    this.failAfterItemDelete = failAfterItemDelete;
    this.failBeforeItemDelete = failBeforeItemDelete;
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
      if (this.failBeforeItemDelete) {
        this.failBeforeItemDelete = false;
        throw new Error("simulated interruption before item-delete");
      }
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
      if (tail.includes("--readme")) {
        project.readme = this.flag(tail, "--readme");
        if (this.failAfterReadmeSave) {
          this.failAfterReadmeSave = false;
          throw new Error("simulated lost README save response");
        }
      }
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

export function harness(mock = new MockGitHub()) {
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

export function phasesOf(board) {
  return board.waves.flatMap((wave) => wave.phases);
}

export function metadataOf(project) {
  const encoded = project.readme.match(/<!-- trackerboard:metadata:v1:([A-Za-z0-9+/=]+) -->/)?.[1];
  return encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : null;
}

export function fieldValue(item, field) {
  return item.fieldValues.find((value) => value.fieldName === field);
}

export function replacePhaseDependencies(project, phaseId, deps) {
  const item = project.items.find((entry) => fieldValue(entry, "Trackerboard ID")?.text === phaseId);
  const encoded = item.body.match(/<!-- trackerboard:phase:v1:([A-Za-z0-9+/=]+) -->/)[1];
  const bodyData = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  bodyData.details.deps = deps;
  item.body = `<!-- trackerboard:phase:v1:${Buffer.from(JSON.stringify(bodyData)).toString("base64")} -->`;
  item.content.body = item.body;
}

export function hasIssueWrite(mock) {
  return mock.calls.some(({ args }) => args[0] === "issue" || (args[0] === "project" && args[1] === "item-add"));
}
