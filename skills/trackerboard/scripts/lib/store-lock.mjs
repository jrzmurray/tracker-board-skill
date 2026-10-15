import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BoardError } from "./board.mjs";

export function createStoreLock(home) {
  function lockOwnerAlive(lockDir) {
    try {
      const pid = Number(fs.readFileSync(path.join(lockDir, "owner"), "utf8").trim());
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === "ESRCH" ? false : true;
      }
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  function removeStaleLock(lockDir) {
    let initial;
    try { initial = fs.statSync(lockDir); }
    catch (error) { return error.code === "ENOENT"; }
    const alive = lockOwnerAlive(lockDir);
    const stale = alive === false || (alive == null && Date.now() - initial.mtimeMs > 30000);
    if (!stale) return false;
    try {
      const current = fs.statSync(lockDir);
      if (current.dev === initial.dev && current.ino === initial.ino) fs.rmSync(lockDir, { recursive: true });
      return true;
    } catch (error) {
      return error.code === "ENOENT";
    }
  }

  function makeLock(directoryPath) {
    function tryAcquire() {
      const directory = directoryPath();
      fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (removeStaleLock(directory)) return tryAcquire();
        return null;
      }
      try {
        fs.writeFileSync(path.join(directory, "owner"), String(process.pid) + "\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
      }
      return () => fs.rmSync(directory, { recursive: true, force: true });
    }

    async function withLock(fn) {
      const directory = directoryPath();
      fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      const deadline = Date.now() + 15000;
      for (;;) {
        try {
          fs.mkdirSync(directory, { mode: 0o700 });
          try { fs.writeFileSync(path.join(directory, "owner"), String(process.pid) + "\n", { flag: "wx", mode: 0o600 }); }
          catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (removeStaleLock(directory)) continue;
          if (Date.now() > deadline) throw new BoardError("another trackerboard command holds " + directory + "; retry, or remove it if no command is running");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      try {
        return await fn();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }

    // Discovery can skip a busy lock instead of blocking the HTTP event loop.
    withLock.try = async (fn) => {
      const release = tryAcquire();
      if (!release) return { acquired: false };
      try { return { acquired: true, value: await fn() }; }
      finally { release(); }
    };
    return withLock;
  }

  const withLock = makeLock(() => path.join(home(), ".lock"));
  withLock.forBoard = (name) => {
    const key = createHash("sha256").update(String(name)).digest("hex");
    return makeLock(() => path.join(home(), ".board-locks", `${key}.lock`));
  };
  return withLock;
}
