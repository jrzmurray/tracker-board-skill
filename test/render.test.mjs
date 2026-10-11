import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import * as B from "../skills/trackerboard/scripts/lib/board.mjs";
import { docBody, renderPage } from "../skills/trackerboard/scripts/lib/render.mjs";

const FFFD = "�";

async function renderedBoard() {
  const b = B.newBoard("t");
  B.insertPhase(b, "P0");
  return renderPage(await docBody(b));
}

// Pull the inlined markdown-it out of the page and run it in a bare sandbox.
function markdownItFrom(html) {
  const m = html.match(/<script id="tb-md">([\s\S]*?)<\/script>/);
  assert.ok(m, "page has the tb-md script");
  const window = {};
  const context = vm.createContext({ window, self: window, globalThis: window, atob, btoa, TextDecoder, TextEncoder });
  vm.runInContext(m[1], context);
  assert.equal(typeof window.markdownit, "function", "markdownit is exposed on window");
  return window.markdownit;
}

test("rendered page contains no literal U+FFFD and keeps the markdown-it slot", async () => {
  const html = await renderedBoard();
  assert.ok(!html.includes(FFFD), "no raw U+FFFD in the page");
  assert.ok(html.includes('<script id="tb-md">'), "tb-md script is present");
});

test("inlined markdown-it still renders and tolerates a NUL byte", async () => {
  const md = markdownItFrom(await renderedBoard())({ html: false });
  assert.equal(md.render("**x**"), "<p><strong>x</strong></p>\n");
  assert.doesNotThrow(() => md.render("a\u0000b"));
});
