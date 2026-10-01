# trackerboard

Phase/wave TODO trackers for multi-PR plans, edited by a script and published as a claude.ai artifact.

Hand-maintained tracker artifacts make an agent read and rewrite ~50 KB of HTML for every status change. Here the board is JSON on disk, edited with one command per change. The artifact is a fixed page that renders the board live from its artifact database, so an update is one `ArtifactData` write with a file path. The agent never sees the page.

## Install

```bash
./install.sh
```

This symlinks `skills/trackerboard` into `~/.claude/skills/` and the CLI into `~/.local/bin/trackerboard`. It needs Node 20 or newer and runs `npm install` for its one dependency, [elkjs](https://github.com/kieler/elkjs) (the graph layout engine).

## Use

```bash
cd ~/Code/my-repo
trackerboard create az-c --title "AZ-C Column Cells" --repo-url https://github.com/org/repo
trackerboard insert --phase C1 --title "reference tier" --lane A --status done --pr "#2821"
trackerboard insert --phase C2 --title "n-hop walk" --deps C1
trackerboard insert --phase C1.1 --title "follow-up"      # lands after C1, before C2
trackerboard update --phase C2 --status review --note "round 1 in flight" --log "C2 in review"
trackerboard dep add C3 --on C2
trackerboard show
```

Every write prints the `ArtifactData` call that publishes the change. See [skills/trackerboard/SKILL.md](skills/trackerboard/SKILL.md) for the agent workflow, including first publish and version conflicts.

[skills/trackerboard/AGENTS.md](skills/trackerboard/AGENTS.md) is a short, harness-neutral version to copy into a project root. In Claude Code, point to it from the `CLAUDE.md` beside it in prose, for example:

```markdown
Multi-PR plans in this repo are tracked with trackerboard. Before starting or updating tracked work, read AGENTS.md in this directory and follow it.
```

## Data model

```
board  name title subtitle lede notes repoUrl log[] waves[]
wave   id title prefix notes phases[]
phase  id title lane owner status note req pr review notes deps[]
```

`status` is one of `todo active review waiting blocked done ongoing external dropped`. The dependency graph is the `deps` lists; `trackerboard dep graph` prints it as mermaid.

The page draws the graph as plain SVG from geometry the CLI computes. Every publish runs ELK's layered algorithm (left to right, orthogonal edges, one box per wave when there are several) and stores the result as `layout` in the published document beside the board, so the page does no layout of its own. If elkjs is missing the CLI warns and publishes without `layout`, and the page falls back to a simple built-in layering; it does the same if the stored layout no longer matches the board's deps.

Files live in `~/.trackerboard` (override with `TRACKERBOARD_HOME`):

| Path | Contents |
| --- | --- |
| `boards/<name>.json` | the board |
| `boards/<name>.local.json` | this machine's bindings, artifact URL, last db version and when it was last checked |
| `boards/<name>.base.json` | the published document as of the recorded db version (the merge base for `pull`) |
| `remote/<name>/` | where `refresh` has `ArtifactData get` save the published document |
| `out/docs/<name>-<hash>.json` | the db document written on each change, one file per snapshot |
| `out/<name>.page.html` | the publishable page |

## Board resolution

`create` binds the board to the current git repository, keyed by a hash of the repository root (shared by all its worktrees) and, with `--branch`, the branch. Outside git it binds to the directory and its subdirectories. Commands without `--board` use the board bound to the cwd. A branch binding beats a repo-wide one; two boards at the same level is an error.

## Test

```bash
npm test
```
