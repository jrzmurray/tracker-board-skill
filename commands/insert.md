---
description: Add a phase or a wave
argument-hint: "--phase P [--wave W] [--title T] [--lane L] [--status S] [--deps A,B] | --wave W [--title T] [--after W2]"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `insert` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" insert $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
