---
description: Create a board and bind it to this repo
argument-hint: "<name> [--title T] [--repo-url URL] [--branch] [--no-bind]"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `create` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" create $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
