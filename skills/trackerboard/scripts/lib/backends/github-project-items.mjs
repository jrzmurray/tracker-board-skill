import { graphql } from "./github-project-core.mjs";

const ITEM_FIELDS = `id type project { id } content {
  __typename
  ... on DraftIssue { id title body }
  ... on Issue { id title body }
  ... on PullRequest { id title body }
} fieldValues(first: 100) { nodes {
  __typename
  ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { id name } } }
  ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id name } } }
  ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2SingleSelectField { id name } } }
} }`;

export function projectItemsByIds(client, ids) {
  const found = [];
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  for (let offset = 0; offset < unique.length; offset += 50) {
    const batch = unique.slice(offset, offset + 50);
    const data = graphql(client,
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProjectV2Item { ${ITEM_FIELDS} } } }`,
      { ids: batch });
    found.push(...(Array.isArray(data?.nodes) ? data.nodes.filter(Boolean) : []));
  }
  return found;
}
