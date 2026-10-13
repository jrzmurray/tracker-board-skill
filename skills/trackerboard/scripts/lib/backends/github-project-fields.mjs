import { BoardError, STATUSES } from "../board.mjs";
import * as core from "./github-project-core.mjs";

const { PROJECT_FIELDS, fieldByName, fieldOptions, fieldType, graphql, optionName, run } = core;

export function createGitHubProjectFieldManager({ client, readRemote, rereadBeforeMutation }) {
  function updateStatusOptions(ref, field, latestFields, previous, desired) {
    const latest = rereadBeforeMutation(ref, previous, desired);
    const current = fieldByName(latest?.fields || latestFields, "Status") || field;
    const input = {
      fieldId: current.id,
      singleSelectOptions: STATUSES.map((name) => ({ name })),
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
        const args = ["project", "field-create", String(ref.number), "--owner", ref.owner, "--name", definition.name, "--data-type", definition.type];
        if (definition.options) args.push("--single-select-options", definition.options.join(","));
        run(client, args);
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
