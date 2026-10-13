import { BoardError } from "../board.mjs";
import { graphql } from "./github-project-core.mjs";

const PROJECT_FIELDS = "id number title public readme createdAt";

export function projectByNumber(client, owner, number) {
  const data = graphql(client,
    `query($owner: String!, $number: Int!) { repositoryOwner(login: $owner) { ... on User { projectV2(number: $number) { ${PROJECT_FIELDS} } } ... on Organization { projectV2(number: $number) { ${PROJECT_FIELDS} } } } }`,
    { owner, number: Number(number) });
  const project = data?.repositoryOwner?.projectV2;
  if (!project) throw new BoardError(`GitHub Project ${number} was not found for ${owner}.`);
  return project;
}

export function projectsForOwner(client, owner) {
  const projects = [];
  let after = null;
  do {
    const data = graphql(client,
      `query($owner: String!, $after: String) { repositoryOwner(login: $owner) { ... on User { projectsV2(first: 100, after: $after) { nodes { ${PROJECT_FIELDS} } pageInfo { hasNextPage endCursor } } } ... on Organization { projectsV2(first: 100, after: $after) { nodes { ${PROJECT_FIELDS} } pageInfo { hasNextPage endCursor } } } } }`,
      { owner, after });
    const connection = data?.repositoryOwner?.projectsV2;
    if (!connection || !Array.isArray(connection.nodes)) throw new BoardError(`GitHub could not list Projects for ${owner}.`);
    projects.push(...connection.nodes);
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    if (connection.pageInfo?.hasNextPage && !after) throw new BoardError("GitHub Project pagination returned no cursor.");
  } while (after);
  return projects;
}

export function createProject(client, owner, title) {
  const data = graphql(client,
    "query($owner: String!) { repositoryOwner(login: $owner) { id } }",
    { owner });
  const ownerId = data?.repositoryOwner?.id;
  if (!ownerId) throw new BoardError(`GitHub could not resolve Project owner ${owner}.`);
  const created = graphql(client,
    "mutation($input: CreateProjectV2Input!) { createProjectV2(input: $input) { projectV2 { id number title public readme createdAt } } }",
    { input: { ownerId, title } });
  const project = created?.createProjectV2?.projectV2;
  if (!project?.id || !Number(project.number)) throw new BoardError("GitHub created a Project but did not return its ID and number; retry to reconcile the setup placeholder.");
  return project;
}

export function projectDetails(client, ref) {
  const data = ref.id
    ? graphql(client, `query($id: ID!) { node(id: $id) { ... on ProjectV2 { ${PROJECT_FIELDS} } } }`, { id: ref.id })
    : null;
  const project = data?.node || projectByNumber(client, ref.owner, ref.number);
  if (!project?.id) throw new BoardError("GitHub Project did not return its ID.");
  return project;
}

export function projectFields(client, id) {
  if (!id) throw new BoardError("GitHub Project did not return an ID required to read its fields.");
  const data = graphql(client,
    "query($id: ID!) { node(id: $id) { ... on ProjectV2 { fields(first: 100) { nodes { ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options { id name } } } } } } }",
    { id });
  const fields = data?.node?.fields?.nodes;
  if (!Array.isArray(fields)) throw new BoardError("GitHub returned invalid Project fields.");
  return fields;
}

export function updateProject(client, ref, values) {
  if (!ref?.id) throw new BoardError("GitHub Project did not return an ID required for updates.");
  return graphql(client,
    "mutation($input: UpdateProjectV2Input!) { updateProjectV2(input: $input) { projectV2 { id number title public readme } } }",
    { input: { projectId: ref.id, ...values } });
}

export function createProjectField(client, projectId, definition, options = []) {
  return graphql(client,
    "mutation($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options { id name } } } } }",
    { input: { projectId, name: definition.name, dataType: definition.type, ...(options.length ? { singleSelectOptions: options } : {}) } });
}

export function createDraftIssue(client, projectId, title, body) {
  return graphql(client,
    "mutation($input: AddProjectV2DraftIssueInput!) { addProjectV2DraftIssue(input: $input) { projectItem { id content { ... on DraftIssue { id title body } } } } }",
    { input: { projectId, title, body } });
}

export function updateDraftIssue(client, draftIssueId, values) {
  return graphql(client,
    "mutation($input: UpdateProjectV2DraftIssueInput!) { updateProjectV2DraftIssue(input: $input) { draftIssue { id title body } } }",
    { input: { draftIssueId, ...values } });
}

export function updateItemFieldValue(client, projectId, itemId, fieldId, value) {
  return graphql(client,
    "mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } }",
    { input: { projectId, itemId, fieldId, value } });
}

export function clearItemFieldValue(client, projectId, itemId, fieldId) {
  return graphql(client,
    "mutation($input: ClearProjectV2ItemFieldValueInput!) { clearProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } }",
    { input: { projectId, itemId, fieldId } });
}

export function deleteProjectItem(client, projectId, itemId) {
  return graphql(client,
    "mutation($input: DeleteProjectV2ItemInput!) { deleteProjectV2Item(input: $input) { deletedItemId } }",
    { input: { projectId, itemId } });
}

export function deleteProject(client, projectId) {
  return graphql(client,
    "mutation($input: DeleteProjectV2Input!) { deleteProjectV2(input: $input) { projectV2 { id } } }",
    { input: { projectId } });
}
