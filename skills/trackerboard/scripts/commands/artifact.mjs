import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as B from "../lib/board.mjs";
import * as S from "../lib/store.mjs";
import { content, mergeBoards, sameContent } from "../lib/merge.mjs";
import { DOC_FILE, DOC_LIMIT, docBody, renderPage } from "../lib/render.mjs";

const FRESH_SECONDS = Number(process.env.TRACKERBOARD_FRESH_SECONDS ?? 120);

// The artifact slug is the last path segment of its claude.ai URL.
const slugOf = (url) => String(url).replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop();

export function createArtifactCommands({ boardName, out }) {
  const linked = (local) => !local.artifactDetached && !!local.artifactUrl && local.artifactVersion != null;
  const checkedAgo = (local) => local.checkedAt ? (Date.now() - Date.parse(local.checkedAt)) / 1000 : Infinity;
  const age = (seconds) => seconds === Infinity ? "never" : seconds < 90 ? `${Math.round(seconds)}s ago` : seconds < 5400 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`;

  const remoteFile = (name) => path.join(S.remoteDir(name), DOC_FILE);

  // get_artifact is a few lines; the document itself is only read (read_file)
  // when the version has moved, which `pull` says.
  function refreshLines(name, local) {
    return [
      `refresh: get_artifact ${JSON.stringify({ slug: slugOf(local.artifactUrl) })}`,
      `then:    trackerboard pull --board ${name} --version <version from the result>`,
    ];
  }

  function readRemote(name, from) {
    const remote = JSON.parse(fs.readFileSync(from, "utf8"));
    delete remote.layout; // derived; recomputed on every push
    delete remote.prStates; // derived presentation data, never canonical board state
    if (remote.name !== name) throw new B.BoardError(`document is board "${remote.name}", not "${name}"`);
    B.validate(remote);
    return remote;
  }

  function readFileLines(name, local) {
    return [
      `read:    read_file ${JSON.stringify({ slug: slugOf(local.artifactUrl), paths: [DOC_FILE] })}`,
      `then:    copy the saved file to ${remoteFile(name)} and rerun this pull`,
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
      throw new B.BoardError(`board document is ${Buffer.byteLength(body)} bytes, over the ${DOC_LIMIT}-byte limit; trim long fields or the log`);
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
    // publish_files sends file bytes without passing them through the model.
    // base_version makes it a compare-and-swap: it is refused if anyone
    // published since the recorded version.
    const call = { slug: slugOf(local.artifactUrl), base_version: local.artifactVersion ?? "<version from get_artifact>", files: [{ as: DOC_FILE, path: file }] };
    out(`publish: publish_files ${JSON.stringify(call)}`);
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
      const prStates = cachedPrStates(name);
      const file = path.join(S.outDir(), `${name}.page.html`);
      fs.mkdirSync(S.outDir(), { recursive: true });
      // The page carries no board data; state.json is published beside it.
      fs.writeFileSync(file, renderPage(board, { embed: false }));
      const doc = await writeDoc(board, prStates);
      const local = S.loadLocal(name);
      out(`ok: wrote ${file} and ${doc}`);
      if (local.artifactUrl) {
        const call = { slug: slugOf(local.artifactUrl), base_version: local.artifactVersion ?? "<version from get_artifact>", files: [{ as: "index.html", path: file }] };
        out(`publish: publish_files ${JSON.stringify(call)}`);
        out("(only needed when the page template changed; data updates go through push)");
        out(`then:    trackerboard synced --board ${name} --version <version from the result> --doc ${doc}   (only if you also published ${DOC_FILE})`);
        return;
      }
      const call = { title: board.title, icon: "checklist", files: [{ as: "index.html", path: file }, { as: DOC_FILE, path: doc }] };
      out(`publish: publish_files ${JSON.stringify(call)}`);
      out(`then:    trackerboard link --board ${name} --url <artifact url>   and   trackerboard synced --board ${name} --version <version from the result> --doc ${doc}`);
    },

    link({ opts }) {
      const name = boardName(opts);
      assertArtifactAttached(name);
      if (!opts.url || !/^https:\/\/claude\.ai\/(code\/)?artifact\//.test(opts.url)) throw new B.BoardError("link needs --url https://claude.ai/artifact/...");
      const local = S.loadLocal(name);
      if (local.artifactUrl !== opts.url) { local.artifactVersion = null; local.checkedAt = null; S.dropBase(name); }
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
      const version = String(opts.version ?? "").trim();
      if (!version || version === "true") throw new B.BoardError("synced needs --version <version id from the publish_files result>");
      // The published document is now the merge base: the snapshot that was
      // sent (--doc), or the local board if it was not named.
      const sent = opts.doc ? JSON.parse(fs.readFileSync(opts.doc, "utf8")) : S.loadBoard(name);
      if (sent.name !== name) throw new B.BoardError(`document is board "${sent.name}", not "${name}"`);
      delete sent.layout;
      delete sent.prStates;
      S.saveBase(name, sent);
      const local = S.loadLocal(name);
      local.artifactVersion = version;
      local.checkedAt = new Date().toISOString();
      S.saveLocal(name, local);
      pruneDocs(name, opts.doc);
      out(`ok: ${name} artifact version ${version}`);
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
      const version = String(opts.version ?? "").trim();
      if (!version || version === "true") throw new B.BoardError("pull needs --version <version id from the get_artifact result>");
      const local = S.loadLocal(name);
      const from = opts.from || remoteFile(name);
      // Version ids are opaque, so the only comparison is "unchanged". When
      // it has moved, the published document is needed.
      if (version !== local.artifactVersion && !fs.existsSync(from)) {
        throw new B.BoardError(`artifact version ${version} is not the recorded ${local.artifactVersion ?? "(none)"}; read the published document first:\n${readFileLines(name, local).join("\n")}`);
      }
      const board = S.loadBoard(name);
      const base = S.loadBase(name);
      const now = new Date().toISOString();

      if (version === local.artifactVersion) {
        if (!base && fs.existsSync(from)) S.saveBase(name, readRemote(name, from));
        S.saveLocal(name, { ...local, checkedAt: now });
        fs.rmSync(remoteFile(name), { force: true });
        out(`ok: ${name} is current at artifact version ${version}`);
        const saved = S.loadBase(name);
        if (!saved || !sameContent(board, saved)) {
          out("local changes are not published yet:");
          await pushInstruction(board);
        }
        return;
      }

      const remote = readRemote(name, from);
      // Without a recorded base, assume nothing local is unpublished.
      const prefer = opts.theirs ? "remote" : opts.ours ? "local" : null;
      const { board: merged, conflicts, notes } = !base || sameContent(board, base)
        ? { board: remote, conflicts: [], notes: [] }
        : mergeBoards(content(base), content(board), content(remote), { prefer });
      if (conflicts.length) {
        throw new B.BoardError(`artifact version ${version} conflicts with unpublished changes here:\n  ${conflicts.join("\n  ")}\nRerun with --theirs (keep the artifact's) or --ours (keep these), or ask the user which.`);
      }
      if (!base && !sameContent(board, remote)) out("note: no merge base was recorded, so the local board was replaced by the artifact's");
      B.validate(merged);
      S.saveBoard(merged);
      S.saveBase(name, remote);
      S.saveLocal(name, { ...local, artifactVersion: version, checkedAt: now });
      fs.rmSync(remoteFile(name), { force: true }); // never reuse a stale copy for a later pull
      out(`ok: pulled ${name} artifact version ${version}${local.artifactVersion != null ? ` (was ${local.artifactVersion})` : ""}`);
      for (const note of notes) out(`note: ${note}`);
      if (!sameContent(merged, remote)) {
        out("merged with unpublished changes here; publish them:");
        await pushInstruction(merged);
      }
    },
  };

  return { commands, commit, cachedPrStates, staleNote };
}
