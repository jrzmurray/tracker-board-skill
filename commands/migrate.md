---
description: Move a board to the json, sqlite or github backend
argument-hint: "--to json|sqlite|github [--binding KEY] [--dry-run]"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `migrate` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" migrate $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output. Migrating detaches a linked Claude artifact; use --dry-run first and confirm with the user.
