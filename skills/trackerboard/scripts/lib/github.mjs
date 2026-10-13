// Overlay GitHub references onto a board. PR lifecycle never changes the
// human-controlled phase status; the page derives independent PR badges.
// Nothing is removed, so this remains safe to run on every refresh.

import { allPhases } from "./board.mjs";

export const SOURCES = ["title", "branch", "labels", "body"];
export const DEFAULT_SOURCES = ["title", "branch", "labels"];

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

// prs: [{number, title, body, headRefName, labels, isDraft, state, mergedAt,
//        mergeStateStatus, closingIssuesReferences: [{number}]}]
// issues: [{number, title, body, labels}]
// Returns reference changes made, one per phase: {id, pr?, issue?}.
export function applyGithub(board, { prs = [], issues = [] }, { sources = DEFAULT_SOURCES } = {}) {
  const phases = allPhases(board).map(({ phase }) => ({ phase, re: idPattern(phase.id) }));
  const mentions = (item) => phases.filter(({ re }) => texts(item, sources).some((t) => re.test(t))).map(({ phase }) => phase);

  const hits = new Map(); // phase -> {prs: Set(number), issues: Set}
  const hit = (p) => {
    if (!hits.has(p)) hits.set(p, { prs: new Set(), issues: new Set() });
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
      hit(p).prs.add(pr.number);
      if (direct.includes(p)) for (const n of closes) hit(p).issues.add(n);
    }
  }

  const changes = [];
  for (const [p, h] of hits) {
    const change = { id: p.id };
    const sortNum = (a, b) => a - b;
    const pr = addRefs(p.pr || "", [...h.prs].sort(sortNum));
    if (pr !== (p.pr || "")) { change.pr = pr; p.pr = pr; }
    const issue = addRefs(p.issue || "", [...h.issues].sort(sortNum));
    if (issue !== (p.issue || "")) { change.issue = issue; p.issue = issue; }
    if (Object.keys(change).length > 1) changes.push(change);
  }
  return changes;
}

export function prLifecycle(pr) {
  const state = String(pr.state || (pr.mergedAt ? "MERGED" : "OPEN")).toUpperCase();
  if (pr.mergedAt || state === "MERGED") return { status: "done", label: "Merged" };
  if (state === "CLOSED") return { status: "dropped", label: "Closed" };
  if (["DIRTY", "CONFLICTING"].includes(String(pr.mergeStateStatus || "").toUpperCase())) {
    return { status: "blocked", label: "Conflicting" };
  }
  if (pr.isDraft) return { status: "todo", label: "Draft" };
  return { status: "active", label: "Open" };
}

export function derivePrStates(board, prs = []) {
  const byNumber = new Map(prs.map((pr) => [String(pr.number), prLifecycle(pr)]));
  const out = {};
  for (const { phase } of allPhases(board)) {
    const numbers = refs(phase.pr || "");
    const states = numbers.map((number) => ({ number, ...(byNumber.get(number) || { status: "unknown", label: "Unknown" }) }));
    if (states.length) out[phase.id] = states;
  }
  return out;
}

export function describeChange(c) {
  const parts = [];
  if (c.pr) parts.push(`pr ${c.pr}`);
  if (c.issue) parts.push(`issue ${c.issue}`);
  return `${c.id}: ${parts.join(", ")}`;
}
