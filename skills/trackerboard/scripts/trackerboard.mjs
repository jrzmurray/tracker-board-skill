#!/usr/bin/env node
// trackerboard: deterministic CRUD for phase/wave tracker boards that publish
// to a claude.ai artifact. Run `trackerboard help` for usage.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as B from "./lib/board.mjs";
import * as S from "./lib/store.mjs";
import * as G from "./lib/github.mjs";
import { content, mergeBoards, sameContent } from "./lib/merge.mjs";
import { CAPABILITIES, DOC_COLLECTION, DOC_ID, DOC_LIMIT, docBody, renderPage, renderStandalone } from "./lib/render.mjs";

const FRESH_SECONDS_HELP = process.env.TRACKERBOARD_FRESH_SECONDS ?? 120;
const USAGE = `trackerboard <command> [options]

Boards
  create <name> [--title T] [--repo-url URL] [--branch] [--no-bind]
                         Create a board and bind it to the current repo (or dir).
  boards                 List boards; marks the one this directory resolves to.
  bind [--board B] [--branch]     Bind a board to this repo (optionally this branch only).
  unbind [--board B] [--all]      Remove this directory's binding (or every binding).
  remove <name> --force           Delete a board and its local state.

Read
  show [--phase P] [--json]              Compact board summary, grouped by wave and lane (or one phase).
  show [--wave W] [--lane L] [--status S,S] [--owner O] [--ids | --pr-list | --json]
                         Filter the phases (--lane "" / --owner "" = none).
                         --ids: ids only. --pr-list: id, status and PR of phases with one.
  dep list [P] | dep graph | dep ready   Dependencies, mermaid graph, unblocked phases.

Write (--board is optional when exactly one board resolves from the cwd)
  insert --phase P [--wave W] [fields]    Add a phase; position comes from its id.
  insert --wave W [--title T] [--prefix X] [--after W2]   Add a wave.
  update --phase P [--wave W] [fields] [--rename P2] [--to-wave W2]
  update --wave W [--title T] [--prefix X] [--notes N] [--rename W2]
  update [board fields]                   --title --subtitle --lede --notes --repo-url
  delete [--wave W] <P> | --phase P       Delete a phase (its inbound deps are removed).
  delete --wave W [--force]               Delete a wave (--force if it has phases).
  dep add <P> --on A,B | dep rm <P> --on A | dep set <P> --on A,B | dep clear <P>
  log "<text>"                            Append to the board's change log.

Phase fields
  --title --lane --owner --status --note --req --issue --pr --review --notes --deps A,B
  --issue: the GitHub issue (#1234, or a bare number).
  --owner: who is working the phase (agent id or person); "" clears it.
  --status: ${B.STATUSES.join(" | ")} (aliases: merged, in-progress, not-started, n/a, ...)
  Any write accepts --log "<text>". A value of @file reads the field from a file; - reads stdin.

Publish
  page                    Write the publishable page and print the first-publish steps.
  link --url URL          Record the artifact URL for this board.
  push                    Write the db document and print the ArtifactData call.
  synced --version N [--doc FILE]  Record the db version an ArtifactData write returned.
  refresh                 Print the ArtifactData get that checks the published board.
  pull --version N [--from FILE] [--theirs | --ours]
                          Merge the fetched document into the local board
                          (no-op when N is the recorded version).
  Writes to a linked board need a refresh within ${FRESH_SECONDS_HELP}s
  (TRACKERBOARD_FRESH_SECONDS); otherwise they print the refresh steps and stop.
  render [--out FILE]     Write a static HTML snapshot (for local preview).

Generated boards (the input format is board.schema.json)
  import [name] --from FILE [--branch] [--no-bind]   Create a board from board JSON.
  import [name] --from FILE --replace [--keep owner,note]
                          Update an existing board from regenerated JSON; logs status
                          changes, adds and removals. --keep: phase fields the board keeps.
  github [--repo OWNER/NAME] [--in title,branch,labels,body] [--dry-run]
                          Find phase ids in open PRs and issues: fill --pr and --issue,
                          and move todo/waiting -> active (draft PR) or review (ready PR).
                          Never moves a phase back. --repo defaults to the board's repo URL.
`;

// ---------- args ----------

const BOOL = new Set(["replace", "dry-run", "ids", "pr-list", "theirs", "ours", "force", "json", "no-bind", "branch", "all", "help"]);
const ALIASES = { "status-note": "note", requirements: "req", "repo-url": "repoUrl", depends: "deps", "depends-on": "deps" };

