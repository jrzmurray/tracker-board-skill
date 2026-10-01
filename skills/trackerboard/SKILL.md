---
name: trackerboard
description: Create and edit phase/wave TODO tracker boards (published as claude.ai artifacts) with a script instead of hand-editing HTML. Use for any tracker-board change - create a board, insert/update/delete a phase or wave, change a status/PR/notes field, add or remove dependencies - and whenever a plan's tracker artifact needs its status updated.
---

# trackerboard

Each board is a JSON file under `~/.trackerboard/boards/`. The published artifact is a fixed page that renders the board live from its artifact database (one document, `board/state`). **Never read, regenerate or hand-edit the artifact HTML to change status.** Run one command, then make the one tool call it prints.

Run the CLI as `trackerboard …` if it is on PATH, otherwise `node <this skill's base directory>/scripts/trackerboard.mjs …`. `trackerboard help` prints the full usage.

## Which board

`--board <name>` is optional. Without it the board resolves from the cwd: the git repository (any worktree of it) or directory a board was bound to at `create` (or with `bind`). A board bound with `--branch` wins over a repo-wide one on that branch. If more than one board resolves at the same level the command fails and lists them; pass `--board`. `TRACKERBOARD_BOARD=<name>` also selects one.

## Writing

```
trackerboard create <name> --title "…" [--repo-url https://github.com/org/repo] [--branch] [--no-bind]
trackerboard insert --phase P0.1 [--wave W] --title "…" --status todo --deps P0
trackerboard update --phase P0.1 --status done --pr "#2933" --note "merged 951de27" --log "P0.1 merged"
trackerboard delete [--wave W] P0.1
trackerboard insert --wave B --title "Wave B" --prefix B-        # waves: insert/update/delete without --phase
trackerboard update --title "…" --lede "…"                       # board fields: no --phase/--wave
trackerboard dep add F7 --on F1,F2 | dep rm F7 --on F2 | dep set F7 --on F1 | dep clear F7
trackerboard log "JR ruled the EXCLUDED sites"
```

- Phase fields: `--title --lane --status --note --req --pr --review --notes --deps`. `--note` is the one-line status detail shown under the status pill; `--req`, `--review` and `--notes` are the expandable detail. Text supports `` `code` ``, `**bold**`, `[text](url)`, `- ` lists and bare `#1234` (linked to the board's `--repo-url`).
- Status: `todo active review waiting blocked done ongoing external dropped` (aliases such as `merged`, `in-progress`, `not-started`, `n/a` are accepted).
- Long values: `--req @file.md` reads a file; `--notes -` reads stdin.
- `--wave` is optional. A new phase goes to the wave of its parent id (`P0.1` → `P0`'s wave), else the wave whose `--prefix` matches, else the wave holding the same id stem, else the only wave.
- Position comes from the id: `P0.1` / `P0-1` lands right after `P0` (and after lower siblings like `P0.0`) even if `P1` exists. Insert never overwrites; it fails if the id exists anywhere on the board.
- Import an existing board JSON with `trackerboard import <name> --from file.json`.
- Rename with `update --phase X --rename Y` (dependencies follow). Move with `--to-wave W`.
- Deleting a phase removes it from every other phase's deps and says which.
- Add `--log "…"` to any write to record it in the board's "Recent changes" (keeps the last 40).

Batch several writes, then publish once. Each write prints the publish step; only the last one matters.

## Publishing

Every write ends with:

```
publish: ArtifactData {"action":"set","url":"…","collection":"board","doc_id":"state","file_path":"…/out/<name>.doc.json","if_version":7}
then:    trackerboard synced --board <name> --version <version from the result>
```

Make exactly that `ArtifactData` call (load the tool with ToolSearch `select:ArtifactData` if it is deferred), then run the `synced` line with the `version` from the result. The page updates live for anyone viewing it.

- No `if_version` printed and the write is refused because the document exists: call `ArtifactData` `get` (`collection: "board"`, `doc_id: "state"`, `out_dir:` the scratchpad) to learn the version, run `trackerboard synced --version N`, then `trackerboard push` and retry.
- Refused for a version mismatch: someone wrote the board from elsewhere. Ask the user whether to overwrite (re-run with the named version) or to pull theirs first: `get` with `out_dir`, then `trackerboard pull --from <saved json> --version N`, then redo your writes.

**First publish** (a new board, or an old hand-written tracker being replaced): run `trackerboard page`. It writes the page and prints the `Artifact` publish call with the `db` capability. Make that call, then `trackerboard link --url <artifact url>` and `trackerboard push`, and make the printed `ArtifactData` call. After publishing, the page HTML only needs republishing when this skill's page template changes (`trackerboard page` prints that call too).

## Reading

`trackerboard show` prints a compact board (status, title, deps per phase, plus phases whose dependencies are all done). `show --phase X` prints one phase in full, `show --json` the raw data. `dep list X`, `dep ready` and `dep graph` (mermaid) cover the graph. Prefer these over opening the artifact.
