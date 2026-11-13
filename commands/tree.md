---
description: Outline the board hierarchy with rolled-up progress
argument-hint: "[--board B]"
allowed-tools: Bash(node "*/skills/trackerboard/scripts/trackerboard.mjs" *), Bash(trackerboard *)
---

Run the trackerboard `tree` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" tree $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
