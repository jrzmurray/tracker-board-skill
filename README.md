# trackerboard

Harness-neutral phase and wave boards for multi-PR plans. The CLI is JSON-backed by default and works from a shell or any agent harness without Claude. SQLite, private GitHub Projects, and a local browser editor are optional integrations.

Boards are edited with one CLI command per change. Use the optional Claude artifact integration only when a live shared page is useful; the board data remains structured and the CLI never edits page HTML.

## Install

```bash
./install.sh
```

By default this installs the CLI at `~/.local/bin/trackerboard` and leaves Claude-specific setup out. To also link the optional Claude Code skill, run `./install.sh --claude-skill`. `TRACKERBOARD_BIN_DIR` selects a custom CLI directory. `CLAUDE_SKILLS_DIR` selects a custom skill directory and, for compatibility with existing installs, also opts into skill linking. The installer needs Node 20 or newer and installs [elkjs](https://github.com/kieler/elkjs), the graph layout engine, and [markdown-it](https://github.com/markdown-it/markdown-it), which renders text fields. `page` and `render` inline markdown-it's browser build into the page, so the page needs no network access; raw HTML in board text is escaped, not rendered.

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

The default JSON backend writes locally; commands do not require Claude or publish anything. See [skills/trackerboard/AGENTS.md](skills/trackerboard/AGENTS.md) for a harness-neutral workflow and [skills/trackerboard/SKILL.md](skills/trackerboard/SKILL.md) for the optional Claude skill and artifact workflow.

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
                                   On the default JSON backend, this is local; nothing is published until `page` and `link`.
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
    remove <name> --force          Delete a board/local state and its bound GitHub Project, if any.

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
  refresh-prs                    Refresh derived per-PR lifecycle badges (60-second cache).

  Backend and local editor
    backend [--json]              Show the resolved backend and configuration sources.
    migrate --to json|sqlite|github [--dry-run]
                                   Migrate and verify before switching this board's backend.
    serve [--port N]               Open an editable board on a loopback-only URL.

  Environment
    TRACKERBOARD_BOARD             Board name to use when --board is omitted.
    TRACKERBOARD_HOME              Data directory (default: ~/.trackerboard).
    TRACKERBOARD_FRESH_SECONDS     Seconds a refresh stays valid before writes are refused (default: 120).
    XDG_DATA_HOME                  Base directory for backend config (default: ~/.local/share).
    TRACKERBOARD_DATA_HOME          Backend config directory (default: ~/.local/share/trackerboard).
```

These commands are available in the CLI installed from this repository. Older standalone copies may not include the optional backends or editor.

## Optional Claude artifact integration

The core CLI does not contact Claude or claude.ai. The JSON backend reads and writes local files; the existing `trackerboard github` overlay uses the GitHub CLI (`gh`). Only the commands below need an agent that can call Claude's artifact tools.

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

Everything else (`create`, `bind`, `unbind`, `boards`, `remove`, `show`, `insert`, `update`, `delete`, `dep`, `log`, `import`, `github`, `refresh-prs`, `backend`, `migrate`, `serve`, `render`) works without Claude. An unlinked board has no refresh or publish steps; `render` writes a static HTML snapshot you can open anywhere. The artifact integration is optional. Migration to SQLite or GitHub Projects leaves the original artifact untouched and detached; it becomes a read-only snapshot and its refresh/pull/push workflow is no longer available.

## Storage backends and configuration

The default backend is local JSON. Board files remain under `~/.trackerboard` (or `TRACKERBOARD_HOME`), while backend configuration lives in the data directory `~/.local/share/trackerboard` by default. `XDG_DATA_HOME` changes that root to `$XDG_DATA_HOME/trackerboard`; `TRACKERBOARD_DATA_HOME` can set it directly.

Configuration is merged key by key, from broadest to most specific: global config, repository config, then a board override. Global settings live in `~/.local/share/trackerboard/config.json`; repository settings live in `~/.local/share/trackerboard/repos/<bindingKey>.json`, shared by worktrees for that repository. The board override is stored in its local metadata file at `~/.trackerboard/boards/<name>.local.json`. The matching XDG or `TRACKERBOARD_DATA_HOME` root applies to the global and repository paths. Later layers override earlier values; nested backend settings merge as well.

The setting is a top-level `backend` value: `"json"`, `"sqlite"`, or `"github"`. It selects the default for new boards, and the selected backend is recorded in each board's local metadata. Changing a machine default therefore does not move existing boards. A legacy JSON board with no backend pointer remains on JSON while its JSON file exists; use `migrate` to move it, which writes the board override only after target verification. SQLite uses one database per repository binding at `~/.local/share/trackerboard/repos/<bindingKey>.sqlite` unless `sqlite.path` supplies a custom location. SQLite is durable local storage with atomic writes and a same-machine lock; it is not cross-machine coordination. JSON remains the default and its board file is an inactive recovery snapshot after migration to another backend. There is no standalone backend-switch command: set the config value for new boards or migrate an existing board.

For example, a global or repository config can select SQLite and set a custom database path:

```json
{
  "backend": "sqlite",
  "sqlite": { "path": "/absolute/path/trackerboard.sqlite" }
}
```

For GitHub Projects, config selects the backend with `{ "backend": "github" }`; bootstrap records the private Project pointer locally.

To select GitHub Projects for one repository, put that same JSON object in `~/.local/share/trackerboard/repos/<bindingKey>.json`. Get the key from `trackerboard backend --json` on an existing board or the `key` printed by `trackerboard create`. Config files contain backend preferences only; GitHub authentication stays in `gh`'s credential store.

Inspect the active backend and migrate a board with:

```text
trackerboard backend [--json]
trackerboard migrate --to json|sqlite|github [--dry-run]
```

`backend` reports the resolved configuration and active backend; it does not switch storage. Configuration merges key-by-key from `~/.local/share/trackerboard/config.json`, `~/.local/share/trackerboard/repos/<bindingKey>.json`, and the board's `.local.json` override. `XDG_DATA_HOME` or `TRACKERBOARD_DATA_HOME` changes the first two paths; `TRACKERBOARD_HOME` changes board metadata paths. JSON remains the default.

`migrate` first writes a mode-0600 recovery snapshot, then copies to the target backend, reads it back, validates it, and only then changes the active backend override. If the copy or verification fails, the original backend remains active. The original JSON file is preserved as an inactive recovery snapshot. Migrating back to JSON exports the current active board—it never restores stale JSON over newer data. A linked Claude artifact is left untouched and detached/read-only after a successful migration; `page`, `link`, `push`, `refresh`, `pull`, and `synced` are unavailable for that board. `render` remains available for a local static snapshot.

Recovery copies and merge-base files remain available for manual recovery but are not active boards; `boards` and the shared `serve` index omit them.

### GitHub Projects backend

Select `{ "backend": "github" }` in the global or repository config before creating a board, or run `trackerboard migrate --to github` for an existing board. The owner is derived from the repository remote or board `repoUrl`. Bootstrap creates a generic Project, immediately changes it to PRIVATE, and verifies that visibility before adding board data. If privacy cannot be verified, Trackerboard attempts to delete the still-empty placeholder and stops with permission guidance. `gh project create` has no visibility option, so the separate private edit and verification are intentional. The Project pointer and stable board ID are saved in the machine-local board index; no token is requested, logged, or stored.

Use GitHub CLI `gh` version 2.96.0 or newer, authenticated with Project read/write access. The required OAuth scope is `project`; if it is missing, run `gh auth refresh -s project` and retry. The signed-in account must have permission to create a private Project for the detected owner. See [GitHub CLI Project commands](https://cli.github.com/manual/gh_project), [Project privacy editing](https://cli.github.com/manual/gh_project_edit), and [draft Project items](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/adding-items-to-your-project).

Each phase maps its title to the draft-item title and has custom fields for Trackerboard ID, Status, Wave, Lane, Owner, and Order. The versioned item-body block stores the phase note, req, review, notes, and dependencies. A versioned Project README metadata block stores board fields, wave order and metadata, the recent log, a stable board ID, and the phase-ID-to-item-ID mapping. The README block and each draft-item body block have independent 60 KiB limits. Writes over either limit are rejected; content is never silently truncated.

GitHub Project writes use reread-and-reconcile best effort because the API does not provide a multi-item transaction or compare-and-swap token. Observed same-field conflicts are rejected, but a race after the last read remains best-effort last-write-wins. Bootstrap and retries reconcile by stable board, phase, and Project item IDs. Coordinate writes to a shared board and inspect it after concurrent changes. Phases are Project draft items only; Trackerboard does not create or close repository Issues, and an `--issue` field only references an existing Issue.

When GitHub returns a new draft item's ID before its Project item listing reflects it, Trackerboard persists the ID in Project metadata and reads the item directly by ID. If the `gh project item-create` response is lost before that ID can be saved, inspect the private Project before retrying; a reported GitHub Projects forward-index inconsistency can leave an item retrievable by ID but absent from the Project's item list and views. See the [GitHub report](https://github.com/orgs/community/discussions/208677).

### Local editor and PR badges

`trackerboard serve [--board NAME] [--port N]` serves an editable browser view over the active backend. It binds only to `127.0.0.1`; the printed URL contains a random per-run capability. Writes also require the matching bearer capability and same-origin request. The editor uses validated board operations rather than accepting a replacement board document. Local JSON and SQLite changes appear on the next two-second poll; GitHub Project state is cached for up to 60 seconds. You can open the printed URL in a browser panel beside the chat, but no Codex-specific integration is required.

`trackerboard refresh-prs` refreshes a derived cache of PR lifecycle badges, with a 60-second TTL. A badge reports the linked PR's state independently from the phase's human-controlled `status`: Draft is todo-colored, Open is active-colored, Conflicting is blocked/red, Merged is done/green, and Closed-unmerged is dropped/gray. Only merged PRs are green. Merging a PR does not change phase status. The `trackerboard github` overlay only adds PR and Issue references; it does not advance phase status.

The CLI starts or reuses one local service for all discovered boards. Use `trackerboard serve --board NAME` to print a selected board's URL; without a selected board it still starts the shared service and prints the protected index URL. See [skills/trackerboard/AGENTS.md](skills/trackerboard/AGENTS.md) for commands and lifecycle details, and [docs/shared-server-plan.md](docs/shared-server-plan.md) for the design decisions and acceptance criteria.

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
| `boards/<name>.local.json` | this machine's bindings, backend override, artifact URL/version and local backend metadata |
| `boards/<name>.base.json` | the published document as of the recorded db version (the merge base for `pull`) |
| `remote/<name>/` | where `refresh` has `ArtifactData get` save the published document |
| `out/docs/<name>-<hash>.json` | the db document written on each change, one file per snapshot |
| `out/<name>.page.html` | the publishable page |

Backend configuration is separate from the board files and normally lives under `~/.local/share/trackerboard` (or the root selected by `XDG_DATA_HOME` / `TRACKERBOARD_DATA_HOME`).

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
- `github` reads open PRs and issues with the GitHub CLI (`gh`) from `--repo` or the board's `repoUrl`. A PR or issue that mentions a phase id in its title, branch name or labels (add `--in title,branch,labels,body` to search bodies) adds itself to the phase's PR or Issue field, and a PR is also credited to the phases whose issues it closes. It does not change phase status. `--dry-run` lists the changes without writing. With `--file` it updates a board JSON file instead of a board; run it on the generated file before `import --replace`, so each refresh is one change and an unchanged refresh changes nothing.
- `render` writes a self-contained HTML file that opens with nothing else running.

## Board resolution

A binding is a local record that maps a repository (or directory) to a board, so commands there can omit `--board`. `create` and `bind` write it to the board's `.local.json` on this machine; it is not stored in the repo or published. `create` binds the board to the current git repository, keyed by a hash of the repository root (shared by all its worktrees) and, with `--branch`, the branch. Outside git it binds to the directory and its subdirectories. Commands without `--board` use the board bound to the cwd. A branch binding beats a repo-wide one; two boards at the same level is an error.

## Test

```bash
npm test
```
