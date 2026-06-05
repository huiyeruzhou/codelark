#!/usr/bin/env bash
set -euo pipefail
CODELARK_HOME="${CODELARK_HOME:-${CODELARK_HOME:-$HOME/.codelark}}"
CONFIG_FILE="$CODELARK_HOME/config.env"
PID_FILE="$CODELARK_HOME/runtime/bridge.pid"
LOG_FILE="$CODELARK_HOME/logs/bridge.log"

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

# --- Node.js version ---
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ] 2>/dev/null; then
    check "Node.js >= 20 (found v$(node -v | sed 's/v//'))" 0
  else
    check "Node.js >= 20 (found v$(node -v | sed 's/v//'), need >= 20)" 1
  fi
else
  check "Node.js installed" 1
fi

# --- Helper: read a value from config.env ---
get_config() { grep "^$1=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'"'"']//;s/["'"'"']$//'; }

# --- Read runtime setting ---
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CODELARK_RUNTIME=$(get_config CODELARK_RUNTIME)
CODELARK_RUNTIME="codex"
echo "Runtime: $CODELARK_RUNTIME"
echo ""

# --- Codex checks ---
  if command -v codex &>/dev/null; then
    CODEX_VER=$(codex --version 2>/dev/null || echo "unknown")
    check "Codex CLI available (${CODEX_VER})" 0
  else
    check "Codex CLI available (not found in PATH)" 1
  fi

  # Check @openai/codex-sdk
  CODEX_SDK="$SKILL_DIR/node_modules/@openai/codex-sdk"
  if [ -d "$CODEX_SDK" ]; then
    check "@openai/codex-sdk installed" 0
  else
    check "@openai/codex-sdk installed (not found — run 'npm install' in $SKILL_DIR)" 1
  fi

  # Check Codex auth: any of CODELARK_CODEX_API_KEY / CODEX_API_KEY / OPENAI_API_KEY,
  # or `codex auth status` showing logged-in (interactive login).
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
  check "dist/daemon.mjs exists (not built — run 'npm run build')" 1
fi

# --- config.env exists ---
if [ -f "$CONFIG_FILE" ]; then
  check "config.env exists" 0
else
  check "config.env exists ($CONFIG_FILE not found)" 1
fi

# --- config.env permissions ---
if [ -f "$CONFIG_FILE" ]; then
  PERMS=$(stat -f "%Lp" "$CONFIG_FILE" 2>/dev/null || stat -c "%a" "$CONFIG_FILE" 2>/dev/null || echo "unknown")
  if [ "$PERMS" = "600" ]; then
    check "config.env permissions are 600" 0
  else
    check "config.env permissions are 600 (currently $PERMS)" 1
  fi
fi

# --- Load config for channel checks ---
if [ -f "$CONFIG_FILE" ]; then
  CODELARK_CHANNELS=$(get_config CODELARK_ENABLED_CHANNELS)

  # --- Feishu ---
  if echo "$CODELARK_CHANNELS" | grep -q feishu; then
    FS_APP_ID=$(get_config CODELARK_FEISHU_APP_ID)
    FS_SECRET=$(get_config CODELARK_FEISHU_APP_SECRET)
    FS_SITE=$(get_config CODELARK_FEISHU_SITE)
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
  echo "  SDK cli.js missing    → cd $SKILL_DIR && npm install"
  echo "  dist/daemon.mjs stale → cd $SKILL_DIR && npm run build"
  echo "  config.env missing    → run setup wizard"
  echo "  Stale PID file        → run stop, then start"
fi

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
