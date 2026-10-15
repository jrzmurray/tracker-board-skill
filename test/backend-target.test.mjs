import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backendTargetIdentity, canonicalDataPath, canonicalizeBinding, normalizeRepositoryUrl, sanitizeRepositoryUrl } from "../skills/trackerboard/scripts/lib/backend-target.mjs";

function initRepo(directory) {
  fs.mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Trackerboard Test", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: directory });
}

test("repository identity strips credentials, query strings, and fragments", () => {
  assert.equal(
    normalizeRepositoryUrl("https://alice:secret@GitHub.com/acme/widgets.git?token=private#fragment"),
    "https://github.com/acme/widgets",
  );
  assert.equal(
    sanitizeRepositoryUrl("ssh://git@github.com/acme/widgets.git?token=private#fragment"),
    "https://github.com/acme/widgets",
  );
  assert.equal(normalizeRepositoryUrl("git@github.com:acme/widgets.git"), "https://github.com/acme/widgets");
});

test("target identity canonicalizes path aliases and distinguishes SQLite rows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-target-identity-"));
  try {
    const actual = path.join(root, "store.sqlite");
    const alias = path.join(root, "alias.sqlite");
    fs.writeFileSync(actual, "db");
    fs.symlinkSync(actual, alias);
    assert.equal(canonicalDataPath(alias), canonicalDataPath(actual));
    assert.deepEqual(
      backendTargetIdentity({ backend: "sqlite", file: alias, boardName: "alpha" }),
      backendTargetIdentity({ backend: "sqlite", file: actual, boardName: "alpha" }),
    );
    assert.notDeepEqual(
      backendTargetIdentity({ backend: "sqlite", file: actual, boardName: "alpha" }),
      backendTargetIdentity({ backend: "sqlite", file: actual, boardName: "beta" }),
    );
    assert.deepEqual(
      backendTargetIdentity({ backend: "github", projectId: "PVT_123" }),
      { backend: "github", projectId: "PVT_123" },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a pinned backend ignores the current directory and unbound boards ignore repository config", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trackerboard-target-resolution-"));
  const home = path.join(root, "home");
  const alternateHome = path.join(root, "alternate-home");
  const data = path.join(root, "data");
  const repoA = path.join(root, "repo-a");
  const repoB = path.join(root, "repo-b");
  const old = {
    home: process.env.TRACKERBOARD_HOME,
    data: process.env.TRACKERBOARD_DATA_HOME,
    cwd: process.cwd(),
  };
  process.env.TRACKERBOARD_HOME = home;
  process.env.TRACKERBOARD_DATA_HOME = data;
  t.after(() => {
    process.chdir(old.cwd);
    if (old.home === undefined) delete process.env.TRACKERBOARD_HOME;
    else process.env.TRACKERBOARD_HOME = old.home;
    if (old.data === undefined) delete process.env.TRACKERBOARD_DATA_HOME;
    else process.env.TRACKERBOARD_DATA_HOME = old.data;
    fs.rmSync(root, { recursive: true, force: true });
  });
  initRepo(repoA);
  initRepo(repoB);

  const S = await import("../skills/trackerboard/scripts/lib/store.mjs?backend-target-contract");
  const C = await import("../skills/trackerboard/scripts/lib/config.mjs");
  await S.initializeBackends();
  const bindingA = S.makeBinding(S.context(repoA));
  const bindingB = S.makeBinding(S.context(repoB));
  const worktree = path.join(root, "repo-a-worktree");
  execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "agent-branch"], { cwd: repoA });
  const branchBinding = S.makeBinding(S.context(worktree), { branch: true });
  assert.notEqual(branchBinding.key, bindingA.key);
  assert.equal(canonicalizeBinding(branchBinding).key, bindingA.key);
  fs.mkdirSync(path.dirname(C.repoConfigPath(bindingA.key)), { recursive: true });
  fs.writeFileSync(C.repoConfigPath(bindingA.key), JSON.stringify({ backend: "sqlite" }));
  fs.writeFileSync(C.repoConfigPath(bindingB.key), JSON.stringify({ backend: "sqlite", sqlite: { path: "repo-b.sqlite" } }));

  const created = S.createBoard("portable", { title: "Pinned to A" }, { binding: bindingA });
  const originalLocal = S.loadLocal("portable");
  assert.ok(originalLocal.boardId);
  assert.equal(originalLocal.storageBindingKey, bindingA.key);
  assert.equal(S.backendConfig("portable").bindingKey, bindingA.key);
  assert.equal(fs.existsSync(path.join(home, "boards", "portable.json")), false);

  S.createBoard("branch-alias", { title: "Same repository target" }, { binding: branchBinding });
  assert.equal(S.loadLocal("branch-alias").storageBindingKey, bindingA.key);
  assert.equal(S.backendConfig("branch-alias").bindingKey, bindingA.key);
  process.chdir(worktree);
  assert.equal(S.loadBoard("branch-alias").title, "Same repository target");
  process.chdir(old.cwd);
  assert.deepEqual(S.findBackendTargetCollisions(["portable", "branch-alias"]), []);

  process.env.TRACKERBOARD_HOME = alternateHome;
  S.createBoard("portable", { title: "Candidate in B" }, { binding: bindingB });
  process.env.TRACKERBOARD_HOME = home;
  const localWithAlias = S.loadLocal("portable");
  localWithAlias.bindings.push(bindingB);
  S.saveLocal("portable", localWithAlias);
  assert.throws(() => S.selectStorageBinding("portable", "unknown-binding"), /not saved/);
  assert.equal(S.loadLocal("portable").storageBindingKey, bindingA.key);
  const selected = S.selectStorageBinding("portable", bindingB.key);
  assert.equal(selected.target.bindingKey, bindingB.key);
  assert.equal(S.loadBoard("portable").title, "Candidate in B");
  assert.equal(S.loadLocal("portable").boardId, originalLocal.boardId);

  const unbound = S.createBoard("unbound", {
    repoUrl: "https://user:password@github.com/acme/roadmap?token=secret#private",
  });
  assert.equal(S.backendConfig(unbound.name).backend, "json");
  assert.equal(S.loadLocal("unbound").storageBindingKey, undefined);
  assert.equal(S.loadBoard("unbound").repoUrl, "https://github.com/acme/roadmap");
  assert.doesNotMatch(fs.readFileSync(path.join(home, "boards", "unbound.json"), "utf8"), /password|token=secret|private/);

  const legacyBytes = fs.readFileSync(path.join(home, "boards", "unbound.json"));
  const legacyLocal = S.loadLocal("unbound");
  delete legacyLocal.boardId;
  delete legacyLocal.storageBindingKey;
  delete legacyLocal.storageTarget;
  S.saveLocal("unbound", legacyLocal);
  const identity = S.ensureBoardIdentity("unbound");
  assert.ok(identity.boardId);
  assert.deepEqual(fs.readFileSync(path.join(home, "boards", "unbound.json")), legacyBytes);

  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "sqlite" }));
  assert.throws(() => S.createBoard("unbound-sqlite"), /explicit sqlite\.path/);
  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "sqlite", sqlite: { path: "private.sqlite" } }));
  S.createBoard("unbound-sqlite", { title: "Private local store" });
  const pinnedSqlitePath = S.loadLocal("unbound-sqlite").storageTarget.sqlitePath;
  assert.equal(pinnedSqlitePath, path.join(data, "private.sqlite"));
  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "json" }));
  assert.equal(S.backendConfig("unbound-sqlite").storageTarget.sqlitePath, pinnedSqlitePath);
  assert.equal(S.loadBoard("unbound-sqlite").title, "Private local store");

  const legacySqliteLocal = {
    bindings: [], artifactUrl: "", dbVersion: null, revision: 0,
    backendOverride: { backend: "sqlite" },
  };
  S.saveLocal("legacy-unbound-sqlite", legacySqliteLocal);
  const legacySqlitePath = path.join(home, "boards", "legacy-unbound-sqlite.local.json");
  const legacySqliteBytes = fs.readFileSync(legacySqlitePath);
  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "sqlite", sqlite: { path: "replacement.sqlite" } }));
  assert.throws(() => S.ensureBoardIdentity("legacy-unbound-sqlite"), /needs-binding: its previous SQLite target is not recorded/);
  assert.deepEqual(fs.readFileSync(legacySqlitePath), legacySqliteBytes);

  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "github", github: { owner: "acme" } }));
  assert.throws(() => S.createBoard("unbound-github", { repoUrl: "https://github.com/acme/roadmap" }), /--repo-url alone is not enough/);
  for (const name of ["gh-one", "gh-two"]) {
    S.saveLocal(name, {
      bindings: [], artifactUrl: "", dbVersion: null, revision: 0,
      backendOverride: { backend: "github" },
      githubProject: { owner: "acme", repoUrl: "https://github.com/acme/roadmap", projectId: "PVT_shared" },
    });
  }
  assert.deepEqual(S.findBackendTargetCollisions(["gh-one", "gh-two"]), [{
    identity: { backend: "github", projectId: "PVT_shared" },
    boards: ["gh-one", "gh-two"],
  }]);

  for (const name of ["gh-number-one", "gh-number-two"]) {
    S.saveLocal(name, {
      bindings: [], artifactUrl: "", dbVersion: null, revision: 0,
      backendOverride: { backend: "github" },
      githubProject: { owner: "acme", repoUrl: "https://github.com/acme/roadmap", projectNumber: 12 },
    });
  }
  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "github", github: { owner: "acme", projectNumber: 12 } }));
  const unresolvedNumbers = S.inspectBackendTargets(["gh-number-one", "gh-number-two"]);
  assert.deepEqual(unresolvedNumbers.collisions, []);
  assert.equal(unresolvedNumbers.unresolved.length, 2);
  assert.ok(unresolvedNumbers.unresolved.every((item) => item.target.projectNumber === 12));

  S.saveLocal("gh-id-conflict", {
    bindings: [], artifactUrl: "", dbVersion: null, revision: 0,
    backendOverride: { backend: "github" },
    githubProject: { owner: "acme", repoUrl: "https://github.com/acme/roadmap", projectId: "PVT_saved" },
  });
  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "github", github: { owner: "acme", projectId: "PVT_configured" } }));
  assert.deepEqual(S.backendTargetInfo("gh-id-conflict").identity, { backend: "github", projectId: "PVT_configured" });

  S.saveLocal("gh-number-conflict", {
    bindings: [], artifactUrl: "", dbVersion: null, revision: 0,
    backendOverride: { backend: "github" },
    githubProject: { owner: "acme", repoUrl: "https://github.com/acme/roadmap", projectNumber: 7, projectId: "PVT_saved" },
  });
  fs.writeFileSync(C.globalConfigPath(), JSON.stringify({ backend: "github", github: { owner: "acme", projectNumber: 12 } }));
  assert.equal(S.backendTargetInfo("gh-number-conflict").identity, null);
  assert.equal(S.inspectBackendTargets(["gh-number-conflict"]).unresolved[0].target.projectNumber, 12);

  process.chdir(repoB);
  assert.equal(S.backendConfig("portable").bindingKey, bindingB.key);
  assert.equal(S.loadBoard("portable").title, "Candidate in B");
});
