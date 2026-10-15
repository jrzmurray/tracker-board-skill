import { backendTargetIdentity, normalizeRepositoryUrl } from "./backend-target.mjs";

function repositoryOwner(value) {
  const normalized = normalizeRepositoryUrl(value);
  if (!normalized) return "";
  try { return new URL(normalized).pathname.split("/").filter(Boolean)[0] || ""; }
  catch { return ""; }
}

function sameNumber(left, right) {
  return left != null && right != null && Number(left) === Number(right);
}

export function createBackendTargetInspector({ backendConfig, loadLocal, boardPath, boardRepoUrl, checkName }) {
  function backendTargetInfo(name) {
    const checked = checkName(name);
    const config = backendConfig(checked);
    const local = loadLocal(checked);
    const file = config.backend === "json"
      ? boardPath(checked)
      : config.backend === "sqlite"
        ? config.storageTarget.sqlitePath
        : null;
    const savedProject = local.githubProject || {};
    const github = config.github || {};
    let projectId = null;
    let unresolved = null;

    if (config.backend === "github") {
      const owner = github.owner || savedProject.owner || repositoryOwner(
        config.storageTarget?.repoUrl || savedProject.repoUrl || boardRepoUrl(checked),
      );
      const effectiveNumber = github.projectNumber ?? savedProject.projectNumber;
      const effectiveId = github.projectId ?? savedProject.projectId;
      if (effectiveNumber != null) {
        const savedNumberMatches = sameNumber(savedProject.projectNumber, effectiveNumber);
        const savedOwnerMatches = !savedProject.owner || !owner || savedProject.owner.toLowerCase() === owner.toLowerCase();
        if (savedProject.projectId && savedNumberMatches && savedOwnerMatches) {
          projectId = savedProject.projectId;
        } else {
          unresolved = {
            reason: "GitHub Project number has not been verified against a saved Project node ID",
            target: { owner, projectNumber: Number(effectiveNumber) },
          };
        }
      } else if (effectiveId) {
        projectId = effectiveId;
      } else {
        unresolved = { reason: "GitHub Project target has not been configured or resolved", target: { owner } };
      }
    }

    const identity = backendTargetIdentity({ backend: config.backend, file, boardName: checked, projectId });
    return {
      board: checked,
      backend: config.backend,
      identity,
      unresolved,
      bindingKey: config.bindingKey,
      target: config.storageTarget,
    };
  }

  function inspectBackendTargets(names) {
    const identities = new Map();
    const unresolved = [];
    for (const name of names) {
      let info;
      try { info = backendTargetInfo(name); }
      catch (error) {
        unresolved.push({ board: name, reason: error.message });
        continue;
      }
      if (!info.identity) {
        unresolved.push({ board: name, backend: info.backend, ...info.unresolved });
        continue;
      }
      const key = JSON.stringify(info.identity);
      const boards = identities.get(key) || [];
      boards.push(name);
      identities.set(key, boards);
    }
    const collisions = [...identities.entries()]
      .filter(([, boards]) => boards.length > 1)
      .map(([identity, boards]) => ({ identity: JSON.parse(identity), boards }));
    return { collisions, unresolved };
  }

  return { backendTargetInfo, inspectBackendTargets };
}
