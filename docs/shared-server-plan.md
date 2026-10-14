# Shared multi-board `serve` plan

Status: proposed. This document specifies a follow-on to the local editor; it does not describe behavior implemented on `main` today.

## Goal

Run one local Trackerboard service for all boards in a user's configured data universe. Agents and harnesses can start or reuse that service, while a browser index and board-specific URLs let the user move between boards. A board remains independently backed by JSON, SQLite, or GitHub Projects; serving multiple boards does not combine or copy their data.

The service stays local to the user's machine and binds only to IPv4 loopback. It is not a cloud service, a team-wide server, or a replacement for the CLI. Starting it after a reboot discovers existing board state from disk and backend configuration; it does not recreate boards or migrate them.

## Current baseline

The current `serve` command resolves one board name, loads its backend, and starts one editor server. The editor already uses validated command-shaped operations, a capability URL, bearer authorization, exact Origin and Host checks, expected revisions, and two-second snapshot polling. The implementation and tests are in [the backend command](../skills/trackerboard/scripts/commands/backend.mjs), [the editor server](../skills/trackerboard/scripts/lib/serve.mjs), [the editor callbacks](../skills/trackerboard/scripts/lib/editor-operations.mjs), and [serve tests](../test/serve.test.mjs). Reuse those contracts rather than adding whole-board replacement.

Board discovery is a synchronous scan of `TRACKERBOARD_HOME/boards`. Backend selection currently depends on the working directory's repository binding key; SQLite paths use that key, while the GitHub Project pointer is in the board's local index. A shared process cannot safely infer a board's target from the directory that happened to launch it. Pinning one storage target per board is therefore a prerequisite, not a detail to defer to the server implementation.

## Decisions

### Board identity and backend target

- Add a stable `boardId` and canonical `storageBindingKey` to each board's existing `.local.json` index. Keep bindings as aliases for resolving a board from worktrees and directories. Do not put backend metadata in canonical board JSON.
- Each board has exactly one active backend target. Creation and successful migration pin the key used for that target. All worktrees sharing the same Git common directory resolve to that target; invoking a command from another binding does not silently select a different SQLite file or GitHub Project. Branch-specific bindings are aliases for resolving the board, never separate server targets. If a board has no pinned target and multiple branch bindings could select different stores, require an explicit binding choice; never fall back to `bindings[0]`.
- Persist enough non-secret target context in the local index to open the backend without the server's current working directory: the selected binding's repository root and normalized, credential-free repository identity/URL where applicable. Refactor `openBackendFor` to accept this explicit target descriptor. It must not infer `repoRoot`, `repoUrl`, or a repository config key from the daemon's CWD. A missing repository root must not prevent access to a GitHub Project when the saved Project pointer and repository identity are available.
- Keep existing board-name uniqueness and file paths for compatibility. Use `boardId`, not the display name or current directory, for server routing and in-memory registry identity.
- Preserve configuration precedence: global config, config for the board's canonical binding key, then the board's local override. The resolved backend and target are read from the local index plus those configuration layers.
- For legacy JSON boards, the JSON file remains authoritative and can be registered without consulting the launch directory. For a migrated board, reuse an unambiguous saved target. If legacy bindings or backend stores yield multiple possible targets, do not guess or merge them: show a `needs-binding` state and require an explicit selection through a new `trackerboard backend --set-binding <key>` operation. `trackerboard migrate --binding <key>` may select the source/target key as part of migration. Persist the key only after the selected backend can be read and validated.
- Migration preflight must detect split or divergent SQLite stores before pinning a key. GitHub state is associated with its one saved Project pointer. Ambiguous or unreadable state remains untouched until the user chooses a target.
- A board with no repository binding uses global configuration plus its board-local override, with no repository-scoped config, repository URL, or launch-directory context inferred. JSON remains available. A repository-dependent backend such as GitHub Projects requires an explicit binding or a previously saved repository identity and Project pointer before it can be opened or bootstrapped.
- Define duplicate-store detection by the concrete backend target, not by binding key: JSON and SQLite use their normalized absolute data-file paths (resolving symlinks when the file exists); GitHub Projects use the Project node ID. If two distinct board IDs resolve to the same writable target, mark both as a collision requiring repair and do not mount duplicate editable routes. Pending GitHub bootstrap targets remain provisional until a Project node ID is saved, then are checked for collisions before phase data is written.

### One service process and its lifecycle

