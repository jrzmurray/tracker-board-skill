#!/usr/bin/env node
// trackerboard: deterministic CRUD for phase/wave tracker boards that publish
// to a claude.ai artifact. Run `trackerboard help` for usage.

import fs from "node:fs";
import path from "node:path";
import * as B from "./lib/board.mjs";
import * as S from "./lib/store.mjs";
import { CAPABILITIES, DOC_COLLECTION, DOC_ID, DOC_LIMIT, docBody, renderPage } from "./lib/render.mjs";

const USAGE = `trackerboard <command> [options]

Boards
  create <name> [--title T] [--repo-url URL] [--branch] [--no-bind]
                         Create a board and bind it to the current repo (or dir).
  boards                 List boards; marks the one this directory resolves to.
  bind [--board B] [--branch]     Bind a board to this repo (optionally this branch only).
  unbind [--board B] [--all]      Remove this directory's binding (or every binding).
  remove <name> --force           Delete a board and its local state.

Read
  show [--wave W] [--phase P] [--json]   Compact board summary (or one wave/phase).
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
  --title --lane --status --note --req --pr --review --notes --deps A,B
  --status: ${B.STATUSES.join(" | ")} (aliases: merged, in-progress, not-started, n/a, ...)
  Any write accepts --log "<text>". A value of @file reads the field from a file; - reads stdin.

Publish
  page                    Write the publishable page and print the first-publish steps.
  link --url URL          Record the artifact URL for this board.
  push                    Write the db document and print the ArtifactData call.
  synced --version N      Record the db version an ArtifactData write returned.
  pull --from FILE [--version N]   Replace the local board with a fetched db document.
  render [--out FILE]     Write a static HTML snapshot (for local preview).
`;

// ---------- args ----------

const BOOL = new Set(["force", "json", "no-bind", "branch", "all", "help"]);
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

function docFile(name) {
  return path.join(S.outDir(), `${name}.doc.json`);
}

function writeDoc(board) {
  const body = JSON.stringify(docBody(board));
  if (Buffer.byteLength(body) > DOC_LIMIT) {
    throw new B.BoardError(`board document is ${Buffer.byteLength(body)} bytes, over the ${DOC_LIMIT}-byte db limit; trim long fields or the log`);
  }
  fs.mkdirSync(S.outDir(), { recursive: true });
  fs.writeFileSync(docFile(board.name), body);
  return docFile(board.name);
}

function pushInstruction(board) {
  const local = S.loadLocal(board.name);
  const file = writeDoc(board);
  if (!local.artifactUrl) {
    out(`publish: (no artifact linked; \`trackerboard page\` publishes one)`);
    return;
  }
  const call = { action: "set", url: local.artifactUrl, collection: DOC_COLLECTION, doc_id: DOC_ID, file_path: file };
  if (local.dbVersion != null) call.if_version = local.dbVersion;
  out(`publish: ArtifactData ${JSON.stringify(call)}`);
  out(`then:    trackerboard synced --board ${board.name} --version <version from the result>`);
}

function commit(board, opts, summary) {
  B.appendLog(board, opts.log);
  S.saveBoard(board);
  out(`ok: ${summary}`);
  pushInstruction(board);
}

// ---------- show ----------

const short = (s, n = 70) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function showPhase(wave, p) {
  out(`${p.id}  [${p.status}]  wave ${wave.id}${p.lane ? `  lane ${p.lane}` : ""}`);
  for (const f of ["title", "note", "deps", "pr", "review", "req", "notes"]) {
    const v = f === "deps" ? p.deps.join(", ") : p[f];
    if (v) out(`  ${f}: ${v}`);
  }
}

function showBoard(board, name, opts) {
  if (opts.json) {
    const v = opts.phase ? B.locatePhase(board, opts.phase, opts.wave).phase : opts.wave ? B.requireWave(board, opts.wave) : board;
    out(JSON.stringify(v, null, 2));
    return;
  }
  if (opts.phase) {
    const { wave, phase } = B.locatePhase(board, opts.phase, opts.wave);
    showPhase(wave, phase);
    for (const d of B.dependents(board, phase.id)) out(`  needed by: ${d}`);
    return;
  }
  const local = S.loadLocal(name);
  const waves = opts.wave ? [B.requireWave(board, opts.wave)] : board.waves;
  out(`${board.name}: ${board.title}`);
  out(`artifact: ${local.artifactUrl || "(none)"}  db version: ${local.dbVersion ?? "(unknown)"}`);
  for (const w of waves) {
    out(`\nwave ${w.id}${w.title ? ` — ${w.title}` : ""}${w.prefix ? `  (prefix ${w.prefix})` : ""}`);
    for (const p of w.phases) {
      out(`  ${p.id.padEnd(10)} ${p.status.padEnd(8)} ${short(p.title, 34).padEnd(34)} ${p.deps.length ? "← " + p.deps.join(",") : ""}`);
    }
  }
  const ready = B.readyPhases(board);
  if (ready.length) out(`\nready: ${ready.join(", ")}`);
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
    commit(board, opts, `inserted ${phase.id} into wave ${wave.id} (after ${nb[0] ?? "start"}, before ${nb[1] ?? "end"})`);
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
    commit(board, opts, `updated board ${Object.keys(fields).join(", ")}`);
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
    commit(board, opts, `deleted wave ${wave.id}${removedDeps.length ? `; removed deps ${removedDeps.join(", ")}` : ""}`);
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
    commit(board, { log: text }, "logged");
  },

  page({ opts }) {
    const name = boardName(opts);
    const board = S.loadBoard(name);
    const file = path.join(S.outDir(), `${name}.page.html`);
    fs.mkdirSync(S.outDir(), { recursive: true });
    fs.writeFileSync(file, renderPage(board));
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
    if (local.artifactUrl !== opts.url) local.dbVersion = null;
    local.artifactUrl = opts.url;
    S.saveLocal(name, local);
    out(`ok: ${name} -> ${opts.url}`);
  },

  push({ opts }) {
    const name = boardName(opts);
    pushInstruction(S.loadBoard(name));
  },

  synced({ opts }) {
    const name = boardName(opts);
    const v = Number(opts.version);
    if (!Number.isInteger(v) || v < 1) throw new B.BoardError("synced needs --version <positive integer>");
    const local = S.loadLocal(name);
    local.dbVersion = v;
    S.saveLocal(name, local);
    out(`ok: ${name} db version ${v}`);
  },

  pull({ opts }) {
    const name = boardName(opts);
    if (!opts.from) throw new B.BoardError("pull needs --from <file>");
    const board = JSON.parse(fs.readFileSync(opts.from, "utf8"));
    if (board.name !== name) throw new B.BoardError(`document is board "${board.name}", not "${name}"`);
    S.saveBoard(board);
    if (opts.version) {
      const local = S.loadLocal(name);
      local.dbVersion = Number(opts.version);
      S.saveLocal(name, local);
    }
    out(`ok: replaced local ${name} from ${opts.from}`);
  },

  render({ opts }) {
    const name = boardName(opts);
    const file = opts.out || path.join(S.outDir(), `${name}.html`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderPage(S.loadBoard(name)));
    out(`ok: wrote ${file}`);
  },
};

commands.ls = commands.boards;
commands.rm = commands.delete;

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") return commands.help();
  const fn = commands[cmd];
  if (!fn) throw new B.BoardError(`unknown command "${cmd}"; run trackerboard help`);
  const args = parseArgs(rest);
  if (args.opts.help) return commands.help();
  fn(args);
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (e instanceof B.BoardError) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}
