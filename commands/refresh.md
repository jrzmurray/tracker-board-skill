---
description: Print the list_files call that checks the published board
argument-hint: "[--board B]"
allowed-tools: Bash(node "*/skills/trackerboard/scripts/trackerboard.mjs" *), Bash(trackerboard *)
---

Run the trackerboard `refresh` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" refresh $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output. This prints claude-artifacts tool calls (list_files, publish_files, read_file); make them exactly as printed, then run the follow-up line it prints. Never read or summarize the board data.
