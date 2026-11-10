---
description: List, graph or edit phase dependencies
argument-hint: "list [P] | graph | ready | add <P> --on A,B | rm <P> --on A | set <P> --on A,B | clear <P>"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `dep` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" dep $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
