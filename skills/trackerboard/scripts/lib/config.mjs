// Backend configuration is machine-local and key-wise merged from least to
// most specific: global, repository, then the board's existing local index.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoardError } from "./board.mjs";

const DATA_HOME = process.env.TRACKERBOARD_DATA_HOME || path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
  "trackerboard",
);

export const dataHome = () => DATA_HOME;
export const globalConfigPath = () => path.join(DATA_HOME, "config.json");
export const repoConfigPath = (key) => path.join(DATA_HOME, "repos", `${key}.json`);
export const sqlitePath = (key) => path.join(DATA_HOME, "repos", `${key}.sqlite`);

const ALLOWED = new Set(["backend", "sqlite", "github"]);

function readConfig(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must contain a JSON object");
    for (const key of Object.keys(value)) {
      if (!ALLOWED.has(key)) throw new Error(`unknown key ${JSON.stringify(key)}`);
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new BoardError(`invalid backend config ${file}: ${error.message}`);
  }
}

function mergeConfig(...layers) {
  const out = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer || {})) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out[key] = { ...(out[key] && typeof out[key] === "object" ? out[key] : {}), ...value };
      } else out[key] = value;
    }
  }
  return { backend: "json", ...out };
}

export function readGlobalConfig() {
  return readConfig(globalConfigPath());
}

export function readRepoConfig(key) {
  return key ? readConfig(repoConfigPath(key)) : {};
}

export function writeRepoConfig(key, config) {
  if (!key) throw new BoardError("repository backend config needs a binding key");
  const file = repoConfigPath(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function resolveConfig({ bindingKey, boardOverride = {} } = {}) {
  return mergeConfig(readGlobalConfig(), readRepoConfig(bindingKey), boardOverride);
}

