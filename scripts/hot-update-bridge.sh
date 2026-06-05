#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CODELARK_HOME="${CODELARK_HOME:-$HOME/.codelark}"
LOG_DIR="$CODELARK_HOME/logs"
BRIDGE_LOG="$LOG_DIR/bridge.log"

usage() {
  cat <<'USAGE'
Usage: bash scripts/hot-update-bridge.sh [--pull] [--skip-tests] [--dry-run] [--run]

Dispatch a detached CodeLark hot update so the current bridge-hosted
Codex session can survive the bridge stop/start sequence.

Options:
  --pull         Run git pull before build/test/restart.
  --skip-tests   Skip npm test during this hot update.
  --dry-run      Validate environment and print the planned detached update
                 without dispatching a worker, building, testing, or restarting.
  --run          Internal worker mode. Do not call directly from a bridge session.
USAGE
}

USE_PULL=0
SKIP_TESTS=0
RUN_WORKER=0
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pull)
      USE_PULL=1
      ;;
    --skip-tests)
      SKIP_TESTS=1
      ;;
    --run)
      RUN_WORKER=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

validate_project_dir() {
  if [ ! -f "$PROJECT_DIR/package.json" ] || [ ! -f "$PROJECT_DIR/scripts/hot-update-bridge.sh" ]; then
    echo "[hot-update] refusing to run outside a CodeLark/codelark project directory" >&2
    exit 1
  fi

  local package_name
  package_name="$(env -u NODE_OPTIONS node -e "const fs = require('fs'); const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(String(pkg.name || ''));" "$PROJECT_DIR/package.json" 2>/dev/null || true)"
  if [ "$package_name" != "codelark" ]; then
    echo "[hot-update] refusing to run outside a CodeLark/codelark project directory" >&2
    exit 1
  fi
}

bridge_cli_display() {
  if [ -f "$PROJECT_DIR/dist/cli.mjs" ]; then
    echo "node $PROJECT_DIR/dist/cli.mjs"
    return
  fi
  if command -v codelark >/dev/null 2>&1; then
    echo "codelark"
    return
  fi
  echo "codelark"
}

run_bridge_cli() {
  if [ -f "$PROJECT_DIR/dist/cli.mjs" ]; then
    node "$PROJECT_DIR/dist/cli.mjs" "$@"
    return
  fi
  if command -v codelark >/dev/null 2>&1; then
    codelark "$@"
    return
  fi
  echo "[hot-update] codelark CLI not found" >&2
  return 127
}

ensure_node24() {
  # npm test can export npm_config_prefix, which makes nvm refuse to run.
  # Hot update owns its Node runtime selection, so clear the incompatible prefix.
  unset npm_config_prefix NPM_CONFIG_PREFIX

  # Check if Node 24 is already available in the current environment.
  # This handles CI environments (GitHub Actions, etc.) where Node is installed
  # via setup-node rather than nvm.
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
    if [ "$current_major" = "24" ]; then
      return
    fi
  fi

  # Try to switch to Node 24 via nvm if available.
  local nvm_root="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_root/nvm.sh" ]; then
    # shellcheck source=/dev/null
    source "$nvm_root/nvm.sh"
    # Allow nvm use to fail gracefully if Node 24 is not installed via nvm.
    # We'll check again below and search for a manually-installed Node 24.
    nvm use 24 >/dev/null 2>&1 || true
  fi

  # Check again after attempting nvm use.
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
    if [ "$current_major" = "24" ]; then
      return
    fi
  fi

  # Search for Node 24 in common nvm installation directories.
  local node24=""
  local root
  for root in \
    "${NVM_DIR:-}" \
    "$HOME/.nvm" \
    "/home/${USER:-}/.nvm" \
    "/data00/home/${USER:-}/.nvm"
  do
    [ -n "$root" ] || continue
    [ -d "$root/versions/node" ] || continue
    local candidate
    for candidate in "$root"/versions/node/v24.*/bin/node; do
      [ -x "$candidate" ] || continue
      node24="$candidate"
    done
  done
  if [ -n "$node24" ]; then
    PATH="$(dirname "$node24"):$PATH"
    export PATH
  fi

  # Final check: ensure Node 24 is now available.
  if ! command -v node >/dev/null 2>&1; then
    echo "[hot-update] node is not available in PATH" >&2
    exit 1
  fi

  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [ "$major" != "24" ]; then
    echo "[hot-update] Node.js 24 is required, found $(node -v)" >&2
    exit 1
  fi
}

node_supports_env_proxy() {
  node --help 2>/dev/null | grep -F -- --use-env-proxy >/dev/null 2>&1
}

run_logged() {
  echo "[hot-update] $*"
  "$@"
}

