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
      const query = payload.query;
      if (query.includes("projectsV2(first: 100")) {
        if (this.projectListFailure) throw new Error("project capability denied");
        const projects = [...this.projects.values()].map((project) => this.projectSummary(project));
        return JSON.stringify({ data: { repositoryOwner: { projectsV2: { nodes: projects, pageInfo: { hasNextPage: false, endCursor: null } } } } });
      }
      if (query.includes("projectV2(number: $number)")) {
        const project = this.projects.get(Number(payload.variables.number));
        return JSON.stringify({ data: { repositoryOwner: { projectV2: project ? this.projectSummary(project) : null } } });
      }
      if (query.includes("repositoryOwner(login: $owner) { id }")) {
        return JSON.stringify({ data: { repositoryOwner: { id: `USER-${payload.variables.owner}` } } });
      }
      if (query.includes("createProjectV2(input")) {
        const project = this.createProject(String(input.ownerId).replace(/^USER-/, ""), input.title);
        if (this.failAfterProjectCreate) {
          this.failAfterProjectCreate = false;
          throw new Error("simulated lost project-create response");
        }
        return JSON.stringify({ data: { createProjectV2: { projectV2: this.projectSummary(project) } } });
      }
      if (query.includes("createProjectV2Field")) {
        const project = this.findProject(input.projectId);
        const field = {
          id: `FIELD-${this.nextField++}`,
          name: input.name,
          dataType: input.dataType,
          options: (input.singleSelectOptions || []).map((option) => ({ id: `FIELD-${this.nextField}-${option.name}`, ...option })),
        };
        project.fields.push(field);
        return JSON.stringify({ data: { createProjectV2Field: { projectV2Field: field } } });
      }
      if (query.includes("updateProjectV2Field")) {
        const field = this.findField(input.fieldId);
        field.options = input.singleSelectOptions.map((option) => ({
          id: option.id || `${field.id}-OPTION-${option.name}`,
          name: option.name,
          color: option.color,
          description: option.description,
        }));
        return JSON.stringify({ data: { updateProjectV2Field: { projectV2Field: field } } });
      }
      if (query.includes("addProjectV2DraftIssue")) {
        const project = this.findProject(input.projectId);
        const item = this.createItem(project, input.title, input.body);
        if (this.failAfterDraftCreate) {
          this.failAfterDraftCreate = false;
          throw new Error("simulated interrupted response");
        }
        return JSON.stringify({ data: { addProjectV2DraftIssue: { projectItem: this.graphqlItem(item, project) } } });
      }
      if (query.includes("updateProjectV2DraftIssue")) {
        const { project, item } = this.findItem(input.draftIssueId);
        for (const key of ["title", "body"]) if (input[key] !== undefined) {
          item[key] = input[key];
          if (item.content) item.content[key] = input[key];
        }
        return JSON.stringify({ data: { updateProjectV2DraftIssue: { draftIssue: item.content } } });
      }
      if (query.includes("updateProjectV2ItemFieldValue")) {
        const project = this.findProject(input.projectId);
        const item = project.items.find((entry) => entry.id === input.itemId);
        this.setItemField(project, item, input.fieldId, input.value);
        return JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } } });
      }
      if (query.includes("clearProjectV2ItemFieldValue")) {
        const project = this.findProject(input.projectId);
        const item = project.items.find((entry) => entry.id === input.itemId);
        item.fieldValues = item.fieldValues.filter((entry) => entry.fieldId !== input.fieldId);
        return JSON.stringify({ data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } } });
      }
      if (query.includes("deleteProjectV2Item")) {
        const project = this.findProject(input.projectId);
        if (this.failBeforeItemDelete) {
          this.failBeforeItemDelete = false;
          throw new Error("simulated interruption before item-delete");
        }
        project.items = project.items.filter((item) => item.id !== input.itemId);
        if (this.failAfterItemDelete) {
          this.failAfterItemDelete = false;
          throw new Error("simulated lost item-delete response");
        }
        return JSON.stringify({ data: { deleteProjectV2Item: { deletedItemId: input.itemId } } });
      }
      if (query.includes("deleteProjectV2(")) {
        const project = this.findProject(input.projectId);
        this.projects.delete(project.number);
        return JSON.stringify({ data: { deleteProjectV2: { projectV2: { id: project.id } } } });
      }
      if (query.includes("updateProjectV2(input")) {
        const project = this.findProject(input.projectId);
        if (!(this.privateFailure && input.public === false)) {
          for (const key of ["public", "title", "readme", "shortDescription", "closed"]) {
            if (input[key] !== undefined) project[key] = input[key];
          }
        }
        return JSON.stringify({ data: { updateProjectV2: { projectV2: this.projectSummary(project) } } });
      }
      const project = this.findProject(payload.variables.id);
      if (payload.query.includes("fields(first: 100)")) {
        return JSON.stringify({ data: { node: { fields: { nodes: project.fields } } } });
      }
      if (payload.query.includes("items(first: 100")) {
        const offset = Number(payload.variables.after) || 0;
        const page = project.items.slice(offset, offset + 100).map((item) => this.graphqlItem(item, project));
        const next = offset + page.length;
        const hasNextPage = next < project.items.length;
        return JSON.stringify({ data: { node: { items: {
          nodes: page,
          pageInfo: { hasNextPage, endCursor: hasNextPage ? String(next) : null },
        } } } });
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
      const item = this.createItem(project, this.flag(tail, "--title"), this.flag(tail, "--body"));
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

  createProject(owner, title) {
    const number = this.nextProject++;
    const project = {
      number,
      id: `PROJECT-${number}`,
      title,
      owner,
      public: true,
      createdAt: new Date().toISOString(),
      readme: "",
      fields: [{
        id: `DEFAULT-STATUS-${number}`,
        name: "Status",
        dataType: "SINGLE_SELECT",
        options: ["Todo", "In Progress", "Done"].map((name) => ({ id: `DEFAULT-${name}`, name })),
      }],
      items: [],
    };
    this.projects.set(number, project);
    return project;
  }

  graphqlItem(item, project) {
    return {
      id: item.id,
      type: item.type === "DraftIssue" ? "DRAFT_ISSUE" : item.type.toUpperCase(),
      content: item.content && {
        __typename: item.content.type,
        id: item.content.id,
        title: item.content.title,
        body: item.content.body,
      },
      fieldValues: { nodes: item.fieldValues.map((value) => {
        const field = project.fields.find((candidate) => candidate.id === value.fieldId);
        const common = { field: field && { id: field.id, name: field.name } };
        if (field?.dataType === "TEXT") return { __typename: "ProjectV2ItemFieldTextValue", ...common, text: value.text };
        if (field?.dataType === "NUMBER") return { __typename: "ProjectV2ItemFieldNumberValue", ...common, number: value.number };
        return { __typename: "ProjectV2ItemFieldSingleSelectValue", ...common, name: value.name, optionId: field?.options.find((option) => option.name === value.name)?.id };
      }) },
    };
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

  findItem(draftId) {
    for (const project of this.projects.values()) {
      const item = project.items.find((entry) => entry.content?.id === draftId);
      if (item) return { project, item };
    }
    throw new Error(`missing draft issue ${draftId}`);
  }

  createItem(project, title, body) {
    const item = {
      id: `ITEM-${this.nextItem++}`,
      type: "DraftIssue",
      title,
      body,
      fieldValues: [],
    };
    item.content = { id: `DRAFT-${item.id}`, type: "DraftIssue", title, body };
    project.items.push(item);
    return item;
  }

  setItemField(project, item, fieldId, value) {
    const field = project.fields.find((entry) => entry.id === fieldId);
    const option = field?.options?.find((entry) => entry.id === value.singleSelectOptionId);
    const next = { fieldId, fieldName: field.name };
    if (value.text !== undefined) next.text = value.text;
    else if (value.number !== undefined) next.number = value.number;
    else if (option) next.name = option.name;
    const previous = item.fieldValues.find((entry) => entry.fieldId === fieldId);
    if (previous) Object.assign(previous, next);
    else item.fieldValues.push(next);
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
    return this.calls.filter(({ args, input }) => args[0] === "project" && (
      ["create", "edit", "field-create", "item-create", "item-edit", "item-delete", "delete", "item-add"].includes(args[1])
    ) || args[0] === "api" && args[1] === "graphql" && JSON.parse(input).query.trimStart().startsWith("mutation"));
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
