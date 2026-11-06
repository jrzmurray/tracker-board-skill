// Board hierarchy: a board may name a `parent` board. Parents are derived into
// children by scanning every board, so there is one source of truth. Progress
// rolls up from leaf phase counts; `dropped` phases never count toward totals.
import { BoardError, STATUSES, allPhases } from "./board.mjs";
import * as S from "./store.mjs";

const blank = () => Object.fromEntries(STATUSES.map((s) => [s, 0]));

function ownCounts(board) {
  const counts = blank();
  for (const { phase } of allPhases(board)) counts[phase.status] = (counts[phase.status] || 0) + 1;
  return counts;
}

export const totalOf = (counts) => Object.entries(counts).reduce((n, [s, c]) => (s === "dropped" ? n : n + c), 0);

function loadAll() {
  const boards = new Map();
  for (const name of S.listBoards()) {
    try { boards.set(name, S.loadBoard(name)); } catch { /* unreadable board: skip */ }
  }
  return boards;
}

function childrenOf(boards, name) {
  return [...boards.values()].filter((b) => b.parent === name && b.name !== name).sort((a, z) => a.name.localeCompare(z.name));
}

// A root board with children rolls up its children's phases (its own phases are
// milestones that point at them). A non-root board counts its own phases plus
// its children's; a leaf uses its own.
function rollup(boards, name, seen = new Set()) {
  const board = boards.get(name);
  const counts = blank();
  if (!board || seen.has(name)) return counts;
  seen.add(name);
  const kids = childrenOf(boards, name);
  const parts = kids.map((k) => rollup(boards, k.name, seen));
  if (!kids.length || board.parent) parts.push(ownCounts(board));
  for (const part of parts) for (const [s, c] of Object.entries(part)) counts[s] = (counts[s] || 0) + c;
  return counts;
}

const urlOf = (name) => {
  try { return S.loadLocal(name).artifactUrl || `${name}.page.html`; } catch { return `${name}.page.html`; }
};

function ancestorsOf(boards, name) {
  const chain = [];
  const seen = new Set([name]);
  for (let p = boards.get(name)?.parent; p && boards.has(p) && !seen.has(p); p = boards.get(p).parent) {
    seen.add(p);
    chain.unshift({ name: p, title: boards.get(p).title || p, url: urlOf(p) });
  }
  return chain;
}

function summarize(boards, b) {
  const counts = rollup(boards, b.name);
  return { name: b.name, title: b.title || b.name, url: urlOf(b.name), counts, total: totalOf(counts), done: counts.done, children: childrenOf(boards, b.name).length };
}

// Derived presentation data for one board's page, or undefined when it has
// neither a parent nor children.
export function boardTree(name) {
  const boards = loadAll();
  const board = boards.get(name);
  if (!board) return undefined;
  const ancestors = ancestorsOf(boards, name);
  const kids = childrenOf(boards, name).map((k) => summarize(boards, k));
  if (!ancestors.length && !kids.length) return undefined;
  return { ancestors, children: kids, rollup: kids.length ? summarize(boards, board) : undefined };
}

// Outline for `trackerboard tree`.
export function treeLines(rootName) {
  const boards = loadAll();
  const lines = [];
  const walk = (name, depth, seen) => {
    const b = boards.get(name);
    if (!b || seen.has(name)) return;
    seen.add(name);
    const s = summarize(boards, b);
    lines.push(`${"  ".repeat(depth)}${name}  ${s.done}/${s.total} done${s.total ? ` (${Math.round((s.done / s.total) * 100)}%)` : ""}${b.title && b.title !== name ? `  ${b.title}` : ""}`);
    for (const k of childrenOf(boards, name)) walk(k.name, depth + 1, seen);
  };
  if (rootName) {
    const chain = ancestorsOf(boards, rootName);
    if (chain.length) lines.push(`^ ${chain.map((c) => c.name).join(" > ")}`);
    walk(rootName, 0, new Set());
  } else {
    for (const b of boards.values()) if (!b.parent || !boards.has(b.parent)) walk(b.name, 0, new Set());
  }
  return lines;
}

// Throws when `parent` is not an existing board or would make a cycle.
export function checkParent(name, parent) {
  if (!parent) return;
  if (parent === name) throw new BoardError("a board cannot be its own parent");
  if (!S.boardExists(parent)) throw new BoardError(`parent board "${parent}" not found; boards: ${S.listBoards().join(", ") || "(none)"}`);
  const boards = loadAll();
  for (let p = parent, seen = new Set(); p && !seen.has(p); p = boards.get(p)?.parent) {
    if (p === name) throw new BoardError(`making "${parent}" the parent of "${name}" would create a cycle`);
    seen.add(p);
  }
}