- `trackerboard serve` becomes an ensure-or-reuse command. If no service exists, it starts a detached local server process, waits for its authenticated health response, performs discovery, and prints the index URL. Detaching means the first agent's shell can exit without taking the service away from other agents or harnesses.
- `trackerboard serve --board <name>` ensures the same service, requests a rescan, and prints that board's URL. Without `--board`, it also prints the URL for the board resolved from the caller's working directory when one exists. Keep the existing `ok: serving NAME at URL` output line for that selected board, and add an `index:` line. With no selected board, `serve` still starts or reuses the service and prints the index.
- Add `trackerboard serve status` and `trackerboard serve stop`. Stop asks the authenticated service to exit and waits for its lock to be released. `serve --foreground` is available for debugging and tests; it does not create a second instance if the detached service is already running.
- Scope singleton identity to the canonical real paths of both `TRACKERBOARD_HOME` and `TRACKERBOARD_DATA_HOME` (including the effective XDG defaults). Different data/config universes are separate services. A second invocation requesting a different port from the running service fails with the current address; it never starts a second server silently. If the requested port is occupied by a process that does not prove the expected instance nonce, report a port conflict rather than attaching to it.
- Hold a cross-process OS lock for the service lifetime in a user-private runtime directory, separate from the backend's shorter read-modify-write lock. The service must never hold the storage lock for its lifetime. The service lock primitive must be released by the OS when the owner exits; do not implement singleton ownership as a PID-only stale file. A mode-`0600` runtime record in a mode-`0700` directory contains the instance ID, process metadata for diagnostics, address, and a random control capability. It contains no index or per-board browser capabilities. A second CLI invocation reads that record and verifies the instance nonce through the control endpoint before requesting status, rescan, or URLs. PID is informational, never proof of liveness. If the lock is held but authenticated health fails, fail closed and explain how to inspect/stop the owner; do not start another listener.
- Runtime capabilities are per service run and never enter board data, backend configuration, or logs. After reboot the OS lock is gone; the next `serve` call cleans stale runtime metadata only after acquiring the lock, scans durable board indexes, and creates fresh capabilities. Automatic launch at login/reboot is explicitly out of scope.

### URL and board discovery contract

- Use `http://127.0.0.1:<port>/i/<index-capability>` for the index and `/b/<boardId>/<board-capability>` for each board. A request without a valid capability gets no board listing; do not expose tokenized board links from an unauthenticated `/` route.
- The protected index lists all discovered boards and their display title/name, active backend type, and sanitized availability state. It links to each board's capability URL. This intentionally makes the index capability an all-board access grant: anyone who obtains it can discover and open every listed board. The separate board capabilities still protect direct board URLs from callers that do not have the index. If per-board compartmentalization is later required, the index must stop exposing board bearer URLs and route access through a separately authorized mechanism.
- The service scans the local board index, not the current working directory. It can therefore serve all boards after restart even when the launching directory has no board binding. Duplicate target detection uses the concrete target identities above; collisions are visible as errors for every affected board, never silently collapsed.
- A second `serve` call asks the running process to rescan before resolving an explicit board or current-directory binding. Unknown boards return a clear not-found result without stopping the service. A request for a newly created board can therefore find it without restarting the service.
- Keep a board's in-memory index and board capabilities stable across rescans while its `boardId` and concrete target identity remain unchanged. Rotate capabilities only when the service restarts, the board is removed and later re-added, or its backend target is rebound/migrated. A temporary backend outage does not revoke the URL: show a sanitized unavailable state, keep the route, and let the same URL recover when the backend returns. On board removal, revoke the route and return 410 for its old URL. A backend migration or binding change replaces that board's adapter/cache and rotates its board capability; open pages receive a reload/revision-conflict response. Name/title changes do not change the route identity.
- Serialize board removal and writes with the same existing storage mutation lock. Once removal is observed, mark the route as draining and reject new writes. A write already inside the lock may finish before removal; if removal obtains the lock first, a later write must re-check the board's existence/target under the lock and fail without recreating it. Removal is not complete until prior writes have drained, and the old URL returns 410 afterward.

### Backend, editor, and PR behavior

- Keep one cache and adapter lifecycle per board. Load boards lazily so a slow or unreachable GitHub Project cannot delay startup, periodic discovery, or another board's JSON/SQLite requests. Display sanitized per-board failures and retry that board independently with capped exponential backoff (starting at two seconds, capped at 60 seconds, with jitter); reset backoff after success and rate-limit repeated logs to state changes or periodic summaries.
- Poll local JSON/SQLite snapshots and local indexes every two seconds, preserving visibility of CLI writes. Discovery and index rendering use cached backend metadata and never contact GitHub once per board on each scan. Coalesce GitHub reads per board and refresh remote state at most once per 60-second cache window; concurrent requests share one in-flight refresh. GitHub pages may be unavailable while `gh` or the Project is unreachable without taking down the service.
- Reuse the current editor's validated board operations for board details, wave/phase CRUD, dependencies, and log entries. All editor writes pass through the active backend and existing read-modify-write lock. Local JSON/SQLite writes compare expected revisions; GitHub retains its best-effort observed-conflict behavior because Projects has no transaction or compare-and-swap. Never accept an arbitrary whole-board PUT.
- Preserve phase status as human/agent-controlled. PR lifecycle remains a derived badge only: Draft is todo-colored, Open is active-colored, Conflicting is blocked/red, Merged is done/green, and Closed-unmerged is dropped/gray. Only merged PRs are green; a merge never advances or closes a phase.

