---
description: Append a line to the board's change log
argument-hint: '"<text>"'
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `log` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" log $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
