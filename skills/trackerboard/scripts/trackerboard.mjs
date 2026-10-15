#!/usr/bin/env node
// trackerboard: deterministic CRUD for phase/wave tracker boards that publish
// to a claude.ai artifact. Run `trackerboard help` for usage.

import fs from "node:fs";
import path from "node:path";
import * as B from "./lib/board.mjs";
import * as S from "./lib/store.mjs";
import { docBody, renderStandalone } from "./lib/render.mjs";
import { createArtifactCommands } from "./commands/artifact.mjs";
import { createBackendCommands } from "./commands/backend.mjs";
import { createGeneratedCommands } from "./commands/generated.mjs";
import { createDisplayHelpers } from "./lib/cli/display.mjs";

const FRESH_SECONDS_HELP = process.env.TRACKERBOARD_FRESH_SECONDS ?? 120;
const USAGE = `trackerboard <command> [options]

Boards
  create <name> [--title T] [--repo-url URL] [--branch] [--no-bind]
                         Create a board and bind it to the current repo (or dir).
  boards                 List boards; marks the one this directory resolves to.
  bind [--board B] [--branch]     Record that this repo (all its worktrees) uses a board, so --board can
                         be omitted here. Local to this machine; --branch limits it to this branch.
  unbind [--board B] [--all]      Remove this directory's binding (or every binding).
  remove <name> --force           Delete a board, local state, and bound GitHub Project (if any).

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

Publish (Claude-specific: prints Artifact/ArtifactData tool calls; the CLI never contacts Claude)
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
  github [--repo OWNER/NAME] [--in title,branch,labels,body] [--dry-run] [--file FILE]
                          Find phase ids in open PRs and issues: fill --pr and --issue,
                          without changing the human-controlled phase status. PR lifecycle
                          badges are derived separately. --repo defaults to the board's repo URL.
  refresh-prs [--repo OWNER/NAME] [--limit N]
                          Refresh derived per-PR lifecycle badges (cached locally for 60 seconds).

Backend and local editor
  backend [--json]                Show the resolved backend and configuration sources.
  backend --set-binding KEY       Select and validate an existing saved backend target.
  migrate --to json|sqlite|github [--binding KEY] [--dry-run]
                                  Migrate and verify before switching this board's backend; KEY selects the destination.
  serve [--port N]                Open a local, editable board at a loopback-only URL.
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

// ---------- commands ----------

function boardName(opts) {
  const n = S.resolveBoardName(opts.board);
  delete opts.board;
  return n;
}

function bindBoard(opts) {
  const name = S.checkName(opts.board || S.resolveBoardName(null));
  const binding = S.makeBinding(S.context(), { branch: !!opts.branch });
  const local = S.loadLocal(name);
  if (!local.bindings.some((item) => item.key === binding.key)) local.bindings.push(binding);
  S.saveLocal(name, local);
  out(`ok: ${name} bound to ${binding.root}${binding.branch ? ` @ ${binding.branch}` : ""} (key ${binding.key})`);
}

const artifact = createArtifactCommands({ boardName, out });
const { commit, cachedPrStates } = artifact;
const display = createDisplayHelpers({ out, staleNote: artifact.staleNote });
const generatedCommands = createGeneratedCommands({ boardName, out, commit });

const commands = {
  help() { out(USAGE); },
  ...createBackendCommands({ boardName, rejectLeftovers, out }),
  ...artifact.commands,
  ...generatedCommands,

  create({ pos, opts }) {
    const name = S.checkName(pos[0] || opts.board);
    const meta = take(opts, ["title", "repoUrl"]);
    const binding = opts["no-bind"] ? null : S.makeBinding(S.context(), { branch: !!opts.branch });
    const board = S.createBoard(name, meta, { binding });
    let where = "unbound";
    if (binding) {
      where = `bound to ${binding.root}${binding.branch ? ` @ ${binding.branch}` : ""} (key ${binding.key})`;
    }
    const backend = S.backendConfig(name).backend;
    out(`ok: created board ${name}, ${where}${backend === "github" ? " with a private GitHub Project" : ` using ${backend}`}`);
    out(`next: trackerboard show --board ${name}`);
    if (backend !== "github") out(`optional: trackerboard page --board ${name}   (publish a Claude artifact)`);
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

  bind({ opts }) { bindBoard(opts); },

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
    const backend = S.backendConfig(name).backend;
    S.removeBoard(name);
    out(backend === "github"
      ? `ok: removed board ${name} and its bound GitHub Project (the Claude artifact is untouched)`
      : `ok: removed board ${name} (the published artifact is untouched)`);
  },

  show({ opts }) {
    const name = boardName(opts);
    display.showBoard(S.loadBoard(name), name, opts);
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

  async render({ opts }) {
    const name = boardName(opts);
    const file = opts.out || path.join(S.outDir(), `${name}.html`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderStandalone(await docBody(S.loadBoard(name), { prStates: cachedPrStates(name) })));
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
  await S.initializeBackends();
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