function parseArgs(argv) {
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { pos.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOL.has(k)) { opts[k] = v == null ? true : v !== "false"; continue; }
    if (v == null) {
      if (i + 1 >= argv.length) throw new B.BoardError(`--${k} needs a value`);
      v = argv[++i];
    }
    k = ALIASES[k] || k;
    if (k in opts) throw new B.BoardError(`--${k} given twice`);
    opts[k] = readValue(v);
  }
  return { pos, opts };
}

function readValue(v) {
  if (v === "-") return fs.readFileSync(0, "utf8").replace(/\n$/, "");
  if (v.startsWith("@") && v.length > 1 && fs.existsSync(v.slice(1))) return fs.readFileSync(v.slice(1), "utf8").replace(/\n$/, "");
  return v;
}

function take(opts, names) {
  const out = {};
  for (const n of names) if (n in opts) { out[n] = opts[n]; delete opts[n]; }
  return out;
}

// Phase id from --phase or the first positional; returns how many positionals it used.
function pickPhase(opts, pos) {
  if (opts.phase != null) { const id = opts.phase; delete opts.phase; return { id, used: 0 }; }
  return pos.length ? { id: pos[0], used: 1 } : { id: null, used: 0 };
}

function rejectLeftovers(opts, pos, extra = 0) {
  const left = Object.keys(opts).filter((k) => !["board", "log"].includes(k));
  if (left.length) throw new B.BoardError(`unexpected option(s): ${left.map((k) => "--" + k).join(", ")}`);
  if (pos.length > extra) throw new B.BoardError(`unexpected argument(s): ${pos.slice(extra).join(" ")}`);
}

// ---------- output ----------

const out = (s = "") => process.stdout.write(s + "\n");

// Each document body gets its own content-addressed file, so a publish call
// always sends the snapshot it was printed for, even if another agent on this
// machine writes the board before the call is made.
async function writeDoc(board) {
  const body = JSON.stringify(await docBody(board));
  if (Buffer.byteLength(body) > DOC_LIMIT) {
    throw new B.BoardError(`board document is ${Buffer.byteLength(body)} bytes, over the ${DOC_LIMIT}-byte db limit; trim long fields or the log`);
  }
  const dir = path.join(S.outDir(), "docs");
  const file = path.join(dir, `${board.name}-${createHash("sha256").update(body).digest("hex").slice(0, 12)}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

// ---------- freshness ----------

// Writes need a recent check against the artifact, because other agents may
// publish to it at any time.
const FRESH_SECONDS = Number(process.env.TRACKERBOARD_FRESH_SECONDS ?? 120);
const linked = (local) => !!local.artifactUrl && local.dbVersion != null;
const checkedAgo = (local) => local.checkedAt ? (Date.now() - Date.parse(local.checkedAt)) / 1000 : Infinity;
const age = (sec) => sec === Infinity ? "never" : sec < 90 ? `${Math.round(sec)}s ago` : sec < 5400 ? `${Math.round(sec / 60)}m ago` : `${Math.round(sec / 3600)}h ago`;

function refreshLines(name, local) {
  const call = { action: "get", url: local.artifactUrl, collection: DOC_COLLECTION, doc_id: DOC_ID, out_dir: S.remoteDir(name) };
  return [
    `refresh: ArtifactData ${JSON.stringify(call)}`,
    `then:    trackerboard pull --board ${name} --version <version from the result>`,
  ];
}

function requireFresh(name) {
  const local = S.loadLocal(name);
  if (!linked(local) || checkedAgo(local) <= FRESH_SECONDS) return;
  throw new B.BoardError(`${name} was last checked against its artifact ${age(checkedAgo(local))}; other agents may have written it. Refresh, then repeat this command:\n${refreshLines(name, local).join("\n")}`);
}

function staleNote(name, toStderr = false) {
  const local = S.loadLocal(name);
  if (linked(local) && checkedAgo(local) > FRESH_SECONDS) {
    (toStderr ? (s) => process.stderr.write(s.trimStart() + "\n") : out)(`\nnote: last checked against the artifact ${age(checkedAgo(local))}; \`trackerboard refresh\` first if others may have written it`);
  }
}

async function pushInstruction(board) {
  const local = S.loadLocal(board.name);
  const file = await writeDoc(board);
  if (!local.artifactUrl) {
    out(`publish: (no artifact linked; \`trackerboard page\` publishes one)`);
    return;
  }
  const call = { action: "set", url: local.artifactUrl, collection: DOC_COLLECTION, doc_id: DOC_ID, file_path: file };
  if (local.dbVersion != null) call.if_version = local.dbVersion;
  out(`publish: ArtifactData ${JSON.stringify(call)}`);
  out(`then:    trackerboard synced --board ${board.name} --version <version from the result> --doc ${file}`);
}

