// Page rendering: the published shell is assets/page.html with the board
// title and an embedded snapshot. Live viewers then follow the db document.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { layoutBoard } from "./layout.mjs";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "page.html");

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// JSON that is safe inside <script type="application/json">.
const scriptJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// markdown-it's browser build, inlined so the page renders markdown with no
// network access. "</script" cannot appear inside the inline script.
const require = createRequire(import.meta.url);
let markdownIt = null;
function markdownItSource() {
  if (markdownIt == null) {
    const file = path.join(path.dirname(require.resolve("markdown-it/package.json")), "dist", "browser", "markdown-it.umd.min.js");
    // The library writes U+FFFD as a raw character inside template literals.
    // The Artifact publish tool refuses that character, so emit the equivalent escape.
    markdownIt = fs.readFileSync(file, "utf8")
      .replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "")
      .replace(/<\/(script)/gi, "<\\/$1")
      .replace(/�/g, "\\uFFFD");
  }
  return markdownIt;
}

// `embed: false` is the published page: it holds no board data and loads the
// separately published state.json instead, so there is one copy of the data.
// The embedded form is for the local static render, which has no other source.
export function renderPage(board, { embed = true } = {}) {
  let html = fs.readFileSync(TEMPLATE, "utf8");
  const mdSlot = '<script id="tb-md"></script>';
  if (!html.includes(mdSlot)) throw new Error("page template is missing the tb-md slot");
  html = html.replace(mdSlot, () => `<script id="tb-md">${markdownItSource()}</script>`);
  html = html.replace("<title>Tracker Board</title>", `<title>${escapeHtml(board.title || board.name)}</title>`);
  const slot = '<script type="application/json" id="tb-data">null</script>';
  if (!html.includes(slot)) throw new Error("page template is missing the tb-data slot");
  return embed ? html.replace(slot, () => `<script type="application/json" id="tb-data">${scriptJson(board)}</script>`) : html;
}

// A standalone document for local preview; the artifact skeleton supplies
// the doctype and charset at publish time.
export function renderStandalone(board) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>\n${renderPage(board)}</body></html>\n`;
}

// The published form of a board: the board plus its computed graph layout.
// If the layout engine is unavailable the page falls back to its own simple
// layering, so a missing dependency never blocks a status update.
export async function docBody(board, { prStates, tree } = {}) {
  let layout = null;
  try {
    layout = await layoutBoard(board);
  } catch (e) {
    process.stderr.write(`warning: graph layout skipped (${e.code === "MODULE_NOT_FOUND" ? "elkjs not installed; run npm install in the trackerboard repo" : e.message})\n`);
  }
  return { ...board, layout, ...(prStates ? { prStates } : {}), ...(tree ? { tree } : {}) };
}

// The board document is published as this file next to the page.
export const DOC_FILE = "state.json";
export const DOC_LIMIT = 8 * 1024 * 1024;
