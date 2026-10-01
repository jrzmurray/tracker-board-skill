// Pure board model: waves, phases, ordering, dependency graph.
// Every function takes a board object and mutates it in place or throws a
// BoardError. No I/O lives here.

export class BoardError extends Error {}

export const SCHEMA = 1;

export const STATUSES = [
  "todo", "active", "review", "waiting", "blocked", "done", "ongoing", "external", "dropped",
];

const STATUS_ALIASES = {
  "not-started": "todo", "not_started": "todo", "pending": "todo", "planned": "todo",
  "in-progress": "active", "in_progress": "active", "running": "active", "wip": "active",
  "in-review": "review",
  "wait": "waiting",
  "block": "blocked", "stopped": "blocked",
  "merged": "done", "complete": "done", "completed": "done", "shipped": "done",
  "ext": "external",
  "n/a": "dropped", "na": "dropped", "cancelled": "dropped", "canceled": "dropped", "skipped": "dropped",
};

// Phase fields settable from the CLI. `deps` is handled by the graph helpers.
export const PHASE_FIELDS = ["title", "lane", "owner", "status", "note", "req", "issue", "pr", "review", "notes", "deps"];
export const WAVE_FIELDS = ["title", "prefix", "notes"];
export const BOARD_FIELDS = ["title", "subtitle", "lede", "notes", "repoUrl"];

export const LOG_LIMIT = 40;

export function normalizeStatus(value) {
  const v = String(value).trim().toLowerCase();
  if (STATUSES.includes(v)) return v;
  if (STATUS_ALIASES[v]) return STATUS_ALIASES[v];
  throw new BoardError(`unknown status "${value}"; expected one of: ${STATUSES.join(", ")}`);
}

export function newBoard(name, { title } = {}) {
  return {
    schema: SCHEMA,
    name,
    title: title || name,
    subtitle: "",
    lede: "",
    notes: "",
    repoUrl: "",
    waves: [],
    log: [],
    updatedAt: new Date().toISOString(),
  };
}

const key = (s) => String(s).trim().toLowerCase();

// ---------- lookup ----------

export function findWave(board, waveId) {
  return board.waves.find((w) => key(w.id) === key(waveId)) || null;
}

export function requireWave(board, waveId) {
  const w = findWave(board, waveId);
  if (!w) throw new BoardError(`wave "${waveId}" not found; waves: ${board.waves.map((x) => x.id).join(", ") || "(none)"}`);
  return w;
}

export function allPhases(board) {
  return board.waves.flatMap((w) => w.phases.map((p) => ({ wave: w, phase: p })));
}

export function locatePhase(board, phaseId, waveId) {
  const hits = allPhases(board).filter(({ wave, phase }) =>
    key(phase.id) === key(phaseId) && (waveId == null || key(wave.id) === key(waveId)));
  if (hits.length === 0) {
    throw new BoardError(`phase "${phaseId}" not found${waveId != null ? ` in wave "${waveId}"` : ""}`);
  }
  if (hits.length > 1) {
    throw new BoardError(`phase "${phaseId}" exists in waves ${hits.map((h) => h.wave.id).join(", ")}; pass --wave`);
  }
  return hits[0];
}

// ---------- ordering ----------

const SEP = /[.\-]/;

// Natural sort key: alternating text and number chunks, case-insensitive,
// with "." and "-" treated as the same separator.
export function naturalKey(id) {
  return key(id).replace(/[.\-_]/g, ".").match(/\d+|\D+/g) || [];
}

export function compareIds(a, b) {
  const ka = naturalKey(a), kb = naturalKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    if (i >= ka.length) return -1;
    if (i >= kb.length) return 1;
    const x = ka[i], y = kb[i];
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d; continue; }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// "P0.1" -> "P0", "A-2.3" -> "A-2", "P0" -> null
export function parentId(id) {
  const m = String(id).match(/^(.*\S)[.\-][^.\-]+$/);
  return m ? m[1] : null;
}