async function commit(board, opts, summary) {
  requireFresh(board.name);
  B.appendLog(board, opts.log);
  S.saveBoard(board);
  out(`ok: ${summary}`);
  await pushInstruction(board);
}

// ---------- show ----------

const short = (s, n = 70) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function showPhase(wave, p) {
  out(`${p.id}  [${p.status}]  wave ${wave.id}${p.lane ? `  lane ${p.lane}` : ""}${p.owner ? `  owner ${p.owner}` : ""}`);
  for (const f of ["title", "note", "deps", "issue", "pr", "review", "req", "notes"]) {
    const v = f === "deps" ? p.deps.join(", ") : p[f];
    if (v) out(`  ${f}: ${v}`);
  }
}

// Phase filters shared by the show views: --wave, --lane, --status, --owner.
// --lane "" and --owner "" select phases with none.
function selectPhases(board, opts) {
  const lc = (v) => String(v).toLowerCase();
  let rows = B.allPhases(board);
  if (opts.wave != null) {
    const w = B.requireWave(board, opts.wave);
    rows = rows.filter((r) => r.wave === w);
  }
  if (opts.lane != null) {
    const lanes = [...new Set(B.allPhases(board).map((r) => r.phase.lane || ""))];
    if (!lanes.some((l) => lc(l) === lc(opts.lane))) {
      throw new B.BoardError(`no lane "${opts.lane}"; lanes: ${lanes.map((l) => l || '""').join(", ")}`);
    }
    rows = rows.filter((r) => lc(r.phase.lane || "") === lc(opts.lane));
  }
  if (opts.status != null) {
    const want = new Set(B.parseList(opts.status).map(B.normalizeStatus));
    rows = rows.filter((r) => want.has(r.phase.status));
  }
  if (opts.owner != null) rows = rows.filter((r) => lc(r.phase.owner || "") === lc(opts.owner));
  return rows;
}

function showBoard(board, name, opts) {
  if (opts.phase) {
    const { wave, phase } = B.locatePhase(board, opts.phase, opts.wave);
    if (opts.json) return out(JSON.stringify(phase, null, 2));
    showPhase(wave, phase);
    for (const d of B.dependents(board, phase.id)) out(`  needed by: ${d}`);
    staleNote(name);
    return;
  }
  const filtered = ["lane", "status", "owner"].some((k) => opts[k] != null);
  const rows = selectPhases(board, opts);
  if (opts.json) {
    const v = filtered ? rows.map((r) => ({ wave: r.wave.id, ...r.phase })) : opts.wave ? B.requireWave(board, opts.wave) : board;
    out(JSON.stringify(v, null, 2));
    return;
  }
  // Terse views write only their rows to stdout; the staleness note goes to stderr.
  if (opts.ids) {
    for (const r of rows) out(r.phase.id);
    return staleNote(name, true);
  }
  if (opts["pr-list"]) {
    const withPr = rows.filter((r) => /[\p{L}\p{N}]/u.test(r.phase.pr || "")); // skip "—" placeholders
    const w = Math.max(0, ...withPr.map((r) => r.phase.id.length));
    for (const { phase: p } of withPr) out(`${p.id.padEnd(w)}  ${p.status.padEnd(8)} ${short(p.pr, 90)}`);
    if (!withPr.length) out("(no PRs)");
    return staleNote(name, true);
  }

  const local = S.loadLocal(name);
  out(`${board.name}: ${board.title}`);
  out(`artifact: ${local.artifactUrl || "(none)"}  db version: ${local.dbVersion ?? "(unknown)"}`);
  const line = (p) => `${p.id.padEnd(10)} ${p.status.padEnd(8)} ${short(p.title, 34).padEnd(34)} ${p.deps.length ? "← " + p.deps.join(",") : ""}${p.owner ? `  @${p.owner}` : ""}`.trimEnd();
  for (const w of board.waves) {
    const mine = rows.filter((r) => r.wave === w).map((r) => r.phase);
    if (!mine.length && (filtered || opts.wave != null)) continue;
    out(`\nwave ${w.id}${w.title ? ` — ${w.title}` : ""}${w.prefix ? `  (prefix ${w.prefix})` : ""}`);
    // Group by lane, in order of first use, with the lane's done count (the
    // whole lane, not just the filtered rows), as the page does.
    const lanes = new Map();
    for (const p of mine) {
      const l = p.lane || "";
      if (!lanes.has(l)) lanes.set(l, []);
      lanes.get(l).push(p);
    }
    const laned = w.phases.some((p) => p.lane);
    for (const [l, ps] of lanes) {
      const indent = laned ? "    " : "  ";
      if (laned) {
        const all = w.phases.filter((p) => (p.lane || "") === l);
        out(`  ${l ? `lane ${l}` : "no lane"}  ${all.filter((p) => p.status === "done").length}/${all.length} done`);
      }
      for (const p of ps) out(indent + line(p));
    }
  }
  if (filtered && !rows.length) out("\n(no matching phases)");
  const shown = new Set(rows.map((r) => r.phase.id));
  const ready = B.readyPhases(board).filter((id) => shown.has(id));
  if (ready.length) out(`\nready: ${ready.join(", ")}`);
  staleNote(name);
}

