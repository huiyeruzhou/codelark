#!/usr/bin/env bash
set -euo pipefail

CODELARK_HOME="${CODELARK_HOME:-$HOME/.codelark}"
CONFIG_TOML="$CODELARK_HOME/config.toml"
LEGACY_CONFIG_ENV="$CODELARK_HOME/config.env"
LEGACY_CONFIG_JSON="$CODELARK_HOME/config.json"
PID_FILE="$CODELARK_HOME/runtime/bridge.pid"
LOG_FILE="$CODELARK_HOME/logs/bridge.log"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "[OK]   $label"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $label"
    FAIL=$((FAIL + 1))
  fi
}

note() {
  echo "[INFO] $1"
}

toml_value() {
  local key="$1"
  awk -F= -v key="$key" '
    $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      value=$2
      sub(/^[[:space:]]*/, "", value)
      sub(/[[:space:]]*$/, "", value)
      gsub(/^"/, "", value)
      gsub(/"$/, "", value)
      print value
      exit
    }
  ' "$CONFIG_TOML" 2>/dev/null || true
}

toml_bool() {
  local key="$1"
  toml_value "$key" | tr '[:upper:]' '[:lower:]'
}

# --- Node.js version ---
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 24 ] 2>/dev/null; then
    check "Node.js >= 24 (found v$(node -v | sed 's/v//'))" 0
  else
    check "Node.js >= 24 (found v$(node -v | sed 's/v//'), need >= 24)" 1
  fi
else
  check "Node.js installed" 1
fi

# --- Runtime setting ---
CODELARK_AGENT="$(toml_value agent)"
CODELARK_AGENT="${CODELARK_AGENT:-codex}"
echo "Runtime agent: $CODELARK_AGENT"
echo ""

# --- Package dependency checks ---
CODEX_SDK="$SKILL_DIR/node_modules/@openai/codex-sdk"
if [ -d "$CODEX_SDK" ]; then
  check "@openai/codex-sdk installed" 0
else
  check "@openai/codex-sdk installed (not found; run 'npm install' in $SKILL_DIR)" 1
fi

# --- Codex runtime checks ---
if [ "$CODELARK_AGENT" = "codex" ]; then
  if command -v codex &>/dev/null; then
    CODEX_VER=$(codex --version 2>/dev/null || echo "unknown")
    check "Codex CLI available (${CODEX_VER})" 0
  else
    check "Codex CLI available (not found in PATH)" 1
  fi

  CODEX_AUTH=1
  if [ -n "${CODELARK_CODEX_API_KEY:-}" ] || [ -n "${CODEX_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY:-}" ]; then
    CODEX_AUTH=0
  elif command -v codex &>/dev/null; then
    CODEX_AUTH_OUT=$(codex auth status 2>&1 || true)
    if echo "$CODEX_AUTH_OUT" | grep -qiE 'logged.in|authenticated'; then
      CODEX_AUTH=0
    fi
  fi
  if [ "$CODEX_AUTH" = "0" ]; then
    check "Codex auth available (API key or login)" 0
  else
    check "Codex auth available (set OPENAI_API_KEY or run 'codex auth login')" 1
  fi
else
  note "Skipping Codex CLI/auth checks for runtime agent '$CODELARK_AGENT'."
fi

# --- Kimi runtime checks ---
if [ "$CODELARK_AGENT" = "kimi" ]; then
  if command -v kimi &>/dev/null; then
    KIMI_VER=$(kimi --version 2>/dev/null || echo "unknown")
    check "Kimi CLI available (${KIMI_VER})" 0
  else
    check "Kimi CLI available (not found in PATH)" 1
  fi

  if command -v tmux &>/dev/null; then
    TMUX_VER=$(tmux -V 2>/dev/null || echo "unknown")
    check "tmux available for Kimi provider (${TMUX_VER})" 0
  else
    check "tmux available for Kimi provider (not found in PATH)" 1
  fi

  KIMI_HOME="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
  if [ -d "$KIMI_HOME" ]; then
    note "Kimi Code home: $KIMI_HOME"
  else
    note "Kimi Code home not found yet: $KIMI_HOME"
  fi
fi

