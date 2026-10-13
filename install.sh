#!/usr/bin/env bash
# Install the layout engine and put the trackerboard CLI on PATH.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${TRACKERBOARD_BIN_DIR:-$HOME/.local/bin}"
install_claude_skill=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--claude-skill]

Install the trackerboard CLI. Pass --claude-skill to also link its optional
Claude Code skill. TRACKERBOARD_BIN_DIR selects the CLI location. Setting
CLAUDE_SKILLS_DIR selects a custom skill location and also opts into linking it.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --claude-skill) install_claude_skill=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'error: unknown option %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

skills="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
if [[ -n "${CLAUDE_SKILLS_DIR:-}" ]]; then
  # Supplying the legacy custom destination remains an explicit skill-install request.
  install_claude_skill=1
fi

(cd "$here" && npm install --omit=dev --no-audit --no-fund --silent)
mkdir -p "$bin"
ln -sfn "$here/skills/trackerboard/scripts/trackerboard.mjs" "$bin/trackerboard"
if (( install_claude_skill )); then
  mkdir -p "$skills"
  ln -sfn "$here/skills/trackerboard" "$skills/trackerboard"
  echo "skill: $skills/trackerboard -> $here/skills/trackerboard"
fi
echo "cli:   $bin/trackerboard"
case ":$PATH:" in *":$bin:"*) ;; *) echo "note: $bin is not on PATH";; esac
