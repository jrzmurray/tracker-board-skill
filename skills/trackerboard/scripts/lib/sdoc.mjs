// StrictDoc (.sdoc) to a board hierarchy.
//
// parseSdoc reads the subset of the format that requirement documents use:
// [DOCUMENT], [GRAMMAR] (skipped; field names are taken from the elements),
// [[SECTION]] / [[/SECTION]], and any element block such as [REQUIREMENT] with
// single-line fields, `>>>` ... `<<<` multi-line fields, and RELATIONS lists.
// sdocBoards turns the elements into board JSON: a root board, one board per
// group value (nested for several --group-by fields), requirements as phases.
import fs from "node:fs";
import path from "node:path";
import { BoardError, STATUS_ALIASES } from "./board.mjs";

const HEADER = /^\[(\[)?(\/)?([A-Z_]+)\]\]?\s*(.*)$/;
const FIELD = /^([A-Z][A-Z0-9_]*):\s?(.*)$/;
const SKIPPED = new Set(["GRAMMAR", "FREETEXT", "TEXT", "DOCUMENT_FROM_FILE", "LIBRARY_FROM_FILE"]);

export function parseSdoc(text, file = "") {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const doc = { title: "", file, elements: [] };
  const sections = [];
  let cur = null;       // the element or document being filled
  let skipping = false; // inside a block we do not read
  let multi = null;     // { name, parts } while inside >>> ... <<<
  let rel = null;       // the RELATIONS list being filled
  let relEntry = null;

  const close = () => { cur = null; rel = null; relEntry = null; };
  const setField = (name, value) => {
    if (!cur) return;
    if (name === "RELATIONS") { rel = cur.relations = cur.relations || []; return; }
    rel = null;
    if (cur === doc) { if (name === "TITLE") doc.title = value; return; }
    cur.fields[name] = value;
  };
  const feed = (line, n) => {
    if (multi) {
      const end = line.indexOf("<<<");
      if (end < 0) { multi.parts.push(line); return; }
      const before = line.slice(0, end);
      if (before !== "") multi.parts.push(before);
      const done = multi; multi = null;
      setField(done.name, done.parts.join("\n").trim());
      const after = line.slice(end + 3).trim();
      if (after) feed(after, n);
      return;
    }
    if (rel && /^(- |\s+)\S/.test(line)) {
      const item = line.replace(/^-\s+/, "- ");
      const m = item.match(/^(- )?\s*([A-Z_]+):\s*(.*)$/);
      if (!m) return;
      if (m[1]) { relEntry = {}; rel.push(relEntry); }
      if (relEntry) relEntry[m[2].toLowerCase()] = m[3].trim();
      return;
    }
    const f = line.match(FIELD);
    if (!f) return;
    if (f[2].startsWith(">>>")) {
      multi = { name: f[1], parts: [] };
      const rest = f[2].slice(3).trim();
      if (rest) feed(rest, n);
      return;
    }
    setField(f[1], f[2].trim());
  };

  lines.forEach((line, i) => {
    if (multi) return feed(line, i + 1);
    const h = line.match(HEADER);
    if (h && !line.startsWith(" ")) {
      const [, double, closing, tag, rest] = h;
      if (closing) { if (tag === "SECTION") sections.pop(); skipping = false; close(); return; }
      close();
      skipping = SKIPPED.has(tag);
      if (skipping) return;
      if (tag === "DOCUMENT") cur = doc;
      else if (tag === "SECTION" && double) { cur = { tag, fields: {}, section: true }; sections.push(cur); }
      else { cur = { tag, fields: {}, sections: sections.map((s) => s.fields.TITLE || "").filter(Boolean) }; doc.elements.push(cur); }
      if (rest) feed(rest, i + 1);
      return;
    }
    if (!skipping) feed(line, i + 1);
  });
  if (multi) throw new BoardError(`${file}: unterminated >>> field ${multi.name}`);
  return doc;
}

