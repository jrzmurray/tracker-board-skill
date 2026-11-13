---
description: Convert StrictDoc .sdoc files into a board hierarchy (JSON)
argument-hint: "PATH... --root NAME --out DIR [--group-by document,section] [--status-map in_progress=active]"
allowed-tools: Bash(node "*/skills/trackerboard/scripts/trackerboard.mjs" *), Bash(trackerboard *)
---

Run the trackerboard `sdoc` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" sdoc $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output. This writes board JSON files under --out; import each one afterwards, root first.
