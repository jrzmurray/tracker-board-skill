import fs from "node:fs";
import path from "node:path";
import { BoardError, validate } from "../board.mjs";
import { registerBackendFactory } from "../backend.mjs";

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

registerBackendFactory("json", {
  open(context) {
    const { boardPath, loadLocal, saveLocal } = context;
    return {
      load() {
        const board = readJson(boardPath);
        if (!board && context.config.migration) return null;
        if (!board) throw new BoardError(`board "${context.name}" has no JSON data`);
        return board;
      },
      create(board) {
        if (readJson(boardPath) && !context.config.migrationReplace) throw new BoardError(`board "${context.name}" already exists`);
        validate(board);
        writeJson(boardPath, board);
        saveLocal({ ...loadLocal(), revision: Math.max(0, Number(loadLocal().revision) || 0) + 1 });
      },
      save(board, { expectedRevision } = {}) {
        validate(board);
        const currentLocal = loadLocal();
        const current = Number.isSafeInteger(currentLocal.revision) ? currentLocal.revision : 0;
        if (expectedRevision != null && expectedRevision !== current) {
          const error = new BoardError(`board ${context.name} changed (expected revision ${expectedRevision}, current ${current}); reload and retry`);
          error.code = "TRACKERBOARD_REVISION_CONFLICT";
          throw error;
        }
        writeJson(boardPath, board);
        saveLocal({ ...currentLocal, revision: current + 1 });
        return current + 1;
      },
      revision() {
        const value = loadLocal().revision;
        return Number.isSafeInteger(value) ? value : 0;
      },
      remove() { fs.rmSync(boardPath, { force: true }); },
    };
  },
});

