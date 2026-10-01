// Dependency-graph layout with ELK (layered, left to right, orthogonal edges).
// The result is plain geometry in absolute coordinates; the page draws it as
// SVG without any layout code of its own.

import { createRequire } from "node:module";
import { allPhases } from "./board.mjs";

const require = createRequire(import.meta.url);

let elk = null;
function engine() {
  if (!elk) {
    const ELK = require("elkjs/lib/elk.bundled.js");
    elk = new ELK();
  }
  return elk;
}

// Every node is the same size so each layer forms one left-aligned column.
// The page wraps "ID - title" over two lines of 11px mono inside it.
export const NODE_W = 232;
export const NODE_H = 44;

const ROOT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.alignment": "LEFT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "44",
  "elk.spacing.nodeNode": "14",
  "elk.spacing.edgeNode": "12",
  "elk.spacing.edgeEdge": "8",
  "elk.padding": "[top=8,left=8,bottom=8,right=8]",
};
const GROUP_OPTIONS = { "elk.padding": "[top=30,left=12,bottom=12,right=12]" };

const sid = (i) => `n${i}`;

// Returns null when no phase has a dependency (the page then omits the graph).
export async function layoutBoard(board) {
  const entries = allPhases(board);
  if (!entries.some(({ phase }) => phase.deps.length)) return null;

  const index = new Map(entries.map(({ phase }, i) => [phase.id.toLowerCase(), i]));
  const grouped = board.waves.filter((w) => w.phases.length).length > 1;
  const leaf = ({ phase }) => ({ id: sid(index.get(phase.id.toLowerCase())), width: NODE_W, height: NODE_H });

  const children = grouped
    ? board.waves.filter((w) => w.phases.length).map((w, wi) => ({
      id: `g${wi}`,
      layoutOptions: GROUP_OPTIONS,
      children: entries.filter((e) => e.wave === w).map(leaf),
    }))
    : entries.map(leaf);

  const edges = [];
  entries.forEach(({ phase }, i) => {
    for (const d of phase.deps) {
      const from = index.get(d.toLowerCase());
      if (from != null) edges.push({ id: `e${edges.length}`, sources: [sid(from)], targets: [sid(i)] });
    }
  });

  const g = await engine().layout({ id: "root", layoutOptions: ROOT_OPTIONS, children, edges });

  // ELK coordinates are relative to the parent node (nodes) or to the
  // edge's container (edges); flatten both to absolute.
  const origin = new Map([["root", { x: 0, y: 0 }]]);
  const out = { engine: "elk-layered", width: Math.ceil(g.width), height: Math.ceil(g.height), groups: [], nodes: [], edges: [] };
  const groupWaves = board.waves.filter((w) => w.phases.length);
  const visit = (node, ox, oy) => {
    for (const c of node.children || []) {
      const x = ox + c.x, y = oy + c.y;
      origin.set(c.id, { x, y });
      if (c.id.startsWith("g")) {
        const w = groupWaves[Number(c.id.slice(1))];
        out.groups.push({ wave: w.id, title: w.title || "", x, y, w: c.width, h: c.height });
        visit(c, x, y);
      } else {
        out.nodes.push({ id: entries[Number(c.id.slice(1))].phase.id, x, y, w: c.width, h: c.height });
      }
    }
  };
  visit(g, 0, 0);

  const collect = (node) => {
    for (const e of node.edges || []) {
      const o = origin.get(e.container || node.id) || { x: 0, y: 0 };
      for (const s of e.sections || []) {
        const pts = [s.startPoint, ...(s.bendPoints || []), s.endPoint].map((p) => [round(o.x + p.x), round(o.y + p.y)]);
        out.edges.push({
          from: entries[Number(e.sources[0].slice(1))].phase.id,
          to: entries[Number(e.targets[0].slice(1))].phase.id,
          points: pts,
        });
      }
    }
    for (const c of node.children || []) collect(c);
  };
  collect(g);
  for (const n of out.nodes) Object.assign(n, { x: round(n.x), y: round(n.y) });
  for (const gr of out.groups) Object.assign(gr, { x: round(gr.x), y: round(gr.y), w: round(gr.w), h: round(gr.h) });
  return out;
}

const round = (v) => Math.round(v * 10) / 10;
