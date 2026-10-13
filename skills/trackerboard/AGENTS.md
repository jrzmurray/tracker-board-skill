# Tracker boards (trackerboard)

Track multi-PR plans as waves and phases with the `trackerboard` CLI. The default backend is local JSON; the CLI is harness-neutral and does not require Claude. Use commands to read and update a board. Never edit a rendered page to change its data.

Run `trackerboard` if it is on `PATH`; otherwise run `node <trackerboard install>/skills/trackerboard/scripts/trackerboard.mjs`. The optional Claude Code skill is installed separately with `./install.sh --claude-skill`.

## Rules

- Start with `trackerboard show`. It lists phase status, owner, dependencies, and phases whose dependencies are all done. Use `show --phase X` for one phase in full. `show --json` is the machine-readable view.
- Use the active backend as the source of truth. JSON is the default; SQLite and GitHub Projects are explicit opt-ins. A linked Claude artifact is optional; only then run `trackerboard refresh` and follow its steps before writing. Writes to a linked artifact are refused if it has not been checked in the last two minutes. Migrating to another backend detaches the artifact without changing it.
- When you start a phase: `trackerboard update --phase X --status active --owner <your agent id>`.
- When a PR opens or is reviewed, update `--status`, `--pr` and `--note` as appropriate. PR lifecycle badges are independent of phase status: merging a PR changes its badge, not the human-controlled phase `--status`.
- When you hand a phase off or finish it, clear the owner with `--owner ""`.
- Add `--log "…"` to any write that someone reading the board should notice. It is recorded under "Recent changes".
- Batch related writes where practical. Writes to a linked Claude artifact print a publish step; publish once after the last write.

## Choosing the board

`--board <name>` is optional. Without it, the board resolves from the current directory: whichever board is bound to this git repository (any worktree) or directory. A board bound to the current branch wins over a repo-wide one. If more than one board resolves, the command fails and lists them; pass `--board`. `TRACKERBOARD_BOARD=<name>` also selects a board.

## Commands

```
trackerboard show [--phase P] [--json]
trackerboard show [--wave W] [--lane L] [--status S,S] [--owner O] [--ids | --pr-list | --json]
trackerboard insert --phase P0.1 [--wave W] --title "…" [--lane L] [--status todo] [--deps P0]
trackerboard update --phase P0.1 --status review --pr "#2933" --note "round 1" --log "P0.1 in review"
trackerboard update --phase P0.1 --rename P0.2 | --to-wave B
trackerboard delete P0.1
trackerboard dep add P2 --on P1,P0 | dep rm P2 --on P0 | dep set P2 --on P1 | dep clear P2
trackerboard dep ready | dep list P2 | dep graph
trackerboard insert --wave B --title "Wave B" --prefix B-
trackerboard log "decision: …"
trackerboard import --from board.json --replace [--keep owner]
trackerboard github [--dry-run]
```

- Phase fields: `--title --lane --owner --status --note --req --issue --pr --review --notes --deps`. `--issue` is the GitHub issue the phase works (`#1234`). `--req`, `--review` and `--notes` are the expandable details. A value of `@file.md` reads the field from a file, and `-` reads it from stdin. Field text is markdown, not HTML: `` `code` `` for identifiers, commands and paths, `**bold**`, `*italic*`, `[text](url)`, `#1234`; the expandable fields also take paragraphs, headings, lists, tables, quotes and fenced code blocks.
- Status: `todo active review waiting blocked done ongoing external dropped`. Aliases such as `merged` and `in-progress` are accepted.
- A phase's position comes from its id. `P0.1` or `P0-1` goes right after `P0`, even if `P1` exists. Insert never overwrites: it fails if the id already exists.
- `--wave` is optional. A new phase goes to the wave of its parent id, then to a wave whose prefix matches, then to the only wave.
- Deleting a phase removes it from every other phase's deps.
- `show` groups phases by wave and lane. The filters narrow it to one lane, status or owner (`""` means none). `--ids` prints only ids, and `--pr-list` prints id, status and PR for phases that have one.
- A board may be generated from another source by a project script (`import --from FILE --replace`). Fields the generator writes are overwritten on the next import, so change those at the source; `owner` and others the import keeps (`--keep`) are yours to edit. `trackerboard github` adds open PRs and issues that mention phase ids.
- `trackerboard help` prints the full usage.

