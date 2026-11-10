---
description: Merge a downloaded state.json into the local board
argument-hint: "--version V [--from FILE] [--theirs | --ours]"
allowed-tools: Bash(node:*), Bash(trackerboard:*)
---

Run the trackerboard `pull` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" pull $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output. This is the deliberate, token-costly path: it needs read_file of state.json first. If it stops on a conflict, ask the user which side wins.
