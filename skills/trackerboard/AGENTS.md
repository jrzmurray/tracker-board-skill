# Tracker boards (trackerboard)

Multi-PR plans are tracked on a board of waves and phases, edited with the `trackerboard` CLI. A board is JSON under `~/.trackerboard/boards/`. Its published page renders that JSON. Never edit, regenerate or read the page HTML to change status. Run a command instead.

Run the CLI as `trackerboard` if it is on PATH. Otherwise run `node <skill dir>/scripts/trackerboard.mjs`, where the skill dir is wherever the trackerboard skill is installed (the repo's `.claude/skills/trackerboard` or `~/.claude/skills/trackerboard`).

## Rules

- Other agents may write the board at any time. Start each session with `trackerboard refresh` and follow its steps (see Publishing). Writes are refused if the board hasn't been checked against the artifact in the last two minutes; when that happens, refresh and repeat the write.
- Run `trackerboard show` before you start work. It lists each phase's status, owner and deps, plus the phases whose deps are all done. Use `show --phase X` for one phase in full. Prefer these to opening the published page.
- When you start a phase: `trackerboard update --phase X --status active --owner <your agent id>`.
- When a PR opens, is reviewed or merges, update `--status`, `--pr` and `--note`. `--note` is the one-line detail shown under the status.
- When you hand a phase off or finish it, clear the owner with `--owner ""`.
- Add `--log "…"` to any write that someone reading the board should notice. It is recorded under "Recent changes".
- Batch your writes, then publish once (see Publishing).

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

- Phase fields: `--title --lane --owner --status --note --req --issue --pr --review --notes --deps`. `--issue` is the GitHub issue the phase works (`#1234`). `--req`, `--review` and `--notes` are the expandable details. A value of `@file.md` reads the field from a file, and `-` reads it from stdin. Field text is markdown, not HTML: `` `code` `` for identifiers, commands and paths, `**bold**`, `[text](url)`, `#1234`; the expandable fields also take paragraphs, `- ` lists and fenced code blocks.
- Status: `todo active review waiting blocked done ongoing external dropped`. Aliases such as `merged` and `in-progress` are accepted.
- A phase's position comes from its id. `P0.1` or `P0-1` goes right after `P0`, even if `P1` exists. Insert never overwrites: it fails if the id already exists.
- `--wave` is optional. A new phase goes to the wave of its parent id, then to a wave whose prefix matches, then to the only wave.
- Deleting a phase removes it from every other phase's deps.
- `show` groups phases by wave and lane. The filters narrow it to one lane, status or owner (`""` means none). `--ids` prints only ids, and `--pr-list` prints id, status and PR for phases that have one.
- A board may be generated from another source by a project script (`import --from FILE --replace`). Fields the generator writes are overwritten on the next import, so change those at the source; `owner` and others the import keeps (`--keep`) are yours to edit. `trackerboard github` adds open PRs and issues that mention phase ids.
- `trackerboard help` prints the full usage.

## Publishing

Every write prints a `publish:` step and a `then:` step. Only the last write's steps matter.

- **Claude (claude.ai artifact):**
  - **Refresh:** `trackerboard refresh` prints an `ArtifactData get` call. Make it, then run the printed `trackerboard pull --version <version from the result>`. The pull does nothing if the board is current; otherwise it merges the published board with this machine's unpublished changes. If both sides changed the same field, it stops and lists the conflicts. Ask the user, then rerun with `--theirs` or `--ours`.
  - **Publish:** make the printed `ArtifactData set` call exactly as given, then run the printed `trackerboard synced …` with the version from the result. The page updates live.
  - **Version mismatch:** someone published in between. Refresh as above, then publish the step that `pull` prints. Nothing needs to be redone.
- **Other harnesses:** nothing is linked, so there is no refresh or publish step. The board JSON on disk is the source of truth, shared by agents on this machine through a lock. `trackerboard render` writes a static HTML snapshot to `~/.trackerboard/out/<board>.html`.
