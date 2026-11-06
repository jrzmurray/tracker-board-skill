import { BoardError, STATUSES } from "../board.mjs";
import { createProjectField } from "./github-project-api.mjs";
import * as core from "./github-project-core.mjs";

const { PROJECT_FIELDS, fieldByName, fieldOptions, fieldType, graphql, optionName } = core;

const STATUS_OPTION_STYLE = {
  todo: { color: "GRAY", description: "Not yet started." },
  active: { color: "BLUE", description: "Work is in progress." },
  review: { color: "PURPLE", description: "Awaiting review." },
  waiting: { color: "YELLOW", description: "Waiting on external input or a dependency." },
  blocked: { color: "RED", description: "Unable to proceed." },
  done: { color: "GREEN", description: "Complete." },
  ongoing: { color: "BLUE", description: "Ongoing or recurring work." },
  external: { color: "PINK", description: "Tracked here, managed elsewhere." },
  dropped: { color: "GRAY", description: "Cancelled or out of scope." },
};

const EXISTING_STATUS_NAMES = {
  todo: ["todo", "to do", "not started", "not-started"],
  active: ["active", "in progress", "in-progress"],
  done: ["done", "complete", "completed"],
};

export function createGitHubProjectFieldManager({ client, readRemote, rereadBeforeMutation }) {
  function updateStatusOptions(ref, field, latestFields, previous, desired) {
    const latest = rereadBeforeMutation(ref, previous, desired);
    const current = fieldByName(latest?.fields || latestFields, "Status") || field;
    const input = {
      fieldId: current.id,
      singleSelectOptions: STATUSES.map((name) => {
        const acceptedNames = EXISTING_STATUS_NAMES[name] || [name];
        const existing = fieldOptions(current).find((option) => acceptedNames.includes(optionName(option).trim().toLowerCase()));
        return { ...(existing?.id ? { id: existing.id } : {}), name, ...STATUS_OPTION_STYLE[name] };
      }),
    };
    graphql(client,
      "mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input) { projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } } } }",
      { input });
  }

  function ensureFields(ref, previous, desired) {
    let current = readRemote(ref, { allowMissing: true });
    for (const definition of PROJECT_FIELDS) {
      let field = fieldByName(current.fields, definition.name);
      if (!field) {
        rereadBeforeMutation(ref, previous, desired);
        if (!current.ref?.id) throw new BoardError("GitHub Project did not return an ID required to create fields.");
        const options = definition.options
          ? STATUSES.map((name) => ({ name, ...STATUS_OPTION_STYLE[name] }))
          : [];
        createProjectField(client, current.ref.id, definition, options);
        current = readRemote(ref, { allowMissing: true });
        field = fieldByName(current.fields, definition.name);
      }
      if (!field) throw new BoardError(`GitHub Project field ${definition.name} was not created.`);
      if (fieldType(field) !== definition.type.replace(/_/g, "")) throw new BoardError(`GitHub Project field ${definition.name} has type ${fieldType(field)}; expected ${definition.type}.`);
      if (definition.options) {
        const names = fieldOptions(field).map((option) => optionName(option).toLowerCase());
        if (STATUSES.some((status) => !names.includes(status)) || names.length !== STATUSES.length) {
          updateStatusOptions(ref, field, current.fields, previous, desired);
          current = readRemote(ref, { allowMissing: true });
          field = fieldByName(current.fields, definition.name);
          const refreshed = fieldOptions(field).map((option) => optionName(option).toLowerCase());
          if (STATUSES.some((status) => !refreshed.includes(status)) || refreshed.length !== STATUSES.length) {
            throw new BoardError("GitHub Project Status field could not be configured with all nine canonical Trackerboard statuses.");
          }
        }
      }
    }
    return readRemote(ref, { allowMissing: true });
  }

  return { ensureFields };
}