export function readSdoc(paths) {
  const files = [];
  const walk = (p) => {
    if (!fs.existsSync(p)) throw new BoardError(`no such file or directory: ${p}`);
    if (fs.statSync(p).isDirectory()) fs.readdirSync(p).sort().forEach((n) => walk(path.join(p, n)));
    else if (p.endsWith(".sdoc")) files.push(p);
  };
  paths.forEach(walk);
  if (!files.length) throw new BoardError("no .sdoc files found");
  return files.map((f) => parseSdoc(fs.readFileSync(f, "utf8"), f));
}

const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

// The board status vocabulary and its aliases, plus StrictDoc's lifecycle words.
const DEFAULT_STATUS = {
  ...STATUS_ALIASES,
  planned: "planned", planning: "planning", in_progress: "active", active: "active", partial: "active",
  done: "done", dropped: "dropped",
  // StrictDoc's usual lifecycle words
  draft: "planning", approved: "planned", implemented: "done", obsolete: "dropped", rejected: "dropped",
};

export function parseStatusMap(spec) {
  const map = {};
  for (const pair of String(spec || "").split(",").filter(Boolean)) {
    const [k, v] = pair.split("=");
    if (!k || !v) throw new BoardError(`--status-map entries look like in_progress=active, got "${pair}"`);
    map[k.trim().toLowerCase()] = v.trim();
  }
  return map;
}

