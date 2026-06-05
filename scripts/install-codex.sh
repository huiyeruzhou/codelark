#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "scripts/install-codex.sh is kept for compatibility."
echo "Use scripts/install-codex-skills.sh for the clearer manual CodeLark skill installer."
echo ""

exec "$SCRIPT_DIR/install-codex-skills.sh" "$@"
