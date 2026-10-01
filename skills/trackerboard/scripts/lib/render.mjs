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
    markdownIt = fs.readFileSync(file, "utf8").replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "").replace(/<\/(script)/gi, "<\\/$1");
  }
  return markdownIt;
}

export function renderPage(board) {
  let html = fs.readFileSync(TEMPLATE, "utf8");
  const mdSlot = '<script id="tb-md"></script>';
  if (!html.includes(mdSlot)) throw new Error("page template is missing the tb-md slot");
  html = html.replace(mdSlot, () => `<script id="tb-md">${markdownItSource()}</script>`);
  html = html.replace("<title>Tracker Board</title>", `<title>${escapeHtml(board.title || board.name)}</title>`);
  const slot = '<script type="application/json" id="tb-data">null</script>';
  if (!html.includes(slot)) throw new Error("page template is missing the tb-data slot");
  return html.replace(slot, () => `<script type="application/json" id="tb-data">${scriptJson(board)}</script>`);
}

// A standalone document for local preview; the artifact skeleton supplies
// the doctype and charset at publish time.
export function renderStandalone(board) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>\n${renderPage(board)}</body></html>\n`;
}

// The published form of a board: the board plus its computed graph layout.
// If the layout engine is unavailable the page falls back to its own simple
// layering, so a missing dependency never blocks a status update.
export async function docBody(board) {
  let layout = null;
  try {
    layout = await layoutBoard(board);
  } catch (e) {
    process.stderr.write(`warning: graph layout skipped (${e.code === "MODULE_NOT_FOUND" ? "elkjs not installed; run npm install in the trackerboard repo" : e.message})\n`);
  }
  return { ...board, layout };
}

export const DOC_COLLECTION = "board";
export const DOC_ID = "state";
export const DOC_LIMIT = 240 * 1024;

export const CAPABILITIES = { db: { rules: [{ path: "", read: "view", write: "admin" }] } };