export function isDescendant(id, ancestor) {
  const a = key(ancestor), d = key(id);
  return d.length > a.length && d.startsWith(a) && SEP.test(d[a.length]);
}

export function stemOf(id) {
  return key(id).match(/^\D*/)[0];
}

// Index just past `idx` and every following phase that descends from it.
function endOfSubtree(phases, idx) {
  let end = idx + 1;
  while (end < phases.length && isDescendant(phases[end].id, phases[idx].id)) end++;
  return end;
}

// Where a new phase id lands inside a wave's phase list.
// 1. If an ancestor (P0 for P0.1, P0.1 for P0.1.1) exists in the wave, the
//    phase goes inside that ancestor's block, after any sibling that sorts
//    lower, so P0.1 sits right after P0 even when P1 exists.
// 2. Otherwise it goes after the last phase with the same stem ("P", "A-")
//    that sorts lower, or before the first same-stem phase that sorts higher.
// 3. Otherwise it is appended.
export function insertionIndex(phases, id) {
  for (let anc = parentId(id); anc; anc = parentId(anc)) {
    const ai = phases.findIndex((p) => key(p.id) === key(anc));
    if (ai === -1) continue;
    const blockEnd = endOfSubtree(phases, ai);
    let pos = ai + 1;
    let i = ai + 1;
    while (i < blockEnd) {
      const end = endOfSubtree(phases, i);
      if (compareIds(phases[i].id, id) <= 0) pos = end;
      i = end;
    }
    return pos;
  }
  const stem = stemOf(id);
  let lowerEnd = -1, firstHigher = -1;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (stemOf(p.id) !== stem || parentId(p.id) && phases.some((q) => isDescendant(p.id, q.id))) continue;
    if (compareIds(p.id, id) <= 0) lowerEnd = endOfSubtree(phases, i);
    else if (firstHigher === -1) firstHigher = i;
  }
  if (lowerEnd !== -1) return lowerEnd;
  if (firstHigher !== -1) return firstHigher;
  return phases.length;
}

// Wave a new phase belongs to when --wave is omitted.
export function inferWaveForInsert(board, phaseId) {
  for (let anc = parentId(phaseId); anc; anc = parentId(anc)) {
    const hits = allPhases(board).filter(({ phase }) => key(phase.id) === key(anc));
    if (hits.length === 1) return hits[0].wave;
  }
  const byPrefix = board.waves
    .filter((w) => w.prefix && key(phaseId).startsWith(key(w.prefix)))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  if (byPrefix.length) {
    const top = byPrefix.filter((w) => w.prefix.length === byPrefix[0].prefix.length);
    if (top.length === 1) return top[0];
  }
  const stem = stemOf(phaseId);
  const stemWaves = board.waves.filter((w) => w.phases.some((p) => stemOf(p.id) === stem));
  if (stemWaves.length === 1) return stemWaves[0];
  if (board.waves.length === 1) return board.waves[0];
  if (board.waves.length === 0) return null;
  throw new BoardError(`cannot infer the wave for "${phaseId}"; pass --wave (waves: ${board.waves.map((w) => w.id).join(", ")})`);
}

// ---------- waves ----------

export function insertWave(board, waveId, fields = {}, { after } = {}) {
  if (findWave(board, waveId)) throw new BoardError(`wave "${waveId}" already exists`);
  const wave = { id: String(waveId), title: "", prefix: "", notes: "", phases: [] };
  applyFields(wave, fields, WAVE_FIELDS, "wave");
  if (after) {
    const i = board.waves.indexOf(requireWave(board, after));
    board.waves.splice(i + 1, 0, wave);
  } else {
    board.waves.push(wave);
  }
  return wave;
}

export function updateWave(board, waveId, fields = {}, { rename } = {}) {
  const wave = requireWave(board, waveId);
  if (rename) {
    if (findWave(board, rename) && key(rename) !== key(waveId)) throw new BoardError(`wave "${rename}" already exists`);
    wave.id = String(rename);
  }
  applyFields(wave, fields, WAVE_FIELDS, "wave");
  return wave;
}

