import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as B from "../lib/board.mjs";
import * as S from "../lib/store.mjs";
import { content, mergeBoards, sameContent } from "../lib/merge.mjs";
import { DOC_FILE, DOC_LIMIT, docBody, renderPage } from "../lib/render.mjs";

const FRESH_SECONDS = Number(process.env.TRACKERBOARD_FRESH_SECONDS ?? 120);

// Only a Claude harness has the claude-artifacts tools the publish and
// refresh steps call. Every other agent edits the local board and never sees
// those steps. TRACKERBOARD_PUBLISHER=1|0 overrides the detection.
const isPublisher = () => process.env.TRACKERBOARD_PUBLISHER ? process.env.TRACKERBOARD_PUBLISHER === "1" : !!process.env.CLAUDECODE;

// The artifact slug is the last path segment of its claude.ai URL.
const slugOf = (url) => String(url).replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop();

export function createArtifactCommands({ boardName, out }) {
  const linked = (local) => !local.artifactDetached && !!local.artifactUrl && local.artifactVersion != null;
  const checkedAgo = (local) => local.checkedAt ? (Date.now() - Date.parse(local.checkedAt)) / 1000 : Infinity;
  const age = (seconds) => seconds === Infinity ? "never" : seconds < 90 ? `${Math.round(seconds)}s ago` : seconds < 5400 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`;

  const remoteFile = (name) => path.join(S.remoteDir(name), DOC_FILE);

  const sha256 = (data) => createHash("sha256").update(data).digest("hex");

  // list_files returns the live version and each file's sha256, so change
  // detection never reads the document. `check` compares the state.json hash
  // with the one recorded at the last push.
  function refreshLines(name, local) {
    return [
      `refresh: list_files ${JSON.stringify({ slug: slugOf(local.artifactUrl) })}`,
      `then:    trackerboard check --board ${name} --version <version from the result> --sha <sha256 of ${DOC_FILE} from the result>`,
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
    if (isPublisher() && linked(local) && checkedAgo(local) > FRESH_SECONDS) {
      (toStderr ? (text) => process.stderr.write(text.trimStart() + "\n") : out)(`\nnote: last checked against the artifact ${age(checkedAgo(local))}; \`trackerboard refresh\` first if others may have written it`);
    }
  }

  async function writeDoc(board, prStates) {
    const body = JSON.stringify(await docBody(board, { prStates }));
    if (Buffer.byteLength(body) > DOC_LIMIT) {
      throw new B.BoardError(`board document is ${Buffer.byteLength(body)} bytes, over the ${DOC_LIMIT}-byte limit; trim long fields or the log`);
    }
    const dir = path.join(S.outDir(), "docs");
    const file = path.join(dir, `${board.name}-${sha256(body).slice(0, 12)}.json`);
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
    const call = { slug: slugOf(local.artifactUrl), base_version: local.artifactVersion ?? "<version from list_files>", files: [{ as: DOC_FILE, path: file }] };
    out(`publish: publish_files ${JSON.stringify(call)}`);
    out(`then:    trackerboard synced --board ${board.name} --version <version from the result> --doc ${file}`);
    out("safe:    the publish is refused, never overwritten, if anyone published since that version");
  }

  async function commit(board, opts, summary) {
    B.appendLog(board, opts.log);
    const expected = process.env.TRACKERBOARD_EXPECTED_REVISION;
    S.saveBoard(board, { expectedRevision: expected == null ? undefined : /^\d+$/.test(expected) ? Number(expected) : expected });
    out(`ok: ${summary}`);
    const local = S.loadLocal(board.name);
    if (local.artifactDetached) return;
    if (!isPublisher()) {
      if (local.artifactUrl) out("saved locally. Nothing else to do: a Claude agent publishes this board, and it never overwrites anyone's changes.");
      return;
    }
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
        const call = { slug: slugOf(local.artifactUrl), base_version: local.artifactVersion ?? "<version from list_files>", files: [{ as: "index.html", path: file }] };
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
      if (opts.doc) { local.stateSha = sha256(fs.readFileSync(opts.doc)); local.pushedAt = local.checkedAt; }
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

    // Compare the live state.json hash (from list_files) with the one recorded
    // at the last push. Nothing is read. Equal: nobody else wrote the board.
    // Different: stop; --overwrite accepts that the next push replaces it.
    async check({ opts }) {
      const name = boardName(opts);
      assertArtifactAttached(name);
      const version = String(opts.version ?? "").trim();
      const sha = String(opts.sha ?? "").trim().toLowerCase();
      if (!version || version === "true" || !/^[0-9a-f]{64}$/.test(sha)) throw new B.BoardError(`check needs --version <version> and --sha <64-hex sha256 of ${DOC_FILE}>, both from the list_files result`);
      const local = S.loadLocal(name);
      const now = new Date().toISOString();
      if (local.stateSha !== sha && !opts.overwrite) {
        out(`diverged: the published ${DOC_FILE} was changed by another writer. Nothing was overwritten, and your local edits are safe.`);
        out("next:    stop and ask the user which to do. Do not guess.");
        out(`  keep theirs and merge yours in (reads the whole board, costs tokens): read_file ${JSON.stringify({ slug: slugOf(local.artifactUrl), paths: [DOC_FILE] })}, copy it to ${remoteFile(name)}, then trackerboard pull --board ${name} --version ${version}`);
        out(`  or publish yours over theirs: trackerboard check --board ${name} --version ${version} --sha ${sha} --overwrite`);
        return;
      }
      S.saveLocal(name, { ...local, artifactVersion: version, stateSha: sha, checkedAt: now });
      out(`ok: ${name} ${local.stateSha === sha ? "is current" : "will overwrite the published board on the next push"} (version ${version})`);
      const saved = S.loadBase(name);
      if (opts.overwrite || !saved || !sameContent(S.loadBoard(name), saved)) {
        out("local changes are not published yet:");
        await pushInstruction(S.loadBoard(name));
      }
    },

    // Bring in the published document. Unpublished local changes are merged
    // onto it; a field changed differently on both sides stops the pull unless
    // --theirs or --ours says which side wins.
    async pull({ opts }) {
      const name = boardName(opts);
      assertArtifactAttached(name);
      const version = String(opts.version ?? "").trim();
      if (!version || version === "true") throw new B.BoardError("pull needs --version <version id from the list_files result>");
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
      const remoteSha = sha256(fs.readFileSync(from));
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
      S.saveLocal(name, { ...local, artifactVersion: version, stateSha: remoteSha, checkedAt: now });
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
