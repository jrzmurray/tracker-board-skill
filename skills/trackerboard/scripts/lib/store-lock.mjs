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

  return async function withLock(fn) {
    const dir = path.join(home(), ".lock");
    fs.mkdirSync(home(), { recursive: true });
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        fs.mkdirSync(dir);
        try { fs.writeFileSync(path.join(dir, "owner"), String(process.pid) + "\n", { flag: "wx", mode: 0o600 }); }
        catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (removeStaleLock(dir)) continue;
        if (Date.now() > deadline) throw new BoardError("another trackerboard command holds " + dir + "; retry, or remove it if no command is running");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      return await fn();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