run_worker() {
  cd "$PROJECT_DIR"
  mkdir -p "$LOG_DIR"

  echo "[hot-update] started $(date -Is)"
  echo "[hot-update] project: $PROJECT_DIR"
  echo "[hot-update] bridge log: $BRIDGE_LOG"

  validate_project_dir

  ensure_node24
  echo "[hot-update] node: $(node -v)"

  local proxy_supported=0
  if node_supports_env_proxy; then
    proxy_supported=1
    echo "[hot-update] --use-env-proxy: supported"
  else
    echo "[hot-update] --use-env-proxy: not supported"
  fi

  if [ "$USE_PULL" = "1" ]; then
    run_logged git pull
  else
    echo "[hot-update] git pull: skipped"
  fi

  run_logged npm run build
  if [ "$SKIP_TESTS" = "1" ]; then
    echo "[hot-update] npm test: skipped by --skip-tests"
  else
    run_logged npm test
  fi

  local cli
  cli="$(bridge_cli_display)"
  if [ "$proxy_supported" = "1" ]; then
    echo "[hot-update] restart command: NODE_OPTIONS=--use-env-proxy LITELLM_KEY=sk-local-dev $cli stop && NODE_OPTIONS=--use-env-proxy LITELLM_KEY=sk-local-dev $cli start"
    NODE_OPTIONS=--use-env-proxy LITELLM_KEY="sk-local-dev" run_bridge_cli stop
    NODE_OPTIONS=--use-env-proxy LITELLM_KEY="sk-local-dev" run_bridge_cli start
  else
    echo "[hot-update] restart command: LITELLM_KEY=sk-local-dev $cli stop && LITELLM_KEY=sk-local-dev $cli start"
    LITELLM_KEY="sk-local-dev" run_bridge_cli stop
    LITELLM_KEY="sk-local-dev" run_bridge_cli start
  fi

  echo "[hot-update] completed $(date -Is)"
}

run_dry_run() {
  cd "$PROJECT_DIR"
  validate_project_dir
  ensure_node24

  local args=(--run)
  if [ "$USE_PULL" = "1" ]; then
    args+=(--pull)
  fi
  if [ "$SKIP_TESTS" = "1" ]; then
    args+=(--skip-tests)
  fi

  echo "[hot-update] dry-run: yes"
  echo "[hot-update] project: $PROJECT_DIR"
  echo "[hot-update] pwd: $(pwd)"
  echo "[hot-update] script: $PROJECT_DIR/scripts/hot-update-bridge.sh"
  echo "[hot-update] CODELARK_HOME: $CODELARK_HOME"
  echo "[hot-update] log dir: $LOG_DIR"
  echo "[hot-update] bridge log: $BRIDGE_LOG"
  echo "[hot-update] node: $(node -v)"
  if node_supports_env_proxy; then
    echo "[hot-update] --use-env-proxy: supported"
  else
    echo "[hot-update] --use-env-proxy: not supported"
  fi
  echo "[hot-update] worker args: ${args[*]}"
  echo "[hot-update] dispatch command: bash scripts/hot-update-bridge.sh ${args[*]}"
  echo "[hot-update] git pull: $([ "$USE_PULL" = "1" ] && echo planned || echo skipped)"
  echo "[hot-update] npm run build: planned"
  echo "[hot-update] npm test: $([ "$SKIP_TESTS" = "1" ] && echo skipped || echo planned)"
  echo "[hot-update] restart cli: $(bridge_cli_display)"
  echo "[hot-update] restart: planned"
}

dispatch_worker() {
  local log_stamp
  log_stamp="$(date +%Y%m%d-%H%M%S)"
  local log_file="$LOG_DIR/hot-update-$log_stamp.log"
  if ! { mkdir -p "$LOG_DIR" && : >"$log_file"; } 2>/dev/null; then
    local fallback_log_dir="${TMPDIR:-/tmp}/codelark-logs"
    mkdir -p "$fallback_log_dir"
    log_file="$fallback_log_dir/hot-update-$log_stamp.log"
    : >"$log_file"
  fi
  local args=(--run)
  if [ "$USE_PULL" = "1" ]; then
    args+=(--pull)
  fi
  if [ "$SKIP_TESTS" = "1" ]; then
    args+=(--skip-tests)
  fi

  if command -v setsid >/dev/null 2>&1; then
    nohup setsid bash "$0" "${args[@]}" >"$log_file" 2>&1 </dev/null &
  else
    nohup bash "$0" "${args[@]}" >"$log_file" 2>&1 </dev/null &
  fi

  echo "Dispatched CodeLark hot update."
  echo "PID: $!"
  echo "Hot update log: $log_file"
  echo "Bridge log: $BRIDGE_LOG"
  echo "Pull requested: $([ "$USE_PULL" = "1" ] && echo yes || echo no)"
  echo "Tests skipped: $([ "$SKIP_TESTS" = "1" ] && echo yes || echo no)"
}

if [ "$DRY_RUN" = "1" ]; then
  run_dry_run
elif [ "$RUN_WORKER" = "1" ]; then
  run_worker
else
  dispatch_worker
fi
