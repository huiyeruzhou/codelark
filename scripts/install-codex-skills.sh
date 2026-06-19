#!/usr/bin/env bash
set -euo pipefail

# Install bundled CodeLark skills and the official Lark lark-doc skill.
# Usage:
#   bash scripts/install-codex-skills.sh [--link] [skill ...]
#
# If no skill name is provided, all default skills are installed. Supported names:
#   codelark              IM attachment send-back skill
#   codelark-question     explicit question-card skill
#   lark-doc              official Lark document skill from larksuite/cli
#
# --link only symlinks the primary package skill for local development.

CODEX_SKILLS_DIR="$HOME/.codex/skills"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LINK_PRIMARY=0
REQUESTED_SKILLS=()

for arg in "$@"; do
  case "$arg" in
    --link)
      LINK_PRIMARY=1
      ;;
    -h|--help)
      sed -n '3,18p' "$0"
      exit 0
      ;;
    *)
      REQUESTED_SKILLS+=("$arg")
      ;;
  esac
done

if [ "${#REQUESTED_SKILLS[@]}" -eq 0 ]; then
  REQUESTED_SKILLS=(codelark codelark-question lark-doc)
fi

echo "Installing CodeLark skills..."
echo "Target: $CODEX_SKILLS_DIR"
echo "Note: lark-doc is installed through the official larksuite/cli skills package."
echo ""

mkdir -p "$CODEX_SKILLS_DIR"

skill_source_dir() {
  case "$1" in
    codelark|codelark-question)
      printf '%s\n' "$SOURCE_DIR/skills/$1"
      ;;
    lark-doc)
      printf '%s\n' ""
      ;;
    *)
      echo "Error: unknown skill '$1'" >&2
      echo "Supported skills: codelark codelark-question lark-doc" >&2
      exit 1
      ;;
  esac
}

install_skill_dir() {
  local name="$1"
  local source_dir="$2"
  local target_dir="$CODEX_SKILLS_DIR/$name"
  if [ ! -f "$source_dir/SKILL.md" ]; then
    echo "Error: SKILL.md not found in $source_dir"
    exit 1
  fi
  if [ -e "$target_dir" ]; then
    if [ -L "$target_dir" ]; then
      local existing
      existing=$(readlink "$target_dir")
      echo "Already installed: $name -> $existing"
    else
      echo "Already installed: $target_dir"
    fi
    return
  fi
  cp -R "$source_dir" "$target_dir"
  echo "Copied $name to: $target_dir"
}

for skill in "${REQUESTED_SKILLS[@]}"; do
  if [ "$skill" = "lark-doc" ]; then
    echo "Installing official lark-doc skill..."
    npx skills add larksuite/cli -s lark-doc -y -g -a claude-code
    continue
  fi
  source_dir="$(skill_source_dir "$skill")"
  target_dir="$CODEX_SKILLS_DIR/$skill"
  if [ "$skill" = "codelark" ] && [ "$LINK_PRIMARY" -eq 1 ]; then
    if [ -e "$target_dir" ]; then
      echo "Already installed: $target_dir"
    else
      ln -s "$source_dir" "$target_dir"
      echo "Symlinked: $target_dir -> $source_dir"
    fi
  else
    install_skill_dir "$skill" "$source_dir"
  fi
done

TARGET_DIR="$CODEX_SKILLS_DIR/codelark"
if [[ " ${REQUESTED_SKILLS[*]} " == *" codelark "* ]] && [ "$LINK_PRIMARY" -eq 0 ]; then
  if [ ! -d "$TARGET_DIR/node_modules" ] || [ ! -d "$TARGET_DIR/node_modules/@openai/codex-sdk" ]; then
    echo "Installing dependencies for codelark..."
    (cd "$TARGET_DIR" && npm install)
  fi

  if [ ! -f "$TARGET_DIR/dist/daemon.mjs" ]; then
    echo "Building daemon bundle for codelark..."
    (cd "$TARGET_DIR" && npm run build)
  fi

  echo "Pruning dev dependencies for codelark..."
  (cd "$TARGET_DIR" && npm prune --production)
fi

if [ "$LINK_PRIMARY" -eq 1 ]; then
  echo ""
  echo "Development mode: no install/build/prune steps were run against the source repo."
fi

echo ""
echo "Done. Start a new Codex session for newly installed skills to be discoverable."
