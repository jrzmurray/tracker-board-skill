---
description: Make this repo use a board so --board can be omitted
argument-hint: "[--board B] [--branch]"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `bind` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" bind $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
