#!/usr/bin/env bash
set -euo pipefail

# Install bundled CodeLark skills and the official Lark lark-doc skill.
# Usage:
#   bash scripts/install-codex-skills.sh [--link] [skill ...]
#
# If no skill name is provided, all default skills are installed. Supported names:
#   codelark              unified CodeLark messaging and automation skill
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
  REQUESTED_SKILLS=(codelark lark-doc)
fi

echo "Installing CodeLark skills..."
echo "Target: $CODEX_SKILLS_DIR"
echo "Note: lark-doc is installed through the official larksuite/cli skills package."
echo ""

mkdir -p "$CODEX_SKILLS_DIR"

skill_source_dir() {
  case "$1" in
    codelark)
      printf '%s\n' "$SOURCE_DIR/skills/$1"
      ;;
    lark-doc)
      printf '%s\n' ""
      ;;
    *)
      echo "Error: unknown skill '$1'" >&2
      echo "Supported skills: codelark lark-doc" >&2
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
  local temporary_dir="${target_dir}.install.$$"
  local backup_dir="${target_dir}.backup.$$"
  rm -rf "$temporary_dir" "$backup_dir"
  cp -R "$source_dir" "$temporary_dir"
  if [ -e "$target_dir" ] || [ -L "$target_dir" ]; then
    mv "$target_dir" "$backup_dir"
    mv "$temporary_dir" "$target_dir"
    rm -rf "$backup_dir"
    echo "Updated $name at: $target_dir"
  else
    mv "$temporary_dir" "$target_dir"
    echo "Copied $name to: $target_dir"
  fi
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

if [[ " ${REQUESTED_SKILLS[*]} " == *" codelark "* ]]; then
  rm -rf "$CODEX_SKILLS_DIR/codelark-question" "$CODEX_SKILLS_DIR/codelark-auto"
fi

TARGET_DIR="$CODEX_SKILLS_DIR/codelark"
if [ "$LINK_PRIMARY" -eq 1 ]; then
  echo ""
  echo "Development mode: no install/build/prune steps were run against the source repo."
fi

echo ""
echo "Done. Start a new Codex session for newly installed skills to be discoverable."
