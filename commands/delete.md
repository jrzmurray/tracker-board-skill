---
description: Delete a phase or a wave
argument-hint: "--phase P | --wave W [--force]"
allowed-tools: Bash(node "*/skills/trackerboard/scripts/trackerboard.mjs" *), Bash(trackerboard *)
disable-model-invocation: true
---

Run the trackerboard `delete` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" delete $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output. Confirm with the user before deleting a wave that still has phases (--force).