### Security boundaries

- Bind the page listener to `127.0.0.1` only. Apply exact Host validation and, for browser writes, exact Origin validation plus the board bearer capability. The CLI control capability is separate from browser capabilities and is accepted only by control operations; it cannot write board data.
- Require the user-private runtime directory and permissions before starting. Write runtime state atomically and remove it only while holding the singleton lock. Do not log capability URLs or request authorization headers.
- Preserve no-store, no-referrer, nosniff, a restrictive Content Security Policy, and frame denial. Escape board names, titles, and errors in the index. Do not render raw backend errors, local filesystem paths, repository-private metadata, or credentials to the index.
- Keep all HTTP routes on loopback and validate the Host header to reduce DNS-rebinding risk. Do not add CORS access for arbitrary origins.

## Delivery phases

### Phase 1 — Pin identity and target resolution

Add `boardId`, `storageBindingKey`, and the saved backend target context to local indexes; make new boards and migrations pin them; and refactor backend opening to use that context rather than process CWD. Specify that branch bindings are aliases and define the explicit-selection behavior when no canonical target can be selected unambiguously. Define the no-repository-context rule for unbound boards and concrete duplicate-store identities. Keep JSON default behavior and existing CLI commands compatible. Before proceeding, tests must cover worktree and branch aliases, CWD-independent backend opening and repository identity, unbound-board config resolution, config precedence, selected-target read-back, target collision detection, and refusal to guess between divergent legacy stores.

### Phase 2 — Shared process manager and index, JSON first

Implement the private runtime directory, lifetime OS lock, authenticated nonce/control channel, daemon startup/stop/status, port mismatch behavior, protected index URL, and board URL/capability routing. Initially register JSON boards only. Preserve the existing editor command protocol and one-board output compatibility. Tests must cover concurrent first starts, attach/reuse, stale runtime records, PID reuse with a mismatched nonce, bad port ownership, runtime permissions, absence of browser capabilities from the runtime record, separate home/data universes, token stability across rescans, unavailable-target recovery, the index's all-board capability scope, and service exit cleanup.

### Phase 3 — Multi-board registry and backend isolation

Discover additions/removals and backend/config changes without restarting. Add lazy per-board adapter creation, cache invalidation on migration, token revocation, and isolated unavailable states. Enable SQLite and GitHub Projects after the canonical target contract is in place. Tests must cover multiple simultaneous boards across all backends, independent failures and retry backoff, slow GitHub reads not blocking local boards, no GitHub request per index rescan, CLI writes visible in the editor, stable capabilities across scans and outages, removal/re-addition, removal racing an in-flight write, duplicate target collisions, and migration while the service is live.

### Phase 4 — Editor integration and security hardening

Mount the existing editor page under board-specific routes and expose only validated command operations. Add index and board page security headers, Host/Origin/capability tests, stale-revision tests, sanitized error rendering, and behavior for unknown or unavailable boards. Verify that an unauthenticated request cannot list boards, that the index capability intentionally exposes all board URLs, and that a board capability alone does not expose other boards. Confirm phase status remains unchanged when a linked PR merges.

### Phase 5 — Acceptance, docs, and rollout

Document URL/lifecycle behavior, runtime storage and permissions, port conflicts, backend identity, legacy repair, reboot recovery, and the fact that login auto-start is not included. Run the full test suite, then use a disposable private GitHub Project to verify the three backends, cross-board isolation, a server restart, a migration while serving, a slow/unavailable Project alongside a local board, and token expiry after stop/restart.

## Completion criteria

- One invocation serves every unambiguous board in the configured data universe, and concurrent invocations reuse that instance rather than starting duplicates.
- The same board resolves to the same backend target from every worktree alias and after reboot.
- New, removed, migrated, or unavailable boards affect only their own route and cache; local CLI edits appear without restarting the server, unchanged targets retain their capabilities across scans, and removal cannot race a write into recreating deleted board data.
- The browser editor cannot bypass board validation, revision handling, backend locking, loopback binding, capability checks, or Origin/Host validation.
- Existing single-board CLI usage and the JSON default remain compatible, and PR merges never mutate phase status.
