# Tracker boards (trackerboard)

Multi-PR plans are tracked on a board of waves and phases, edited with the `trackerboard` CLI. A board is JSON under `~/.trackerboard/boards/`. Its published page renders that JSON. Never edit, regenerate or read the page HTML to change status. Run a command instead.

## Rules

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
trackerboard insert --phase P0.1 [--wave W] --title "…" [--lane L] [--status todo] [--deps P0]
trackerboard update --phase P0.1 --status review --pr "#2933" --note "round 1" --log "P0.1 in review"
trackerboard update --phase P0.1 --rename P0.2 | --to-wave B
trackerboard delete P0.1
trackerboard dep add P2 --on P1,P0 | dep rm P2 --on P0 | dep set P2 --on P1 | dep clear P2
trackerboard dep ready | dep list P2 | dep graph
trackerboard insert --wave B --title "Wave B" --prefix B-
trackerboard log "decision: …"
```

- Phase fields: `--title --lane --owner --status --note --req --pr --review --notes --deps`. `--req`, `--review` and `--notes` are the expandable details. A value of `@file.md` reads the field from a file, and `-` reads it from stdin.
- Status: `todo active review waiting blocked done ongoing external dropped`. Aliases such as `merged` and `in-progress` are accepted.
- A phase's position comes from its id. `P0.1` or `P0-1` goes right after `P0`, even if `P1` exists. Insert never overwrites: it fails if the id already exists.
- `--wave` is optional. A new phase goes to the wave of its parent id, then to a wave whose prefix matches, then to the only wave.
- Deleting a phase removes it from every other phase's deps.
- `trackerboard help` prints the full usage.

## Publishing

Every write prints a `publish:` step and a `then:` step. Only the last write's steps matter.

- **Claude (claude.ai artifact):** make the printed `ArtifactData` call exactly as given. Then run the printed `trackerboard synced --version <version from the result>`. The page updates live.
  - If the write is refused for a version mismatch, someone else changed the board. Ask before overwriting, or pull their version first: `get` the document with `out_dir`, then run `trackerboard pull --from <saved json> --version N`, then redo your writes.
- **Other harnesses:** skip the publish step. Board JSON on disk is the source of truth. `trackerboard render` writes a static HTML snapshot to `~/.trackerboard/out/<board>.html`.
