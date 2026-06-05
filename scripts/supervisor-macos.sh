#!/usr/bin/env bash
# macOS supervisor — launchd-based process management.
# Sourced by daemon.sh; expects CODELARK_HOME, SKILL_DIR, PID_FILE, STATUS_FILE, LOG_FILE.

LAUNCHD_LABEL="com.codelark.bridge"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LAUNCHD_LABEL.plist"

# ── launchd helpers ──

launchd_target() {
  local label="$1"
  echo "gui/$(id -u)/$label"
}

launchd_bootout() {
  local label="$1"
  launchctl bootout "$(launchd_target "$label")" 2>/dev/null || true
}

launchd_print() {
  local label="$1"
  launchctl print "$(launchd_target "$label")" 2>/dev/null
}

launchd_active_label() {
  if launchd_print "$LAUNCHD_LABEL" >/dev/null; then
    echo "$LAUNCHD_LABEL"
    return 0
  fi
  return 1
}

launchd_pid_for_label() {
  local label="$1"
  launchd_print "$label" | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' '
}

# Collect env vars that should be forwarded into the plist.
# We honour clean_env() logic by reading *after* clean_env runs.
build_env_dict() {
  local indent="            "
  local dict=""

  # Always forward basics
  for var in HOME PATH USER SHELL LANG TMPDIR; do
    local val="${!var:-}"
    [ -z "$val" ] && continue
    dict+="${indent}<key>${var}</key>\n${indent}<string>${val}</string>\n"
  done

  # Forward CodeLark-specific vars.
  while IFS='=' read -r name val; do
    case "$name" in CODELARK_*)
      dict+="${indent}<key>${name}</key>\n${indent}<string>${val}</string>\n"
      ;; esac
  done < <(env)

  # Forward Codex/OpenAI credentials used by the Codex runtime.
  for var in OPENAI_API_KEY CODEX_API_KEY CODELARK_CODEX_API_KEY CODELARK_CODEX_BASE_URL; do
    local val="${!var:-}"
    [ -z "$val" ] && continue
    dict+="${indent}<key>${var}</key>\n${indent}<string>${val}</string>\n"
  done

  echo -e "$dict"
}

generate_plist() {
  local node_path
  node_path=$(command -v node)

  mkdir -p "$PLIST_DIR"
  local env_dict
  env_dict=$(build_env_dict)

  cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${node_path}</string>
        <string>${SKILL_DIR}/dist/daemon.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SKILL_DIR}</string>

    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>

    <key>RunAtLoad</key>
    <false/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>EnvironmentVariables</key>
    <dict>
${env_dict}    </dict>
</dict>
</plist>
PLIST
}

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  launchd_bootout "$LAUNCHD_LABEL"
  generate_plist
  launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
  launchctl kickstart -k "$(launchd_target "$LAUNCHD_LABEL")"
}

supervisor_stop() {
  launchd_bootout "$LAUNCHD_LABEL"
  rm -f "$PID_FILE"
}

supervisor_is_managed() {
  launchd_active_label >/dev/null
}

supervisor_status_extra() {
  local active_label
  active_label=$(launchd_active_label 2>/dev/null || true)
  if [ -n "$active_label" ]; then
    echo "Bridge is registered with launchd ($active_label)"
    # Extract PID from launchctl as the authoritative source
    local lc_pid
    lc_pid=$(launchd_pid_for_label "$active_label")
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      echo "launchd reports PID: $lc_pid"
    fi
  fi
}

# Override: on macOS, check launchctl first, then fall back to PID file
supervisor_is_running() {
  # Primary: launchctl knows the process
  local active_label
  active_label=$(launchd_active_label 2>/dev/null || true)
  if [ -n "$active_label" ]; then
    local lc_pid
    lc_pid=$(launchd_pid_for_label "$active_label")
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      return 0
    fi
  fi
  # Fallback: PID file
  local pid
  pid=$(read_pid)
  pid_alive "$pid"
}
