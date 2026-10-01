#!/usr/bin/env bash
# Link the trackerboard skill into Claude Code and put the CLI on PATH.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
skills="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
bin="${TRACKERBOARD_BIN_DIR:-$HOME/.local/bin}"

mkdir -p "$skills" "$bin"
ln -sfn "$here/skills/trackerboard" "$skills/trackerboard"
ln -sfn "$here/skills/trackerboard/scripts/trackerboard.mjs" "$bin/trackerboard"
echo "skill: $skills/trackerboard -> $here/skills/trackerboard"
echo "cli:   $bin/trackerboard"
case ":$PATH:" in *":$bin:"*) ;; *) echo "note: $bin is not on PATH";; esac