# --- dist/daemon.mjs freshness ---
DAEMON_MJS="$SKILL_DIR/dist/daemon.mjs"
if [ -f "$DAEMON_MJS" ]; then
  STALE_SRC=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$DAEMON_MJS" 2>/dev/null | head -1)
  if [ -z "$STALE_SRC" ]; then
    check "dist/daemon.mjs is up to date" 0
  else
    check "dist/daemon.mjs is stale (src changed, run 'npm run build')" 1
  fi
else
  check "dist/daemon.mjs exists (not built; run 'npm run build')" 1
fi

# --- Config files ---
if [ -f "$CONFIG_TOML" ]; then
  check "config.toml exists" 0
else
  if [ -f "$LEGACY_CONFIG_JSON" ] || [ -f "$LEGACY_CONFIG_ENV" ]; then
    check "config.toml exists (legacy config will migrate on next startup)" 0
  else
    check "config.toml exists ($CONFIG_TOML not found)" 1
  fi
fi

if [ -f "$CONFIG_TOML" ]; then
  PERMS=$(stat -f "%Lp" "$CONFIG_TOML" 2>/dev/null || stat -c "%a" "$CONFIG_TOML" 2>/dev/null || echo "unknown")
  if [ "$PERMS" = "600" ]; then
    check "config.toml permissions are 600" 0
  else
    check "config.toml permissions are 600 (currently $PERMS)" 1
  fi
fi

if [ -f "$LEGACY_CONFIG_ENV" ] || [ -f "$LEGACY_CONFIG_JSON" ]; then
  check "legacy config.env/config.json are migration inputs only" 0
  echo "       Legacy config files are not sourced by daemon scripts; startup migration writes config.toml."
fi

# --- Feishu credentials, best-effort from home TOML ---
CHANNEL_ENABLED="$(toml_bool enabled)"
if [ -f "$CONFIG_TOML" ] && [ "$CHANNEL_ENABLED" = "true" ]; then
  FS_APP_ID="$(toml_value app_id)"
  FS_SECRET="$(toml_value app_secret)"
  FS_SITE="$(toml_value site)"
  case "$FS_SITE" in
    lark|*open.larksuite.com*)
      FS_DOMAIN="https://open.larksuite.com"
      ;;
    *)
      FS_DOMAIN="https://open.feishu.cn"
      ;;
  esac
  if [ -n "$FS_APP_ID" ] && [ -n "$FS_SECRET" ]; then
    FEISHU_RESULT=$(curl -s --max-time 5 -X POST "${FS_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" \
      -H "Content-Type: application/json" \
      -d "{\"app_id\":\"${FS_APP_ID}\",\"app_secret\":\"${FS_SECRET}\"}" 2>/dev/null || echo '{"code":1}')
    if echo "$FEISHU_RESULT" | grep -q '"code"[[:space:]]*:[[:space:]]*0'; then
      check "Feishu app credentials are valid" 0
    else
      check "Feishu app credentials are valid (token request failed)" 1
    fi
  else
    check "Feishu app credentials configured" 1
  fi
fi

# --- Log directory writable ---
LOG_DIR="$CODELARK_HOME/logs"
if [ -d "$LOG_DIR" ] && [ -w "$LOG_DIR" ]; then
  check "Log directory is writable" 0
else
  check "Log directory is writable ($LOG_DIR)" 1
fi

# --- PID file consistency ---
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    check "PID file consistent (process $PID is running)" 0
  else
    check "PID file consistent (stale PID $PID, process not running)" 1
  fi
else
  check "PID file consistency (no PID file, OK)" 0
fi

# --- Recent errors in log ---
if [ -f "$LOG_FILE" ]; then
  ERROR_COUNT=$(tail -50 "$LOG_FILE" | grep -ciE 'ERROR|Fatal' || true)
  if [ "$ERROR_COUNT" -eq 0 ]; then
    check "No recent errors in log (last 50 lines)" 0
  else
    check "No recent errors in log (found $ERROR_COUNT ERROR/Fatal lines)" 1
  fi
else
  check "Log file exists (not yet created)" 0
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Common fixes:"
  echo "  SDK cli.js missing       -> cd $SKILL_DIR && npm install"
  echo "  dist/daemon.mjs stale    -> cd $SKILL_DIR && npm run build"
  echo "  config.toml missing      -> run setup wizard or start once to migrate legacy config"
  echo "  Stale PID file           -> run stop, then start"
fi

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
