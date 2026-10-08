# trackerboard

Phase/wave TODO trackers for multi-PR plans, edited by a script and published as a claude.ai artifact.

Hand-maintained tracker artifacts make an agent read and rewrite ~50 KB of HTML for every status change. Here the board is JSON on disk, edited with one command per change. The artifact is a fixed page that renders the board live from its artifact database, so an update is one `ArtifactData` write with a file path. The agent never sees the page.

## Install

```bash
./install.sh
```

This symlinks `skills/trackerboard` into `~/.claude/skills/` and the CLI into `~/.local/bin/trackerboard`. It needs Node 20 or newer and runs `npm install` for its two dependencies: [elkjs](https://github.com/kieler/elkjs), the graph layout engine, and [markdown-it](https://github.com/markdown-it/markdown-it), which renders the text fields. `page` and `render` inline markdown-it's browser build into the page, so the page needs no network access; raw HTML in board text is escaped, not rendered.

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

## Options

`trackerboard help` prints the same reference. `--board <name>` is optional on every command that takes a board; without it the board resolves from the current directory (see [Board resolution](#board-resolution)).

```text
trackerboard <command> [options]

  Boards
    create <name>                  Create a board and bind it to the current repo (or directory).
                                   Local only; nothing is published until `page` and `link`.
      --title T                      Display title (any text; quote it if it has spaces).
      --repo-url URL                 GitHub repo URL; links bare #1234 references to PRs and issues.
      --branch                       Bind to the current branch only, not the whole repo.
      --no-bind                      Create the board without binding it to this directory.
    boards                         List boards; marks the one this directory resolves to.
    bind                           Record that this repo (every worktree of it) uses a board, so commands
                                   run here can omit --board. Stored on this machine in the board's
                                   `.local.json`; nothing is added to the repo and nothing is published.
                                   Outside git it binds the directory and its subdirectories.
      --board B                      Board to bind (default: the board this directory already resolves to).
      --branch                       Bind only while this branch is checked out; beats a repo-wide binding.
    unbind                         Remove this directory's binding (the board itself is untouched).
      --board B                      Board to unbind.
      --all                          Remove every binding for the board.
    remove <name> --force          Delete a board and its local state (--force is required).

  Read
    show                           Compact board summary, grouped by wave and lane.
      --phase P                      Show one phase in full.
      --wave W                       Only phases in this wave.
      --lane L                       Only phases in this lane ("" = no lane).
      --status S,S                   Only phases with these statuses.
      --owner O                      Only phases with this owner ("" = no owner).
      --ids                          Print phase ids only, one per line.
      --pr-list                      Print id, status and PR for phases that have a PR.
      --json                         Print the raw board data.
    dep list [P]                   Show a phase's dependencies (or all of them).
    dep graph                      Print the dependency graph as mermaid.
    dep ready                      List phases whose dependencies are all done.

  Write
    insert --phase P               Add a phase; its position comes from its id.
      --wave W                       Wave to add it to (default: parent id, prefix, or only wave).
      --title --lane --owner --status --note --req --issue --pr --review --notes --deps A,B
                                     Phase fields (see below).
    insert --wave W                Add a wave.
      --title T                      Wave title.
      --prefix X                     Id prefix; new phases whose id starts with it go to this wave.
      --after W2                     Insert after this wave.
    update --phase P               Change a phase's fields.
      --rename P2                    Rename the phase; dependencies follow.
      --to-wave W2                   Move the phase to another wave.
    update --wave W                Change a wave.
      --title --prefix --notes       Wave fields.
      --rename W2                    Rename the wave.
    update                         Change board fields.
      --title --subtitle --lede --notes --repo-url
    delete <P>                     Delete a phase; it is removed from other phases' deps.
      --wave W                       Disambiguate when the id exists in more than one wave.
    delete --wave W                Delete a wave.
      --force                        Required if the wave still has phases.
    dep add <P> --on A,B           Add dependencies.
    dep rm <P> --on A              Remove dependencies.
    dep set <P> --on A,B           Replace a phase's dependencies.
    dep clear <P>                  Remove all of a phase's dependencies.
    log "<text>"                   Append to the board's "Recent changes".

  Phase fields (insert and update)
    --title                        Phase title.
    --lane                         Group within a wave.
    --owner                        Who is working it (agent id or person); "" clears it.
    --status                       todo | active | review | waiting | blocked | done | ongoing | external | dropped
                                   (aliases: merged, in-progress, not-started, n/a, ...).
    --note                         One-line detail shown under the status.
    --req --review --notes         Expandable details (markdown).
    --issue                        GitHub issue (#1234 or 1234).
    --pr                           Pull request(s), e.g. "#2933".
    --deps A,B                     Phases this one depends on.
    --log "<text>"                 Also record the change in "Recent changes" (any write).
    @file                          As a field value: read it from a file; - reads stdin.

  Publish (Claude-specific: these steps print Claude `Artifact` / `ArtifactData` tool calls)
    page                           Write the publishable page and print the first-publish steps.
    link --url URL                 Record the board's artifact URL.
    push                           Write the db document and print the ArtifactData call.
    synced --version N             Record the db version an ArtifactData write returned.
      --doc FILE                     The document that was written.
    refresh                        Print the ArtifactData get that checks the published board.
    pull --version N               Merge the fetched document into the local board (no-op if current).
      --from FILE                    Read the fetched document from FILE.
      --theirs                       On conflict, keep the artifact's value.
      --ours                         On conflict, keep this machine's value.
    render                         Write a static HTML snapshot for local preview.
      --out FILE                     Where to write it.

  Generated boards
    import [name] --from FILE      Create a board from board JSON (see board.schema.json).
      --branch                       Bind to the current branch only.
      --no-bind                      Do not bind to this directory.
      --replace                      Update an existing board from regenerated JSON.
      --keep owner,note              With --replace: phase fields the board keeps.
    github                         (Uses the GitHub CLI, `gh`; not Claude.) Fill --pr and --issue from open PRs and issues that mention phase ids.
      --repo OWNER/NAME              Repository (default: the board's repo URL).
      --in title,branch,labels,body  Where to look for phase ids.
      --dry-run                      List the changes without writing.
      --file FILE                    Update a board JSON file instead of a board.

  Environment
    TRACKERBOARD_BOARD             Board name to use when --board is omitted.
    TRACKERBOARD_HOME              Data directory (default: ~/.trackerboard).
    TRACKERBOARD_FRESH_SECONDS     Seconds a refresh stays valid before writes are refused (default: 120).
```

## What needs Claude

The CLI itself never contacts Claude or claude.ai. It reads and writes JSON under `~/.trackerboard` and prints text. The only network access is `trackerboard github`, which runs the GitHub CLI (`gh`).

Publishing to a claude.ai artifact is done by an agent, not by the CLI. The commands below print `Artifact` or `ArtifactData` tool calls (Claude Code / claude.ai tools) for the agent to make, then record the result:

| Command | Claude-specific part |
| --- | --- |
| `page` | Prints the `Artifact` publish call that creates the page, with the `db` capability. |
| `link --url URL` | Records the claude.ai artifact URL for the board. |
| `push` | Prints the `ArtifactData set` call that writes the board to the artifact's database. |
| `synced` | Records the db version that `ArtifactData` returned. |
| `refresh` | Prints the `ArtifactData get` call that reads the published board from claude.ai. |
| `pull` | Merges the document that `ArtifactData get` saved locally. |

Once a board is linked, every write also prints a `publish:` step (an `ArtifactData set`), and writes are refused if the board has not been checked against the artifact within 120 seconds (`TRACKERBOARD_FRESH_SECONDS`).

Everything else (`create`, `bind`, `unbind`, `boards`, `remove`, `show`, `insert`, `update`, `delete`, `dep`, `log`, `import`, `render`) is local and works without Claude. An unlinked board has no refresh or publish steps; `render` writes a static HTML snapshot you can open anywhere. [skills/trackerboard/SKILL.md](skills/trackerboard/SKILL.md) is a Claude Code skill; [skills/trackerboard/AGENTS.md](skills/trackerboard/AGENTS.md) is the harness-neutral version for other agents.

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

A binding is a local record that maps a repository (or directory) to a board, so commands there can omit `--board`. `create` and `bind` write it to the board's `.local.json` on this machine; it is not stored in the repo or published. `create` binds the board to the current git repository, keyed by a hash of the repository root (shared by all its worktrees) and, with `--branch`, the branch. Outside git it binds to the directory and its subdirectories. Commands without `--board` use the board bound to the cwd. A branch binding beats a repo-wide one; two boards at the same level is an error.

## Test

```bash
npm test
```
