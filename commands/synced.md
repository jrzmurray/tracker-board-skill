---
description: Record the artifact version a publish returned
argument-hint: "--version V [--doc FILE]"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `synced` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" synced $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