// Delete this board's document snapshots older than a day, except `keep`.
function pruneDocs(name, keep) {
  const dir = path.join(S.outDir(), "docs");
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return; }
  for (const f of files) {
    const file = path.join(dir, f);
    if (!f.startsWith(`${name}-`) || file === keep) continue;
    try { if (Date.now() - fs.statSync(file).mtimeMs > 86400000) fs.rmSync(file); } catch {}
  }
}

// ---------- commands ----------

function boardName(opts) {
  const n = S.resolveBoardName(opts.board);
  delete opts.board;
  return n;
}

const commands = {
  help() { out(USAGE); },

  create({ pos, opts }) {
    const name = S.checkName(pos[0] || opts.board);
    const meta = take(opts, ["title", "repoUrl"]);
    const board = S.createBoard(name, { title: meta.title });
    if (meta.repoUrl) board.repoUrl = meta.repoUrl;
    S.saveBoard(board);
    let where = "unbound";
    if (!opts["no-bind"]) {
      const ctx = S.context();
      const b = S.makeBinding(ctx, { branch: !!opts.branch });
      S.saveLocal(name, { ...S.loadLocal(name), bindings: [b] });
      where = `bound to ${b.root}${b.branch ? ` @ ${b.branch}` : ""} (key ${b.key})`;
    }
    out(`ok: created board ${name}, ${where}`);
    out(`next: trackerboard page --board ${name}   (publish its artifact)`);
  },

  boards() {
    const names = S.listBoards();
    let resolved = null;
    try { resolved = S.resolveBoardName(null); } catch {}
    if (!names.length) return out("(no boards)");
    for (const n of names) {
      const local = S.loadLocal(n);
      const binds = (local.bindings || []).map((b) => `${b.root}${b.branch ? "@" + b.branch : ""}`).join("; ");
      out(`${n === resolved ? "*" : " "} ${n.padEnd(24)} ${local.artifactUrl || "-"}  ${binds}`);
    }
  },

  bind({ opts }) {
    const name = S.checkName(opts.board || S.resolveBoardName(null));
    const b = S.makeBinding(S.context(), { branch: !!opts.branch });
    const local = S.loadLocal(name);
    if (!local.bindings.some((x) => x.key === b.key)) local.bindings.push(b);
    S.saveLocal(name, local);
    out(`ok: ${name} bound to ${b.root}${b.branch ? ` @ ${b.branch}` : ""} (key ${b.key})`);
  },

  unbind({ opts }) {
    const name = boardName(opts);
    const local = S.loadLocal(name);
    const ctx = S.context();
    const before = local.bindings.length;
    local.bindings = opts.all ? [] : local.bindings.filter((b) => b.root !== ctx.root || (b.branch && b.branch !== ctx.branch));
    S.saveLocal(name, local);
    out(`ok: removed ${before - local.bindings.length} binding(s) from ${name}`);
  },

  remove({ pos, opts }) {
    const name = S.checkName(pos[0] || opts.board);
    S.loadBoard(name);
    if (!opts.force) throw new B.BoardError(`pass --force to delete board ${name}`);
    S.removeBoard(name);
    out(`ok: removed board ${name} (the published artifact is untouched)`);
  },

  show({ opts }) {
    const name = boardName(opts);
    showBoard(S.loadBoard(name), name, opts);
  },

  insert({ pos, opts }) {
    const name = boardName(opts);
    const board = S.loadBoard(name);
    const { id: phaseId, used } = pickPhase(opts, pos);
    if (phaseId == null) {
      if (opts.wave == null) throw new B.BoardError("insert needs --phase or --wave");
      const waveId = opts.wave; delete opts.wave;
      const extra = take(opts, ["after"]);
      const fields = take(opts, B.WAVE_FIELDS);
      rejectLeftovers(opts, pos);
      const w = B.insertWave(board, waveId, fields, extra);
      return commit(board, opts, `inserted wave ${w.id}`);
    }
    const waveId = opts.wave; delete opts.wave;
    const fields = take(opts, B.PHASE_FIELDS);
    rejectLeftovers(opts, pos, used);
    const { wave, phase } = B.insertPhase(board, phaseId, fields, { wave: waveId });
    const i = wave.phases.indexOf(phase);
    const nb = [wave.phases[i - 1]?.id, wave.phases[i + 1]?.id];
    return commit(board, opts, `inserted ${phase.id} into wave ${wave.id} (after ${nb[0] ?? "start"}, before ${nb[1] ?? "end"})`);
  },

  update({ pos, opts }) {
    const name = boardName(opts);
    const board = S.loadBoard(name);
    const { id: phaseId, used } = pickPhase(opts, pos);
    if (phaseId != null) {
      const waveId = opts.wave; delete opts.wave;
      const extra = take(opts, ["rename", "to-wave"]);
      const fields = take(opts, B.PHASE_FIELDS);
      rejectLeftovers(opts, pos, used);
      if (!Object.keys(fields).length && !Object.keys(extra).length) throw new B.BoardError("update needs at least one field");
      const { wave, phase } = B.updatePhase(board, phaseId, fields, { wave: waveId, rename: extra.rename, toWave: extra["to-wave"] });
      return commit(board, opts, `updated ${phase.id} in wave ${wave.id} (${[...Object.keys(fields), ...Object.keys(extra)].join(", ")})`);
    }
    if (opts.wave != null) {
      const waveId = opts.wave; delete opts.wave;
      const extra = take(opts, ["rename"]);
      const fields = take(opts, B.WAVE_FIELDS);
      rejectLeftovers(opts, pos);
      if (!Object.keys(fields).length && !extra.rename) throw new B.BoardError("update needs at least one field");
      const w = B.updateWave(board, waveId, fields, extra);
      return commit(board, opts, `updated wave ${w.id}`);
    }
    const fields = take(opts, B.BOARD_FIELDS);
    rejectLeftovers(opts, pos);
    if (!Object.keys(fields).length) throw new B.BoardError("update needs --phase, --wave, or a board field (--title --subtitle --lede --notes --repo-url)");
    Object.assign(board, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])));
    return commit(board, opts, `updated board ${Object.keys(fields).join(", ")}`);
  },

  delete({ pos, opts }) {
    const name = boardName(opts);
    const board = S.loadBoard(name);
    const { id: phaseId, used } = pickPhase(opts, pos);
    const waveId = opts.wave; delete opts.wave;
    const force = opts.force; delete opts.force;
    rejectLeftovers(opts, pos, used);
    if (phaseId != null) {
      const { wave, phase, removedDeps } = B.deletePhase(board, phaseId, waveId);
      return commit(board, opts, `deleted ${phase.id} from wave ${wave.id}${removedDeps.length ? `; removed deps ${removedDeps.join(", ")}` : ""}`);
    }
    if (waveId == null) throw new B.BoardError("delete needs a phase or --wave");
    const { wave, removedDeps } = B.deleteWave(board, waveId, { force });
    return commit(board, opts, `deleted wave ${wave.id}${removedDeps.length ? `; removed deps ${removedDeps.join(", ")}` : ""}`);
  },

  dep({ pos, opts }) {
    const sub = pos.shift();
    const name = boardName(opts);
    const board = S.loadBoard(name);
    const phaseId = opts.phase ?? pos.shift();
    delete opts.phase;
    if (sub === "graph") return out(B.toMermaid(board));
    if (sub === "ready") return out(B.readyPhases(board).join("\n") || "(none)");
    if (sub === "list") {
      const rows = phaseId ? [B.locatePhase(board, phaseId).phase] : B.allPhases(board).map((x) => x.phase);
      for (const p of rows) out(`${p.id}: ${p.deps.join(", ") || "-"}${phaseId ? `\n  needed by: ${B.dependents(board, p.id).join(", ") || "-"}` : ""}`);
      return;
    }
    if (!phaseId) throw new B.BoardError(`dep ${sub} needs a phase`);
    const on = opts.on ?? pos.join(",");
    delete opts.on;
    rejectLeftovers(opts, []);
    if (sub === "add") {
      if (!on) throw new B.BoardError("dep add needs --on");
      const { phase, added } = B.addDeps(board, phaseId, on);
      return commit(board, opts, `${phase.id} now depends on ${phase.deps.join(", ")}${added.length ? ` (added ${added.join(", ")})` : " (no change)"}`);
    }
    if (sub === "rm" || sub === "remove") {
      if (!on) throw new B.BoardError("dep rm needs --on");
      const { phase, removed } = B.removeDeps(board, phaseId, on);
      return commit(board, opts, `${phase.id} deps: ${phase.deps.join(", ") || "-"} (removed ${removed.join(", ") || "nothing"})`);
    }
    if (sub === "set" || sub === "clear") {
      const { phase } = B.setDeps(board, phaseId, sub === "clear" ? [] : on);
      return commit(board, opts, `${phase.id} deps: ${phase.deps.join(", ") || "-"}`);
    }
    throw new B.BoardError(`unknown dep subcommand "${sub}" (add, rm, set, clear, list, graph, ready)`);
  },

  log({ pos, opts }) {
    const name = boardName(opts);
    const board = S.loadBoard(name);
    const text = pos.join(" ") || opts.log;
    if (!text) throw new B.BoardError('log needs text: trackerboard log "<text>"');
    delete opts.log;
    rejectLeftovers(opts, []);
    return commit(board, { log: text }, "logged");
  },

  async page({ opts }) {
    const name = boardName(opts);
    const board = S.loadBoard(name);
    const file = path.join(S.outDir(), `${name}.page.html`);
    fs.mkdirSync(S.outDir(), { recursive: true });
    fs.writeFileSync(file, renderPage(await docBody(board)));
    const local = S.loadLocal(name);
    out(`ok: wrote ${file}`);
    if (local.artifactUrl) {
      out(`publish: Artifact {"action":"publish","url":"${local.artifactUrl}","file_path":"${file}"}`);
      out("(only needed when the page template changed; data updates go through push)");
      return;
    }
    out(`publish: Artifact ${JSON.stringify({ action: "publish", file_path: file, icon: "checklist", capabilities: CAPABILITIES, description: `Phase tracker for ${board.title}` })}`);
    out(`then:    trackerboard link --board ${name} --url <artifact url>   and   trackerboard push --board ${name}`);
  },

  link({ opts }) {
    const name = boardName(opts);
    if (!opts.url || !/^https:\/\/claude\.ai\/(code\/)?artifact\//.test(opts.url)) throw new B.BoardError("link needs --url https://claude.ai/artifact/...");
    const local = S.loadLocal(name);
    if (local.artifactUrl !== opts.url) { local.dbVersion = null; local.checkedAt = null; S.dropBase(name); }
    local.artifactUrl = opts.url;
    S.saveLocal(name, local);
    out(`ok: ${name} -> ${opts.url}`);
  },

  async push({ opts }) {
    const name = boardName(opts);
    await pushInstruction(S.loadBoard(name));
  },

  synced({ opts }) {
    const name = boardName(opts);
    const v = Number(opts.version);
    if (!Number.isInteger(v) || v < 1) throw new B.BoardError("synced needs --version <positive integer>");
    // The published document is now the merge base: the snapshot that was
    // sent (--doc), or the local board if it was not named.
    const sent = opts.doc ? JSON.parse(fs.readFileSync(opts.doc, "utf8")) : S.loadBoard(name);
    if (sent.name !== name) throw new B.BoardError(`document is board "${sent.name}", not "${name}"`);
    delete sent.layout;
    S.saveBase(name, sent);
    const local = S.loadLocal(name);
    local.dbVersion = v;
    local.checkedAt = new Date().toISOString();
    S.saveLocal(name, local);
    pruneDocs(name, opts.doc);
    out(`ok: ${name} db version ${v}`);
  },

  refresh({ opts }) {
    const name = boardName(opts);
    const local = S.loadLocal(name);
    if (!local.artifactUrl) return out(`ok: ${name} has no artifact linked; nothing to check`);
    for (const l of refreshLines(name, local)) out(l);
  },

  // Bring in the published document. Unpublished local changes are merged
  // onto it; a field changed differently on both sides stops the pull unless
  // --theirs or --ours says which side wins.
  async pull({ opts }) {
    const name = boardName(opts);
    const v = Number(opts.version);
    if (!Number.isInteger(v) || v < 1) throw new B.BoardError("pull needs --version <version from the ArtifactData result>");
    const from = opts.from || path.join(S.remoteDir(name), DOC_COLLECTION, `${DOC_ID}.json`);
    const remote = JSON.parse(fs.readFileSync(from, "utf8"));
    delete remote.layout; // derived; recomputed on every push
    if (remote.name !== name) throw new B.BoardError(`document is board "${remote.name}", not "${name}"`);
    B.validate(remote);
    const local = S.loadLocal(name);
    const board = S.loadBoard(name);
    const base = S.loadBase(name);
    const now = new Date().toISOString();

    if (local.dbVersion != null && v < local.dbVersion) {
      return out(`ok: version ${v} is older than the recorded ${local.dbVersion}; nothing changed`);
    }
    if (v === local.dbVersion) {
      if (!base) S.saveBase(name, remote);
      S.saveLocal(name, { ...local, checkedAt: now });
      out(`ok: ${name} is current at db version ${v}`);
      if (!sameContent(board, base || remote)) {
        out("local changes are not published yet:");
        await pushInstruction(board);
      }
      return;
    }

    // Without a recorded base, assume nothing local is unpublished.
    const prefer = opts.theirs ? "remote" : opts.ours ? "local" : null;
    const { board: merged, conflicts, notes } = !base || sameContent(board, base)
      ? { board: remote, conflicts: [], notes: [] }
      : mergeBoards(content(base), content(board), content(remote), { prefer });
    if (conflicts.length) {
      throw new B.BoardError(`db version ${v} conflicts with unpublished changes here:\n  ${conflicts.join("\n  ")}\nRerun with --theirs (keep the artifact's) or --ours (keep these), or ask the user which.`);
    }
    if (!base && !sameContent(board, remote)) out("note: no merge base was recorded, so the local board was replaced by the artifact's");
    B.validate(merged);
    S.saveBoard(merged);
    S.saveBase(name, remote);
    S.saveLocal(name, { ...local, dbVersion: v, checkedAt: now });
    out(`ok: pulled ${name} db version ${v}${local.dbVersion != null ? ` (was ${local.dbVersion})` : ""}`);
    for (const n of notes) out(`note: ${n}`);
    if (!sameContent(merged, remote)) {
      out("merged with unpublished changes here; publish them:");
      await pushInstruction(merged);
    }
  },

  async import({ pos, opts }) {
    if (!opts.from) throw new B.BoardError("import needs --from <board json>");
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(opts.from, "utf8"));
    } catch (e) {
      throw new B.BoardError(`cannot read ${opts.from}: ${e.message}`);
    }
    const incoming = B.normalizeBoard(raw);
    // --replace with no name updates the file's board, or the one this directory resolves to.
    const name = pos[0] || opts.board || incoming.name || (opts.replace ? boardName(opts) : "");
    if (!name) throw new B.BoardError("import needs a board name: an argument, --board, or \"name\" in the file");
    S.checkName(name);
    incoming.name = name;
    if (!opts.replace) {
      if (opts.keep) throw new B.BoardError("--keep only applies with --replace");
      if (S.boardExists(name)) throw new B.BoardError(`board "${name}" already exists; pass --replace to update it from this file`);
      S.createBoard(name, { title: incoming.title });
      S.saveBoard(incoming);
      out(`ok: imported ${name} (${B.allPhases(incoming).length} phases)`);
      if (!opts["no-bind"]) commands.bind({ opts: { board: name, branch: opts.branch } });
      return;
    }
    if (opts["no-bind"] || opts.branch) throw new B.BoardError("--replace keeps the board's bindings; drop --no-bind / --branch");
    const current = B.normalizeBoard(S.loadBoard(name));
    const keep = B.parseList(opts.keep || "");
    for (const f of keep) {
      if (!B.PHASE_FIELDS.includes(f)) throw new B.BoardError(`--keep: unknown phase field "${f}"; fields: ${B.PHASE_FIELDS.join(", ")}`);
    }
    const before = new Map(B.allPhases(current).map(({ phase }) => [phase.id.toLowerCase(), phase]));
    const after = new Map(B.allPhases(incoming).map(({ phase }) => [phase.id.toLowerCase(), phase]));
    // --keep: fields this board owns rather than the generator (an agent's owner, say).
    for (const [id, p] of after) {
      const was = before.get(id);
      if (was) for (const f of keep) p[f] = f === "deps" ? [...was.deps] : was[f];
    }
    if (keep.includes("deps")) B.validate(incoming);
    // The log is the board's history, so keep it and add any entries the file brings.
    const seen = new Set();
    incoming.log = [...incoming.log, ...current.log]
      .filter((e) => { const k = `${e.at}\0${e.text}`; return !seen.has(k) && seen.add(k); })
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, B.LOG_LIMIT);
    if (sameContent(incoming, current) && !opts.log) {
      out(`ok: ${name} already matches ${opts.from}`);
      return;
    }
    const added = [...after.keys()].filter((id) => !before.has(id)).map((id) => after.get(id).id);
    const removed = [...before.keys()].filter((id) => !after.has(id)).map((id) => before.get(id).id);
    const moved = [...after].filter(([id, p]) => before.has(id) && before.get(id).status !== p.status)
      .map(([id, p]) => `${p.id} ${before.get(id).status} → ${p.status}`);
    const changed = [...after].filter(([id, p]) => before.has(id) && !sameContent(before.get(id), p)).length;
    const list = (xs) => xs.slice(0, 8).join(", ") + (xs.length > 8 ? `, +${xs.length - 8} more` : "");
    const parts = [
      moved.length && `${moved.length} status change(s): ${list(moved)}`,
      added.length && `${added.length} added: ${list(added)}`,
      removed.length && `${removed.length} removed: ${list(removed)}`,
    ].filter(Boolean);
    if (!opts.log && parts.length) B.appendLog(incoming, `import: ${parts.join("; ")}`);
    await commit(incoming, opts, `replaced ${name} from ${opts.from} (${changed} changed, ${added.length} added, ${removed.length} removed)`);
  },

  async github({ opts }) {
    const name = boardName(opts);
    const board = S.loadBoard(name);
    const sources = opts.in ? B.parseList(opts.in) : G.DEFAULT_SOURCES;
    for (const s of sources) if (!G.SOURCES.includes(s)) throw new B.BoardError(`--in: unknown source "${s}"; sources: ${G.SOURCES.join(", ")}`);
    const repo = opts.repo || (board.repoUrl.match(/github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?\/?$/) || [])[1] || null;
    const limit = String(opts.limit || 1000);
    const gh = (args) => {
      const r = spawnSync(process.env.TRACKERBOARD_GH || "gh", [...args, ...(repo ? ["--repo", repo] : []), "--state", "open", "--limit", limit], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (r.error) throw new B.BoardError(`cannot run gh (${r.error.code === "ENOENT" ? "not installed" : r.error.message}); install the GitHub CLI and run \`gh auth login\``);
      if (r.status !== 0) throw new B.BoardError(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr.trim()}`);
      return JSON.parse(r.stdout || "[]");
    };
    const fields = ["number", "title", "labels", ...(sources.includes("body") ? ["body"] : [])];
    const prs = gh(["pr", "list", "--json", [...fields, "headRefName", "isDraft", "closingIssuesReferences"].join(",")]);
    const issues = gh(["issue", "list", "--json", fields.join(",")]);
    const changes = G.applyGithub(board, { prs, issues }, { sources });
    const scanned = `${prs.length} open PRs and ${issues.length} open issues${repo ? ` in ${repo}` : ""}`;
    if (!changes.length) return out(`ok: no changes from ${scanned}`);
    for (const c of changes) out(`  ${G.describeChange(c)}`);
    if (opts["dry-run"]) return out(`dry run: ${changes.length} phase(s) would change from ${scanned}`);
    if (!opts.log) {
      const moved = changes.filter((c) => c.status).map((c) => `${c.id} ${c.status[1]}`);
      B.appendLog(board, `github: ${changes.length} phase(s) updated from open PRs/issues${moved.length ? ` (${moved.slice(0, 8).join(", ")}${moved.length > 8 ? ", …" : ""})` : ""}`);
    }
    await commit(board, opts, `${changes.length} phase(s) updated from ${scanned}`);
  },

  async render({ opts }) {
    const name = boardName(opts);
    const file = opts.out || path.join(S.outDir(), `${name}.html`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderStandalone(await docBody(S.loadBoard(name))));
    out(`ok: wrote ${file}`);
  },
};

commands.ls = commands.boards;
commands.rm = commands.delete;

// A reader that closes early (`show | head`) is not an error.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") return commands.help();
  const fn = commands[cmd];
  if (!fn) throw new B.BoardError(`unknown command "${cmd}"; run trackerboard help`);
  const args = parseArgs(rest);
  if (args.opts.help) return commands.help();
  // Commands that change state run under the lock. Reads skip it: every
  // write replaces its file atomically, so a read never sees half of one.
  const dep = args.pos[0];
  const reads = cmd === "show" || cmd === "boards" || cmd === "ls" || cmd === "render" || cmd === "refresh" ||
    (cmd === "dep" && ["list", "graph", "ready"].includes(dep));
  await (reads ? fn(args) : S.withLock(() => fn(args)));
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof B.BoardError) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
});