## Backends

Backend configuration is machine-local. Config is merged key-by-key from global settings to repository settings to a board override:

- `~/.local/share/trackerboard/config.json`
- `~/.local/share/trackerboard/repos/<bindingKey>.json`
- `~/.trackerboard/boards/<name>.local.json` board override

`XDG_DATA_HOME` or `TRACKERBOARD_DATA_HOME` can change the global and repository config root; `TRACKERBOARD_HOME` changes board metadata paths. The default is `backend: "json"`. SQLite uses `~/.local/share/trackerboard/repos/<bindingKey>.sqlite`, unless `sqlite.path` specifies another location; it is durable local storage, not cross-machine coordination. Do not set up or edit GitHub Project identifiers by hand; the CLI bootstraps a private Project and records its pointer in local board metadata. GitHub phases are draft items only, never repository Issues. Require `gh >= 2.96.0` with Project permission and OAuth scope (`gh auth refresh -s project`). GitHub writes are best-effort last-write-wins if a same-field race occurs after the adapter's last read.

```text
trackerboard backend [--json]
trackerboard migrate --to json|sqlite|github [--dry-run]
trackerboard serve [--board NAME] [--port N]
trackerboard refresh-prs [--repo OWNER/NAME] [--limit N]
```

GitHub bootstrap makes the Project private and verifies visibility before adding phases. Phase title, ID, status, wave, lane, owner, and order map to Project fields; note, req, issue, pr, review, notes, and deps are stored in a versioned item-body block. A versioned README metadata block stores board fields, wave metadata/order, recent log, stable board ID, and phase/item mapping. The README block and each item-body block each have a 60 KiB limit; oversized writes fail without truncation.

GitHub concurrency is best effort: the adapter rereads and reconciles before narrow writes, but GitHub does not offer compare-and-swap for this data. Coordinate simultaneous writers and inspect the board after concurrent changes.

`backend` reports resolved configuration and active storage; it does not switch storage. Global/repository backend settings select the default for new boards, and board creation pins that backend in local metadata. Changing those defaults does not move existing boards. A legacy JSON board without a backend pointer stays on JSON while its JSON file exists; use migration to select and verify another backend. Migration verifies a read-back before switching; on success it leaves the old JSON file as an inactive recovery snapshot. Migration back to JSON exports the current active board, not stale snapshot data. A timestamped mode-0600 recovery copy is kept for each migration attempt. Migration detaches a linked artifact without a separate detach command; the artifact remains untouched as a read-only snapshot, and page/link/push/refresh/pull/synced is unavailable after migration.

`trackerboard serve` provides an editable local browser view over the active backend. It binds only to `127.0.0.1`, prints a random per-run capability URL, and requires a bearer token plus same-origin validation for writes. It sends validated command operations, not whole-board replacements. JSON/SQLite changes appear on the next two-second poll; GitHub is cached for 60 seconds. `trackerboard refresh-prs` maintains derived PR badges: Draft=todo color, Open=active, Conflicting=blocked/red, Merged=done/green, Closed-unmerged=dropped/gray. A merge updates the badge but never the phase status; green means merged only.

## Optional Claude artifact publishing

The local CLI works without Claude. This section applies only to a board linked to a Claude artifact. Every write to such a board prints a `publish:` step and a `then:` step. Only the last write's steps matter. A board migrated to SQLite or GitHub Projects is detached; do not run this workflow for it.

- **Claude (claude.ai artifact):**
  - **Refresh:** `trackerboard refresh` prints an `ArtifactData get` call. Make it, then run the printed `trackerboard pull --version <version from the result>`. The pull does nothing if the board is current; otherwise it merges the published board with this machine's unpublished changes. If both sides changed the same field, it stops and lists the conflicts. Ask the user, then rerun with `--theirs` or `--ours`.
  - **Publish:** make the printed `ArtifactData set` call exactly as given, then run the printed `trackerboard synced …` with the version from the result. The page updates live.
  - **Version mismatch:** someone published in between. Refresh as above, then publish the step that `pull` prints. Nothing needs to be redone.
- **Other harnesses:** nothing is linked, so there is no refresh or publish step. The active backend is the source of truth. The JSON backend coordinates agents on this machine with a lock. `trackerboard render` writes a static HTML snapshot to `~/.trackerboard/out/<board>.html`.