export function deleteWave(board, waveId, { force } = {}) {
  const wave = requireWave(board, waveId);
  if (wave.phases.length && !force) {
    throw new BoardError(`wave "${wave.id}" has ${wave.phases.length} phase(s); pass --force to delete them too`);
  }
  const removedDeps = [];
  for (const p of [...wave.phases]) removedDeps.push(...deletePhase(board, p.id, wave.id).removedDeps);
  board.waves.splice(board.waves.indexOf(wave), 1);
  return { wave, removedDeps };
}

// ---------- phases ----------

// Text fields are markdown. HTML <code>...</code> and <strong>/<b> spans,
// which agents sometimes write, are stored as backtick and ** spans.
const ENTITY = { "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&amp;": "&" };
export function htmlToMarkdown(text) {
  return String(text).replace(/<code>([\s\S]*?)<\/code>/gi, (_, c) => {
    c = c.replace(/&(lt|gt|quot|#39|amp);/g, (e) => ENTITY[e]);
    return c.includes("`") ? `\`\` ${c} \`\`` : `\`${c}\``;
  }).replace(/<(strong|b)>([^<]*?)<\/\1>/gi, "**$2**");
}

function applyFields(target, fields, allowed, what) {
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) throw new BoardError(`unknown ${what} field "${k}"; fields: ${allowed.join(", ")}`);
    if (k === "deps") continue;
    target[k] = k === "status" ? normalizeStatus(v) : htmlToMarkdown(v);
  }
}

export function insertPhase(board, phaseId, fields = {}, { wave: waveId } = {}) {
  if (!phaseId || !String(phaseId).trim()) throw new BoardError("phase id is required");
  const existing = allPhases(board).filter(({ phase }) => key(phase.id) === key(phaseId));
  let wave = waveId != null ? findWave(board, waveId) : inferWaveForInsert(board, phaseId);
  if (!wave) wave = insertWave(board, waveId != null ? waveId : "main");
  if (existing.some((e) => e.wave === wave)) {
    throw new BoardError(`phase "${phaseId}" already exists in wave "${wave.id}"; use update`);
  }
  if (existing.length) throw new BoardError(`phase "${phaseId}" already exists in wave "${existing[0].wave.id}"; ids are unique per board`);
  const phase = { id: String(phaseId), title: "", lane: "", owner: "", status: "todo", note: "", req: "", issue: "", pr: "", review: "", notes: "", deps: [] };
  applyFields(phase, fields, PHASE_FIELDS, "phase");
  wave.phases.splice(insertionIndex(wave.phases, phase.id), 0, phase);
  if (fields.deps != null) setDeps(board, phase.id, parseList(fields.deps));
  return { wave, phase };
}

export function updatePhase(board, phaseId, fields = {}, { wave: waveId, rename, toWave } = {}) {
  let { wave, phase } = locatePhase(board, phaseId, waveId);
  applyFields(phase, fields, PHASE_FIELDS, "phase");
  if (rename && key(rename) !== key(phase.id)) {
    if (allPhases(board).some(({ phase: p }) => key(p.id) === key(rename))) throw new BoardError(`phase "${rename}" already exists`);
    const old = phase.id;
    for (const { phase: p } of allPhases(board)) p.deps = p.deps.map((d) => (key(d) === key(old) ? String(rename) : d));
    phase.id = String(rename);
    wave.phases.splice(wave.phases.indexOf(phase), 1);
    wave.phases.splice(insertionIndex(wave.phases, phase.id), 0, phase);
  }
  if (toWave && key(toWave) !== key(wave.id)) {
    const dest = findWave(board, toWave) || insertWave(board, toWave);
    wave.phases.splice(wave.phases.indexOf(phase), 1);
    dest.phases.splice(insertionIndex(dest.phases, phase.id), 0, phase);
    wave = dest;
  }
  if (fields.deps != null) setDeps(board, phase.id, parseList(fields.deps));
  return { wave, phase };
}

