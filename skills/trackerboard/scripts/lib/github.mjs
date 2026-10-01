// Overlay open GitHub work onto a board: a PR or issue that mentions a phase
// id fills that phase's PR and Issue columns, and an open PR moves the phase
// forward (draft -> active, ready -> review). Nothing moves backward and
// nothing is removed, so it is safe to run on every refresh. No I/O here; the
// CLI fetches with `gh` and passes the lists in.

import { allPhases } from "./board.mjs";

export const SOURCES = ["title", "branch", "labels", "body"];
export const DEFAULT_SOURCES = ["title", "branch", "labels"];

// Statuses an open PR may advance, and how far along each is.
const RANK = { todo: 0, waiting: 0, active: 1, review: 2 };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// An id matches as a whole token: not inside a longer id (R-SEC-056 does not
// match SEC-056 or R-SEC-0561) and not a sub-id (P1 does not match P1.2 or
// P1-2), but a trailing word is fine (branch fix/r-sec-056-lock matches).
export function idPattern(id) {
  return new RegExp(`(?<![A-Za-z0-9])(?<![A-Za-z0-9][.\\-])${escapeRe(id)}(?![A-Za-z0-9])(?![.\\-][0-9])`, "i");
}

function texts(item, sources) {
  const out = [];
  if (sources.includes("title")) out.push(item.title || "");
  if (sources.includes("branch") && item.headRefName) out.push(item.headRefName);
  if (sources.includes("labels")) out.push(...(item.labels || []).map((l) => (typeof l === "string" ? l : l.name || "")));
  if (sources.includes("body")) out.push(item.body || "");
  return out;
}

const refs = (field) => (field.match(/#\d+/g) || []).map((r) => r.slice(1));
const addRefs = (field, nums) => {
  const have = new Set(refs(field));
  const add = nums.filter((n) => !have.has(String(n))).map((n) => `#${n}`);
  if (!add.length) return field;
  return [field.trim(), add.join(", ")].filter(Boolean).join(", ");
};

// prs: [{number, title, body, headRefName, labels, isDraft, closingIssuesReferences: [{number}]}]
// issues: [{number, title, body, labels}]
// Returns the changes made, one per phase: {id, pr?, issue?, status?: [from, to]}.
export function applyGithub(board, { prs = [], issues = [] }, { sources = DEFAULT_SOURCES } = {}) {
  const phases = allPhases(board).map(({ phase }) => ({ phase, re: idPattern(phase.id) }));
  const mentions = (item) => phases.filter(({ re }) => texts(item, sources).some((t) => re.test(t))).map(({ phase }) => phase);

  const hits = new Map(); // phase -> {prs: Map(number -> isDraft), issues: Set}
  const hit = (p) => {
    if (!hits.has(p)) hits.set(p, { prs: new Map(), issues: new Set() });
    return hits.get(p);
  };
  const issuePhases = new Map(); // issue number -> phases that mention it
  for (const issue of issues) {
    for (const p of mentions(issue)) {
      hit(p).issues.add(issue.number);
      if (!issuePhases.has(issue.number)) issuePhases.set(issue.number, []);
      issuePhases.get(issue.number).push(p);
    }
  }
  for (const pr of prs) {
    const closes = (pr.closingIssuesReferences || []).map((i) => i.number);
    // A PR counts for a phase it names, and for a phase whose issue it closes.
    const direct = mentions(pr);
    const viaIssue = closes.flatMap((n) => issuePhases.get(n) || []);
    for (const p of new Set([...direct, ...viaIssue])) {
      hit(p).prs.set(pr.number, !!pr.isDraft);
      if (direct.includes(p)) for (const n of closes) hit(p).issues.add(n);
    }
  }

  const changes = [];
  for (const [p, h] of hits) {
    const change = { id: p.id };
    const sortNum = (a, b) => a - b;
    const pr = addRefs(p.pr || "", [...h.prs.keys()].sort(sortNum));
    if (pr !== (p.pr || "")) { change.pr = pr; p.pr = pr; }
    const issue = addRefs(p.issue || "", [...h.issues].sort(sortNum));
    if (issue !== (p.issue || "")) { change.issue = issue; p.issue = issue; }
    if (h.prs.size && p.status in RANK) {
      const to = [...h.prs.values()].some((draft) => !draft) ? "review" : "active";
      if (RANK[to] > RANK[p.status]) { change.status = [p.status, to]; p.status = to; }
    }
    if (Object.keys(change).length > 1) changes.push(change);
  }
  return changes;
}

export function describeChange(c) {
  const parts = [];
  if (c.status) parts.push(`${c.status[0]} → ${c.status[1]}`);
  if (c.pr) parts.push(`pr ${c.pr}`);
  if (c.issue) parts.push(`issue ${c.issue}`);
  return `${c.id}: ${parts.join(", ")}`;
}
