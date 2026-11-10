---
description: Write state.json and print the publish_files call
argument-hint: "[--board B]"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `push` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" push $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output. This prints claude-artifacts tool calls (list_files, publish_files, read_file); make them exactly as printed, then run the follow-up line it prints. Never read or summarize the board data.
