import fs from "node:fs";
import path from "node:path";
import * as B from "../lib/board.mjs";
import * as S from "../lib/store.mjs";
import { dataHome, globalConfigPath, repoConfigPath, sqlitePath } from "../lib/config.mjs";
import { sameContent } from "../lib/merge.mjs";
import { ensureSharedService, runServiceProcess, serviceStatus, serviceUrl, stopService } from "../lib/service-runtime.mjs";

function assertGithubMigrationTarget(name, bindingKey, config) {
  if (bindingKey) return;
  const local = S.loadLocal(name);
  const saved = local.githubProject || {};
  const configured = config.github || {};
  const repositoryIdentity = config.storageTarget?.repoUrl || local.storageTarget?.repoUrl || saved.repoUrl;
  const hasProject = configured.projectId || configured.projectNumber || saved.projectId || saved.projectNumber;
  const resumableBootstrap = local.boardId && saved.boardId === local.boardId && saved.owner && saved.bootstrapStartedAt;
  if (!repositoryIdentity || (!hasProject && !resumableBootstrap)) {
    throw new B.BoardError("unbound GitHub migration needs a saved repository identity and configured/saved Project; select an explicit destination binding when repository context is not saved");
  }
}

export function createBackendCommands({ boardName, rejectLeftovers, out }) {
  return {
    backend({ opts }) {
      const name = boardName(opts);
      const asJson = !!opts.json;
      delete opts.json;
      const setBinding = opts["set-binding"];
      delete opts["set-binding"];
      rejectLeftovers(opts, []);
      if (setBinding) {
        const selected = S.selectStorageBinding(name, String(setBinding));
        return out("ok: " + name + " now uses saved binding " + selected.target.bindingKey + (selected.target.repoRoot ? " (" + selected.target.repoRoot + ")" : ""));
      }
      const config = S.backendConfig(name);
      const local = S.loadLocal(name);
      const configPrecedence = [globalConfigPath()];
      if (config.bindingKey) configPrecedence.push(repoConfigPath(config.bindingKey));
      configPrecedence.push(path.join(S.home(), "boards", `${name}.local.json`));
      const info = {
        board: name,
        backend: config.backend,
        bindingKey: config.bindingKey,
        configPrecedence,
        storage: config.backend === "json"
          ? path.join(S.home(), "boards", `${name}.json`)
          : config.backend === "sqlite"
            ? (config.sqlite?.path ? path.resolve(dataHome(), config.sqlite.path) : sqlitePath(config.bindingKey))
            : ((local.githubProject?.projectNumber || config.github?.projectNumber) ? `${local.githubProject?.owner || config.github?.owner || "GitHub"} Project #${local.githubProject?.projectNumber || config.github.projectNumber}` : local.githubProject?.projectId || config.github?.projectId || local.githubProjectUrl || local.projectUrl || null),
        artifactDetached: !!local.artifactDetached,
      };
      out(asJson ? JSON.stringify(info, null, 2) : `${name}: ${info.backend}\nconfig: ${info.configPrecedence.join(" → ")}\nstorage: ${info.storage || "GitHub Project not bootstrapped"}${info.artifactDetached ? "\nClaude artifact: detached (read-only)" : ""}`);
    },

    async migrate({ opts }) {
      const name = boardName(opts);
      const to = opts.to;
      delete opts.to;
      const destinationBinding = opts.binding;
      delete opts.binding;
      const dryRun = !!opts["dry-run"];
      delete opts["dry-run"];
      if (!new Set(["json", "sqlite", "github"]).has(to)) throw new B.BoardError("migrate needs --to json|sqlite|github");
      rejectLeftovers(opts, []);
      S.ensureBoardIdentity(name);
      const sourceConfig = S.backendConfig(name);
      const board = S.loadBoard(name);
      const targetBaseConfig = destinationBinding
        ? S.backendConfig(name, { bindingKey: String(destinationBinding) })
        : sourceConfig;
      const destinationKey = targetBaseConfig.bindingKey;
      if (to === "github") assertGithubMigrationTarget(name, destinationKey, targetBaseConfig);
      const sourceLabel = sourceConfig.backend + (sourceConfig.bindingKey ? "@" + sourceConfig.bindingKey : "");
      const destinationLabel = to + (destinationKey ? "@" + destinationKey : "");
      const bytes = Buffer.byteLength(JSON.stringify(board));
      if (to === sourceConfig.backend && destinationKey === sourceConfig.bindingKey) return out(`ok: ${name} already uses ${to}`);
      if (dryRun) {
        return out(`dry run: ${name} (${B.allPhases(board).length} phases, ${bytes} bytes) ${sourceLabel} → ${destinationLabel}; target will be verified before its per-board override is activated`);
      }

      const targetConfig = { ...targetBaseConfig, backend: to, migration: true, migrationReplace: to === "json" };
      if (to === "sqlite") {
        const targetPath = targetBaseConfig.sqlite?.path
          ? path.resolve(dataHome(), targetBaseConfig.sqlite.path)
          : destinationKey
            ? sqlitePath(destinationKey)
            : null;
        if (!targetPath) throw new B.BoardError("unbound SQLite migration needs an explicit sqlite.path in backend configuration");
        targetConfig.sqlite = { ...(targetBaseConfig.sqlite || {}), path: targetPath };
        targetConfig.storageTarget = { ...(targetBaseConfig.storageTarget || {}), sqlitePath: targetPath };
      }
      const target = S.openBackendFor(name, targetConfig, destinationBinding ? { bindingKey: String(destinationBinding) } : {});
      let targetBoard = null;
      try { targetBoard = target.load(); }
      catch (error) {
        const expectedEmpty = to === "github" && /no (?:GitHub )?Project|not configured|not bootstrapped/i.test(error.message);
        if (!expectedEmpty) throw error;
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const recovery = path.join(S.home(), "boards", `${name}.recovery-${stamp}.json`);
      fs.mkdirSync(path.dirname(recovery), { recursive: true, mode: 0o700 });
      fs.writeFileSync(recovery, `${JSON.stringify(board, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      if (!targetBoard) target.create(board);
      else if (!sameContent(targetBoard, board)) {
        if (to === "sqlite") {
          throw new B.BoardError(`migration destination ${destinationLabel} already contains a different board; choose an empty target or reconcile it explicitly. Source remains active; recovery snapshot: ${recovery}`);
        }
        if (to === "github") {
          const priorProject = S.loadLocal(name).githubProject || {};
          if (!priorProject.projectId || priorProject.boardId !== S.loadLocal(name).boardId) {
            throw new B.BoardError(`migration destination ${destinationLabel} already contains different Trackerboard data; source remains active; recovery snapshot: ${recovery}`);
          }
        }
        target.save(board, { previous: targetBoard, expectedRevision: target.revision() });
      }

      const verified = target.load();
      B.validate(verified);
      if (!sameContent(verified, board)) throw new B.BoardError(`migration verification failed for ${name} → ${to}; the current backend remains active and the recovery snapshot is ${recovery}`);

      const local = S.loadLocal(name);
      if (destinationKey) local.storageBindingKey = destinationKey;
      const destinationTarget = targetConfig.storageTarget;
      const savedTarget = {
        ...(destinationTarget?.repoRoot ? { repoRoot: destinationTarget.repoRoot } : {}),
        ...(destinationTarget?.repoUrl ? { repoUrl: destinationTarget.repoUrl } : {}),
        ...(to === "sqlite" && destinationTarget?.sqlitePath ? { sqlitePath: destinationTarget.sqlitePath } : {}),
      };
      if (Object.keys(savedTarget).length) local.storageTarget = savedTarget;
      else delete local.storageTarget;
      local.backendOverride = { ...(local.backendOverride || {}), backend: to };
      local.artifactDetached = true;
      local.artifactDetachedAt = new Date().toISOString();
      local.migration = { from: sourceLabel, to: destinationLabel, at: local.artifactDetachedAt, recovery };
      S.saveLocal(name, local);
      out(`ok: migrated ${name} ${sourceLabel} → ${destinationLabel}; read-back verified`);
      out(`recovery: ${recovery}`);
      if (local.artifactUrl) out(`note: Claude artifact ${local.artifactUrl} is detached and read-only; refresh/pull/push are disabled`);
    },

    async serve({ pos, opts }) {
      const action = pos.shift();
      const explicitBoard = opts.board == null ? null : String(opts.board);
      delete opts.board;
      const hasPort = opts.port != null;
      const port = opts.port == null ? 0 : Number(opts.port);
      delete opts.port;
      const foreground = !!opts.foreground;
      delete opts.foreground;
      const runServer = !!opts["run-server"];
      delete opts["run-server"];
      rejectLeftovers(opts, pos);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new B.BoardError("--port must be an integer from 0 through 65535");
      if (runServer) {
        if (action) throw new B.BoardError("internal server mode does not accept a serve subcommand");
        return runServiceProcess({ port, boardName: explicitBoard });
      }
      if (action === "status") {
        if (explicitBoard || hasPort || foreground) throw new B.BoardError("serve status does not accept --board, --port, or --foreground");
        const result = await serviceStatus();
        return out(result ? `service: running at ${result.record.origin}` : "service: stopped");
      }
      if (action === "stop") {
        if (explicitBoard || hasPort || foreground) throw new B.BoardError("serve stop does not accept --board, --port, or --foreground");
        return out(await stopService() ? "ok: stopped shared Trackerboard service" : "service: not running");
      }
      if (action) throw new B.BoardError(`unknown serve action ${JSON.stringify(action)}; use status or stop`);

      let selectedBoard = explicitBoard;
      if (!selectedBoard) {
        try { selectedBoard = S.resolveBoardName(null); }
        catch {}
      }
      const started = await ensureSharedService({ port, foreground, boardName: selectedBoard });
      if (foreground && !started.attached) return;
      const urls = await serviceUrl({ port, boardName: selectedBoard });
      if (selectedBoard) out(`ok: serving ${selectedBoard} at ${urls.boardUrl}`);
      out(`index: ${urls.indexUrl}`);
      out("stop: trackerboard serve stop");
    },
  };
}
