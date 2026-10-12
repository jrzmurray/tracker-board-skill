import { spawnSync } from "node:child_process";
import fs from "node:fs";
import * as B from "../lib/board.mjs";
import * as S from "../lib/store.mjs";
import * as G from "../lib/github.mjs";
import { sameContent } from "../lib/merge.mjs";

function runGhJson(args, { repo, limit = 1000, state } = {}) {
  const extra = [...(repo ? ["--repo", repo] : []), ...(state ? ["--state", state] : []), "--limit", String(limit)];
  const result = spawnSync(process.env.TRACKERBOARD_GH || "gh", [...args, ...extra], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new B.BoardError(`cannot run gh (${result.error.code === "ENOENT" ? "not installed" : result.error.message}); install the GitHub CLI and run \`gh auth login\``);
  if (result.status !== 0) throw new B.BoardError(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`);
  try { return JSON.parse(result.stdout || "[]"); }
  catch { throw new B.BoardError(`gh ${args.slice(0, 2).join(" ")} returned invalid JSON`); }
}

function repoSlug(board, override) {
  return override || (board.repoUrl.match(/github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?\/?$/) || [])[1] || null;
}

function refreshPrStates(board, repo, limit) {
  const prs = runGhJson(["pr", "list", "--json", "number,isDraft,state,mergedAt,mergeStateStatus"], { repo, limit, state: "all" });
  return G.derivePrStates(board, prs);
}

export function createGeneratedCommands({ boardName, out, commit, bindBoard }) {
  return {
    async import({ pos, opts }) {
      if (!opts.from) throw new B.BoardError("import needs --from <board json>");
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(opts.from, "utf8"));
      } catch (error) {
        throw new B.BoardError(`cannot read ${opts.from}: ${error.message}`);
      }
      const incoming = B.normalizeBoard(raw);
      // --replace with no name updates the file's board, or the one this directory resolves to.
      const name = pos[0] || opts.board || incoming.name || (opts.replace ? boardName(opts) : "");
      if (!name) throw new B.BoardError("import needs a board name: an argument, --board, or \"name\" in the file");
      S.checkName(name);
      incoming.name = name;
      incoming.title ||= name;
      if (!opts.replace) {
        if (opts.keep) throw new B.BoardError("--keep only applies with --replace");
        if (S.boardExists(name)) throw new B.BoardError(`board "${name}" already exists; pass --replace to update it from this file`);
        S.createBoard(name, { title: incoming.title, repoUrl: incoming.repoUrl });
        S.saveBoard(incoming);
        out(`ok: imported ${name} (${B.allPhases(incoming).length} phases)`);
        if (!opts["no-bind"]) bindBoard({ board: name, branch: opts.branch });
        return;
      }
      if (opts["no-bind"] || opts.branch) throw new B.BoardError("--replace keeps the board's bindings; drop --no-bind / --branch");
      const current = B.normalizeBoard(S.loadBoard(name));
      const keep = B.parseList(opts.keep || "");
      for (const field of keep) {
        if (!B.PHASE_FIELDS.includes(field)) throw new B.BoardError(`--keep: unknown phase field "${field}"; fields: ${B.PHASE_FIELDS.join(", ")}`);
      }
      const before = new Map(B.allPhases(current).map(({ phase }) => [phase.id.toLowerCase(), phase]));
      const after = new Map(B.allPhases(incoming).map(({ phase }) => [phase.id.toLowerCase(), phase]));
      // --keep: fields this board owns rather than the generator (an agent's owner, say).
      for (const [id, phase] of after) {
        const was = before.get(id);
        if (was) for (const field of keep) phase[field] = field === "deps" ? [...was.deps] : was[field];
      }
      if (keep.includes("deps")) B.validate(incoming);
      // The log is the board's history, so keep it and add any entries the file brings.
      const seen = new Set();
      incoming.log = [...incoming.log, ...current.log]
        .filter((entry) => { const key = `${entry.at}\0${entry.text}`; return !seen.has(key) && seen.add(key); })
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .slice(0, B.LOG_LIMIT);
      if (sameContent(incoming, current) && !opts.log) {
        out(`ok: ${name} already matches ${opts.from}`);
        return;
      }
      const added = [...after.keys()].filter((id) => !before.has(id)).map((id) => after.get(id).id);
      const removed = [...before.keys()].filter((id) => !after.has(id)).map((id) => before.get(id).id);
      const moved = [...after].filter(([id, phase]) => before.has(id) && before.get(id).status !== phase.status)
        .map(([id, phase]) => `${phase.id} ${before.get(id).status} → ${phase.status}`);
      const changed = [...after].filter(([id, phase]) => before.has(id) && !sameContent(before.get(id), phase)).length;
      const list = (items) => items.slice(0, 8).join(", ") + (items.length > 8 ? `, +${items.length - 8} more` : "");
      const parts = [
        moved.length && `${moved.length} status change(s): ${list(moved)}`,
        added.length && `${added.length} added: ${list(added)}`,
        removed.length && `${removed.length} removed: ${list(removed)}`,
      ].filter(Boolean);
      if (!opts.log && parts.length) B.appendLog(incoming, `import: ${parts.join("; ")}`);
      const what = changed || added.length || removed.length ? `${changed} changed, ${added.length} added, ${removed.length} removed` : "board fields only";
      await commit(incoming, opts, `replaced ${name} from ${opts.from} (${what})`);
    },

    async github({ opts }) {
      // --file: overlay a board JSON file in place, before `import --replace`,
      // so a regenerated board and its overlay land as one change.
      let board;
      if (opts.file) {
        try {
          board = B.normalizeBoard(JSON.parse(fs.readFileSync(opts.file, "utf8")));
        } catch (error) {
          throw error instanceof B.BoardError ? error : new B.BoardError(`cannot read ${opts.file}: ${error.message}`);
        }
      } else {
        board = S.loadBoard(boardName(opts));
      }
      const sources = opts.in ? B.parseList(opts.in) : G.DEFAULT_SOURCES;
      for (const source of sources) if (!G.SOURCES.includes(source)) throw new B.BoardError(`--in: unknown source "${source}"; sources: ${G.SOURCES.join(", ")}`);
      const repo = repoSlug(board, opts.repo);
      const limit = opts.limit || 1000;
      const fields = ["number", "title", "labels", ...(sources.includes("body") ? ["body"] : [])];
      const prs = runGhJson(["pr", "list", "--json", [...fields, "headRefName", "isDraft", "state", "mergedAt", "mergeStateStatus", "closingIssuesReferences"].join(",")], { repo, limit, state: "all" });
      const issues = runGhJson(["issue", "list", "--json", fields.join(",")], { repo, limit, state: "open" });
      const prStates = G.derivePrStates(board, prs);
      const changes = G.applyGithub(board, { prs, issues }, { sources });
      const scanned = `${prs.length} PRs and ${issues.length} open issues${repo ? ` in ${repo}` : ""}`;
      if (opts["dry-run"]) {
        if (!changes.length) return out(`ok: no changes from ${scanned}`);
        for (const change of changes) out(`  ${G.describeChange(change)}`);
        return out(`dry run: ${changes.length} phase(s) would change from ${scanned}`);
      }
      if (!opts.file) {
        const cacheLocal = S.loadLocal(board.name);
        S.saveLocal(board.name, { ...cacheLocal, prStates, prStatesAt: new Date().toISOString() });
      }
      if (!changes.length) return out(`ok: no changes from ${scanned}; PR badges refreshed`);
      for (const change of changes) out(`  ${G.describeChange(change)}`);
      if (opts.file) {
        fs.writeFileSync(opts.file, JSON.stringify(board, null, 2) + "\n");
        return out(`ok: ${changes.length} phase(s) in ${opts.file} updated from ${scanned}`);
      }
      if (!opts.log) B.appendLog(board, `github: ${changes.length} phase(s) linked from PRs/issues`);
      await commit(board, opts, `${changes.length} phase(s) linked from ${scanned}`);
    },

    async "refresh-prs"({ opts }) {
      const name = boardName(opts);
      const board = S.loadBoard(name);
      const repo = repoSlug(board, opts.repo);
      if (!repo) throw new B.BoardError(`board ${name} has no GitHub repository URL; pass --repo OWNER/NAME`);
      const prStates = refreshPrStates(board, repo, opts.limit || 1000);
      const local = S.loadLocal(name);
      S.saveLocal(name, { ...local, prStates, prStatesAt: new Date().toISOString() });
      const count = Object.values(prStates).reduce((total, rows) => total + rows.length, 0);
      out(`ok: refreshed ${count} PR badge(s) for ${repo}; cache expires in 60 seconds`);
    },
  };
}
