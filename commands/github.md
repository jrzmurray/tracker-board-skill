---
description: Fill phase PR and issue fields from open GitHub PRs and issues
argument-hint: "[--repo OWNER/NAME] [--in title,branch,labels,body] [--dry-run] [--file FILE]"
allowed-tools: Bash(node "*/skills/trackerboard/scripts/trackerboard.mjs" *), Bash(trackerboard *)
---

Run the trackerboard `github` action with Bash and follow its output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/trackerboard/scripts/trackerboard.mjs" github $ARGUMENTS
```

If `trackerboard` is on PATH you may run it instead. Follow the trackerboard skill for how to use the output.
