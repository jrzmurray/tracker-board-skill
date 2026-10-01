// Three-way merge of boards: `base` is the published document this machine
// last synced with, `local` is base plus this machine's unpublished writes,
// `remote` is the published document now. Changes from both sides are kept;
// a field changed differently on both sides is a conflict.

import { BOARD_FIELDS, LOG_LIMIT, PHASE_FIELDS, WAVE_FIELDS, insertionIndex } from "./board.mjs";

const k = (id) => String(id).toLowerCase();
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const clone = (v) => JSON.parse(JSON.stringify(v));

// The board without fields that change on every save.
export function content(board) {
  if (!board) return null;
  const { updatedAt, layout, ...rest } = board;
  return rest;
}

export const sameContent = (a, b) => same(content(a), content(b));

function phaseIndex(board) {
  const m = new Map();
  for (const w of board.waves) for (const p of w.phases) m.set(k(p.id), { wave: w.id, phase: p });
  return m;
}

// prefer: null (report conflicts), "local" or "remote" (that side wins them).
export function mergeBoards(base, local, remote, { prefer = null } = {}) {
  const out = clone(remote);
  const conflicts = [];
  const notes = [];
  const pick = (what, b, l, r) => {
    if (same(l, b)) return r;
    if (same(r, b) || same(l, r)) return l;
    if (prefer) return prefer === "local" ? l : r;
    conflicts.push(what);
    return r;
  };

  for (const f of BOARD_FIELDS) out[f] = pick(`board ${f}`, base[f], local[f], remote[f]);

  // Waves
  const wmap = (b) => new Map(b.waves.map((w) => [k(w.id), w]));
  const [bw, lw, rw] = [wmap(base), wmap(local), wmap(remote)];
  const outWave = (id) => out.waves.find((w) => k(w.id) === k(id));
  for (const [id, l] of lw) {
    const b = bw.get(id), r = rw.get(id);
    if (r) {
      const o = outWave(id);
      for (const f of WAVE_FIELDS) o[f] = pick(`wave ${l.id} ${f}`, b?.[f], l[f], r[f]);
    } else if (!b) {
      // Added here: place it after the wave that precedes it locally.
      const li = local.waves.indexOf(l);
      const prev = local.waves.slice(0, li).reverse().find((w) => outWave(w.id));
      const at = prev ? out.waves.indexOf(outWave(prev.id)) + 1 : 0;
      out.waves.splice(at, 0, { ...clone(l), phases: [] });
    } else {
      const wb = { ...b, phases: undefined }, wl = { ...l, phases: undefined };
      if (!same(wb, wl)) conflicts.push(`wave ${l.id} changed here, deleted in the artifact`);
    }
  }
  const removedWaves = [];
  for (const [id, b] of bw) {
    if (lw.has(id) || !rw.has(id)) continue;
    const r = rw.get(id);
    if (same({ ...b, phases: undefined }, { ...r, phases: undefined })) removedWaves.push(id);
    else if (prefer === "local") removedWaves.push(id);
    else if (!prefer) conflicts.push(`wave ${b.id} deleted here, changed in the artifact`);
  }

  // Phases
  const [bp, lp, rp] = [phaseIndex(base), phaseIndex(local), phaseIndex(remote)];
  const op = phaseIndex(out);
  const removeOut = (id) => {
    const e = op.get(id);
    if (!e) return;
    const w = outWave(e.wave);
    w.phases.splice(w.phases.indexOf(e.phase), 1);
    op.delete(id);
  };
  const placeOut = (phase, waveId) => {
    const w = outWave(waveId);
    if (!w) { conflicts.push(`phase ${phase.id} belongs to wave ${waveId}, which the artifact deleted`); return; }
    w.phases.splice(insertionIndex(w.phases, phase.id), 0, phase);
    op.set(k(phase.id), { wave: w.id, phase });
  };

  const ids = new Set([...bp.keys(), ...lp.keys(), ...rp.keys()]);
  for (const id of ids) {
    const b = bp.get(id), l = lp.get(id), r = rp.get(id);
    if (!l && !r) continue;
    if (l && !r) {
      if (!b) placeOut(clone(l.phase), l.wave);
      else if (!same(b, l)) {
        if (prefer === "local") placeOut(clone(l.phase), l.wave);
        else if (!prefer) conflicts.push(`phase ${l.phase.id} changed here, deleted in the artifact`);
      }
      continue;
    }
    if (!l && r) {
      if (!b) continue; // added in the artifact
      if (same(b, r) || prefer === "local") removeOut(id);
      else if (!prefer) conflicts.push(`phase ${r.phase.id} deleted here, changed in the artifact`);
      continue;
    }
    // On both sides (or added on both).
    const o = op.get(id).phase;
    for (const f of PHASE_FIELDS) {
      if (f === "deps") continue;
      o[f] = pick(`phase ${l.phase.id} ${f}`, b?.phase[f], l.phase[f], r.phase[f]);
    }
    o.id = pick(`phase ${l.phase.id} id`, b?.phase.id, l.phase.id, r.phase.id);
    // deps merge as sets: the artifact's, plus what was added here, minus what was removed here.
    const bd = new Set((b?.phase.deps || []).map(k)), ld = new Set(l.phase.deps.map(k));
    const added = l.phase.deps.filter((d) => !bd.has(k(d)));
    const removed = new Set([...bd].filter((d) => !ld.has(d)));
    const deps = r.phase.deps.filter((d) => !removed.has(k(d)));
    for (const d of added) if (!deps.some((x) => k(x) === k(d))) deps.push(d);
    o.deps = deps;
    const wave = pick(`phase ${l.phase.id} wave`, b && k(b.wave), k(l.wave), k(r.wave));
    if (wave !== k(op.get(id).wave)) { removeOut(id); placeOut(o, wave); }
  }

  for (const id of removedWaves) {
    const w = outWave(id);
    if (w && !w.phases.length) out.waves.splice(out.waves.indexOf(w), 1);
    else if (w) conflicts.push(`wave ${w.id} was deleted here but still has phases`);
  }

  // Drop dependencies on phases that no longer exist.
  const live = new Set(op.keys());
  for (const { phase } of op.values()) {
    const gone = phase.deps.filter((d) => !live.has(k(d)));
    if (gone.length) {
      phase.deps = phase.deps.filter((d) => live.has(k(d)));
      notes.push(`removed deps ${phase.id} -> ${gone.join(", ")} (deleted phases)`);
    }
  }

  // Log: union of both sides, newest first.
  const seen = new Set();
  out.log = [...local.log, ...remote.log]
    .filter((e) => { const s = `${e.at}\0${e.text}`; if (seen.has(s)) return false; seen.add(s); return true; })
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, LOG_LIMIT);

  return { board: out, conflicts, notes };
}
