---
description: Change a phase, a wave or the board's own fields
argument-hint: "--phase P [--status S] [--owner O] [--pr N] [--note T] [--rename P2] | --wave W [--title T] | [--title T]"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `update` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" update $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
