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
phase  id title lane owner status note req issue pr review notes deps[]
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

## Generated boards

A project that already tracks its work somewhere else (a requirements file, an issue tracker export) can generate a board instead of editing one. The board JSON is the interface: write it in the format of [board.schema.json](skills/trackerboard/board.schema.json) and hand it to the CLI. Only `waves`, wave `id` and phase `id` are required; other fields default to empty, `status` accepts aliases such as `planned` and `in_progress`, and `deps` may be a list or a comma string. Unknown fields are rejected, so a generator typo fails instead of being dropped.

```bash
my-generator > board.json                           # your project's script
trackerboard github --file board.json                # overlay work that has not merged yet
trackerboard import roadmap --from board.json        # first time
trackerboard import roadmap --from board.json --replace --keep owner   # every refresh
trackerboard render --board roadmap --out roadmap.html
```

- `import --replace` replaces the board's content with the file's, keeps its bindings, artifact link and log, and logs the status changes, additions and removals. `--keep` names phase fields the board owns rather than the generator, such as an `owner` set by agents. On a linked board it prints the usual publish step.
- `github` reads open PRs and issues with the GitHub CLI (`gh`) from `--repo` or the board's `repoUrl`. A PR or issue that mentions a phase id in its title, branch name or labels (add `--in title,branch,labels,body` to search bodies) adds itself to the phase's PR or Issue field, and a PR is also credited to the phases whose issues it closes. An open PR moves a `todo` or `waiting` phase to `active` (draft) or `review` (ready). Nothing moves backward and nothing is removed. `--dry-run` lists the changes without writing. With `--file` it updates a board JSON file instead of a board; run it on the generated file before `import --replace`, so each refresh is one change and an unchanged refresh changes nothing.
- `render` writes a self-contained HTML file that opens with nothing else running.

## Board resolution

`create` binds the board to the current git repository, keyed by a hash of the repository root (shared by all its worktrees) and, with `--branch`, the branch. Outside git it binds to the directory and its subdirectories. Commands without `--board` use the board bound to the cwd. A branch binding beats a repo-wide one; two boards at the same level is an error.

## Test

```bash
npm test
```
