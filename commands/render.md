---
description: Write a static HTML snapshot of the board for local preview
argument-hint: "[--out FILE]"
allowed-tools: Bash(node "*/skills/trackerboard/scripts/trackerboard.mjs" *), Bash(trackerboard *)
---

Run the trackerboard `render` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" render $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
