---
description: Show the board, or filter phases by wave, lane, status or owner
argument-hint: "[--phase P] [--wave W] [--lane L] [--status S,S] [--owner O] [--ids | --pr-list | --json]"
allowed-tools: Bash(node "*/skills/trackerboard/scripts/trackerboard.mjs" *), Bash(trackerboard *)
---

Run the trackerboard `show` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" show $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output. This prints board data, so run it only because the user asked to see the board.
