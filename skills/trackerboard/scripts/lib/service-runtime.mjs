import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataHome } from "./config.mjs";
import * as S from "./store.mjs";
import { controlRequest, startSharedBoardServer } from "./shared-server.mjs";

const ENTRY = fileURLToPath(new URL("../trackerboard.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canonicalPath(value) {
  const absolute = path.resolve(value);
  const missing = [];
  let current = absolute;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(fs.realpathSync(current), ...missing);
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Trackerboard runtime path must be a real directory");
  if ((info.mode & 0o077) !== 0) throw new Error("Trackerboard runtime directory permissions must be 0700");
  return fs.realpathSync(directory);
}

export function runtimePaths({ boardHome = S.home(), dataRoot = dataHome() } = {}) {
  const canonicalBoardHome = canonicalPath(boardHome);
  const canonicalDataRoot = canonicalPath(dataRoot);
  const hash = createHash("sha256").update(`${canonicalBoardHome}\0${canonicalDataRoot}`).digest("hex").slice(0, 24);
  const id = `${process.getuid?.() ?? os.userInfo().username}-${hash}`;
  const runtimeRoot = privateDirectory(path.join(canonicalDataRoot, "runtime"));
  const runtimeDir = privateDirectory(path.join(runtimeRoot, id));
  const lockFile = path.join(runtimeDir, "serve.lock");
  try {
    const descriptor = fs.openSync(lockFile, "wx", 0o600);
    fs.closeSync(descriptor);
  }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const lockStat = fs.lstatSync(lockFile);
  if (!lockStat.isFile() || lockStat.isSymbolicLink()) throw new Error("Trackerboard service lock path must be a regular file");
  if ((lockStat.mode & 0o077) !== 0) fs.chmodSync(lockFile, 0o600);
  return {
    runtimeDir,
    lockFile,
    recordFile: path.join(runtimeDir, "serve.json"),
    boardHome: canonicalBoardHome,
    dataRoot: canonicalDataRoot,
  };
}

function executable(name) {
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const directory of [...pathEntries, "/usr/bin", "/bin", "/usr/local/bin"]) {
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    catch {}
  }
  return null;
}

function lockCommand(lockFile, command, args) {
  if (process.platform === "darwin") {
    const binary = executable("lockf");
    if (!binary) throw new Error("shared Trackerboard service requires the macOS lockf utility");
    return { command: binary, args: ["-k", "-t", "0", "-s", lockFile, command, ...args] };
  }
  if (process.platform === "linux") {
    const binary = executable("flock");
    if (!binary) throw new Error("shared Trackerboard service requires the Linux flock utility");
    return { command: binary, args: ["-n", "-E", "73", "--no-fork", lockFile, command, ...args] };
  }
  throw new Error("shared Trackerboard service currently supports macOS and Linux only");
}

function probeLock(lockFile) {
  if (!fs.existsSync(lockFile)) return false;
  const command = lockCommand(lockFile, executable("true") || "/usr/bin/true", []);
  const result = spawnSync(command.command, command.args, { stdio: "ignore", timeout: 1_000 });
  if (result.error) throw result.error;
  return process.platform === "darwin" ? result.status === 75 : result.status === 73;
}

function readRecord(paths) {
  let stat;
  try { stat = fs.lstatSync(paths.recordFile); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Trackerboard runtime record is not a private regular file");
  }
  let record;
  try { record = JSON.parse(fs.readFileSync(paths.recordFile, "utf8")); }
  catch { throw new Error("Trackerboard runtime record is unreadable"); }
  let recordOrigin;
  try { recordOrigin = new URL(record.origin); }
  catch { throw new Error("Trackerboard runtime record is invalid"); }
  if (record?.version !== 1 || typeof record.instanceId !== "string" ||
      typeof record.origin !== "string" || typeof record.controlToken !== "string" ||
      !Number.isInteger(record.port) || record.port < 1 || record.port > 65_535 ||
      recordOrigin.protocol !== "http:" || recordOrigin.hostname !== "127.0.0.1" || Number(recordOrigin.port) !== record.port) {
    throw new Error("Trackerboard runtime record is invalid");
  }
  return record;
}

async function authenticatedRecord(paths) {
  const record = readRecord(paths);
  if (!record) return null;
  try {
    const result = await controlRequest({ origin: record.origin, token: record.controlToken, op: "status", timeoutMs: 1_000 });
    if (!result.running || result.origin !== record.origin || result.port !== record.port) return null;
    return record;
  } catch {
    return null;
  }
}

async function authenticatedRecordOrFailClosed(paths) {
  let record = null;
  try { record = await authenticatedRecord(paths); }
  catch {}
  if (record) return record;
  if (probeLock(paths.lockFile)) {
    throw new Error("a process holds the Trackerboard service lock but authenticated health checks failed; inspect the owner and stop it before retrying");
  }
  return null;
}

