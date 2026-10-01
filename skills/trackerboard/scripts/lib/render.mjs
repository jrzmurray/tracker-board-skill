// Page rendering: the published shell is assets/page.html with the board
// title and an embedded snapshot. Live viewers then follow the db document.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "page.html");

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// JSON that is safe inside <script type="application/json">.
const scriptJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function renderPage(board) {
  let html = fs.readFileSync(TEMPLATE, "utf8");
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

// The db document body: the board itself.
export function docBody(board) {
  return board;
}

export const DOC_COLLECTION = "board";
export const DOC_ID = "state";
export const DOC_LIMIT = 240 * 1024;

export const CAPABILITIES = { db: { rules: [{ path: "", read: "view", write: "admin" }] } };
