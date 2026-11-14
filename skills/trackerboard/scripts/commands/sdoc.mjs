import fs from "node:fs";
import path from "node:path";
import * as B from "../lib/board.mjs";
import * as S from "../lib/store.mjs";
import { readSdoc, sdocBoards, parseStatusMap } from "../lib/sdoc.mjs";

// sdoc PATH... --root NAME --out DIR [--group-by document,domain] [--status-map a=b,...]
//      [--pr-field NAME] [--note-fields A,B] [--repo-url URL] [--title TEXT]
// Writes one board JSON per board; load them with `import` (parents first).
export function createSdocCommands({ out }) {
  return {
    sdoc({ pos, opts }) {
      if (!pos.length) throw new B.BoardError("sdoc needs one or more .sdoc files or directories");
      if (!opts.root) throw new B.BoardError("sdoc needs --root <repo board name>");
      if (!opts.out) throw new B.BoardError("sdoc needs --out <directory> for the board JSON files");
      S.checkName(opts.root);
      const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : undefined);
      const boards = sdocBoards(readSdoc(pos), {
        root: opts.root,
        title: opts.title,
        groupBy: list(opts["group-by"]),
        statusMap: parseStatusMap(opts["status-map"]),
        prField: opts["pr-field"],
        noteFields: list(opts["note-fields"]),
        repoUrl: opts["repo-url"],
        subtitle: opts.subtitle,
      });
      fs.mkdirSync(opts.out, { recursive: true });
      for (const b of boards) {
        S.checkName(b.name);
        B.normalizeBoard(b); // fail here, not in the import
        fs.writeFileSync(path.join(opts.out, `${b.name}.json`), JSON.stringify(b, null, 2) + "\n");
      }
      out(`ok: wrote ${boards.length} board file(s) to ${opts.out}; import ${opts.root} first, then the rest`);
    },
  };
}