function writeRecord(paths, record) {
  const temporary = path.join(paths.runtimeDir, `.${path.basename(paths.recordFile)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, paths.recordFile);
    fs.chmodSync(paths.recordFile, 0o600);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function removeOwnedRecord(paths, instanceId) {
  try {
    const record = readRecord(paths);
    if (record?.instanceId === instanceId) fs.unlinkSync(paths.recordFile);
  } catch {}
}

async function serviceMain(port, { foreground = false, boardName = null, out = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const launchCapability = process.env.TRACKERBOARD_SERVICE_LAUNCH_ID;
  delete process.env.TRACKERBOARD_SERVICE_LAUNCH_ID;
  if (typeof launchCapability !== "string" || !launchCapability) {
    throw new Error("the shared Trackerboard process must be started by `trackerboard serve`");
  }
  const paths = runtimePaths();
  if (!probeLock(paths.lockFile)) throw new Error("the shared Trackerboard process does not own the service lock");
  let runningRecord = null;
  try { runningRecord = await authenticatedRecord(paths); }
  catch {}
  if (runningRecord) throw new Error("a shared Trackerboard service is already running");
  await S.initializeBackends();
  const instanceId = randomUUID();
  const controlToken = randomUUID() + randomUUID();
  let finish;
  const stopped = new Promise((resolve) => { finish = resolve; });
  const server = await startSharedBoardServer({ store: S, port, controlToken, onStop: finish });
  const record = {
    version: 1,
    instanceId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    origin: server.origin,
    port: server.port,
    controlToken,
  };
  try { writeRecord(paths, record); }
  catch (error) {
    await server.close();
    throw error;
  }
  if (foreground) {
    const boardUrl = boardName ? server.boardUrl(boardName) : null;
    out(`service: running at ${server.origin}\n${boardName && boardUrl ? `ok: serving ${boardName} at ${boardUrl}\n` : ""}index: ${server.indexUrl}`);
  }
  const signal = () => finish();
  for (const event of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(event, signal);
  await stopped;
  for (const event of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(event, signal);
  await server.close();
  removeOwnedRecord(paths, instanceId);
}

async function waitForRecord(paths, child, requestedPort) {
  let exited = false;
  let exitCode = null;
  let childError = null;
  child?.once("error", (error) => { exited = true; exitCode = 1; childError = error; });
  child?.once("exit", (code) => { exited = true; exitCode = code; });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    let record = null;
    try { record = await authenticatedRecord(paths); }
    catch { /* A new owner may atomically replace a stale runtime record after taking the OS lock. */ }
    if (record) {
      if (requestedPort && requestedPort !== record.port) {
        throw new Error(`Trackerboard service is already running at ${record.origin}; requested port ${requestedPort} does not match`);
      }
      return record;
    }
    if (exited && exitCode !== 73 && exitCode !== 75) {
      if (childError) throw new Error(`could not launch the shared Trackerboard service: ${childError.message}`);
      if (requestedPort) throw new Error(`could not start Trackerboard service on port ${requestedPort}; the port may be occupied`);
      throw new Error("could not start the shared Trackerboard service; inspect local process and runtime permissions");
    }
    await sleep(100);
  }
  if (probeLock(paths.lockFile)) {
    throw new Error("a process holds the Trackerboard service lock but authenticated health checks failed; inspect the owner and stop it before retrying");
  }
  throw new Error("shared Trackerboard service did not become ready within eight seconds");
}

export async function ensureSharedService({ port = 0, foreground = false, boardName = null } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be an integer from 0 through 65535");
  const paths = runtimePaths();
  let record = null;
  try { record = await authenticatedRecord(paths); }
  catch { /* Stale or corrupt metadata is replaced only by the process holding the OS lock. */ }
  if (record) {
    if (port && port !== record.port) throw new Error(`Trackerboard service is already running at ${record.origin}; requested port ${port} does not match`);
    return { record, attached: true };
  }
  const existingLock = probeLock(paths.lockFile);
  if (existingLock) {
    record = await waitForRecord(paths, null, port);
    return { record, attached: true };
  }
  const nodeArgs = [ENTRY, "serve", "--run-server", "--port", String(port), ...(boardName ? ["--board", boardName] : []), ...(foreground ? ["--foreground"] : [])];
  const command = lockCommand(paths.lockFile, process.execPath, nodeArgs);
  const launchCapability = randomUUID();
  const child = spawn(command.command, command.args, {
    cwd: process.cwd(),
    env: { ...process.env, TRACKERBOARD_SERVICE_LAUNCH_ID: launchCapability },
    detached: !foreground,
    stdio: foreground ? "inherit" : "ignore",
  });
  if (!foreground) child.unref();
  if (foreground) {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    return { record: null, attached: false, foregroundExit: exit };
  }
  record = await waitForRecord(paths, child, port);
  return { record, attached: false };
}

export async function serviceUrl({ port = 0, boardName = null } = {}) {
  const { record } = await ensureSharedService({ port });
  const index = await controlRequest({ origin: record.origin, token: record.controlToken, op: "index" });
  if (!boardName) return { record, indexUrl: index.url, boardUrl: null };
  const board = await controlRequest({ origin: record.origin, token: record.controlToken, op: "board", name: boardName });
  return { record, indexUrl: index.url, boardUrl: board.url };
}

export async function serviceStatus() {
  const paths = runtimePaths();
  const record = await authenticatedRecordOrFailClosed(paths);
  if (!record) return null;
  return { record, status: await controlRequest({ origin: record.origin, token: record.controlToken, op: "status" }) };
}

export async function stopService() {
  const paths = runtimePaths();
  const record = await authenticatedRecordOrFailClosed(paths);
  if (!record) return false;
  await controlRequest({ origin: record.origin, token: record.controlToken, op: "stop" });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const recordExists = fs.existsSync(paths.recordFile);
    let recordIsLive = false;
    try { recordIsLive = !!(await authenticatedRecord(paths)); }
    catch {}
    if (!recordExists && !recordIsLive && !probeLock(paths.lockFile)) return true;
    await sleep(100);
  }
  throw new Error("Trackerboard service did not stop within five seconds");
}

export async function runServiceProcess({ port = 0, boardName = null } = {}) {
  await serviceMain(port, { foreground: true, boardName });
}