// Undo the backslash escapes a generator adds so StrictDoc's RST renderer
// accepts the text (\\ \* \` \| \_).
// Single line breaks inside a multi-line field are wrapping, not content.
const unescapeRst = (t) => t.replace(/(?<!\n)\n(?!\n)/g, " ").replace(/\\([\\*`|_])/g, "$1");

// The first clause of a statement, for a short label when TITLE is absent.
function headline(t) {
  const clean = t.replace(/\s+/g, " ").trim();
  const cut = clean.search(/[:;.](\s|$)| - /);
  const first = cut > 12 ? clean.slice(0, cut) : clean;
  return first.length <= 90 ? first : first.slice(0, 90).replace(/\s\S*$/, "") + "…";
}

// "R-ADM-001" -> "ADM"; "REQ-12" -> "REQ"; no dash -> the UID.
function domainOf(uid) {
  const parts = uid.split("-");
  return parts.length >= 3 ? parts[1] : parts[0];
}

// Group value for one element and one group-by key: `document` (the .sdoc's
// TITLE), `domain` (from the UID), `section` (innermost [[SECTION]] title), or
// a field name such as LEG.
function groupValue(el, doc, key) {
  if (key === "document") return doc.title || path.basename(doc.file, ".sdoc");
  if (key === "domain") return domainOf(el.fields.UID || "");
  if (key === "section") return el.sections.at(-1) || "";
  return el.fields[key] || "";
}

// opts: root, groupBy (array), statusMap (object), prField, noteFields (array),
// repoUrl, subtitle.
export function sdocBoards(docs, opts) {
  const root = opts.root;
  const groupBy = opts.groupBy?.length ? opts.groupBy : ["document"];
  const statusMap = { ...DEFAULT_STATUS, ...(opts.statusMap || {}) };
  const prField = opts.prField || "PROOF_PRS";
  const noteFields = opts.noteFields || ["PRIORITY"];

  // Every requirement-like element with a UID, tagged with its group path.
  const items = [];
  const seen = new Set();
  for (const doc of docs) {
    for (const el of doc.elements) {
      const uid = el.fields.UID;
      if (!uid) continue;
      if (seen.has(uid)) throw new BoardError(`duplicate UID ${uid} (${doc.file})`);
      seen.add(uid);
      items.push({ el, doc, uid, path: groupBy.map((k) => groupValue(el, doc, k) || "Ungrouped") });
    }
  }
  if (!items.length) throw new BoardError("no elements with a UID found");

  // Dependencies: Parent = depends on; Child = the target depends on this one.
  const deps = new Map(items.map((it) => [it.uid, new Set()]));
  const files = new Map(items.map((it) => [it.uid, []]));
  for (const it of items) {
    for (const r of it.el.relations || []) {
      if (r.type === "Parent" && seen.has(r.value)) deps.get(it.uid).add(r.value);
      else if (r.type === "Child" && seen.has(r.value)) deps.get(r.value).add(it.uid);
      else if (r.type === "File") files.get(it.uid).push(r.value);
    }
  }

  const boards = new Map();
  const ensure = (name, init) => {
    if (!boards.has(name)) boards.set(name, { schema: 1, name, repoUrl: opts.repoUrl || "", subtitle: opts.subtitle || "", waves: [], ...init });
    return boards.get(name);
  };
  // Distinct groups whose slugs collide ("Auth Flow" vs "auth-flow") get a
  // numeric suffix, so one never overwrites the other's board.
  const names = new Map(); // path key -> board name
  const taken = new Set();
  const nameFor = (segments) => {
    const key = segments.join("\u0000");
    if (!names.has(key)) {
      const base = [root, ...segments.map(slug)].join("-");
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
      taken.add(name);
      names.set(key, name);
    }
    return names.get(key);
  };
  const phaseOf = (it, onBoard) => {
    const f = it.el.fields;
    const statement = unescapeRst(f.STATEMENT || "");
    const title = f.TITLE ? unescapeRst(f.TITLE) : headline(statement) || it.uid;
    const away = [...deps.get(it.uid)].filter((d) => !onBoard.has(d));
    const extra = Object.keys(f).filter((k) => !["UID", "STATUS", "TITLE", "STATEMENT", prField, ...noteFields].includes(k));
    return {
      id: it.uid,
      title,
      lane: domainOf(it.uid),
      status: statusMap[(f.STATUS || "").toLowerCase()] || "planned",
      note: noteFields.map((k) => f[k]).filter(Boolean).join(" · "),
      req: statement && statement.trim() !== title ? statement : "",
      pr: f[prField] || "",
      notes: [
        ...extra.map((k) => `${k}: ${f[k]}`),
        ...files.get(it.uid).map((p) => `File: ${p}`),
        away.length ? `Also depends on: ${away.join(", ")}` : "",
      ].filter(Boolean).join("\n"),
      deps: [...deps.get(it.uid)].filter((d) => onBoard.has(d)),
    };
  };

  // Leaf boards hold the requirements; every shorter path is a roll-up board.
  const leafDepth = groupBy.length;
  const leaves = new Map();
  for (const it of items) {
    const key = it.path.join("\u0000");
    leaves.set(key, [...(leaves.get(key) || []), it]);
  }
  const counts = new Map(); // board name -> { done, live }
  const addCount = (name, it) => {
    const c = counts.get(name) || { done: 0, live: 0, active: 0 };
    const st = statusMap[(it.el.fields.STATUS || "").toLowerCase()] || "planned";
    if (st !== "dropped") { c.live++; if (st === "done") c.done++; else if (st !== "planned" && st !== "planning") c.active++; }
    counts.set(name, c);
  };
  for (const [key, group] of leaves) {
    const segs = key.split("\u0000");
    const onBoard = new Set(group.map((g) => g.uid));
    for (let d = 1; d <= leafDepth; d++) {
      const name = nameFor(segs.slice(0, d));
      const label = segs.slice(0, d).join(" · ");
      const parent = d === 1 ? root : nameFor(segs.slice(0, d - 1));
      const board = ensure(name, { title: label, parent, lede: d === leafDepth ? `${segs[d - 1]} requirements.` : "Roll-up of the boards beneath." });
      group.forEach((it) => addCount(name, it));
      if (d === leafDepth) board.waves = [{ id: "main", title: "", phases: group.map((it) => phaseOf(it, onBoard)) }];
    }
  }

  const topNames = [...new Set(items.map((it) => it.path[0]))];
  ensure(root, { title: opts.title || root, lede: "Milestones are the top-level groups. Progress above rolls up from every requirement on the boards beneath; dropped requirements are not counted." });
  const rootBoard = boards.get(root);
  rootBoard.waves = [{
    id: "milestones", title: groupBy[0],
    phases: topNames.map((v) => {
      const name = nameFor([v]);
      const c = counts.get(name) || { done: 0, live: 0, active: 0 };
      const status = c.live && c.done === c.live ? "done" : c.done || c.active ? "active" : "planned";
      return { id: v, title: v, status, note: `${c.done}/${c.live} done`, notes: `Board: \`${name}\`` };
    }),
  }];
  return [...boards.values()];
}
