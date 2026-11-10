---
description: List boards and mark the one this directory uses
argument-hint: "(no arguments)"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `boards` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" boards $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
