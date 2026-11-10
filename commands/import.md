---
description: Create or update a board from generated board JSON
argument-hint: "[name] --from FILE [--replace] [--keep owner,note] [--branch] [--no-bind]"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `import` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" import $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
