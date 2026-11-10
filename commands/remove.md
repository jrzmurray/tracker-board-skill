---
description: Delete a board and its local state (needs --force)
argument-hint: "<name> --force"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `remove` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" remove $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output. Deleting is permanent: confirm the board name with the user first.