export function deletePhase(board, phaseId, waveId) {
  const { wave, phase } = locatePhase(board, phaseId, waveId);
  wave.phases.splice(wave.phases.indexOf(phase), 1);
  const removedDeps = [];
  for (const { phase: p } of allPhases(board)) {
    const before = p.deps.length;
    p.deps = p.deps.filter((d) => key(d) !== key(phase.id));
    if (p.deps.length !== before) removedDeps.push(`${p.id} -> ${phase.id}`);
  }
  return { wave, phase, removedDeps };
}

// ---------- dependency graph ----------

export function parseList(v) {
  if (Array.isArray(v)) return v.flatMap(parseList);
  return String(v).split(/[,\s]+/).map((s) => s.trim()).filter((s) => s && s !== "-" && s !== "—");
}

function canonicalId(board, id) {
  const hit = allPhases(board).find(({ phase }) => key(phase.id) === key(id));
  if (!hit) throw new BoardError(`dependency "${id}" is not a phase on this board`);
  return hit.phase.id;
}

// Edges point from a phase to the phases it depends on.
function wouldCycle(board, from, to) {
  const deps = new Map(allPhases(board).map(({ phase }) => [key(phase.id), phase.deps.map(key)]));
  const stack = [key(to)], seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (n === key(from)) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(deps.get(n) || []));
  }
  return false;
}

export function addDeps(board, phaseId, on) {
  const { phase } = locatePhase(board, phaseId);
  const added = [];
  for (const raw of parseList(on)) {
    const id = canonicalId(board, raw);
    if (key(id) === key(phase.id)) throw new BoardError(`"${phase.id}" cannot depend on itself`);
    if (phase.deps.some((d) => key(d) === key(id))) continue;
    if (wouldCycle(board, phase.id, id)) throw new BoardError(`"${phase.id}" -> "${id}" would create a cycle`);
    phase.deps.push(id);
    added.push(id);
  }
  return { phase, added };
}

export function removeDeps(board, phaseId, on) {
  const { phase } = locatePhase(board, phaseId);
  const targets = parseList(on).map(key);
  const removed = phase.deps.filter((d) => targets.includes(key(d)));
  phase.deps = phase.deps.filter((d) => !targets.includes(key(d)));
  return { phase, removed };
}

export function setDeps(board, phaseId, on) {
  const { phase } = locatePhase(board, phaseId);
  const prev = phase.deps;
  phase.deps = [];
  try {
    addDeps(board, phaseId, on);
  } catch (e) {
    phase.deps = prev;
    throw e;
  }
  return { phase };
}

export function dependents(board, phaseId) {
  return allPhases(board).filter(({ phase }) => phase.deps.some((d) => key(d) === key(phaseId))).map(({ phase }) => phase.id);
}

