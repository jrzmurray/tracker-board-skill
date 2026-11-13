---
description: Remove this directory's board binding
argument-hint: "[--board B] [--all]"
allowed-tools: Bash(node "*/skills/trackerboard/scripts/trackerboard.mjs" *), Bash(trackerboard *)
---

Run the trackerboard `unbind` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" unbind $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
