#!/bin/bash
set -euo pipefail

mode="${1:-restart}"
if [[ "$mode" != "restart" && "$mode" != "--check" ]]; then
  echo "Usage: restart-codex-desktop.sh [--check]" >&2
  exit 64
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Codex Desktop restart is supported only on macOS." >&2
  exit 2
fi

endpoint="$(/bin/launchctl getenv CODEX_APP_SERVER_WS_URL)"
if [[ -z "$endpoint" ]]; then
  echo "CODEX_APP_SERVER_WS_URL is not configured in the macOS launch environment." >&2
  exit 3
fi

case "$endpoint" in
  ws+unix://localhost/*:/)
    socket_path="${endpoint#ws+unix://localhost}"
    socket_path="${socket_path%:/}"
    if [[ ! -S "$socket_path" ]]; then
      echo "The shared Codex app-server socket is not ready." >&2
      exit 4
    fi
    ;;
  ws://127.0.0.1:*|ws://localhost:*|ws://\[::1\]:*)
    ;;
  *)
    echo "CODEX_APP_SERVER_WS_URL is not a supported local endpoint." >&2
    exit 5
    ;;
esac

if [[ "$mode" == "--check" ]]; then
  echo "The shared Codex app-server endpoint is ready."
  exit 0
fi

desktop_running() {
  /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1 || /usr/bin/pgrep -x Codex >/dev/null 2>&1
}

if desktop_running; then
  /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit'
  for _ in {1..80}; do
    desktop_running || break
    sleep 0.25
  done
  if desktop_running; then
    echo "Codex Desktop did not quit cleanly; no process was forced." >&2
    exit 6
  fi
fi

/usr/bin/open -n -b com.openai.codex
for _ in {1..80}; do
  desktop_running && {
    echo "Codex Desktop restarted with the shared app-server environment."
    exit 0
  }
  sleep 0.25
done

echo "Codex Desktop did not reopen within 20 seconds." >&2
exit 7
