# GitHub Projects acceptance checklist

Use a disposable repository and an isolated Trackerboard data home. This checklist is intentionally manual because mocked tests cannot verify an account's real Project permissions, visibility, or GitHub's persisted item types. It does not require or expose a GitHub token to Trackerboard.

## Prerequisites

- GitHub CLI 2.96.0 or newer, authenticated to the intended user or organization with Project read/write access and the `project` scope (`gh auth refresh -s project` adds it).
- A disposable public repository owned by the account that will own the private Project. A public repo makes it easier to verify that Trackerboard does not create public Issues.
- A separate throwaway board home and backend config directory. Keep existing Trackerboard data untouched.

Example isolated setup in a shell:

```bash
export TRACKERBOARD_HOME="$(mktemp -d)"
export TRACKERBOARD_DATA_HOME="$(mktemp -d)"
mkdir -p "$TRACKERBOARD_DATA_HOME"
printf '%s\n' '{"backend":"json"}' > "$TRACKERBOARD_DATA_HOME/config.json"
gh auth status
```

Record the public repository's issue numbers before testing:

```bash
gh issue list --repo OWNER/REPO --state all --limit 1000 --json number --jq '.[].number' | sort > "$TRACKERBOARD_HOME/issues-before.txt"
```

## Bootstrap through migration

1. Create a JSON board and add one phase. Confirm `trackerboard backend --board accept --json` reports `json`.

   ```bash
   trackerboard create accept --no-bind --title "Trackerboard acceptance" --repo-url https://github.com/OWNER/REPO
   trackerboard insert --board accept --phase TB-1 --title "Acceptance phase" --status active
   ```

2. Change the isolated global `config.json` to `{ "backend": "github" }`. Confirm the existing board still reports `json`; backend defaults apply to new boards, and legacy JSON boards stay on their source until migrated. Run `trackerboard migrate --board accept --to github`. Migration verifies a read-back and only then writes a board-specific backend override. Confirm it reports a recovery snapshot path and `trackerboard backend --board accept --json` now reports `github`.

3. In GitHub, verify the created Project is private in Project settings before adding any more data. Open its direct URL in a signed-out/private browser window and verify it is inaccessible. Confirm the phase is a Project draft item, not an Issue in the repository.

4. Verify the Project has Trackerboard ID, Status, Wave, Lane, Owner, and Order fields; Status contains all nine Trackerboard statuses. Check that board metadata appears as one versioned block in the Project README and phase detail/dependency data appears in each draft item's body.

5. Capture the after-list with the same `gh issue list ... | sort > "$TRACKERBOARD_HOME/issues-after.txt"` command and compare it with `diff -u "$TRACKERBOARD_HOME/issues-before.txt" "$TRACKERBOARD_HOME/issues-after.txt"`. Trackerboard must not create or close any repository Issue.

6. Interrupt a create or migration after Project bootstrap or draft-item creation only if it can be done safely in the disposable environment. Rerun the same command. Verify it reuses the same Project and phase items by stable IDs and does not create duplicates. If an interruption is not practical, use a one-shot `gh` wrapper that fails one `project item-create` call and then delegates subsequent calls to the real `gh` executable.

7. Test a phase detail body and a Project README metadata block at the application limit. Confirm a value over 60 KiB is rejected before a remote mutation and no content is truncated.

## Editor and independent PR status

1. Start `trackerboard serve --board accept`; confirm the URL uses `127.0.0.1` and includes the random path capability. Open it in a browser panel. Add or edit a phase, wave, dependency, board detail, and log entry. Make unsaved edits in two different forms, save one, and verify the other form's values remain visible and can be saved afterward. Confirm each saved change appears in `trackerboard show` and in the Project.

2. Change the board from another terminal with a Trackerboard CLI command. Confirm the browser reflects the change on its next poll. Try a stale editor tab and confirm a revision conflict refreshes the board instead of replacing the latest state.

3. Link a disposable test PR to a phase. Refresh badges while the PR is draft, open, conflicting (if reproducible), and merged/closed-unmerged. Confirm the badge changes independently from the phase's human-controlled status. In particular, merge the test PR and verify the phase status does not change; only the merged badge becomes green.

## Recovery and cleanup

- Verify migration back to JSON exports the current Project board, including edits made after the first migration, rather than restoring the original recovery snapshot.
- Confirm the linked Claude artifact, if one was attached, remains unchanged and detached/read-only after migration.
- Keep or delete the disposable private Project and test repository manually according to the test owner's retention policy. `trackerboard remove --force` on an active GitHub backend deletes its bound Project, so do not use it unless deleting that Project is intended.
- Compare the repository issue list with the saved before-list again. No Issue should have been created or closed by Trackerboard.
