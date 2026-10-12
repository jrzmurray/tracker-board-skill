import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { BoardError } from "../board.mjs";
import { registerBackendFactory } from "../backend.mjs";

const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js");
const wasmDirectory = path.dirname(require.resolve("sql.js"));
const DEFAULT_HOME = path.join(
  process.env.TRACKERBOARD_DATA_HOME || process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
  ...(process.env.TRACKERBOARD_DATA_HOME ? [] : ["trackerboard"]),
);
const LOCK_WAIT_MS = 15_000;
const STALE_LOCK_MS = 30_000;
const TABLE = "trackerboard_boards";

let SQL = null;

function databasePath(context) {
  const dataHome = typeof context.dataHome === "function" ? context.dataHome() : context.dataHome;
  const home = path.resolve(dataHome || DEFAULT_HOME);
  const configured = context.config?.sqlite?.path;
  let file;
  if (configured != null) {
    if (typeof configured !== "string" || !configured.trim()) {
      throw new BoardError("sqlite.path must be a non-empty path");
    }
    file = path.resolve(home, configured);
  } else {
    if (typeof context.bindingKey !== "string" || !/^[A-Za-z0-9._-]+$/.test(context.bindingKey)) {
      throw new BoardError("SQLite backend needs a valid repository binding key");
    }
    file = path.join(home, "repos", `${context.bindingKey}.sqlite`);
  }

  if (typeof context.repoRoot === "string" && context.repoRoot) {
    const relative = path.relative(path.resolve(context.repoRoot), file);
    if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw new BoardError("SQLite database path must be outside the repository");
    }
  }
  return file;
}

function serializeBoard(board, name) {
  if (!board || typeof board !== "object" || Array.isArray(board) || board.name !== name) {
    throw new BoardError(`SQLite backend expected a board named ${JSON.stringify(name)}`);
  }
  const serialized = JSON.stringify(board);
  if (typeof serialized !== "string") throw new BoardError("board is not JSON serializable");
  return serialized;
}

function openDatabase(file, create = false) {
  if (fs.existsSync(file)) return new SQL.Database(new Uint8Array(fs.readFileSync(file)));
  return create ? new SQL.Database() : null;
}

function ensureSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    name TEXT PRIMARY KEY NOT NULL,
    board_json TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0)
  )`);
}

function readRow(db, name) {
  const statement = db.prepare(`SELECT board_json, revision FROM ${TABLE} WHERE name = ?`);
  try {
    statement.bind([name]);
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
  }
}

function readRecord(file, name) {
  const db = openDatabase(file);
  if (!db) return null;
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [TABLE]);
    if (!tables.length) throw new BoardError(`SQLite database ${file} is missing the ${TABLE} table`);
    return readRow(db, name);
  } finally {
    db.close();
  }
}

function incrementRevision(value) {
  const current = Number(value);
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new BoardError("SQLite board revision is invalid or exhausted");
  }
  return current + 1;
}

function rowRevision(row) {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new BoardError("SQLite board revision is invalid");
  return revision;
}

function writeDatabaseAtomically(file, db) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, Buffer.from(db.export()), { flag: "wx", mode: 0o600 });
    const descriptor = fs.openSync(temporary, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function removeStaleLock(file) {
  let initial;
  let contents;
  try {
    initial = fs.statSync(file);
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    return error.code === "ENOENT";
  }

  const pid = Number(contents.split(":", 1)[0]);
  const stale = Number.isSafeInteger(pid) && pid > 0
    ? !processIsAlive(pid)
    : Date.now() - initial.mtimeMs > STALE_LOCK_MS;
  if (!stale) return false;

  try {
    const current = fs.statSync(file);
    if (current.dev === initial.dev && current.ino === initial.ino) fs.unlinkSync(file);
    return true;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

function withFileLock(file, fn) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${file}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let descriptor;

  while (descriptor == null) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, token);
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch {}
        descriptor = null;
        fs.rmSync(lockPath, { force: true });
        throw error;
      }
      if (error.code !== "EEXIST") throw error;
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) throw new BoardError(`timed out waiting for local SQLite lock ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  try {
    return fn();
  } finally {
    try { fs.closeSync(descriptor); } catch {}
    try {
      if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function mutate(file, callback) {
  return withFileLock(file, () => {
    const db = openDatabase(file, true);
    try {
      db.run("BEGIN IMMEDIATE");
      try {
        ensureSchema(db);
        const result = callback(db);
        db.run("COMMIT");
        writeDatabaseAtomically(file, db);
        return result;
      } catch (error) {
        try { db.run("ROLLBACK"); } catch {}
        throw error;
      }
    } finally {
      db.close();
    }
  });
}

function makeBackend(context) {
  if (typeof context.name !== "string" || !context.name) throw new BoardError("SQLite backend needs a board name");
  const file = databasePath(context);

  return {
    load() {
      const row = readRecord(file, context.name);
      return row?.board_json == null ? null : JSON.parse(row.board_json);
    },

    create(board) {
      const serialized = serializeBoard(board, context.name);
      return mutate(file, (db) => {
        const row = readRow(db, context.name);
        if (row?.board_json != null) throw new BoardError(`board ${context.name} already exists`);
        const revision = row ? incrementRevision(rowRevision(row)) : 1;
        db.run(
          `INSERT INTO ${TABLE} (name, board_json, revision) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET board_json = excluded.board_json, revision = excluded.revision`,
          [context.name, serialized, revision],
        );
        return revision;
      });
    },

    save(board, { expectedRevision } = {}) {
      const serialized = serializeBoard(board, context.name);
      return mutate(file, (db) => {
        const row = readRow(db, context.name);
        const current = row ? rowRevision(row) : 0;
        if (expectedRevision != null && expectedRevision !== current) {
          throw new BoardError(`board ${context.name} changed (expected revision ${expectedRevision}, current ${current}); reload and retry`);
        }
        if (!row || row.board_json == null) throw new BoardError(`board ${context.name} does not exist`);
        const revision = incrementRevision(current);
        db.run(`UPDATE ${TABLE} SET board_json = ?, revision = ? WHERE name = ?`, [serialized, revision, context.name]);
        return revision;
      });
    },

    revision() {
      const row = readRecord(file, context.name);
      return row ? rowRevision(row) : 0;
    },

    remove() {
      mutate(file, (db) => {
        const row = readRow(db, context.name);
        if (row?.board_json == null) return;
        db.run(`UPDATE ${TABLE} SET board_json = NULL, revision = ? WHERE name = ?`, [incrementRevision(rowRevision(row)), context.name]);
      });
    },
  };
}

registerBackendFactory("sqlite", {
  async initialize() {
    if (SQL) return;
    SQL = await initSqlJs({ locateFile: (filename) => path.join(wasmDirectory, filename) });
  },
  open(context) {
    if (!SQL) throw new BoardError("SQLite backend has not been initialized");
    return makeBackend(context);
  },
});
