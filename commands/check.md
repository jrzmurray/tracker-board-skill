---
description: Compare the published state.json hash with the last push
argument-hint: "--version V --sha <sha256|none> [--overwrite]"
allowed-tools: Bash(node "*/skills/trackerboard/scripts/trackerboard.mjs" *), Bash(trackerboard *)
---

Run the trackerboard `check` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" check $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output. This prints claude-artifacts tool calls (list_files, publish_files, read_file); make them exactly as printed, then run the follow-up line it prints. Never read or summarize the board data. If it reports diverged, stop and ask the user; --overwrite replaces the other writer's board on the next push.
