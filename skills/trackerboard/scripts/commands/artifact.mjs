import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as B from "../lib/board.mjs";
import * as S from "../lib/store.mjs";
import { content, mergeBoards, sameContent } from "../lib/merge.mjs";
import { CAPABILITIES, DOC_COLLECTION, DOC_ID, DOC_LIMIT, docBody, renderPage } from "../lib/render.mjs";

const FRESH_SECONDS = Number(process.env.TRACKERBOARD_FRESH_SECONDS ?? 120);

export function createArtifactCommands({ boardName, out }) {
  const linked = (local) => !local.artifactDetached && !!local.artifactUrl && local.dbVersion != null;
  const checkedAgo = (local) => local.checkedAt ? (Date.now() - Date.parse(local.checkedAt)) / 1000 : Infinity;
  const age = (seconds) => seconds === Infinity ? "never" : seconds < 90 ? `${Math.round(seconds)}s ago` : seconds < 5400 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`;

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

  function assertArtifactAttached(name) {
    if (S.loadLocal(name).artifactDetached) {
      throw new B.BoardError(`${name}'s Claude artifact was detached during backend migration; artifact refresh/pull/push is unavailable for this board`);
    }
  }

  function cachedPrStates(name) {
    const local = S.loadLocal(name);
    return local.prStatesAt && Date.now() - Date.parse(local.prStatesAt) <= 60000 ? local.prStates : undefined;
  }

  function staleNote(name, toStderr = false) {
    const local = S.loadLocal(name);
    if (linked(local) && checkedAgo(local) > FRESH_SECONDS) {
      (toStderr ? (text) => process.stderr.write(text.trimStart() + "\n") : out)(`\nnote: last checked against the artifact ${age(checkedAgo(local))}; \`trackerboard refresh\` first if others may have written it`);
    }
  }

  async function writeDoc(board, prStates) {
    const body = JSON.stringify(await docBody(board, { prStates }));
    if (Buffer.byteLength(body) > DOC_LIMIT) {
      throw new B.BoardError(`board document is ${Buffer.byteLength(body)} bytes, over the ${DOC_LIMIT}-byte db limit; trim long fields or the log`);
    }
    const dir = path.join(S.outDir(), "docs");
    const file = path.join(dir, `${board.name}-${createHash("sha256").update(body).digest("hex").slice(0, 12)}.json`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  }

  async function pushInstruction(board) {
    assertArtifactAttached(board.name);
    const local = S.loadLocal(board.name);
    const prStates = cachedPrStates(board.name);
    const file = await writeDoc(board, prStates);
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
    const expected = process.env.TRACKERBOARD_EXPECTED_REVISION;
    S.saveBoard(board, { expectedRevision: expected == null ? undefined : /^\d+$/.test(expected) ? Number(expected) : expected });
    out(`ok: ${summary}`);
    if (S.loadLocal(board.name).artifactDetached) return;
    await pushInstruction(board);
  }

  function pruneDocs(name, keep) {
    const dir = path.join(S.outDir(), "docs");
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const fileName of files) {
      const file = path.join(dir, fileName);
      if (!fileName.startsWith(`${name}-`) || file === keep) continue;
      try { if (Date.now() - fs.statSync(file).mtimeMs > 86400000) fs.rmSync(file); } catch {}
    }
  }

  const commands = {
    async page({ opts }) {
      const name = boardName(opts);
      assertArtifactAttached(name);
      const board = S.loadBoard(name);
      const file = path.join(S.outDir(), `${name}.page.html`);
      fs.mkdirSync(S.outDir(), { recursive: true });
      fs.writeFileSync(file, renderPage(await docBody(board, { prStates: cachedPrStates(name) })));
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
      assertArtifactAttached(name);
      if (!opts.url || !/^https:\/\/claude\.ai\/(code\/)?artifact\//.test(opts.url)) throw new B.BoardError("link needs --url https://claude.ai/artifact/...");
      const local = S.loadLocal(name);
      if (local.artifactUrl !== opts.url) { local.dbVersion = null; local.checkedAt = null; S.dropBase(name); }
      local.artifactUrl = opts.url;
      S.saveLocal(name, local);
      out(`ok: ${name} -> ${opts.url}`);
    },

    async push({ opts }) {
      const name = boardName(opts);
      assertArtifactAttached(name);
      await pushInstruction(S.loadBoard(name));
    },

    synced({ opts }) {
      const name = boardName(opts);
      assertArtifactAttached(name);
      const version = Number(opts.version);
      if (!Number.isInteger(version) || version < 1) throw new B.BoardError("synced needs --version <positive integer>");
      // The published document is now the merge base: the snapshot that was
      // sent (--doc), or the local board if it was not named.
      const sent = opts.doc ? JSON.parse(fs.readFileSync(opts.doc, "utf8")) : S.loadBoard(name);
      if (sent.name !== name) throw new B.BoardError(`document is board "${sent.name}", not "${name}"`);
      delete sent.layout;
      delete sent.prStates;
      S.saveBase(name, sent);
      const local = S.loadLocal(name);
      local.dbVersion = version;
      local.checkedAt = new Date().toISOString();
      S.saveLocal(name, local);
      pruneDocs(name, opts.doc);
      out(`ok: ${name} db version ${version}`);
    },

    refresh({ opts }) {
      const name = boardName(opts);
      assertArtifactAttached(name);
      const local = S.loadLocal(name);
      if (!local.artifactUrl) return out(`ok: ${name} has no artifact linked; nothing to check`);
      for (const line of refreshLines(name, local)) out(line);
    },

    // Bring in the published document. Unpublished local changes are merged
    // onto it; a field changed differently on both sides stops the pull unless
    // --theirs or --ours says which side wins.
    async pull({ opts }) {
      const name = boardName(opts);
      assertArtifactAttached(name);
      const version = Number(opts.version);
      if (!Number.isInteger(version) || version < 1) throw new B.BoardError("pull needs --version <version from the ArtifactData result>");
      const from = opts.from || path.join(S.remoteDir(name), DOC_COLLECTION, `${DOC_ID}.json`);
      const remote = JSON.parse(fs.readFileSync(from, "utf8"));
      delete remote.layout; // derived; recomputed on every push
      delete remote.prStates; // derived presentation data, never canonical board state
      if (remote.name !== name) throw new B.BoardError(`document is board "${remote.name}", not "${name}"`);
      B.validate(remote);
      const local = S.loadLocal(name);
      const board = S.loadBoard(name);
      const base = S.loadBase(name);
      const now = new Date().toISOString();

      if (local.dbVersion != null && version < local.dbVersion) {
        return out(`ok: version ${version} is older than the recorded ${local.dbVersion}; nothing changed`);
      }
      if (version === local.dbVersion) {
        if (!base) S.saveBase(name, remote);
        S.saveLocal(name, { ...local, checkedAt: now });
        out(`ok: ${name} is current at db version ${version}`);
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
        throw new B.BoardError(`db version ${version} conflicts with unpublished changes here:\n  ${conflicts.join("\n  ")}\nRerun with --theirs (keep the artifact's) or --ours (keep these), or ask the user which.`);
      }
      if (!base && !sameContent(board, remote)) out("note: no merge base was recorded, so the local board was replaced by the artifact's");
      B.validate(merged);
      S.saveBoard(merged);
      S.saveBase(name, remote);
      S.saveLocal(name, { ...local, dbVersion: version, checkedAt: now });
      out(`ok: pulled ${name} db version ${version}${local.dbVersion != null ? ` (was ${local.dbVersion})` : ""}`);
      for (const note of notes) out(`note: ${note}`);
      if (!sameContent(merged, remote)) {
        out("merged with unpublished changes here; publish them:");
        await pushInstruction(merged);
      }
    },
  };

  return { commands, commit, cachedPrStates, staleNote };
}