export function toMermaid(board) {
  const phases = allPhases(board).map(({ phase }) => phase);
  const ids = new Map(phases.map((p, i) => [key(p.id), `n${i}`]));
  const lines = ["flowchart LR"];
  for (const p of phases) {
    const label = `${p.id}${p.title ? " " + p.title : ""}`.replace(/"/g, "'");
    lines.push(`  ${ids.get(key(p.id))}["${label}"]:::${p.status}`);
  }
  for (const p of phases) {
    for (const d of p.deps) lines.push(`  ${ids.get(key(d))} --> ${ids.get(key(p.id))}`);
  }
  return lines.join("\n");
}

// Phases whose deps are all done and that are not themselves done/dropped.
export function readyPhases(board) {
  const status = new Map(allPhases(board).map(({ phase }) => [key(phase.id), phase.status]));
  return allPhases(board)
    .filter(({ phase }) => ["todo", "waiting"].includes(phase.status))
    .filter(({ phase }) => phase.deps.every((d) => ["done", "dropped"].includes(status.get(key(d)))))
    .map(({ phase }) => phase.id);
}

// ---------- log ----------

export function appendLog(board, text, at = new Date().toISOString()) {
  if (!text) return;
  board.log.unshift({ at, text: htmlToMarkdown(text) });
  board.log.length = Math.min(board.log.length, LOG_LIMIT);
}

// ---------- input contract ----------

// Accepts board JSON written by a generator (see board.schema.json) and
// returns a complete board: missing fields get their defaults, status aliases
// are normalized, and deps may be a list or a comma string. Unknown keys are
// rejected so a typo in a generator fails loudly instead of being dropped.
export function normalizeBoard(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BoardError("board JSON must be an object");
  const where = (s) => (msg) => new BoardError(`${s}: ${msg}`);
  const strict = (obj, allowed, err) => {
    const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
    if (extra.length) throw err(`unknown field(s) ${extra.join(", ")}; allowed: ${allowed.join(", ")}`);
  };
  const str = (v, err, f) => {
    if (v == null) return "";
    if (typeof v === "object") throw err(`${f} must be a string`);
    return htmlToMarkdown(v);
  };
  const boardErr = where("board");
  strict(input, ["schema", "name", ...BOARD_FIELDS, "waves", "log", "updatedAt", "layout"], boardErr);
  const schema = input.schema ?? SCHEMA;
  if (schema !== SCHEMA) throw boardErr(`unsupported schema ${schema} (this trackerboard reads ${SCHEMA})`);
  if (!Array.isArray(input.waves)) throw boardErr("waves must be a list");
  const board = { schema, name: str(input.name, boardErr, "name") };
  for (const f of BOARD_FIELDS) board[f] = str(input[f], boardErr, f);
  board.title ||= board.name;
  board.waves = input.waves.map((w, i) => {
    const err = where(`wave ${w?.id ?? `#${i + 1}`}`);
    if (!w || typeof w !== "object" || w.id == null || String(w.id).trim() === "") throw err("needs an id");
    strict(w, ["id", ...WAVE_FIELDS, "phases"], err);
    const wave = { id: String(w.id) };
    for (const f of WAVE_FIELDS) wave[f] = str(w[f], err, f);
    if (w.phases != null && !Array.isArray(w.phases)) throw err("phases must be a list");
    wave.phases = (w.phases || []).map((p, j) => {
      const perr = where(`phase ${p?.id ?? `#${j + 1} in wave ${wave.id}`}`);
      if (!p || typeof p !== "object" || p.id == null || String(p.id).trim() === "") throw perr("needs an id");
      strict(p, ["id", ...PHASE_FIELDS], perr);
      const phase = { id: String(p.id) };
      for (const f of PHASE_FIELDS) if (f !== "deps") phase[f] = str(p[f], perr, f);
      try {
        phase.status = normalizeStatus(phase.status || "todo");
      } catch (e) {
        throw perr(e.message);
      }
      phase.deps = Array.isArray(p.deps) ? p.deps.map(String) : parseList(p.deps ?? "");
      return phase;
    });
    return wave;
  });
  board.log = Array.isArray(input.log)
    ? input.log.filter((e) => e && e.text).map((e) => ({ at: String(e.at || new Date().toISOString()), text: htmlToMarkdown(e.text) })).slice(0, LOG_LIMIT)
    : [];
  board.updatedAt = input.updatedAt ? String(input.updatedAt) : new Date().toISOString();
  validate(board);
  return board;
}

export function validate(board) {
  if (board.schema !== SCHEMA) throw new BoardError(`unsupported board schema ${board.schema}`);
  const ids = new Set();
  for (const { phase } of allPhases(board)) {
    if (ids.has(key(phase.id))) throw new BoardError(`duplicate phase id "${phase.id}"`);
    ids.add(key(phase.id));
    normalizeStatus(phase.status);
  }
  for (const { phase } of allPhases(board)) {
    for (const d of phase.deps) if (!ids.has(key(d))) throw new BoardError(`phase "${phase.id}" depends on missing "${d}"`);
  }
}
