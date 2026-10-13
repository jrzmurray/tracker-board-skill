import * as B from "../board.mjs";
import * as S from "../store.mjs";

const short = (value, limit = 70) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

function showPhase(out, wave, phase) {
  out(`${phase.id}  [${phase.status}]  wave ${wave.id}${phase.lane ? `  lane ${phase.lane}` : ""}${phase.owner ? `  owner ${phase.owner}` : ""}`);
  for (const field of ["title", "note", "deps", "issue", "pr", "review", "req", "notes"]) {
    const value = field === "deps" ? phase.deps.join(", ") : phase[field];
    if (value) out(`  ${field}: ${value}`);
  }
}

// Phase filters shared by the show views: --wave, --lane, --status, --owner.
// --lane "" and --owner "" select phases with none.
function selectPhases(board, opts) {
  const lc = (value) => String(value).toLowerCase();
  let rows = B.allPhases(board);
  if (opts.wave != null) {
    const wave = B.requireWave(board, opts.wave);
    rows = rows.filter((row) => row.wave === wave);
  }
  if (opts.lane != null) {
    const lanes = [...new Set(B.allPhases(board).map((row) => row.phase.lane || ""))];
    if (!lanes.some((lane) => lc(lane) === lc(opts.lane))) {
      throw new B.BoardError(`no lane "${opts.lane}"; lanes: ${lanes.map((lane) => lane || '""').join(", ")}`);
    }
    rows = rows.filter((row) => lc(row.phase.lane || "") === lc(opts.lane));
  }
  if (opts.status != null) {
    const want = new Set(B.parseList(opts.status).map(B.normalizeStatus));
    rows = rows.filter((row) => want.has(row.phase.status));
  }
  if (opts.owner != null) rows = rows.filter((row) => lc(row.phase.owner || "") === lc(opts.owner));
  return rows;
}

export function createDisplayHelpers({ out, staleNote }) {
  function showBoard(board, name, opts) {
    if (opts.phase) {
      const { wave, phase } = B.locatePhase(board, opts.phase, opts.wave);
      if (opts.json) return out(JSON.stringify(phase, null, 2));
      showPhase(out, wave, phase);
      for (const dependent of B.dependents(board, phase.id)) out(`  needed by: ${dependent}`);
      staleNote(name);
      return;
    }
    const filtered = ["lane", "status", "owner"].some((key) => opts[key] != null);
    const rows = selectPhases(board, opts);
    if (opts.json) {
      const value = filtered ? rows.map((row) => ({ wave: row.wave.id, ...row.phase })) : opts.wave ? B.requireWave(board, opts.wave) : board;
      out(JSON.stringify(value, null, 2));
      return;
    }
    // Terse views write only their rows to stdout; the staleness note goes to stderr.
    if (opts.ids) {
      for (const row of rows) out(row.phase.id);
      return staleNote(name, true);
    }
    if (opts["pr-list"]) {
      const withPr = rows.filter((row) => /[\p{L}\p{N}]/u.test(row.phase.pr || "")); // skip "—" placeholders
      const width = Math.max(0, ...withPr.map((row) => row.phase.id.length));
      for (const { phase } of withPr) out(`${phase.id.padEnd(width)}  ${phase.status.padEnd(8)} ${short(phase.pr, 90)}`);
      if (!withPr.length) out("(no PRs)");
      return staleNote(name, true);
    }

    const local = S.loadLocal(name);
    out(`${board.name}: ${board.title}`);
    out(`artifact: ${local.artifactUrl || "(none)"}  db version: ${local.dbVersion ?? "(unknown)"}`);
    const line = (phase) => `${phase.id.padEnd(10)} ${phase.status.padEnd(8)} ${short(phase.title, 34).padEnd(34)} ${phase.deps.length ? "← " + phase.deps.join(",") : ""}${phase.owner ? `  @${phase.owner}` : ""}`.trimEnd();
    for (const wave of board.waves) {
      const mine = rows.filter((row) => row.wave === wave).map((row) => row.phase);
      if (!mine.length && (filtered || opts.wave != null)) continue;
      out(`\nwave ${wave.id}${wave.title ? ` — ${wave.title}` : ""}${wave.prefix ? `  (prefix ${wave.prefix})` : ""}`);
      // Group by lane, in order of first use, with the lane's done count (the
      // whole lane, not just the filtered rows), as the page does.
      const lanes = new Map();
      for (const phase of mine) {
        const lane = phase.lane || "";
        if (!lanes.has(lane)) lanes.set(lane, []);
        lanes.get(lane).push(phase);
      }
      const laned = wave.phases.some((phase) => phase.lane);
      for (const [lane, phases] of lanes) {
        const indent = laned ? "    " : "  ";
        if (laned) {
          const all = wave.phases.filter((phase) => (phase.lane || "") === lane);
          out(`  ${lane ? `lane ${lane}` : "no lane"}  ${all.filter((phase) => phase.status === "done").length}/${all.length} done`);
        }
        for (const phase of phases) out(indent + line(phase));
      }
    }
    if (filtered && !rows.length) out("\n(no matching phases)");
    const shown = new Set(rows.map((row) => row.phase.id));
    const ready = B.readyPhases(board).filter((id) => shown.has(id));
    if (ready.length) out(`\nready: ${ready.join(", ")}`);
    staleNote(name);
  }

  return { showBoard };
}
