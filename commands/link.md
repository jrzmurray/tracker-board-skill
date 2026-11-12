---
description: Record the claude.ai artifact URL for this board
argument-hint: "--url https://claude.ai/artifact/<id>"
allowed-tools: Bash(node "*/skills/trackerboard/scripts/trackerboard.mjs" *), Bash(trackerboard *)
---

Run the trackerboard `link` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" link $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
