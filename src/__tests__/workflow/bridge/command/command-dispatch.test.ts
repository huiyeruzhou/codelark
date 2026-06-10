import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { CODELARK_HOME, DEFAULT_WORKSPACE_ROOT } from '../../../../configuration/paths.js';
import {
  LEGACY_CONFIG_ENV_PATH as CONFIG_PATH,
  LEGACY_CONFIG_JSON_PATH as CONFIG_JSON_PATH,
} from '../../../../configuration/migrations/legacy/paths.js';
import { createConfigService } from '../../../../configuration/service.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { initBridgeContext } from '../../../../bridge/host/context.js';
import { handleBridgeCommand } from '../../../../bridge/command/index.js';
import {
  resolveClaudeRuntimeConfig,
  resolveDisplayedModel,
  resolveEffectiveCodexProvider,
  resolveEffectiveNetworkAccess,
  resolveEffectiveMode,
  resolveEffectiveReasoningEffort,
  resolveEffectiveSandboxMode,
} from '../../../../bridge/session/support.js';
import { processMessage } from '../../../../bridge/turn/interactive/sdk-conversation-engine.js';
import { consumeSseEvents } from '../../../../runtime/sse-stream-decoder.js';
import { CodexRoutingProvider } from '../../../../runtime/codex/routing-provider.js';
import { _testOnlyCodexThreadBootstrap } from '../../../../runtime/codex/thread-bootstrap.js';
import { _testOnlyClaudePty } from '../../../../runtime/claude/pty-provider.js';
import { _testOnlyTmuxScreenMonitors } from '../../../../bridge/command/tmux.js';
import { buildCommandCallbackData, parseCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import * as router from '../../../../bridge/host/channel-router.js';
import {
  flushThreadTablePinJobs,
  getThreadTableMessageRecord,
  persistAndPinLatestThreadTableMessage,
} from '../../../../bridge/command/thread-table-message-pins.js';
import { listAutoTasks } from '../../../../bridge/automation/auto-tasks.js';
import {
  buildCodexSandboxArgs,
  detectCodexSandboxCliStyleFromHelp,
  parseShellCommandArgs,
  resolveCodexCliExecutable,
} from '../../../../bridge/command/shell.js';
import { _testOnlyRuntimeSettings } from '../../../../bridge/command/runtime-settings.js';
import { writeCodexSessionJsonlFixture } from '../../../helpers/bridge/test-bridge-utils.js';
import type { OutboundRichCard } from '../../../../domain/index.js';
import type { HotUpdateRunRequest } from '../../../../bridge/command/hot-update.js';
import { consumeStartupNoticeTarget } from '../../../../bridge/host/startup-notice-target.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeModel,
  getSessionClaudeProvider,
  getSessionClaudeReasoningEffort,
  getSessionCodexModel,
  getSessionCodexNetworkAccess,
  getSessionCodexProvider,
  getSessionCodexReasoningEffort,
  getSessionCodexSandboxMode,
  getSessionTmuxAutoEnter,
  getSessionTmuxCaptureLines,
  getSessionTmuxEchoInput,
  getSessionRuntimeTmuxSessionName,
  getSessionTmuxSessionName,
  getSessionWorkingDirectory,
} from '../../../../domain/session-runtime.js';
import { getClaudeProjectDir, isArchivedClaudeSession } from '../../../../runtime/claude/session-jsonl.js';
import { normalizeReasoningEffort, normalizeSandboxMode } from '../../../../runtime/options.js';
import { sseEvent } from '../../../../runtime/sse.js';
import type { LLMProvider, StreamChatParams } from '../../../../runtime/contracts.js';
import { resolveConfigPaths } from '../../../../configuration/sources.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');
const HOME_CONFIG_TOML_PATH = resolveConfigPaths({ codelarkHome: CODELARK_HOME }).homeToml;

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('runtime settings internals', () => {
  it('returns the first Codex thread id from status without waiting for stream result', async () => {
    const threadId = '019e8600-0000-7000-9000-000000000001';
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({
          type: 'status',
          data: JSON.stringify({ session_id: threadId }),
        })}\n`);
      },
    });

    const found = await Promise.race([
      _testOnlyRuntimeSettings.readFirstCodexThreadId(stream),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for status thread id')), 200)),
    ]);

    assert.equal(found, threadId);
  });

  it('keeps Codex bootstrap context but removes the synthetic bootstrap prompt', () => {
    const threadId = '019e8600-0000-7000-9000-000000000002';
    const turnId = '019e8600-0000-7000-9000-000000000003';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bootstrap-trim-'));
    const filePath = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(filePath, [
      {
        type: 'session_meta',
        payload: { id: threadId, cwd: '/tmp/project' },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: turnId },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'permissions context' }] },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'AGENTS context' }] },
      },
      {
        type: 'turn_context',
        payload: { turn_id: turnId, cwd: '/tmp/project' },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: _testOnlyCodexThreadBootstrap.LOCAL_BOOTSTRAP_PROMPT }] },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: _testOnlyCodexThreadBootstrap.LOCAL_BOOTSTRAP_PROMPT },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turnId },
      },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8');

    try {
      _testOnlyCodexThreadBootstrap.trimLocalBootstrapSessionToContextPrefix(filePath, threadId);
      const remaining = fs.readFileSync(filePath, 'utf-8').trimEnd().split(/\n/).map((line) => JSON.parse(line));
      assert.equal(remaining.length, 5);
      assert.equal(remaining.at(0)?.type, 'session_meta');
      assert.equal(remaining.at(-1)?.type, 'turn_context');
      assert.doesNotMatch(fs.readFileSync(filePath, 'utf-8'), /CodeLark local thread bootstrap/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('waits for a Codex bootstrap session file to contain matching session_meta', async () => {
    const threadId = '019e8600-0000-7000-9000-000000000004';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bootstrap-ready-'));
    const oldCodexHome = process.env.CODEX_HOME;
    const sessionDir = path.join(tempDir, 'sessions', '2026', '06', '05');
    const filePath = path.join(sessionDir, `rollout-2026-06-05T18-00-00-${threadId}.jsonl`);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(filePath, '', 'utf-8');

    try {
      process.env.CODEX_HOME = tempDir;
      assert.equal(_testOnlyCodexThreadBootstrap.isBootstrapSessionFileReady(filePath, threadId), false);

      const startedAt = Date.now();
      const waitPromise = _testOnlyCodexThreadBootstrap.waitForSessionFileByThreadId(threadId);
      setTimeout(() => {
        fs.writeFileSync(filePath, `${JSON.stringify({
          type: 'session_meta',
          payload: { id: threadId, cwd: '/tmp/project' },
        })}\n`, 'utf-8');
      }, 100);

      const found = await waitPromise;
      assert.equal(found, filePath);
      assert.equal(_testOnlyCodexThreadBootstrap.isBootstrapSessionFileReady(filePath, threadId), true);
      assert.ok(Date.now() - startedAt >= 50);
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function installFakeCodexSandbox(tempDir: string): string {
  const scriptPath = path.join(tempDir, 'fake-codex-sandbox.cjs');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'sandbox' && args.includes('--help')) {
  process.stdout.write('Usage: codex sandbox [OPTIONS]\\n      --permissions-profile <PROFILE>\\n');
  process.exit(0);
}
if (args[0] !== 'sandbox') process.exit(2);
const cdIndex = args.indexOf('--cd');
const cwd = cdIndex >= 0 ? args[cdIndex + 1] : process.cwd();
const lcIndex = args.lastIndexOf('-lc');
const shell = lcIndex > 0 ? args[lcIndex - 1] : (process.env.SHELL || '/bin/sh');
const command = lcIndex >= 0 ? args[lcIndex + 1] : '';
const redirectMatch = command.match(/>\\s*([^\\s'"]+)/);
if (
  redirectMatch
  && path.isAbsolute(redirectMatch[1])
  && !redirectMatch[1].startsWith('/dev/tcp/')
  && !path.resolve(redirectMatch[1]).startsWith(path.resolve(cwd) + path.sep)
) {
  process.stderr.write('write outside workspace is blocked\\n');
  process.exit(1);
}
const result = spawnSync(shell, ['-lc', command], { cwd, env: process.env, encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  process.stderr.write(result.error.message + '\\n');
  process.exit(1);
}
process.exit(typeof result.status === 'number' ? result.status : 1);
`, 'utf-8');
  if (process.platform !== 'win32') {
    const shPath = path.join(tempDir, 'fake-codex-sandbox');
    fs.writeFileSync(shPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf-8');
    fs.chmodSync(shPath, 0o755);
    return shPath;
  }
  const cmdPath = path.join(tempDir, 'fake-codex-sandbox.cmd');
  fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf-8');
  return cmdPath;
}

function writeClaudeJsonlFixture(params: {
  homeDir: string;
  cwd: string;
  sessionId: string;
  timestamp: string;
  text: string;
}): string {
  const projectDir = getClaudeProjectDir(params.cwd, params.homeDir);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${params.sessionId}.jsonl`);
  fs.writeFileSync(filePath, `${JSON.stringify({
    type: 'user',
    uuid: `${params.sessionId}-user`,
    sessionId: params.sessionId,
    cwd: params.cwd,
    timestamp: params.timestamp,
    message: { role: 'user', content: params.text },
  })}\n`, 'utf-8');
  return filePath;
}

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

const noopLlm = {
  streamChat(): ReadableStream<string> {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  },
};

function initTestContext(options: { dynamicSettings?: boolean; settings?: Record<string, string> } = {}): JsonFileStore {
  const settings = new Map([
    ...makeSettings(),
    ...Object.entries(options.settings || {}),
  ]);
  const store = new JsonFileStore(settings, { dynamicSettings: options.dynamicSettings });
  initBridgeContext({
    store,
    llm: noopLlm,
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
  return store;
}

function readAuditSummaries(): string[] {
  const auditJsonPath = path.join(DATA_DIR, 'audit.json');
  const auditJsonlPath = path.join(DATA_DIR, 'audit.jsonl');
  const jsonRows = fs.existsSync(auditJsonPath)
    ? JSON.parse(fs.readFileSync(auditJsonPath, 'utf-8')) as Array<{ summary?: string }>
    : [];
  const jsonlRows = fs.existsSync(auditJsonlPath)
    ? fs.readFileSync(auditJsonlPath, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { summary?: string })
    : [];
  return [...jsonRows, ...jsonlRows].map((entry) => entry.summary || '');
}

function createGroupCapableAdapter(options: {
  channelType?: string;
  provider?: string;
  sent?: any[];
  groupPrefix?: string;
} = {}): any {
  const sent = options.sent || [];
  const createdGroups: Array<{ chatId: string; chatKind: 'group'; name: string; requestedName: string; createAs?: string }> = [];
  const renamedGroups: Array<{ chatId: string; name: string }> = [];
  return {
    channelType: options.channelType || 'feishu',
    provider: options.provider || 'feishu',
    sent,
    createdGroups,
    renamedGroups,
    send: async (message: any) => {
      sent.push(message);
      return { ok: true, messageId: `reply-${sent.length}` };
    },
    createGroupChat: async (input: { name: string; createAs?: string }) => {
      const group = {
        chatId: `created-group-${createdGroups.length + 1}`,
        chatKind: 'group' as const,
        name: `${options.groupPrefix || '[TestBot]'}${input.name}`,
        requestedName: input.name,
        createAs: input.createAs,
      };
      createdGroups.push(group);
      return group;
    },
    renameGroupChat: async (chatId: string, name: string) => {
      renamedGroups.push({ chatId, name });
      return { chatId, chatKind: 'group' as const, name };
    },
  };
}

function installFakeTmux(): { binDir: string; logPath: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-fake-tmux-'));
  const logPath = path.join(binDir, 'tmux.log');
  const statePath = path.join(binDir, 'tmux.sessions');
  const tmuxPath = path.join(binDir, 'tmux');
  fs.writeFileSync(logPath, '', 'utf-8');
  fs.writeFileSync(statePath, '', 'utf-8');
  fs.writeFileSync(tmuxPath, `#!/usr/bin/env bash
	printf '%s\\n' "$*" >> "$TMUX_FAKE_LOG"
	state_file="${statePath}"
	target_exists() {
	  local target="$1"
	  if [[ "$target" == "alpha" || "$target" == "beta" || "$target" == "codex_existing" ]]; then
	    return 0
	  fi
	  if [[ ",$TMUX_FAKE_EXISTING_SESSIONS," == *",$target,"* ]]; then
	    return 0
	  fi
	  if [[ -f "$state_file" ]] && grep -Fxq -- "$target" "$state_file"; then
	    return 0
	  fi
	  return 1
	}
	case "$1" in
	  list-sessions)
	    printf 'alpha\\t1\\t0\\t0\\t0\\n'
	    printf 'beta\\t2\\t1\\t0\\t0\\n'
	    exit 0
	    ;;
	  has-session)
	    target="$3"
	    target_exists "$target"
	    exit $?
	    ;;
	  kill-session)
	    exit 0
	    ;;
	  new-session)
	    target=""
	    prev=""
	    for arg in "$@"; do
	      if [[ "$prev" == "-s" ]]; then
	        target="$arg"
	        break
	      fi
	      prev="$arg"
	    done
	    if [[ -n "\${TMUX_FAKE_LAUNCH_STDERR:-}" ]]; then
	      command_text="\${*: -1}"
	      log_path="\${command_text#* 2> }"
	      log_path="\${log_path%%;*}"
	      log_path="\${log_path%'}"
	      log_path="\${log_path#'}"
	      mkdir -p "$(dirname "$log_path")"
	      printf '%b' "$TMUX_FAKE_LAUNCH_STDERR" > "$log_path"
	    elif [[ -n "$target" ]]; then
	      printf '%s\\n' "$target" >> "$state_file"
	    fi
	    exit 0
	    ;;
  send-keys)
    previous=''
    for arg in "$@"; do
      if [[ "$previous" == "-l" ]]; then
        if [[ "$arg" == "--" ]]; then
          previous='literal-stop'
          continue
        fi
        if [[ "$arg" == -* ]]; then
          printf 'unknown option: %s\\n' "$arg" >&2
          exit 2
        fi
      fi
      previous="$arg"
    done
    exit 0
    ;;
  capture-pane)
    if [[ -n "\${TMUX_FAKE_CAPTURE_TEXT:-}" ]]; then
      printf '%b' "$TMUX_FAKE_CAPTURE_TEXT"
      exit 0
    fi
    target=""
    prev=""
	    for arg in "$@"; do
	      if [[ "$prev" == "-t" ]]; then
	        target="$arg"
	        break
	      fi
	      prev="$arg"
	    done
	    if ! target_exists "$target"; then
	      printf "can't find pane %s\\n" "$target" >&2
	      exit 1
	    fi
	    ready_after="\${TMUX_FAKE_READY_AFTER_CAPTURES:-0}"
    safe_target="\${target//[^A-Za-z0-9_.-]/_}"
    count_file="$TMUX_FAKE_LOG.\${safe_target:-default}.captures"
    count=0
    [[ -f "$count_file" ]] && count="$(cat "$count_file" 2>/dev/null || printf '0')"
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"
    if [[ "$count" -le "$ready_after" ]]; then
      printf 'alpha-screen\nCodex starting...\n'
    else
      printf 'alpha-screen\nOpenAI Codex\n› \n'
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`, 'utf-8');
  fs.chmodSync(tmuxPath, 0o755);
  return { binDir, logPath };
}

function installFakeClaudeExecutable(): { binDir: string; logPath: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-fake-claude-'));
  const logPath = path.join(binDir, 'claude.log');
  const claudePath = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.writeFileSync(logPath, '', 'utf-8');
  fs.writeFileSync(claudePath, `#!/usr/bin/env bash
{
  printf 'argv:'
  printf ' <%s>' "$0" "$@"
  printf '\\n'
  printf 'cwd:%s\\n' "$PWD"
} >> "$CLAUDE_FAKE_LOG"
printf 'Claude Code v0.0.0\\n❯ ? for shortcuts\\n'
IFS= read -r prompt || true
printf 'prompt:%s\\n' "$prompt" >> "$CLAUDE_FAKE_LOG"
printf '\\nFAKE_CLAUDE_RESPONSE:%s\\n' "$prompt"
sleep 0.1
`, 'utf-8');
  fs.chmodSync(claudePath, 0o755);
  return { binDir, logPath };
}

describe('command-dispatch', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(path.join(CODELARK_HOME, 'config'), { recursive: true, force: true });
    fs.rmSync(HOME_CONFIG_TOML_PATH, { force: true });
    fs.rmSync(CONFIG_PATH, { force: true });
    fs.rmSync(CONFIG_JSON_PATH, { force: true });
  });

  it('round-trips interactive command callback data', () => {
    const callbackData = buildCommandCallbackData('/stop', 'session-1');
    assert.deepEqual(parseCommandCallbackData(callbackData), {
      commandText: '/stop',
      scopeSessionId: 'session-1',
    });
    assert.equal(parseCommandCallbackData('perm:allow:1'), undefined);
    assert.equal(parseCommandCallbackData('clk-command::not-a-command'), null);
  });

  it('dispatches /hot-update through the project script dry-run without touching the live bridge', async () => {
    initTestContext();
    const sent: string[] = [];
    const capturedRuns: HotUpdateRunRequest[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-hot-update-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-hot-update' } as const;
    const env = {
      ...process.env,
      CODELARK_HOT_UPDATE_TEST_MARKER: 'from-current-bridge-env',
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/hot-update --dry-run --pull --skip-tests',
        messageId: 'incoming-hot-update',
      } as any,
      '/hot-update --dry-run --pull --skip-tests',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
        hotUpdateCwd: path.join(process.cwd(), 'src', '__tests__'),
        hotUpdateEnv: env,
        hotUpdateRunner: async (request) => {
          capturedRuns.push(request);
          assert.equal(request.env.CODELARK_HOT_UPDATE_TEST_MARKER, 'from-current-bridge-env');
          assert.equal(request.scriptPath, path.join(request.cwd, 'scripts', 'hot-update-bridge.sh'));
          assert.equal(fs.existsSync(request.scriptPath), true);
          assert.equal(JSON.parse(fs.readFileSync(path.join(request.cwd, 'package.json'), 'utf-8')).name, 'codelark');
          assert.deepEqual(request.args, ['--dry-run', '--pull', '--skip-tests']);
          return {
            stdout: [
              '[hot-update] dry-run: yes',
              `[hot-update] project: ${request.cwd}`,
              `[hot-update] pwd: ${request.cwd}`,
              '[hot-update] node: v24.12.0',
              '[hot-update] worker args: --run --pull --skip-tests',
              '[hot-update] git pull: planned',
              '[hot-update] npm run build: planned',
              '[hot-update] npm test: skipped',
              '[hot-update] restart: planned',
            ].join('\n'),
            stderr: '',
          };
        },
      },
    );

    assert.equal(capturedRuns.length, 1);
    assert.match(sent.at(-1) || '', /热更新 dry-run 通过/);
    assert.match(sent.at(-1) || '', /命令：bash scripts\/hot-update-bridge\.sh --dry-run --pull --skip-tests/);
    assert.match(sent.at(-1) || '', /node: v24\.12\.0/);
    assert.match(sent.at(-1) || '', /worker args: --run --pull --skip-tests/);
    assert.match(sent.at(-1) || '', /npm test: skipped/);
  });

  it('updates /hot-update log in a regular rich card after dispatch', async () => {
    const store = initTestContext();
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-hot-update-log-'));
    const hotUpdateLog = path.join(logDir, 'hot-update.log');
    const bridgeLog = path.join(logDir, 'bridge.log');
    fs.writeFileSync(hotUpdateLog, [
      ...Array.from({ length: 105 }, (_, index) => `[hot-update] old output line ${String(index + 1).padStart(3, '0')}`),
      '[hot-update] started 2026-05-31T23:43:00+08:00',
      '[hot-update] npm run build',
    ].join('\n'), 'utf-8');

    const sent: Array<{
      text: string;
      richCard?: OutboundRichCard;
      richCardUpdateMessageId?: string;
    }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      supportsStructuredStreamingUi: () => true,
      onStreamText: () => {
        throw new Error('/hot-update should not use streaming text cards');
      },
      onStreamStatus: () => {
        throw new Error('/hot-update should not use streaming status cards');
      },
      onStreamEnd: async () => {
        throw new Error('/hot-update should not finalize streaming cards');
      },
      send: async (message: { text: string; richCard?: OutboundRichCard; richCardUpdateMessageId?: string }) => {
        sent.push({
          text: message.text,
          richCard: message.richCard,
          richCardUpdateMessageId: message.richCardUpdateMessageId,
        });
        return { ok: true, messageId: `reply-hot-update-card-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-hot-update-stream', chatKind: 'p2p' as const, userId: 'user-hot-update' } as const;

    try {
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/hot-update --skip-tests',
          messageId: 'incoming-hot-update-stream',
        } as any,
        '/hot-update --skip-tests',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
          hotUpdateCwd: process.cwd(),
          hotUpdateLogRefreshIntervalMs: 5,
          hotUpdateRunner: async (request) => ({
            stdout: [
              'Dispatched CodeLark hot update.',
              'PID: 12345',
              `Hot update log: ${hotUpdateLog}`,
              `Bridge log: ${bridgeLog}`,
              'Pull requested: no',
              'Tests skipped: yes',
              `cwd: ${request.cwd}`,
            ].join('\n'),
            stderr: '',
          }),
        },
      );

      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /已派发 CodeLark 热更新/);
      assert.equal(sent[0].richCard?.title, 'CodeLark 热更新日志');
      assert.match(sent[0].richCard?.updateKey || '', /^hot-update-log:/);
      assert.equal(sent[0].richCard?.updateTtlMs, null);
      assert.match(sent[0].richCard?.subtitle || '', /每 3 秒刷新/);
      assert.match(sent[0].richCard?.subtitle || '', /tail -n 100/);
      assert.equal(sent[0].richCard?.sections.length, 2);
      assert.match(sent[0].richCard?.sections[1]?.code?.text || '', /npm run build/);
      assert.doesNotMatch(sent[0].richCard?.sections[1]?.code?.text || '', /old output line 001/);
      assert.match(sent[0].richCard?.sections[1]?.code?.text || '', /old output line 008/);
      assert.doesNotMatch(sent[0].richCard?.sections.map((section) => section.title || '').join('\n'), /派发输出/);
      assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
      assert.deepEqual(consumeStartupNoticeTarget()?.address, address);

      fs.appendFileSync(hotUpdateLog, '\n[hot-update] completed 2026-05-31T23:43:10+08:00\n', 'utf-8');
      await new Promise((resolve) => setTimeout(resolve, 25));

      assert.ok(sent.length >= 2);
      assert.equal(sent[1].richCardUpdateMessageId, 'reply-hot-update-card-1');
      assert.equal(sent[1].richCard?.updateKey, sent[0].richCard?.updateKey);
      assert.equal(sent[1].richCard?.title, 'CodeLark 热更新完成');
      assert.match(sent[1].richCard?.sections[1]?.code?.text || '', /\[hot-update\] completed/);
      assert.doesNotMatch(sent[1].richCard?.sections[1]?.code?.text || '', /old output line 008/);
      assert.match(sent[1].richCard?.sections[1]?.code?.text || '', /old output line 009/);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('stops /hot-update log updates when the dispatched worker pid exits without completion', async () => {
    initTestContext();
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-hot-update-exited-'));
    const hotUpdateLog = path.join(logDir, 'hot-update.log');
    const bridgeLog = path.join(logDir, 'bridge.log');
    const exitedPid = 999_999_999;
    fs.writeFileSync(hotUpdateLog, [
      '[hot-update] started 2026-06-01T00:17:00+08:00',
      '[hot-update] npm run build',
    ].join('\n'), 'utf-8');

    const sent: Array<{
      text: string;
      richCard?: OutboundRichCard;
      richCardUpdateMessageId?: string;
    }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard; richCardUpdateMessageId?: string }) => {
        sent.push({
          text: message.text,
          richCard: message.richCard,
          richCardUpdateMessageId: message.richCardUpdateMessageId,
        });
        return { ok: true, messageId: `reply-hot-update-exited-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-hot-update-exited' } as const;

    try {
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/hot-update',
          messageId: 'incoming-hot-update-exited',
        } as any,
        '/hot-update',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
          hotUpdateCwd: process.cwd(),
          hotUpdateLogRefreshIntervalMs: 5,
          hotUpdateRunner: async () => ({
            stdout: [
              'Dispatched CodeLark hot update.',
              `PID: ${exitedPid}`,
              `Hot update log: ${hotUpdateLog}`,
              `Bridge log: ${bridgeLog}`,
              'Pull requested: no',
              'Tests skipped: no',
            ].join('\n'),
            stderr: '',
          }),
        },
      );

      assert.equal(sent.length, 1);
      assert.equal(sent[0].richCard?.title, 'CodeLark 热更新日志');

      await new Promise((resolve) => setTimeout(resolve, 35));

      assert.equal(sent.length, 2);
      assert.equal(sent[1].richCardUpdateMessageId, 'reply-hot-update-exited-1');
      assert.equal(sent[1].richCard?.title, 'CodeLark 热更新异常');
      assert.match(sent[1].richCard?.footer?.join('\n') || '', /PID 999999999 已退出/);

      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(sent.length, 2);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('rejects /hot-update --run from IM commands before invoking the script', async () => {
    initTestContext();
    const sent: string[] = [];
    let invoked = false;
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-hot-update-reject-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-hot-update-reject' } as const;

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/hot-update --run',
        messageId: 'incoming-hot-update-run',
      } as any,
      '/hot-update --run',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
        hotUpdateRunner: async () => {
          invoked = true;
          return { stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(invoked, false);
    assert.match(sent.at(-1) || '', /不能通过 IM 命令传 `--run`/);
  });

  it('runs /shell through codex sandbox independent of yolo mode', async () => {
    const store = initTestContext();
    const address = { channelType: 'feishu', chatId: 'chat-shell-run' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-shell-run-'));
    const binding = router.createBinding(address, workDir);
    const session = store.getSession(binding.bridgeSessionId);
    assert.ok(session);
    store.updateSession(session.id, { runtime: { codex: { sandboxMode: 'danger-full-access' } } });
    store.updateSession(session.id, { runtime: { codex: { mode: 'yolo' } } });

    const sent: string[] = [];
    const requests: Array<{
      command: string;
      cwd: string;
      networkAccess: boolean;
      refreshIntervalSeconds: number | undefined;
      sandboxMode: string;
      shell: string;
    }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-shell-${sent.length}` };
      },
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/shell echo ok',
        messageId: 'incoming-shell-run',
      } as any,
      '/shell echo ok',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
        shellRunner: async (request) => {
          requests.push({
            command: request.command,
            cwd: request.cwd,
            networkAccess: request.networkAccess,
            refreshIntervalSeconds: request.refreshIntervalSeconds,
            sandboxMode: request.sandboxMode,
            shell: request.shell,
          });
          return { exitCode: 0, stdout: 'ok\n', stderr: '' };
        },
      },
    );

    assert.deepEqual(requests, [{
      command: 'echo ok',
      cwd: workDir,
      networkAccess: true,
      refreshIntervalSeconds: 5,
      sandboxMode: 'workspace-write',
      shell: process.env.SHELL || '/bin/bash',
    }]);
    assert.match(sent.at(-1) || '', /\/shell 执行完成/);
    assert.match(sent.at(-1) || '', /Codex sandbox.*workspace-write/s);
    assert.match(sent.at(-1) || '', /网络.*on/s);
    assert.match(sent.at(-1) || '', /ok/);
  });

  it('unwraps transported markdown links for /shell commands', async () => {
    initTestContext();
    const address = { channelType: 'feishu', chatId: 'chat-shell-markdown-link' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-shell-markdown-link-'));
    router.createBinding(address, workDir);

    const sent: string[] = [];
    const commands: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-shell-md-${sent.length}` };
      },
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/shell curl [baidu.com](http://baidu.com/)',
        messageId: 'incoming-shell-md-link',
      } as any,
      '/shell curl [baidu.com](http://baidu.com/)',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
        shellRunner: async (request) => {
          commands.push(request.command);
          return { exitCode: 0, stdout: 'ok\n', stderr: '' };
        },
      },
    );

    assert.deepEqual(commands, ['curl baidu.com']);
    assert.match(sent.at(-1) || '', /curl baidu\.com/);
    assert.doesNotMatch(sent.at(-1) || '', /http:\/\/baidu\.com/);
  });

  it('streams /shell progress to a structured card and floors refresh interval to 5 seconds', async () => {
    initTestContext();
    const address = { channelType: 'feishu', chatId: 'chat-shell-stream' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-shell-stream-'));
    router.createBinding(address, workDir);

    const sent: string[] = [];
    const streamTexts: string[] = [];
    const streamStatuses: string[] = [];
    const streamEnds: Array<{ status: string; text: string }> = [];
    const requestedIntervals: Array<number | undefined> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      supportsStructuredStreamingUi: () => true,
      onStreamText: (_chatId: string, text: string) => {
        streamTexts.push(text);
      },
      onStreamStatus: (_chatId: string, text: string) => {
        streamStatuses.push(text);
      },
      onStreamEnd: async (_chatId: string, status: string, text: string) => {
        streamEnds.push({ status, text });
        return true;
      },
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-shell-stream-${sent.length}` };
      },
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/shell 2 echo streamed',
        messageId: 'incoming-shell-stream',
      } as any,
      '/shell 2 echo streamed',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
        shellRunner: async (request) => {
          requestedIntervals.push(request.refreshIntervalSeconds);
          request.onProgress?.({ stdout: 'partial\n', stderr: '' });
          return { exitCode: 0, stdout: 'partial\nfinal\n', stderr: '' };
        },
      },
    );

    assert.deepEqual(requestedIntervals, [5]);
    assert.deepEqual(sent, []);
    assert.ok(streamTexts.some((text) => /partial/.test(text)));
    assert.ok(streamTexts.some((text) => /final/.test(text)));
    assert.ok(streamStatuses.some((text) => /refresh 5s/.test(text)));
    assert.deepEqual(streamEnds.map((entry) => entry.status), ['completed']);
    assert.match(streamEnds[0].text, /\/shell 执行完成/);
  });

  it('parses /shell refresh interval from the leading numeric argument', () => {
    const defaultArgs = parseShellCommandArgs('echo default');
    assert.ok(!('error' in defaultArgs));
    assert.equal(defaultArgs.command, 'echo default');
    assert.equal(defaultArgs.refreshIntervalSeconds, 5);

    const flooredArgs = parseShellCommandArgs('2 echo floored');
    assert.ok(!('error' in flooredArgs));
    assert.equal(flooredArgs.command, 'echo floored');
    assert.equal(flooredArgs.refreshIntervalSeconds, 5);

    const explicitArgs = parseShellCommandArgs('--sandbox read-only 12 echo slow');
    assert.ok(!('error' in explicitArgs));
    assert.equal(explicitArgs.command, 'echo slow');
    assert.equal(explicitArgs.refreshIntervalSeconds, 12);
    assert.equal(explicitArgs.sandboxMode, 'read-only');
  });

  it('builds /shell codex sandbox args with default network access', () => {
    const request = {
      command: 'curl baidu.com',
      cwd: '/tmp/clk-shell',
      networkAccess: true,
      sandboxMode: 'workspace-write',
      shell: '/bin/bash',
      timeoutMs: 60_000,
    } as const;
    const args = buildCodexSandboxArgs(request);

    assert.deepEqual(args, [
      'sandbox',
      '-c',
      'permissions.codelark_shell_workspace_network.extends=":workspace"',
      '-c',
      'permissions.codelark_shell_workspace_network.network.enabled=true',
      '-c',
      'permissions.codelark_shell_workspace_network.network.mode="full"',
      '--permissions-profile',
      'codelark_shell_workspace_network',
      '--cd',
      '/tmp/clk-shell',
      '/bin/bash',
      '-lc',
      'curl baidu.com',
    ]);

    assert.deepEqual(buildCodexSandboxArgs(request, 'linux-subcommand'), [
      'sandbox',
      'linux',
      '-c',
      'permissions.codelark_shell_workspace_network.extends=":workspace"',
      '-c',
      'permissions.codelark_shell_workspace_network.network.enabled=true',
      '-c',
      'permissions.codelark_shell_workspace_network.network.mode="full"',
      '--permissions-profile',
      'codelark_shell_workspace_network',
      '--cd',
      '/tmp/clk-shell',
      '/bin/bash',
      '-lc',
      'curl baidu.com',
    ]);
  });

  it('detects new and legacy codex sandbox CLI help forms', () => {
    assert.equal(detectCodexSandboxCliStyleFromHelp([
      'Usage: codex sandbox [OPTIONS] [COMMAND]...',
      '',
      'Options:',
      '      --permissions-profile <NAME>',
    ].join('\n')), 'top-level');

    assert.equal(detectCodexSandboxCliStyleFromHelp([
      'Usage: codex sandbox [OPTIONS] <COMMAND>',
      '',
      'Commands:',
      '  macos    Run a command under Seatbelt',
      '  linux    Run a command under the Linux sandbox',
      '  windows  Run a command under Windows restricted token',
    ].join('\n')), 'linux-subcommand');
  });

  it('prefers a global codex executable over node_modules for /shell', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-path-'));
    const projectBin = path.join(tempDir, 'project', 'node_modules', '.bin');
    const globalBin = path.join(tempDir, 'global-bin');
    fs.mkdirSync(projectBin, { recursive: true });
    fs.mkdirSync(globalBin, { recursive: true });
    const projectCodex = path.join(projectBin, 'codex');
    const globalCodex = path.join(globalBin, 'codex');
    fs.writeFileSync(projectCodex, '#!/usr/bin/env sh\nexit 0\n', 'utf-8');
    fs.writeFileSync(globalCodex, '#!/usr/bin/env sh\nexit 0\n', 'utf-8');
    fs.chmodSync(projectCodex, 0o755);
    fs.chmodSync(globalCodex, 0o755);

    try {
      assert.equal(
        resolveCodexCliExecutable({ PATH: `${projectBin}${path.delimiter}${globalBin}` }),
        globalCodex,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs real /shell commands for listing, workspace write, and invalid directory write failure', async () => {
    initTestContext();
    const oldCodexCliPath = process.env.CODELARK_CODEX_CLI_PATH;
    const address = { channelType: 'feishu', chatId: 'chat-shell-real' } as const;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-shell-real-'));
    const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-fake-codex-shell-'));
    process.env.CODELARK_CODEX_CLI_PATH = installFakeCodexSandbox(fakeCodexDir);
    fs.writeFileSync(path.join(cwd, 'visible.txt'), 'ok\n', 'utf-8');
    const outsideDir = path.join('/etc', `clk-shell-outside-${process.pid}-${Date.now()}`);
    const outsidePath = path.join(outsideDir, 'blocked.txt');
    router.createBinding(address, cwd);

    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-shell-real-${sent.length}` };
      },
    };
    const deps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
    };

    try {
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/shell ls',
          messageId: 'incoming-shell-real-ls',
        } as any,
        '/shell ls',
        deps,
      );
      assert.match(sent.at(-1) || '', /\/shell 执行完成/);
      assert.match(sent.at(-1) || '', /退出码[\s\S]*0/);
      assert.match(sent.at(-1) || '', /visible\.txt/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/shell echo shell-ok > temp.txt',
          messageId: 'incoming-shell-real-write',
        } as any,
        '/shell echo shell-ok > temp.txt',
        deps,
      );
      assert.match(sent.at(-1) || '', /退出码[\s\S]*0/);
      assert.equal(fs.readFileSync(path.join(cwd, 'temp.txt'), 'utf-8'), 'shell-ok\n');

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: `/shell echo nope > ${outsidePath}`,
          messageId: 'incoming-shell-real-invalid-dir',
        } as any,
        `/shell echo nope > ${outsidePath}`,
        deps,
      );
      assert.match(sent.at(-1) || '', /退出码[\s\S]*[1-9]/);
      assert.equal(fs.existsSync(outsidePath), false);
    } finally {
      if (oldCodexCliPath === undefined) delete process.env.CODELARK_CODEX_CLI_PATH;
      else process.env.CODELARK_CODEX_CLI_PATH = oldCodexCliPath;
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(fakeCodexDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('allows /shell to connect to localhost when sandbox network is enabled', async () => {
    initTestContext();
    const oldCodexCliPath = process.env.CODELARK_CODEX_CLI_PATH;
    const address = { channelType: 'feishu', chatId: 'chat-shell-localhost' } as const;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-shell-localhost-'));
    const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-fake-codex-shell-'));
    process.env.CODELARK_CODEX_CLI_PATH = installFakeCodexSandbox(fakeCodexDir);
    router.createBinding(address, cwd);

    const server = net.createServer((socket) => {
      socket.end('clk-localhost-ok\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addressInfo = server.address();
    assert.ok(addressInfo && typeof addressInfo === 'object');

    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-shell-localhost-${sent.length}` };
      },
    };

    try {
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: `/shell bash -lc 'exec 3<>/dev/tcp/127.0.0.1/${addressInfo.port}; cat <&3'`,
          messageId: 'incoming-shell-localhost',
        } as any,
        `/shell bash -lc 'exec 3<>/dev/tcp/127.0.0.1/${addressInfo.port}; cat <&3'`,
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
        },
      );
      assert.match(sent.at(-1) || '', /退出码[\s\S]*0/);
      assert.match(sent.at(-1) || '', /clk-localhost-ok/);
    } finally {
      if (oldCodexCliPath === undefined) delete process.env.CODELARK_CODEX_CLI_PATH;
      else process.env.CODELARK_CODEX_CLI_PATH = oldCodexCliPath;
      server.close();
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(fakeCodexDir, { recursive: true, force: true });
    }
  });

  it('audits /shell high-risk and malformed commands before running', async () => {
    initTestContext();
    const address = { channelType: 'feishu', chatId: 'chat-shell-audit' } as const;
    router.createBinding(address, fs.mkdtempSync(path.join(os.tmpdir(), 'clk-shell-audit-')));

    const sent: string[] = [];
    let runnerCalls = 0;
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-shell-audit-${sent.length}` };
      },
    };
    const deps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
      shellRunner: async () => {
        runnerCalls += 1;
        return { exitCode: 0, stdout: 'forced\n', stderr: '' };
      },
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/shell rm -rf dist',
        messageId: 'incoming-shell-rm',
      } as any,
      '/shell rm -rf dist',
      deps,
    );
    assert.equal(runnerCalls, 0);
    assert.match(sent.at(-1) || '', /\/shell 需要确认/);
    assert.match(sent.at(-1) || '', /--force/);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/shell / tmp',
        messageId: 'incoming-shell-slash',
      } as any,
      '/shell / tmp',
      deps,
    );
    assert.equal(runnerCalls, 0);
    assert.match(sent.at(-1) || '', /\/shell 已拒绝执行/);
    assert.match(sent.at(-1) || '', /绝对路径被空格拆开/);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/shell --sandbox danger-full-access echo no',
        messageId: 'incoming-shell-danger-sandbox',
      } as any,
      '/shell --sandbox danger-full-access echo no',
      deps,
    );
    assert.equal(runnerCalls, 0);
    assert.match(sent.at(-1) || '', /不允许 danger-full-access/);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/shell --force rm -rf dist',
        messageId: 'incoming-shell-force',
      } as any,
      '/shell --force rm -rf dist',
      deps,
    );
    assert.equal(runnerCalls, 1);
    assert.match(sent.at(-1) || '', /已确认高风险操作/);
    assert.match(sent.at(-1) || '', /forced/);
  });

  it('switches /thread 0 into the hidden temporary session and keeps normal mode', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-1' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-draft' } as const;

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/thread 0',
        messageId: 'incoming-1',
      } as any,
      '/thread 0',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );
    const binding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(binding);
    const session = binding ? store.getSession(binding.bridgeSessionId) : null;
    assert.equal(session?.runtime?.codex?.mode, undefined);
    assert.equal(session?.session_type, 'normal');
    assert.equal(session?.hidden, true);
    assert.match(sent[0] || '', /已切换到临时 BridgeSession/);
  });

  it('applies channel prebinding before running the first session-scoped slash command', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu-default',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-prebound-history' };
      },
    };
    const address = { channelType: 'feishu-default', chatId: 'chat-prebound-status', displayName: 'Prebound Chat' } as const;
    const session = store.createSession('prebound-session', 'test-model', undefined, '/tmp/prebound-status');
    store.updateSession(session.id, {
      runtime: { codex: { threadId: 'codex-thread-prebound' } },
    });
    store.upsertChannelDefaultTarget({
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      channelAlias: '飞书',
      bridgeSessionId: session.id,
    });

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/',
        messageId: 'incoming-prebound-status',
      } as any,
      '/',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const binding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(binding);
    assert.equal(binding?.bridgeSessionId, session.id);
    assert.equal(store.getChannelDefaultTarget(address.channelType), null);
    assert.match(sent[0] || '', /当前会话/);
    assert.match(sent[0] || '', /prebound-session/);
    assert.match(sent[0] || '', /codex-thread-id/);
    assert.match(sent[0] || '', /codex-thread-prebound/);
  });

  it('renders /currnet as a green current-session card and saves name through the config form', async () => {
    const store = initTestContext();
    const sent: any[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    const pinned: string[] = [];
    const unpinned: string[] = [];
    adapter.pinMessage = async (_chatId: string, messageId: string) => {
      pinned.push(messageId);
      return { ok: true, messageId };
    };
    adapter.unpinMessage = async (_chatId: string, messageId: string) => {
      unpinned.push(messageId);
      return { ok: true, messageId };
    };
    const address = { channelType: 'feishu', chatId: 'chat-current-card', chatKind: 'group' as const } as const;
    const binding = router.createBinding(address, '/tmp/current-card');
    const session = store.getSession(binding.bridgeSessionId);
    assert.ok(session);
    store.updateSession(session.id, {
      name: 'Current Card',
      runtime: {
        codex: {
          threadId: '019e7d66-0000-7000-8000-currentcard01',
          title: 'Card title',
          provider: 'sdk',
          mode: 'normal',
          reasoningEffort: 'medium',
          sandboxMode: 'workspace-write',
          networkAccess: true,
        },
        general: { workingDirectory: '/tmp/current-card' },
      },
    });
    const deps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
    };

    await handleBridgeCommand(adapter, { address, text: '/currnet', messageId: 'incoming-current-card' } as any, '/currnet', deps);
    await flushThreadTablePinJobs();

    const card = sent.at(-1)?.richCard as OutboundRichCard | undefined;
    assert.equal(card?.template, 'green');
    assert.equal(card?.updateKey, `thread-card:current:${address.channelType}:${address.chatId}`);
    assert.equal(card?.updateTtlMs, null);
    assert.deepEqual(card?.tags, ['codex', '019e7d66...card01']);
    assert.match(card?.title || '', /Codex Card title/);
    assert.equal(card?.selects?.[0]?.id, 'cur_runtime');
    assert.deepEqual(card?.selects?.[0]?.options.map((option) => option.text), ['Codex', 'Claude Code']);
    assert.equal(parseCommandCallbackData(card?.selects?.[0]?.selectedCallbackData || '')?.commandText, '/current-runtime codex');
    assert.equal(card?.form?.layout, 'two_column');
    assert.equal(card?.form?.inputElementId, 'clk_name');
    assert.equal(card?.form?.controlBar?.selects, undefined);
    assert.deepEqual(card?.form?.controlBar?.actions?.map((action) => action.text), ['刷新']);
    assert.equal(card?.form?.submitText, '保存');
    assert.deepEqual(card?.sections?.[0]?.fields?.map(([label]) => label), ['类型', '运行状态', '共享镜像']);
    assert.equal(card?.sections?.[0]?.fields?.some(([label]) => label === '目录'), false);
    assert.deepEqual(card?.form?.selects?.map((select) => select.elementId), [
      'defaultMode',
      'defaultProvider',
      'codexSandboxMode',
      'codexNetworkAccess',
      'codexReasoningEffort',
    ]);
    assert.deepEqual(card?.form?.selects?.map((select) => select.label), [
      'YOLO模式 (runtime.codex.yolo_mode)',
      'Provider（运行方式） (runtime.codex.provider)',
      '文件系统权限 (runtime.codex.sandbox_mode)',
      '网络访问 (runtime.codex.network_access)',
      '思考级别 (runtime.codex.reasoning_effort)',
    ]);
    assert.equal(card?.form?.extraInputs?.find((input) => input.elementId === 'clk_cwd')?.defaultValue, '/tmp/current-card');
    assert.equal(card?.form?.extraInputs?.some((input) => input.elementId === 'defaultModel'), true);
    assert.equal(card?.form?.selects?.some((select) => select.elementId === 'codexSandboxMode'), true);
    assert.match(card?.footer?.[0] || '', /当前 agent.*<text_tag color='orange'>Codex<\/text_tag>/);
    assert.deepEqual(
      card?.form?.selects?.find((select) => select.elementId === 'codexReasoningEffort')?.options.map((option) => option.text),
      ['medium', 'minimal', 'low', 'high', 'xhigh'],
    );
    assert.equal(getThreadTableMessageRecord(address, 'current')?.messageId, 'reply-1');
    assert.deepEqual(pinned, ['reply-1']);
    assert.deepEqual(unpinned, []);

    await handleBridgeCommand(adapter, { address, text: '/currnet', messageId: 'incoming-current-card-refresh' } as any, '/currnet', deps);
    await flushThreadTablePinJobs();
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, undefined);
    assert.equal(getThreadTableMessageRecord(address, 'current')?.messageId, 'reply-2');
    assert.deepEqual(pinned, ['reply-1', 'reply-2']);
    assert.deepEqual(unpinned, ['reply-1']);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/current-runtime',
        messageId: 'incoming-current-card-runtime',
        callbackMessageId: 'reply-2',
      } as any,
      '/current-runtime claude',
      deps,
    );

    const claudeBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(claudeBinding);
    assert.equal(getSessionActiveRuntime(store.getSession(claudeBinding.bridgeSessionId)), 'claude');
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, 'reply-2');
    assert.equal(sent.at(-1)?.richCard?.selects?.[0]?.selectedCallbackData, buildCommandCallbackData('/current-runtime claude'));
    assert.deepEqual(sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.elementId), [
      'claudeMode',
      'claudeProvider',
      'claudeReasoningEffort',
    ]);
    assert.deepEqual(sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.formName), [
      'cld_mode',
      'cld_provider',
      'cld_rsn_eft',
    ]);
    assert.deepEqual(sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.label), [
      'YOLO模式 (runtime.claude.yolo_mode)',
      'Provider（运行方式） (runtime.claude.provider)',
      '思考级别 (runtime.claude.reasoning_effort)',
    ]);
    assert.equal(
      sent.at(-1)?.richCard?.form?.extraInputs?.some((input: any) => input.elementId === 'claudeIdleTimeoutMinutes'),
      true,
    );
    assert.equal(
      sent.at(-1)?.richCard?.form?.extraInputs?.some((input: any) => input.formName === 'cld_idle_min'),
      true,
    );
    assert.equal(sent.at(-1)?.richCard?.form?.selects?.some((select: any) => select.elementId === 'codexSandboxMode'), false);
    assert.equal(getThreadTableMessageRecord(address, 'current')?.messageId, 'reply-2');

    await handleBridgeCommand(adapter, { address, text: '/current runtime claude', messageId: 'incoming-current-card-claude-preview' } as any, '/current runtime claude', deps);
    const claudePreviewCard = sent.at(-1)?.richCard as OutboundRichCard | undefined;
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, undefined);
    assert.equal(getThreadTableMessageRecord(address, 'current')?.messageId, 'reply-4');
    assert.equal(claudePreviewCard?.tags?.[0], 'claude');
    assert.match(claudePreviewCard?.footer?.[0] || '', /当前 agent.*<text_tag color='orange'>Claude Code<\/text_tag>/);
    assert.equal(claudePreviewCard?.selects?.[0]?.selectedCallbackData, buildCommandCallbackData('/current-runtime claude'));
    assert.equal(claudePreviewCard?.form?.selects?.some((select) => select.elementId === 'codexSandboxMode'), false);
    assert.equal(claudePreviewCard?.form?.selects?.some((select) => select.elementId === 'codexNetworkAccess'), false);
    assert.deepEqual(
      claudePreviewCard?.form?.selects?.find((select) => select.elementId === 'claudeProvider')?.options.map((option) => option.text),
      ['tmux', 'pty', 'sdk'],
    );
    assert.deepEqual(
      claudePreviewCard?.form?.selects?.find((select) => select.elementId === 'claudeReasoningEffort')?.options.map((option) => option.text),
      ['medium', 'low', 'high', 'xhigh', 'max'],
    );
    assert.deepEqual(
      parseCommandCallbackData(claudePreviewCard?.form?.submitCallbackData || '')?.commandText,
      '/current-config claude',
    );

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/current-config',
        messageId: 'incoming-current-card-submit',
        raw: {
          event: {
            context: {
              open_message_id: 'reply-4',
            },
            action: {
              form_value: {
                clk_name: '重命名 Current',
                clk_cwd: '/tmp/current-card',
                claudeDefaultModel: 'test-model',
                claudeMode: 'yolo',
                claudeProvider: 'pty',
                cld_rsn_eft: 'max',
                cld_idle_min: '15',
              },
            },
          },
        },
      } as any,
      '/current-config',
      deps,
    );

    assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.name, '重命名 Current');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.claude.yoloMode', {
      kind: 'session',
      sessionId: claudeBinding.bridgeSessionId,
    }), 'on');
    assert.equal(resolveClaudeRuntimeConfig(store.getSession(claudeBinding.bridgeSessionId), claudeBinding).permissionMode, 'bypassPermissions');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.claude.provider', {
      kind: 'session',
      sessionId: claudeBinding.bridgeSessionId,
    }), 'pty');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.claude.model', {
      kind: 'session',
      sessionId: claudeBinding.bridgeSessionId,
    }), 'test-model');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.claude.reasoningEffort', {
      kind: 'session',
      sessionId: claudeBinding.bridgeSessionId,
    }), 'max');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.claude.idleTimeoutMinutes', {
      kind: 'session',
      sessionId: claudeBinding.bridgeSessionId,
    }), 15);
    assert.deepEqual(adapter.renamedGroups, [{ chatId: 'chat-current-card', name: '重命名 Current' }]);
    assert.equal(sent.at(-1)?.richCard?.form?.inputDefaultValue, '重命名 Current');
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, 'reply-4');
    assert.equal(getThreadTableMessageRecord(address, 'current')?.messageId, 'reply-4');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/current-runtime',
        messageId: 'incoming-current-card-runtime-codex',
        callbackData: buildCommandCallbackData('/current-runtime codex'),
        raw: {
          event: {
            context: {
              open_message_id: 'reply-4',
            },
          },
        },
      } as any,
      '/current-runtime codex',
      deps,
    );
    const codexBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(codexBinding);
    assert.equal(getSessionActiveRuntime(store.getSession(codexBinding.bridgeSessionId)), 'codex');
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, 'reply-4');
    assert.equal(sent.at(-1)?.richCard?.selects?.[0]?.selectedCallbackData, buildCommandCallbackData('/current-runtime codex'));
    assert.equal(getThreadTableMessageRecord(address, 'current')?.messageId, 'reply-4');
  });

  it('reads Claude Code JSONL for /t, /current, and /his on Claude runtime sessions', async () => {
    const store = initTestContext();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-command-claude-home-'));
    const previousHome = process.env.HOME;
    const previousClaudeHome = process.env.CODELARK_CLAUDE_HOME;
    process.env.HOME = homeDir;
    process.env.CODELARK_CLAUDE_HOME = homeDir;
    const sent: Array<{ text: string; richCard?: OutboundRichCard; attachments?: Array<{ path: string; name?: string }> }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard; attachments?: Array<{ path: string; name?: string }> }) => {
        sent.push(message);
        return { ok: true, messageId: `reply-claude-history-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-claude-history' } as const;
    const binding = router.createBinding(address, '/tmp/claude-history-cwd');
    const session = store.getSession(binding.bridgeSessionId);
    assert.ok(session);
    const claudeSessionId = 'claude-history-session';
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'claude',
        claude: { sessionId: claudeSessionId, cwd: '/tmp/claude-history-cwd', model: 'claude-sonnet-test', reasoningEffort: 'high' },
        general: { workingDirectory: '/tmp/claude-history-cwd' },
      },
    });
    createConfigService({ migrate: false, env: {} }).set(
      { kind: 'session', sessionId: session.id },
      {
        runtime: {
          claude: {
            model: 'claude-sonnet-test',
            reasoningEffort: 'high',
          },
        },
      },
    );
    const projectDir = getClaudeProjectDir('/tmp/claude-history-cwd', homeDir);
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${claudeSessionId}.jsonl`);
    fs.writeFileSync(filePath, [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        sessionId: claudeSessionId,
        cwd: '/tmp/claude-history-cwd',
        timestamp: '2026-06-02T00:00:00.000Z',
        message: { role: 'user', content: 'hello claude history' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        sessionId: claudeSessionId,
        cwd: '/tmp/claude-history-cwd',
        timestamp: '2026-06-02T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'claude history reply' }] },
      }),
    ].join('\n') + '\n', 'utf-8');

    try {
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/t',
          messageId: 'incoming-claude-thread-list',
        } as any,
        '/t',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
        },
      );

      assert.match(sent.at(-1)?.text || '', /本地会话/);
      assert.match(sent.at(-1)?.text || '', /Claude Code/);
      assert.match(sent.at(-1)?.text || '', new RegExp(claudeSessionId));

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/current',
          messageId: 'incoming-claude-current',
        } as any,
        '/current',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
        },
      );

      assert.match(sent.at(-1)?.text || '', /runtime.*Claude Code/s);
      assert.match(sent.at(-1)?.text || '', /claude_session_id.*claude-history-session/s);
      assert.match(sent.at(-1)?.text || '', /模型 .*runtime\.claude\.model.*claude-sonnet-test/s);
      assert.match(sent.at(-1)?.text || '', /Provider（运行方式） .*runtime\.claude\.provider/s);
      assert.match(sent.at(-1)?.text || '', /思考级别.*high/s);
      assert.doesNotMatch(sent.at(-1)?.text || '', /codex-thread-id|文件系统权限|网络访问|permission_mode|权限模式/s);
      assert.equal(sent.at(-1)?.richCard?.template, 'green');
      assert.deepEqual(sent.at(-1)?.richCard?.tags, ['claude', 'claude-h...ession']);
      assert.equal(sent.at(-1)?.richCard?.selects?.[0]?.id, 'cur_runtime');
      assert.equal(sent.at(-1)?.richCard?.selects?.[0]?.selectedCallbackData, buildCommandCallbackData('/current-runtime claude'));
      assert.equal(sent.at(-1)?.richCard?.form?.layout, 'two_column');
      assert.equal(sent.at(-1)?.richCard?.form?.inputElementId, 'clk_name');
      assert.equal(sent.at(-1)?.richCard?.form?.controlBar?.selects, undefined);
      assert.deepEqual(sent.at(-1)?.richCard?.form?.controlBar?.actions?.map((action) => action.text), ['刷新']);
      assert.deepEqual(sent.at(-1)?.richCard?.form?.selects?.map((select) => select.elementId), [
        'claudeMode',
        'claudeProvider',
        'claudeReasoningEffort',
      ]);
      assert.deepEqual(sent.at(-1)?.richCard?.form?.selects?.map((select) => select.formName), [
        'cld_mode',
        'cld_provider',
        'cld_rsn_eft',
      ]);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/his msg 2',
          messageId: 'incoming-claude-history-msg',
        } as any,
        '/his msg 2',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
        },
      );

      assert.match(sent.at(-1)?.text || '', /Claude Code session JSONL/);
      assert.match(sent.at(-1)?.text || '', /Claude Code/);
      assert.doesNotMatch(sent.at(-1)?.text || '', /\bCodex\b/);
      assert.doesNotMatch(sent.at(-1)?.text || '', /hello claude history/);
      assert.match(sent.at(-1)?.text || '', /claude history reply/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/his raw 2',
          messageId: 'incoming-claude-history',
        } as any,
        '/his raw 2',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
        },
      );

      assert.match(sent.at(-1)?.text || '', /Claude Code session JSONL/);
      assert.match(sent.at(-1)?.text || '', /Claude Code/);
      assert.doesNotMatch(sent.at(-1)?.text || '', /\bCodex\b/);
      assert.doesNotMatch(sent.at(-1)?.text || '', /hello claude history/);
      assert.match(sent.at(-1)?.text || '', /claude history reply/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/his json',
          messageId: 'incoming-claude-history-json',
        } as any,
        '/his json',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
        },
      );

      assert.equal(sent.at(-1)?.attachments?.[0]?.path, filePath);
      assert.equal(sent.at(-1)?.attachments?.[0]?.name, `${claudeSessionId}.jsonl`);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/t archive',
          messageId: 'incoming-claude-archive',
        } as any,
        '/t archive',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
        },
      );

      assert.match(sent.at(-1)?.text || '', /已归档本地 Claude Code 会话/);
      assert.equal(store.getSession(session.id), null);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/t',
          messageId: 'incoming-claude-thread-list-after-archive',
        } as any,
        '/t',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
        },
      );
      assert.doesNotMatch(sent.at(-1)?.text || '', new RegExp(claudeSessionId));
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousClaudeHome === undefined) {
        delete process.env.CODELARK_CLAUDE_HOME;
      } else {
        process.env.CODELARK_CLAUDE_HOME = previousClaudeHome;
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('imports an unbound Claude Code JSONL session from /t global list', async () => {
    const store = initTestContext();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-command-claude-import-home-'));
    const previousClaudeHome = process.env.CODELARK_CLAUDE_HOME;
    process.env.CODELARK_CLAUDE_HOME = homeDir;
    const cwd = '/tmp/claude-import-cwd';
    const claudeSessionId = '11111111-2222-4333-8444-555555555555';
    const projectDir = getClaudeProjectDir(cwd, homeDir);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${claudeSessionId}.jsonl`), [
      JSON.stringify({
        type: 'user',
        uuid: 'user-import-1',
        sessionId: claudeSessionId,
        cwd,
        timestamp: '2026-06-02T00:00:00.000Z',
        message: { role: 'user', content: 'hello imported claude' },
      }),
    ].join('\n') + '\n', 'utf-8');

    const sent: Array<{ text: string; richCard?: OutboundRichCard }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        sent.push(message);
        return { ok: true, messageId: `reply-claude-import-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-claude-import' } as const;

    try {
      await handleBridgeCommand(adapter, {
        address,
        text: '/t',
        messageId: 'incoming-claude-import-list',
      } as any, '/t', {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      });
      assert.match(sent.at(-1)?.text || '', /Claude1/);
      assert.match(sent.at(-1)?.text || '', new RegExp(claudeSessionId));

      await handleBridgeCommand(adapter, {
        address,
        text: `/t ${claudeSessionId}`,
        messageId: 'incoming-claude-import-switch',
      } as any, `/t ${claudeSessionId}`, {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      });

      assert.match(sent.at(-1)?.text || '', /已切换到本地 Claude Code 会话/);
      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      const session = store.getSession(binding.bridgeSessionId);
      assert.equal(getSessionActiveRuntime(session), 'claude');
      assert.equal(session?.runtime?.claude?.sessionId, claudeSessionId);
      assert.equal(session?.runtime?.claude?.cwd, cwd);
      assert.equal(getSessionWorkingDirectory(session), cwd);
    } finally {
      if (previousClaudeHome === undefined) {
        delete process.env.CODELARK_CLAUDE_HOME;
      } else {
        process.env.CODELARK_CLAUDE_HOME = previousClaudeHome;
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('switches and archives Claude Code sessions by full id outside the /t display window', async () => {
    const store = initTestContext();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-command-claude-direct-home-'));
    const previousClaudeHome = process.env.CODELARK_CLAUDE_HOME;
    process.env.CODELARK_CLAUDE_HOME = homeDir;
    const cwd = '/tmp/claude-direct-cwd';
    const targetSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const archiveSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    writeClaudeJsonlFixture({
      homeDir,
      cwd,
      sessionId: targetSessionId,
      timestamp: '2026-06-02T00:00:00.000Z',
      text: 'old direct switch claude',
    });
    writeClaudeJsonlFixture({
      homeDir,
      cwd,
      sessionId: archiveSessionId,
      timestamp: '2026-06-02T00:00:01.000Z',
      text: 'old direct archive claude',
    });
    for (let i = 0; i < 201; i += 1) {
      writeClaudeJsonlFixture({
        homeDir,
        cwd: `/tmp/claude-direct-filler-${i}`,
        sessionId: `cccccccc-cccc-4ccc-8ccc-${i.toString(16).padStart(12, '0')}`,
        timestamp: `2026-06-02T01:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        text: `newer filler ${i}`,
      });
    }

    const sent: Array<{ text: string; richCard?: OutboundRichCard }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        sent.push(message);
        return { ok: true, messageId: `reply-claude-direct-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-claude-direct-id' } as const;

    try {
      await handleBridgeCommand(adapter, {
        address,
        text: `/t ${targetSessionId}`,
        messageId: 'incoming-claude-direct-switch',
      } as any, `/t ${targetSessionId}`, {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      });

      assert.match(sent.at(-1)?.text || '', /已切换到本地 Claude Code 会话/);
      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      const session = store.getSession(binding.bridgeSessionId);
      assert.equal(getSessionActiveRuntime(session), 'claude');
      assert.equal(session?.runtime?.claude?.sessionId, targetSessionId);
      assert.equal(session?.runtime?.claude?.cwd, cwd);

      await handleBridgeCommand(adapter, {
        address,
        text: `/t archive ${archiveSessionId}`,
        messageId: 'incoming-claude-direct-archive',
      } as any, `/t archive ${archiveSessionId}`, {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      });

      assert.match(sent.at(-1)?.text || '', /已归档本地 Claude Code 会话/);
      assert.match(sent.at(-1)?.text || '', new RegExp(archiveSessionId));
      assert.equal(isArchivedClaudeSession(archiveSessionId, cwd), true);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.claude?.sessionId, targetSessionId);
    } finally {
      if (previousClaudeHome === undefined) {
        delete process.env.CODELARK_CLAUDE_HOME;
      } else {
        process.env.CODELARK_CLAUDE_HOME = previousClaudeHome;
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('renders /check health diagnostics for the current session', async () => {
    initTestContext();
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-3' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-health' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\health');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/check',
        messageId: 'incoming-3',
      } as any,
      '/check',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async (sessionId) => ({
          sessionId,
          checkedAt: null,
          runtimeStatus: 'running',
          healthStatus: 'slow_observed',
          healthReason: '近期没有新的执行进展，先标记为待观察。',
          lastProgressAt: '2026-04-13T12:00:00.000Z',
          lastProgressType: 'tool_running',
          activeToolName: 'shell_command',
          activeToolStartedAt: '2026-04-13T11:50:00.000Z',
          lastToolFinishedAt: null,
          lastStreamUiAttemptAt: null,
          lastStreamUiUpdateAt: null,
          streamUiFlushStartedAt: null,
          lastStreamUiErrorAt: null,
          lastStreamUiError: null,
          streamUiConsecutiveFailures: 0,
          codexThreadId: null,
          processProbe: null,
        }),
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const response = sent[0] || '';
    assert.match(response, /当前会话健康检查/);
    assert.doesNotMatch(response, /检查时间/);
    assert.match(response, new RegExp(binding.bridgeSessionId));
    assert.match(response, /长时运行，待观察/);
    assert.match(response, /shell_command/);
  });

  it('renders /check diagnostics for an explicit session id', async () => {
    initTestContext();
    const sent: string[] = [];
    const requestedSessionIds: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-health-explicit' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-health-explicit' } as const;
    router.createBinding(address, 'D:\\workspace\\health-current');
    const explicitSessionId = 'fbfa3ff0-6226-4f79-99b5-7704754433fb';

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/check ${explicitSessionId}`,
        messageId: 'incoming-health-explicit',
      } as any,
      `/check ${explicitSessionId}`,
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async (sessionId) => {
          requestedSessionIds.push(sessionId);
          return {
            sessionId,
            checkedAt: null,
            runtimeStatus: 'idle',
            healthStatus: 'completed',
            healthReason: '任务已完成。',
            lastProgressAt: '2026-04-13T12:00:00.000Z',
            lastProgressType: 'task_completed',
            activeToolName: null,
            activeToolStartedAt: null,
            lastToolFinishedAt: null,
            lastStreamUiAttemptAt: null,
            lastStreamUiUpdateAt: null,
            streamUiFlushStartedAt: null,
            lastStreamUiErrorAt: null,
            lastStreamUiError: null,
            streamUiConsecutiveFailures: 0,
            codexThreadId: null,
            processProbe: null,
          };
        },
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.deepEqual(requestedSessionIds, [explicitSessionId]);
    const response = sent[0] || '';
    assert.match(response, /指定会话健康检查/);
    assert.match(response, new RegExp(explicitSessionId));
    assert.doesNotMatch(response, /检查时间/);
  });

  it('renders /status as global bridge status without creating a session or binding for an unbound chat', async () => {
    const store = initTestContext();
    fs.writeFileSync(HOME_CONFIG_TOML_PATH, `
schema_version = 2

[[channels]]
id = "feishu-status"
alias = "飞书状态通道"
provider = "feishu"
enabled = true
`);
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-status-1' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-status-draft' } as const;

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/status',
        messageId: 'incoming-status-1',
      } as any,
      '/status',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const response = sent[0] || '';
    assert.match(response, /全局状态/);
    assert.match(response, /Bridge/);
    assert.match(response, /Bridge PID/);
    assert.match(response, /feishu-status/);
    assert.match(response, /alias=飞书状态通道/);
    assert.match(response, /当前聊天.*未绑定/s);
    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    assert.equal(store.listSessions().length, 0);
    assert.deepEqual(readAuditSummaries(), []);
  });

  it('renders /check without creating a session or binding for an unbound chat', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    let diagnoseCalls = 0;
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-health-unbound' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-health-unbound' } as const;

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/check',
        messageId: 'incoming-health-unbound',
      } as any,
      '/check',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => {
          diagnoseCalls += 1;
          return null;
        },
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const response = sent[0] || '';
    assert.match(response, /还没有绑定会话/);
    assert.equal(diagnoseCalls, 0);
    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    assert.equal(store.listSessions().length, 0);
    assert.deepEqual(readAuditSummaries(), []);
  });

  it('creates a new IM session with /new and points the binding at the requested directory', async () => {
    const store = initTestContext();
    const sent: any[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    const address = { channelType: 'feishu', chatId: 'chat-new-command' } as const;
    const commonWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-new-common-'));
    const apiWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-new-api-'));
    const namedWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-new-named-'));

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/new common-flow ${commonWorkDir}`,
        messageId: 'incoming-new-1',
      } as any,
      `/new common-flow ${commonWorkDir}`,
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    assert.equal(adapter.createdGroups[0]?.requestedName, 'common-flow');
    assert.equal(adapter.createdGroups[0]?.name, '[TestBot]common-flow');
    const groupAddress = { channelType: 'feishu', chatId: adapter.createdGroups[0].chatId } as const;
    const binding = store.getChannelChat(groupAddress.channelType, groupAddress.chatId);
    assert.ok(binding);
    assert.equal(getSessionWorkingDirectory(store.getSession(binding!.bridgeSessionId)), commonWorkDir);
    assert.equal(store.getSession(binding!.bridgeSessionId)?.name, '[TestBot]common-flow');
    assert.equal(sent[0]?.address.chatId, groupAddress.chatId);
    assert.equal(sent[0]?.replyToMessageId, undefined);
    assert.match(sent[0]?.text || '', /已创建群聊会话/);
    assert.match(sent[0]?.text || '', /common-flow/);
    assert.doesNotMatch(sent[0]?.text || '', /旧任务在运行/);
    assert.equal(sent[1]?.address.chatId, groupAddress.chatId);
    assert.equal(sent[1]?.replyToMessageId, undefined);
    assert.match(sent[1]?.text || '', /当前会话/);
    assert.equal(sent[1]?.richCard?.updateKey, 'thread-card:current:feishu:created-group-1');

    await handleBridgeCommand(
      adapter,
      {
        address: groupAddress,
        text: '/new set',
        messageId: 'incoming-new-name-only',
      } as any,
      '/new set',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(adapter.createdGroups[1]?.requestedName, 'set');
    const namedOnlyBinding = store.getChannelChat('feishu', adapter.createdGroups[1].chatId);
    assert.ok(namedOnlyBinding);
    assert.equal(getSessionWorkingDirectory(store.getSession(namedOnlyBinding!.bridgeSessionId)), commonWorkDir);
    assert.equal(store.getSession(namedOnlyBinding!.bridgeSessionId)?.name, '[TestBot]set');
    assert.equal(sent.at(-1)?.address.chatId, adapter.createdGroups[1].chatId);
    assert.equal(sent.at(-1)?.replyToMessageId, undefined);
    assert.match(sent.at(-2)?.text || '', /已创建群聊会话/);
    assert.match(sent.at(-1)?.text || '', /标题.*\[TestBot\]set/s);
    assert.match(sent.at(-1)?.text || '', /当前会话/);

    await handleBridgeCommand(
      adapter,
      {
        address: groupAddress,
        text: `/new project/api ${apiWorkDir}`,
        messageId: 'incoming-new-slash-name',
      } as any,
      `/new project/api ${apiWorkDir}`,
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(adapter.createdGroups[2]?.requestedName, 'project/api');
    const slashNameBinding = store.getChannelChat('feishu', adapter.createdGroups[2].chatId);
    assert.ok(slashNameBinding);
    assert.equal(getSessionWorkingDirectory(store.getSession(slashNameBinding!.bridgeSessionId)), apiWorkDir);
    assert.equal(sent.at(-1)?.address.chatId, adapter.createdGroups[2].chatId);

    await handleBridgeCommand(
      adapter,
      {
        address: groupAddress,
        text: `/new RenamedSession ${namedWorkDir}`,
        messageId: 'incoming-new-2',
      } as any,
      `/new RenamedSession ${namedWorkDir}`,
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const renamedBinding = store.getChannelChat('feishu', adapter.createdGroups[3].chatId);
    assert.ok(renamedBinding);
    assert.equal(getSessionWorkingDirectory(store.getSession(renamedBinding!.bridgeSessionId)), namedWorkDir);
    assert.equal(store.getSession(renamedBinding!.bridgeSessionId)?.name, '[TestBot]RenamedSession');
    assert.equal(sent.at(-1)?.address.chatId, adapter.createdGroups[3].chatId);
    assert.match(sent.at(-1)?.text || '', /标题.*\[TestBot\]RenamedSession/s);
    assert.match(sent.at(-2)?.text || '', /\/new \[name\] \[path\]/);

    await handleBridgeCommand(
      adapter,
      {
        address: groupAddress,
        text: '/new a b c',
        messageId: 'incoming-new-too-many-args',
      } as any,
      '/new a b c',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );
    assert.match(sent.at(-1)?.text || '', /参数过多/);
    assert.equal(sent.at(-1)?.address.chatId, groupAddress.chatId);
  });

  it('opens the new-session form for bare /new and allows name-only creation from a draft session directory', async () => {
    const store = initTestContext();
    const sent: any[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    const address = { channelType: 'feishu', chatId: 'chat-new-command-form' } as const;
    const unboundAddress = { channelType: 'feishu', chatId: 'chat-new-command-form-unbound' } as const;

    await handleBridgeCommand(
      adapter,
      {
        address: unboundAddress,
        text: '/new',
        messageId: 'incoming-new-form-unbound',
      } as any,
      '/new',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(adapter.createdGroups.length, 0);
    assert.equal(sent.at(-1)?.richCard?.title, '创建群聊会话');
    assert.equal(sent.at(-1)?.richCard?.form?.extraInputs?.[0]?.defaultValue, DEFAULT_WORKSPACE_ROOT);

    await handleBridgeCommand(
      adapter,
      {
        address: unboundAddress,
        text: '/new unbound-child',
        messageId: 'incoming-new-from-unbound',
      } as any,
      '/new unbound-child',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(adapter.createdGroups.at(-1)?.requestedName, 'unbound-child');
    const unboundCreatedBinding = store.getChannelChat('feishu', adapter.createdGroups.at(-1)?.chatId || '');
    assert.ok(unboundCreatedBinding);
    assert.equal(sent.at(-1)?.address.chatId, adapter.createdGroups.at(-1)?.chatId);
    assert.match(sent.at(-1)?.text || '', /当前会话/);
    assert.equal(
      getSessionWorkingDirectory(store.getSession(unboundCreatedBinding!.bridgeSessionId)),
      path.resolve(DEFAULT_WORKSPACE_ROOT),
    );

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/thread 0',
        messageId: 'incoming-new-form-draft',
      } as any,
      '/thread 0',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );
    const draftBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(draftBinding);
    const draftSession = store.getSession(draftBinding!.bridgeSessionId);
    const draftWorkDir = getSessionWorkingDirectory(draftSession);
    assert.equal(draftSession?.session_type, 'normal');
    assert.ok(draftWorkDir);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/new',
        messageId: 'incoming-new-form',
      } as any,
      '/new',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(adapter.createdGroups.length, 1);
    assert.match(sent.at(-1)?.text || '', /创建群聊会话/);
    assert.equal(sent.at(-1)?.richCard?.title, '创建群聊会话');
    assert.equal(sent.at(-1)?.richCard?.form?.inputElementId, 'clk_input');
    assert.equal(sent.at(-1)?.richCard?.form?.extraInputs?.[0]?.elementId, 'clk_path');
    assert.equal(sent.at(-1)?.richCard?.form?.extraInputs?.[0]?.defaultValue, draftWorkDir);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/new draft-child',
        messageId: 'incoming-new-from-draft',
      } as any,
      '/new draft-child',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(adapter.createdGroups.at(-1)?.requestedName, 'draft-child');
    const createdBinding = store.getChannelChat('feishu', adapter.createdGroups.at(-1)?.chatId || '');
    assert.ok(createdBinding);
    assert.equal(getSessionWorkingDirectory(store.getSession(createdBinding!.bridgeSessionId)), draftWorkDir);
    assert.equal(sent.at(-1)?.address.chatId, adapter.createdGroups.at(-1)?.chatId);
    assert.match(sent.at(-2)?.text || '', /已创建群聊会话/);
    assert.match(sent.at(-1)?.text || '', /当前会话/);
  });

  it('creates a group-backed cloud document chat with /new from a document comment', async () => {
    const store = initTestContext();
    const sent: any[] = [];
    const commentReplies: string[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    adapter.sendCloudDocumentReply = async (_target: unknown, text: string) => {
      commentReplies.push(text);
      return { ok: true, messageId: `doc-reply-${commentReplies.length}` };
    };
    const address = {
      channelType: 'feishu',
      chatId: 'doc:docx:doc-token',
      userId: 'ou_user',
      cloudDocument: {
        provider: 'feishu' as const,
        fileToken: 'doc-token',
        fileType: 'docx' as const,
        commentId: 'comment-1',
        replyId: 'reply-1',
      },
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/new 需求评审',
        messageId: 'incoming-doc-new',
      } as any,
      '/new 需求评审',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(adapter.createdGroups[0]?.requestedName, '需求评审');
    assert.equal(adapter.createdGroups[0]?.createAs, 'user');
    const groupChatId = adapter.createdGroups[0]?.chatId;
    const binding = store.getChannelChat('feishu', groupChatId);
    assert.ok(binding);
    assert.deepEqual(binding!.cloudDocumentChat, {
      provider: 'feishu',
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
    });
    assert.equal(sent[0]?.address.chatId, groupChatId);
    assert.match(sent[0]?.text || '', /已绑定为云文档聊天入口/);
    assert.equal(sent[1]?.address.chatId, groupChatId);
    assert.match(sent[1]?.text || '', /当前会话/);
    assert.equal(commentReplies.length, 1);
    assert.match(commentReplies[0], /已开启云文档群聊模式/);
    assert.match(commentReplies[0], new RegExp(groupChatId));
  });

  it('updates the current session working directory with /cd and expands home paths', async () => {
    const store = initTestContext();
    const sent: any[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    const address = { channelType: 'feishu', chatId: 'chat-cd-command' } as const;
    const initialWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-cd-initial-'));
    const childWorkDir = path.join(initialWorkDir, 'child');
    fs.mkdirSync(childWorkDir);
    const session = store.createSession('cd-session', 'test-model', undefined, initialWorkDir);
    store.upsertChannelChat({
      channelType: address.channelType,
      chatId: address.chatId,
      bridgeSessionId: session.id,
    });

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/cd child',
        messageId: 'incoming-cd-child',
      } as any,
      '/cd child',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(getSessionWorkingDirectory(store.getSession(session.id)), childWorkDir);
    assert.equal(store.getSession(session.id)?.runtime?.general?.workingDirectory, undefined);
    assert.equal(
      createConfigService({ migrate: false, env: {} }).get('session.workspace', {
        kind: 'session',
        sessionId: session.id,
      }),
      childWorkDir,
    );
    assert.match(sent.at(-1)?.text || '', /已切换工作目录/);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/cd ~',
        messageId: 'incoming-cd-home',
      } as any,
      '/cd ~',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(getSessionWorkingDirectory(store.getSession(session.id)), os.homedir());
    assert.equal(store.getSession(session.id)?.runtime?.general?.workingDirectory, undefined);
    assert.equal(
      createConfigService({ migrate: false, env: {} }).get('session.workspace', {
        kind: 'session',
        sessionId: session.id,
      }),
      os.homedir(),
    );
  });

  it('switches the current chat between separate runtime BridgeSessions', async () => {
    const store = initTestContext();
    const sent: any[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    const address = { channelType: 'feishu', chatId: 'chat-runtime-command' } as const;
    const session = store.createSession('runtime-session', 'test-model');
    createConfigService({ migrate: false, env: {} }).set(
      { kind: 'session', sessionId: session.id },
      { runtime: { codex: { provider: 'pty' } } },
    );
    store.upsertChannelChat({
      channelType: address.channelType,
      chatId: address.chatId,
      bridgeSessionId: session.id,
    });

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/runtime claude',
        messageId: 'incoming-runtime-claude',
      } as any,
      '/runtime claude',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const claudeBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(claudeBinding);
    assert.notEqual(claudeBinding.bridgeSessionId, session.id);
    const claudeSession = store.getSession(claudeBinding.bridgeSessionId);
    assert.equal(getSessionActiveRuntime(claudeSession), 'claude');
    assert.equal(claudeSession?.runtime?.codex, undefined);
    assert.equal(claudeBinding.runtimeBridgeSessionIds?.codex, session.id);
    assert.equal(claudeBinding.runtimeBridgeSessionIds?.claude, claudeSession?.id);
    assert.equal(getSessionActiveRuntime(store.getSession(session.id)), undefined);
    assert.equal(store.getSession(session.id)?.runtime?.codex?.provider, undefined);
    assert.equal(
      createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider', {
        kind: 'session',
        sessionId: session.id,
      }),
      'pty',
    );
    assert.match(sent.at(-1)?.text || '', /Runtime.*claude/s);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/runtime codex',
        messageId: 'incoming-runtime-codex',
      } as any,
      '/runtime codex',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const codexBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.equal(codexBinding?.bridgeSessionId, session.id);
    assert.equal(getSessionActiveRuntime(store.getSession(session.id)), undefined);
    assert.equal(store.getSession(session.id)?.runtime?.codex?.provider, undefined);
    assert.equal(codexBinding?.runtimeBridgeSessionIds?.claude, claudeSession?.id);
  });

  it('routes the next normal message through Claude after /runtime claude', async () => {
    const store = initTestContext();
    const sent: any[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    const address = { channelType: 'feishu', chatId: 'chat-runtime-next-message' } as const;
    const codexSession = store.createSession('runtime-route-session', 'test-model');
    store.updateSession(codexSession.id, { runtime: { codex: { threadId: 'codex-thread-before-switch' } } });
    createConfigService({ migrate: false, env: {} }).set(
      { kind: 'session', sessionId: codexSession.id },
      { runtime: { codex: { provider: 'tmux' } } },
    );
    store.upsertChannelChat({
      channelType: address.channelType,
      chatId: address.chatId,
      bridgeSessionId: codexSession.id,
    });

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/runtime claude',
        messageId: 'incoming-runtime-claude-route',
      } as any,
      '/runtime claude',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const claudeBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(claudeBinding);
    const calls: StreamChatParams[] = [];
    const llm: LLMProvider = {
      streamChat(params: StreamChatParams): ReadableStream<string> {
        calls.push(params);
        return new ReadableStream({
          start(controller) {
            controller.enqueue(sseEvent('text', 'hello from claude'));
            controller.enqueue(sseEvent('result', { session_id: 'claude-session-after-switch' }));
            controller.close();
          },
        });
      },
    };

    const result = await processMessage(
      claudeBinding,
      'hi',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        store,
        llm,
        consumeSseEvents,
        normalizeSandboxMode,
        normalizeReasoningEffort,
      },
    );

    assert.equal(result.responseText, 'hello from claude');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.runtime, 'claude');
    assert.equal(calls[0]?.codexThreadId, undefined);
    assert.equal(calls[0]?.claudeSessionId, undefined);
    const updatedClaudeSession = store.getSession(claudeBinding.bridgeSessionId);
    assert.equal(updatedClaudeSession?.runtime?.claude?.sessionId, 'claude-session-after-switch');
    assert.equal(updatedClaudeSession?.runtime?.codex, undefined);
    assert.equal(store.getSession(codexSession.id)?.runtime?.codex?.threadId, 'codex-thread-before-switch');
  });

  it('rejects runtime and provider switches while the current conversation is running', async () => {
    const store = initTestContext();
    const sent: any[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    const address = { channelType: 'feishu', chatId: 'chat-runtime-running-guard' } as const;
    const session = store.createSession('running-session', 'test-model');
    store.updateSession(session.id, {
      runtime_status: 'running',
      health_status: 'running_active',
    });
    createConfigService({ migrate: false, env: {} }).set(
      { kind: 'session', sessionId: session.id },
      { runtime: { codex: { provider: 'sdk' } } },
    );
    store.upsertChannelChat({
      channelType: address.channelType,
      chatId: address.chatId,
      bridgeSessionId: session.id,
    });

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/runtime claude',
        messageId: 'incoming-runtime-running',
      } as any,
      '/runtime claude',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, session.id);
    assert.match(sent.at(-1)?.text || '', /请先停止当前对话/);
    assert.match(sent.at(-1)?.text || '', /\/stop/);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/p tmux',
        messageId: 'incoming-provider-running',
      } as any,
      '/p tmux',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
        reconcileMirrorSubscriptions: async () => {},
        bootstrapCodexThread: async () => {
          throw new Error('bootstrap should not run while provider switch is blocked');
        },
      },
    );

    assert.equal(store.getSession(session.id)?.runtime?.codex?.provider, undefined);
    assert.match(sent.at(-1)?.text || '', /请先停止当前对话/);
    assert.match(sent.at(-1)?.text || '', /\/p tmux/);
  });

  it('does not persist tmux provider state when the launched Codex tmux exits immediately', async () => {
    const previousEnv = {
      PATH: process.env.PATH,
      TMUX_FAKE_LOG: process.env.TMUX_FAKE_LOG,
      TMUX_FAKE_READY_AFTER_CAPTURES: process.env.TMUX_FAKE_READY_AFTER_CAPTURES,
      TMUX_FAKE_LAUNCH_STDERR: process.env.TMUX_FAKE_LAUNCH_STDERR,
    };
    const fakeTmux = installFakeTmux();
    const previousConsoleError = console.error;
    const previousConsoleWarn = console.warn;
    const errorLogs: any[][] = [];
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${previousEnv.PATH || ''}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_READY_AFTER_CAPTURES = '999';
    process.env.TMUX_FAKE_LAUNCH_STDERR = 'bash: codex: command not found\n[codelark] process exited with status 127\n';
    console.error = (...args: any[]) => { errorLogs.push(args); };
    console.warn = () => {};

    try {
      const store = initTestContext({ settings: { bridge_claude_provider: 'pty' } });
      const sent: any[] = [];
      const adapter = createGroupCapableAdapter({ sent });
      const address = { channelType: 'feishu', chatId: 'chat-provider-tmux-not-ready' } as const;
      const session = store.createSession('tmux-not-ready-session', 'test-model', undefined, os.tmpdir(), 'normal');
      store.upsertChannelChat({
        channelType: address.channelType,
        chatId: address.chatId,
        bridgeSessionId: session.id,
      });

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/p tmux',
          messageId: 'incoming-provider-tmux-not-ready',
        } as any,
        '/p tmux',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
          reconcileMirrorSubscriptions: async () => {},
          bootstrapCodexThread: async () => 'not-ready-thread',
        },
      );

      const responseText = sent.at(-1)?.text || '';
      assert.match(responseText, /Codex tmux 启动失败/);
      assert.match(responseText, /Provider.*未切换/);
      assert.match(responseText, /tmux session.*codex_not-ready-thread/);
      assert.match(responseText, /失败原因.*tmux session disappeared after new-session/);
      assert.match(responseText, /原进程输出\*\*\s*```text[\s\S]*codex: command not found/);
      assert.match(responseText, /原进程输出\*\*\s*```text[\s\S]*status 127/);
      assert.match(responseText, /诊断命令\*\*\s*```bash[\s\S]*tmux new-session/);
      assert.doesNotMatch(responseText, /launch log/);
      assert.doesNotMatch(responseText, /清理命令/);
      assert.doesNotMatch(responseText, /```bash[\s\S]*kill-session/);
      assert.match(responseText, /没有写入 `runtime.codex.provider=tmux`/);
      assert.equal(
        errorLogs.some((args) => args[0] === '[codex-tmux-runtime] Codex resume tmux launch failed:'
          && args[1]?.tmux_session === 'codex_not-ready-thread'
          && /tmux session disappeared/.test(args[1]?.reason || '')
          && /codex: command not found/.test(args[1]?.launch_output_excerpt || '')),
        true,
      );
      assert.notEqual(
        createConfigService({ migrate: false, env: {} }).resolve('runtime.codex.provider', {
          kind: 'session',
          sessionId: session.id,
        }).source,
        'session',
      );
      assert.equal(getSessionCodexProvider(store.getSession(session.id)), undefined);
      assert.equal(store.getSession(session.id)?.runtime?.general?.tmuxSessionName, undefined);
      const tmuxLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(tmuxLog, /new-session -d -s codex_not-ready-thread/);
      assert.match(tmuxLog, /kill-session -t codex_not-ready-thread/);
    } finally {
      process.env.PATH = previousEnv.PATH;
      if (previousEnv.TMUX_FAKE_LOG === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = previousEnv.TMUX_FAKE_LOG;
      if (previousEnv.TMUX_FAKE_READY_AFTER_CAPTURES === undefined) delete process.env.TMUX_FAKE_READY_AFTER_CAPTURES;
      else process.env.TMUX_FAKE_READY_AFTER_CAPTURES = previousEnv.TMUX_FAKE_READY_AFTER_CAPTURES;
      if (previousEnv.TMUX_FAKE_LAUNCH_STDERR === undefined) delete process.env.TMUX_FAKE_LAUNCH_STDERR;
      else process.env.TMUX_FAKE_LAUNCH_STDERR = previousEnv.TMUX_FAKE_LAUNCH_STDERR;
      console.error = previousConsoleError;
      console.warn = previousConsoleWarn;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('omits manual tmux-new guidance when a Codex provider tmux session is missing', async () => {
    const store = initTestContext({ settings: { bridge_claude_provider: 'pty' } });
    const fakeTmux = installFakeTmux();
    const previousEnv = {
      PATH: process.env.PATH,
      TMUX_FAKE_LOG: process.env.TMUX_FAKE_LOG,
    };
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${previousEnv.PATH || ''}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;

    try {
      const sent: any[] = [];
      const adapter = createGroupCapableAdapter({ sent });
      const address = { channelType: 'feishu', chatId: 'chat-provider-tmux-missing-screen' } as const;
      const session = store.createSession('tmux-missing-session', 'test-model', undefined, os.tmpdir(), 'normal');
      const tmuxSessionName = 'codex_missing-thread';
      store.updateSession(session.id, {
        runtime: {
          general: { tmuxSessionName },
          codex: { threadId: 'missing-thread' },
        },
      });
      createConfigService({ migrate: false, env: {} }).set(
        { kind: 'session', sessionId: session.id },
        { runtime: { codex: { provider: 'tmux' } } },
      );
      store.upsertChannelChat({
        channelType: address.channelType,
        chatId: address.chatId,
        bridgeSessionId: session.id,
      });

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-screen',
          messageId: 'incoming-provider-tmux-missing-screen',
        } as any,
        '/tmux-screen',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
          reconcileMirrorSubscriptions: async () => {},
        },
      );

      const responseText = sent.at(-1)?.text || '';
      assert.match(responseText, new RegExp(`tmux session 不存在：${tmuxSessionName}`));
      assert.match(responseText, /请先发送 `\/provider tmux` 重新启动 Codex TUI。/);
      assert.doesNotMatch(responseText, /\/tmux-new/);
      assert.doesNotMatch(responseText, /手动创建/);
    } finally {
      process.env.PATH = previousEnv.PATH;
      if (previousEnv.TMUX_FAKE_LOG === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = previousEnv.TMUX_FAKE_LOG;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('starts tmux provider with only a reaction and final text', async () => {
    const previousEnv = {
      PATH: process.env.PATH,
      TMUX_FAKE_LOG: process.env.TMUX_FAKE_LOG,
    };
    const fakeTmux = installFakeTmux();
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${previousEnv.PATH || ''}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;

    try {
      const store = initTestContext({ settings: { bridge_claude_provider: 'pty' } });
      const sent: any[] = [];
      const cardTexts: Array<{ text: string; streamKey?: string }> = [];
      const cardStatuses: Array<{ text: string; streamKey?: string }> = [];
      const cardMetadata: Array<{ title?: string; streamKey?: string }> = [];
      const cardEnds: Array<{ status: string; text: string; streamKey?: string }> = [];
      const reactions: Array<{ action: 'add' | 'remove'; messageId: string; emojiType?: string; reactionId?: string }> = [];
      const adapter: any = {
        ...createGroupCapableAdapter({ sent }),
        supportsStructuredStreamingUi: () => true,
        onMessageStart: (_chatId: string, _streamKey?: string) => {},
        onStreamText: (_chatId: string, text: string, streamKey?: string) => {
          cardTexts.push({ text, streamKey });
        },
        onStreamStatus: (_chatId: string, text: string, streamKey?: string) => {
          cardStatuses.push({ text, streamKey });
        },
        onStreamMetadata: (_chatId: string, metadata: { title?: string }, streamKey?: string) => {
          cardMetadata.push({ title: metadata.title, streamKey });
        },
        onStreamEnd: async (_chatId: string, status: string, text: string, streamKey?: string) => {
          cardEnds.push({ status, text, streamKey });
          return true;
        },
        addMessageReaction: async (messageId: string, emojiType: string) => {
          reactions.push({ action: 'add', messageId, emojiType, reactionId: 'reaction-typing' });
          return 'reaction-typing';
        },
        removeMessageReaction: async (messageId: string, reactionId: string, emojiType?: string) => {
          reactions.push({ action: 'remove', messageId, emojiType, reactionId });
        },
      };
      const address = { channelType: 'feishu', chatId: 'chat-provider-tmux-progress' } as const;
      const session = store.createSession('tmux-progress-session', 'test-model', undefined, os.tmpdir(), 'normal');
      store.upsertChannelChat({
        channelType: address.channelType,
        chatId: address.chatId,
        bridgeSessionId: session.id,
      });

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/p tmux',
          messageId: 'incoming-provider-tmux-progress',
        } as any,
        '/p tmux',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
          reconcileMirrorSubscriptions: async () => {},
          bootstrapCodexThread: async () => 'existing',
        },
      );

      assert.deepEqual(reactions.map((reaction) => reaction.action), ['add', 'remove']);
      assert.equal(reactions[0]?.emojiType, 'Typing');
      assert.equal(reactions[1]?.reactionId, 'reaction-typing');
      assert.deepEqual(cardTexts, []);
      assert.deepEqual(cardStatuses, []);
      assert.deepEqual(cardMetadata, []);
      assert.deepEqual(cardEnds, []);
      assert.equal(sent.length, 1);
      assert.match(sent.at(-1)?.text || '', /已切换 Codex Provider/);
      assert.match(sent.at(-1)?.text || '', /\/tmux-screen/);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider', {
          kind: 'session',
          sessionId: session.id,
        }),
        'tmux',
      );
      assert.equal(store.getSession(session.id)?.runtime?.codex?.provider, undefined);
      assert.equal(getSessionCodexProvider(store.getSession(session.id)), 'tmux');
      assert.equal(resolveEffectiveCodexProvider(store.getSession(session.id)), 'tmux');
      const tmuxLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(tmuxLog, /has-session -t codex_existing/);
      assert.match(tmuxLog, /kill-session -t codex_existing/);
      assert.match(tmuxLog, /new-session -d -s codex_existing/);
    } finally {
      process.env.PATH = previousEnv.PATH;
      if (previousEnv.TMUX_FAKE_LOG === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = previousEnv.TMUX_FAKE_LOG;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('recreates an existing Claude tmux session on /p tmux', async () => {
    const previousEnv = {
      PATH: process.env.PATH,
      TMUX_FAKE_LOG: process.env.TMUX_FAKE_LOG,
      TMUX_FAKE_EXISTING_SESSIONS: process.env.TMUX_FAKE_EXISTING_SESSIONS,
    };
    const fakeTmux = installFakeTmux();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-provider-tmux-'));
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${previousEnv.PATH || ''}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;

    try {
      const store = initTestContext({ settings: { bridge_claude_provider: 'sdk' } });
      const sent: any[] = [];
      const adapter = createGroupCapableAdapter({ sent });
      const address = { channelType: 'feishu', chatId: 'chat-claude-provider-tmux' } as const;
      const session = store.createSession('existing', 'test-model', undefined, workDir, 'normal');
      store.updateSession(session.id, { runtime: { activeRuntime: 'claude' } });
      const tmuxSessionName = `claude_${session.id}`;
      process.env.TMUX_FAKE_EXISTING_SESSIONS = tmuxSessionName;
      store.upsertChannelChat({
        channelType: address.channelType,
        chatId: address.chatId,
        bridgeSessionId: session.id,
      });

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/p tmux',
          messageId: 'incoming-claude-provider-tmux',
        } as any,
        '/p tmux',
        {
          getActiveTask: () => undefined,
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
          reconcileMirrorSubscriptions: async () => {},
        },
      );

      assert.match(sent.at(-1)?.text || '', /已切换 Claude Provider/);
      assert.match(sent.at(-1)?.text || '', /同名 tmux session 已存在/);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.claude.provider', {
          kind: 'session',
          sessionId: session.id,
        }),
        'tmux',
      );
      assert.equal(getSessionRuntimeTmuxSessionName(store.getSession(session.id)), tmuxSessionName);
      const tmuxLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(tmuxLog, new RegExp(`has-session -t ${tmuxSessionName}`));
      assert.match(tmuxLog, new RegExp(`kill-session -t ${tmuxSessionName}`));
      assert.match(tmuxLog, new RegExp(`new-session -d -s ${tmuxSessionName}`));
    } finally {
      process.env.PATH = previousEnv.PATH;
      if (previousEnv.TMUX_FAKE_LOG === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = previousEnv.TMUX_FAKE_LOG;
      if (previousEnv.TMUX_FAKE_EXISTING_SESSIONS === undefined) delete process.env.TMUX_FAKE_EXISTING_SESSIONS;
      else process.env.TMUX_FAKE_EXISTING_SESSIONS = previousEnv.TMUX_FAKE_EXISTING_SESSIONS;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('executes the Claude Code executable after /p tmux, /new, and /runtime claude', async () => {
    const previousEnv = {
      PATH: process.env.PATH,
      CLAUDE_FAKE_LOG: process.env.CLAUDE_FAKE_LOG,
      TMUX_FAKE_LOG: process.env.TMUX_FAKE_LOG,
      CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS,
      CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS,
      CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS: process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS,
    };
    const fakeTmux = installFakeTmux();
    const fakeClaude = installFakeClaudeExecutable();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-route-'));
    _testOnlyClaudePty.clear();
    process.env.PATH = `${fakeClaude.binDir}${path.delimiter}${fakeTmux.binDir}${path.delimiter}${previousEnv.PATH || ''}`;
    process.env.CLAUDE_FAKE_LOG = fakeClaude.logPath;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS = '250';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS = '1500';

    try {
      const store = initTestContext({ settings: { bridge_claude_provider: 'pty' } });
      createConfigService({ migrate: false, env: {} }).set({ kind: 'home' }, {
        runtime: { claude: { provider: 'pty' } },
      });
      const routingProvider = new CodexRoutingProvider(undefined, 'tmux');
      initBridgeContext({
        store,
        llm: routingProvider,
        permissions: { resolvePendingPermission: () => false },
        lifecycle: {},
      });
      const sent: any[] = [];
      const adapter = createGroupCapableAdapter({ sent });
      const address = { channelType: 'feishu', chatId: 'chat-runtime-e2e-source', chatKind: 'group' as const } as const;
      const session = store.createSession('runtime-e2e-source', 'test-model', undefined, workDir, 'normal');
      store.upsertChannelChat({
        channelType: address.channelType,
        chatId: address.chatId,
        bridgeSessionId: session.id,
        chatKind: 'group',
      });
      const deps = {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
        reconcileMirrorSubscriptions: async () => {},
        bootstrapCodexThread: async () => 'codex-thread-from-bootstrap',
      };

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/p tmux',
          messageId: 'incoming-provider-tmux',
        } as any,
        '/p tmux',
        deps,
      );
      assert.equal(store.getSession(session.id)?.runtime?.codex?.provider, undefined);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider', {
          kind: 'session',
          sessionId: session.id,
        }),
        'tmux',
      );
      assert.match(fs.readFileSync(fakeTmux.logPath, 'utf-8'), /new-session|send-keys/s);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/new claude-e2e',
          messageId: 'incoming-new-claude-e2e',
        } as any,
        '/new claude-e2e',
        deps,
      );
      assert.equal(adapter.createdGroups.length, 1);
      const createdAddress = {
        ...address,
        chatId: adapter.createdGroups[0].chatId,
        displayName: adapter.createdGroups[0].name,
      };
      const createdBinding = store.getChannelChat(createdAddress.channelType, createdAddress.chatId);
      assert.ok(createdBinding);
      assert.equal(store.getSession(createdBinding.bridgeSessionId)?.runtime?.codex?.provider, undefined);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider', {
          kind: 'session',
          sessionId: createdBinding.bridgeSessionId,
        }),
        'tmux',
      );

      await handleBridgeCommand(
        adapter,
        {
          address: createdAddress,
          text: '/runtime claude',
          messageId: 'incoming-runtime-claude-e2e',
        } as any,
        '/runtime claude',
        deps,
      );
      const claudeBinding = store.getChannelChat(createdAddress.channelType, createdAddress.chatId);
      assert.ok(claudeBinding);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.activeRuntime, 'claude');

      const result = await processMessage(
        claudeBinding,
        'hello executable',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          store,
          llm: routingProvider,
          consumeSseEvents,
          normalizeSandboxMode,
          normalizeReasoningEffort,
        },
      );

      assert.match(result.responseText, /FAKE_CLAUDE_RESPONSE:hello executable/);
      const claudeLog = fs.readFileSync(fakeClaude.logPath, 'utf-8');
      assert.match(claudeLog, /argv: <.*claude>/);
      assert.doesNotMatch(claudeLog, /\bccr\b|\bcodex\b/);
      assert.match(claudeLog, /prompt:hello executable/);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.codex, undefined);
      assert.equal(store.getSession(createdBinding.bridgeSessionId)?.runtime?.codex?.provider, undefined);
    } finally {
      _testOnlyClaudePty.clear();
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
      fs.rmSync(fakeClaude.binDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('executes the Claude Code executable after default /new and /runtime claude', async () => {
    const previousEnv = {
      PATH: process.env.PATH,
      CLAUDE_FAKE_LOG: process.env.CLAUDE_FAKE_LOG,
      CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS,
      CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS,
      CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS: process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS,
    };
    const fakeClaude = installFakeClaudeExecutable();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-default-new-'));
    _testOnlyClaudePty.clear();
    process.env.PATH = `${fakeClaude.binDir}${path.delimiter}${previousEnv.PATH || ''}`;
    process.env.CLAUDE_FAKE_LOG = fakeClaude.logPath;
    process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS = '250';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS = '1500';

    try {
      const store = initTestContext({ settings: { bridge_claude_provider: 'pty' } });
      createConfigService({ migrate: false, env: {} }).set({ kind: 'home' }, {
        runtime: { claude: { provider: 'pty' } },
      });
      const routingProvider = new CodexRoutingProvider();
      initBridgeContext({
        store,
        llm: routingProvider,
        permissions: { resolvePendingPermission: () => false },
        lifecycle: {},
      });
      const sent: any[] = [];
      const adapter = createGroupCapableAdapter({ sent });
      const address = { channelType: 'feishu', chatId: 'chat-runtime-default-source', chatKind: 'group' as const } as const;
      const session = store.createSession('runtime-default-source', 'test-model', undefined, workDir, 'normal');
      store.upsertChannelChat({
        channelType: address.channelType,
        chatId: address.chatId,
        bridgeSessionId: session.id,
        chatKind: 'group',
      });
      const deps = {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
        reconcileMirrorSubscriptions: async () => {},
      };

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/new claude-default-e2e',
          messageId: 'incoming-new-claude-default-e2e',
        } as any,
        '/new claude-default-e2e',
        deps,
      );
      assert.equal(adapter.createdGroups.length, 1);
      const createdAddress = {
        ...address,
        chatId: adapter.createdGroups[0].chatId,
        displayName: adapter.createdGroups[0].name,
      };
      const createdBinding = store.getChannelChat(createdAddress.channelType, createdAddress.chatId);
      assert.ok(createdBinding);
      const createdCodexSession = store.getSession(createdBinding.bridgeSessionId);
      assert.equal(getSessionActiveRuntime(createdCodexSession) || 'codex', 'codex');
      assert.equal(createdCodexSession?.runtime?.codex?.provider, undefined);

      await handleBridgeCommand(
        adapter,
        {
          address: createdAddress,
          text: '/runtime claude',
          messageId: 'incoming-runtime-claude-default-e2e',
        } as any,
        '/runtime claude',
        deps,
      );
      const claudeBinding = store.getChannelChat(createdAddress.channelType, createdAddress.chatId);
      assert.ok(claudeBinding);
      assert.notEqual(claudeBinding.bridgeSessionId, createdBinding.bridgeSessionId);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.activeRuntime, 'claude');

      const result = await processMessage(
        claudeBinding,
        'hello default executable',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          store,
          llm: routingProvider,
          consumeSseEvents,
          normalizeSandboxMode,
          normalizeReasoningEffort,
        },
      );

      assert.match(result.responseText, /FAKE_CLAUDE_RESPONSE:hello default executable/);
      const claudeLog = fs.readFileSync(fakeClaude.logPath, 'utf-8');
      assert.match(claudeLog, /argv: <.*claude>/);
      assert.doesNotMatch(claudeLog, /\bccr\b|\bcodex\b/);
      assert.match(claudeLog, /prompt:hello default executable/);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.codex, undefined);
      assert.equal(getSessionActiveRuntime(store.getSession(createdBinding.bridgeSessionId)) || 'codex', 'codex');
    } finally {
      _testOnlyClaudePty.clear();
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(fakeClaude.binDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('applies SessionRuntime commands to Claude state when active runtime is Claude', async () => {
    const store = initTestContext();
    const sent: any[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    const address = { channelType: 'feishu', chatId: 'chat-claude-session-runtime' } as const;
    const session = store.createSession('claude-runtime-session', 'codex-model');
    store.updateSession(session.id, { runtime: { activeRuntime: 'claude' } });
    store.upsertChannelChat({
      channelType: address.channelType,
      chatId: address.chatId,
      bridgeSessionId: session.id,
    });

    await handleBridgeCommand(
      adapter,
      { address, text: '/mode yolo', messageId: 'incoming-claude-mode' } as any,
      '/mode yolo',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );
    await handleBridgeCommand(
      adapter,
      { address, text: '/model sonnet', messageId: 'incoming-claude-model' } as any,
      '/model sonnet',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );
    await handleBridgeCommand(
      adapter,
      { address, text: '/reasoning high', messageId: 'incoming-claude-reasoning' } as any,
      '/reasoning high',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );
    await handleBridgeCommand(
      adapter,
      { address, text: '/p sdk', messageId: 'incoming-claude-provider' } as any,
      '/p sdk',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
        reconcileMirrorSubscriptions: async () => {},
      },
    );

    const updated = store.getSession(session.id);
    assert.equal(getSessionClaudeModel(updated), 'sonnet');
    assert.equal(getSessionClaudeReasoningEffort(updated), 'high');
    assert.equal(getSessionClaudeProvider(updated), 'sdk');
    assert.equal(getSessionCodexModel(updated), undefined);
    assert.equal(getSessionCodexReasoningEffort(updated), undefined);
    assert.equal(getSessionCodexSandboxMode(updated), undefined);
    assert.equal(updated?.runtime?.codex, undefined);
    assert.equal(updated?.runtime?.claude?.model, undefined);
    assert.equal(updated?.runtime?.claude?.reasoningEffort, undefined);
    assert.equal(updated?.runtime?.claude?.provider, undefined);
    assert.equal(
      createConfigService({ migrate: false, env: {} }).get('runtime.claude.yoloMode', {
        kind: 'session',
        sessionId: session.id,
      }),
      'on',
    );
    assert.equal(
      createConfigService({ migrate: false, env: {} }).get('runtime.claude.model', {
        kind: 'session',
        sessionId: session.id,
      }),
      'sonnet',
    );
    assert.equal(
      createConfigService({ migrate: false, env: {} }).get('runtime.claude.reasoningEffort', {
        kind: 'session',
        sessionId: session.id,
      }),
      'high',
    );
    assert.equal(
      createConfigService({ migrate: false, env: {} }).get('runtime.claude.provider', {
        kind: 'session',
        sessionId: session.id,
      }),
      'sdk',
    );
    assert.deepEqual(
      {
        provider: resolveClaudeRuntimeConfig(store.getSession(session.id)).provider,
        model: resolveClaudeRuntimeConfig(store.getSession(session.id)).model,
        permissionMode: resolveClaudeRuntimeConfig(store.getSession(session.id)).permissionMode,
        reasoningEffort: resolveClaudeRuntimeConfig(store.getSession(session.id)).reasoningEffort,
      },
      { provider: 'sdk', model: 'sonnet', permissionMode: 'bypassPermissions', reasoningEffort: 'high' },
    );
    assert.match(sent.at(-4)?.text || '', /Claude Code 模式/);
    assert.match(sent.at(-3)?.text || '', /Claude Code 模型/);
    assert.match(sent.at(-2)?.text || '', /Claude Code 思考级别/);
    assert.match(sent.at(-1)?.text || '', /已切换 Claude Provider/);
  });

  it('reminds users that Codex runtime settings apply on the next request', async () => {
    const store = initTestContext();
    const sent: any[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    const address = { channelType: 'feishu', chatId: 'chat-codex-runtime-next-request' } as const;
    const session = store.createSession('codex-runtime-session', 'test-model');
    store.upsertChannelChat({
      channelType: address.channelType,
      chatId: address.chatId,
      bridgeSessionId: session.id,
    });
    const deps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
    };

    await handleBridgeCommand(
      adapter,
      { address, text: '/mode yolo', messageId: 'incoming-codex-mode-next' } as any,
      '/mode yolo',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /下一轮 Codex 请求开始生效/);

    await handleBridgeCommand(
      adapter,
      { address, text: '/reasoning high', messageId: 'incoming-codex-reasoning-next' } as any,
      '/reasoning high',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /下一轮 Codex 请求开始生效/);

    await handleBridgeCommand(
      adapter,
      { address, text: '/model default', messageId: 'incoming-codex-model-next' } as any,
      '/model default',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /下一轮 Codex 请求开始生效/);
  });

  it('writes Codex runtime settings under tmux and pty providers with deferred-effect notices', async () => {
    const providers = ['tmux', 'pty'] as const;
    for (const provider of providers) {
      const store = initTestContext();
      const sent: any[] = [];
      const adapter = createGroupCapableAdapter({ sent });
      const address = { channelType: 'feishu', chatId: `chat-codex-${provider}-runtime-deferred` } as const;
      const session = store.createSession(`${provider}-runtime-session`, 'test-model');
      store.updateSession(session.id, {
        runtime: {
          codex: {
            threadId: `thread-${provider}-runtime-deferred`,
            mode: 'normal',
            reasoningEffort: 'medium',
            sandboxMode: 'workspace-write',
            networkAccess: true,
            model: 'old-model',
          },
        },
      });
      createConfigService({ migrate: false, env: {} }).set(
        { kind: 'session', sessionId: session.id },
        { runtime: { codex: { provider } } },
      );
      store.upsertChannelChat({
        channelType: address.channelType,
        chatId: address.chatId,
        bridgeSessionId: session.id,
      });
      const deps = {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      };

      await handleBridgeCommand(adapter, { address, text: '/mode yolo', messageId: `incoming-${provider}-mode` } as any, '/mode yolo', deps);
      assert.equal(store.getSession(session.id)?.runtime?.codex?.mode, 'normal');
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.yoloMode', {
          kind: 'session',
          sessionId: session.id,
        }),
        'on',
      );
      assert.equal(resolveEffectiveMode(null, store.getSession(session.id)), 'yolo');
      assert.match(sent.at(-1)?.text || '', /已切换模式/);
      assert.match(sent.at(-1)?.text || '', /配置已保存/);
      assert.match(sent.at(-1)?.text || '', /不会影响已经启动的 Codex TUI/);
      assert.doesNotMatch(sent.at(-1)?.text || '', /无法影响/);

      await handleBridgeCommand(adapter, { address, text: '/reasoning minimal', messageId: `incoming-${provider}-reasoning` } as any, '/reasoning minimal', deps);
      assert.equal(getSessionCodexReasoningEffort(store.getSession(session.id)), 'minimal');
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.reasoningEffort', {
          kind: 'session',
          sessionId: session.id,
        }),
        'minimal',
      );
      assert.equal(resolveEffectiveReasoningEffort(store.getSession(session.id)), 'minimal');
      assert.match(sent.at(-1)?.text || '', /已更新思考级别/);
      assert.match(sent.at(-1)?.text || '', /配置已保存/);

      await handleBridgeCommand(adapter, { address, text: '/sandbox read-only', messageId: `incoming-${provider}-sandbox` } as any, '/sandbox read-only', deps);
      assert.equal(getSessionCodexSandboxMode(store.getSession(session.id)), 'read-only');
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.sandboxMode', {
          kind: 'session',
          sessionId: session.id,
        }),
        'read-only',
      );
      assert.equal(resolveEffectiveSandboxMode(store.getSession(session.id)), 'read-only');
      assert.match(sent.at(-1)?.text || '', /已更新 Codex 沙箱/);
      assert.match(sent.at(-1)?.text || '', provider === 'tmux' ? /\/p tmux/ : /\/provider pty/);

      await handleBridgeCommand(adapter, { address, text: '/network off', messageId: `incoming-${provider}-network` } as any, '/network off', deps);
      assert.equal(getSessionCodexNetworkAccess(store.getSession(session.id)), false);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.networkAccess', {
          kind: 'session',
          sessionId: session.id,
        }),
        false,
      );
      assert.equal(resolveEffectiveNetworkAccess(store.getSession(session.id)), false);
      assert.match(sent.at(-1)?.text || '', /已更新 Codex 网络/);
      assert.match(sent.at(-1)?.text || '', /重启后的后续请求中生效/);

      await handleBridgeCommand(adapter, { address, text: '/sandbox default', messageId: `incoming-${provider}-sandbox-default` } as any, '/sandbox default', deps);
      assert.notEqual(
        createConfigService({ migrate: false, env: {} }).resolve('runtime.codex.sandboxMode', {
          kind: 'session',
          sessionId: session.id,
        }).source,
        'session',
      );
      assert.equal(resolveEffectiveSandboxMode(store.getSession(session.id)), 'workspace-write');

      await handleBridgeCommand(adapter, { address, text: '/network default', messageId: `incoming-${provider}-network-default` } as any, '/network default', deps);
      assert.notEqual(
        createConfigService({ migrate: false, env: {} }).resolve('runtime.codex.networkAccess', {
          kind: 'session',
          sessionId: session.id,
        }).source,
        'session',
      );
      assert.equal(resolveEffectiveNetworkAccess(store.getSession(session.id)), true);

      await handleBridgeCommand(adapter, { address, text: '/model gpt-5.4', messageId: `incoming-${provider}-model-set` } as any, '/model gpt-5.4', deps);
      assert.equal(getSessionCodexModel(store.getSession(session.id)), 'gpt-5.4');
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.model', {
          kind: 'session',
          sessionId: session.id,
        }),
        'gpt-5.4',
      );
      assert.equal(resolveDisplayedModel(null, store.getSession(session.id), 'fallback-model'), 'gpt-5.4');
      assert.match(sent.at(-1)?.text || '', /已更新模型/);
      assert.match(sent.at(-1)?.text || '', /配置已保存/);

      createConfigService({ migrate: false, env: {} }).set(
        { kind: 'session', sessionId: session.id },
        { runtime: { codex: { model: 'old-model' } } },
      );
      assert.equal(resolveDisplayedModel(null, store.getSession(session.id), 'fallback-model'), 'old-model');
      await handleBridgeCommand(adapter, { address, text: '/model default', messageId: `incoming-${provider}-model` } as any, '/model default', deps);
      assert.equal(getSessionCodexModel(store.getSession(session.id)), undefined);
      assert.notEqual(
        createConfigService({ migrate: false, env: {} }).resolve('runtime.codex.model', {
          kind: 'session',
          sessionId: session.id,
        }).source,
        'session',
      );
      assert.equal(resolveDisplayedModel(null, store.getSession(session.id), 'fallback-model'), 'fallback-model');
      assert.match(sent.at(-1)?.text || '', /已恢复默认模型/);
      assert.match(sent.at(-1)?.text || '', /配置已保存/);

      await handleBridgeCommand(adapter, { address, text: '/p sdk', messageId: `incoming-${provider}-provider-sdk` } as any, '/p sdk', {
        ...deps,
        reconcileMirrorSubscriptions: async () => {},
      });
      assert.equal(getSessionCodexProvider(store.getSession(session.id)), 'sdk');
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider', {
          kind: 'session',
          sessionId: session.id,
        }),
        'sdk',
      );
      assert.equal(store.getSession(session.id)?.runtime?.codex?.provider, undefined);
      assert.equal(resolveEffectiveCodexProvider(store.getSession(session.id)), 'sdk');
      assert.match(sent.at(-1)?.text || '', /已切换 Codex Provider/);
    }
  });

  it('does not apply Codex-only sandbox and network commands to Claude sessions', async () => {
    const store = initTestContext();
    const sent: any[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    const address = { channelType: 'feishu', chatId: 'chat-claude-session-runtime-unsupported' } as const;
    const session = store.createSession('claude-runtime-session', 'codex-model');
    store.updateSession(session.id, { runtime: { activeRuntime: 'claude' } });
    store.upsertChannelChat({
      channelType: address.channelType,
      chatId: address.chatId,
      bridgeSessionId: session.id,
    });

    await handleBridgeCommand(
      adapter,
      { address, text: '/sandbox read-only', messageId: 'incoming-claude-sandbox' } as any,
      '/sandbox read-only',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );
    await handleBridgeCommand(
      adapter,
      { address, text: '/network on', messageId: 'incoming-claude-network' } as any,
      '/network on',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const updated = store.getSession(session.id);
    assert.equal(updated?.runtime?.codex, undefined);
    assert.match(sent.at(-2)?.text || '', /Claude Code 不支持 Bridge 沙箱设置/);
    assert.match(sent.at(-1)?.text || '', /Claude Code 不支持 Bridge 网络开关/);
  });

  it('clears the current chat into a new BridgeSession using /new-style args', async () => {
    const store = initTestContext();
    const sent: Array<{ text: string; richCard?: OutboundRichCard }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        sent.push(message);
        return { ok: true, messageId: `reply-clear-${sent.length}` };
      },
    };
    const oldWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-old-'));
    const newWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-new-'));
    const address = { channelType: 'feishu', chatId: 'chat-clear', chatKind: 'group' as const } as const;
    const initialBinding = router.createBinding(address, oldWorkDir, '旧上下文');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/clear 新上下文 ${newWorkDir}`,
        messageId: 'incoming-clear-direct',
      } as any,
      `/clear 新上下文 ${newWorkDir}`,
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const nextBinding = store.getChannelChat('feishu', 'chat-clear');
    assert.ok(nextBinding);
    assert.notEqual(nextBinding!.bridgeSessionId, initialBinding.bridgeSessionId);
    const nextSession = store.getSession(nextBinding!.bridgeSessionId);
    assert.equal(nextSession?.name, '新上下文');
    assert.equal(getSessionWorkingDirectory(nextSession), newWorkDir);
    assert.match(sent.at(-1)?.text || '', /已清空当前聊天上下文/);
    assert.match(sent.at(-1)?.text || '', /\/clear \[name\] \[path\]/);
  });

  it('asks for confirmation before /clear stops a running session', async () => {
    const store = initTestContext();
    const sent: Array<{ text: string; richCard?: OutboundRichCard }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        sent.push(message);
        return { ok: true, messageId: `reply-clear-running-${sent.length}` };
      },
    };
    const oldWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-running-old-'));
    const newWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-running-new-'));
    const address = { channelType: 'feishu', chatId: 'chat-clear-running' } as const;
    const initialBinding = router.createBinding(address, oldWorkDir, '旧运行中');
    const activeTask = { abortController: new AbortController() };
    const forcedStops: Array<{ sessionId: string; detail?: string }> = [];

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/clear 新会话 ${newWorkDir}`,
        messageId: 'incoming-clear-running-prompt',
      } as any,
      `/clear 新会话 ${newWorkDir}`,
      {
        getActiveTask: (sessionId) => sessionId === initialBinding.bridgeSessionId ? activeTask : undefined,
        forceStopSession: async (sessionId, detail) => {
          forcedStops.push({ sessionId, detail });
          return true;
        },
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(store.getChannelChat('feishu', 'chat-clear-running')?.bridgeSessionId, initialBinding.bridgeSessionId);
    assert.match(sent.at(-1)?.text || '', /确认清空当前对话/);
    assert.match(sent.at(-1)?.richCard?.actions?.[0]?.[0]?.callbackData || '', /%2Fclear%20--yes/);
    assert.equal(forcedStops.length, 0);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/clear --yes 新会话 ${newWorkDir}`,
        messageId: 'incoming-clear-running-confirmed',
      } as any,
      `/clear --yes 新会话 ${newWorkDir}`,
      {
        getActiveTask: (sessionId) => sessionId === initialBinding.bridgeSessionId ? activeTask : undefined,
        forceStopSession: async (sessionId, detail) => {
          forcedStops.push({ sessionId, detail });
          return true;
        },
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const nextBinding = store.getChannelChat('feishu', 'chat-clear-running');
    assert.ok(nextBinding);
    assert.notEqual(nextBinding!.bridgeSessionId, initialBinding.bridgeSessionId);
    assert.equal(store.getSession(nextBinding!.bridgeSessionId)?.name, '新会话');
    assert.equal(getSessionWorkingDirectory(store.getSession(nextBinding!.bridgeSessionId)), newWorkDir);
    assert.deepEqual(forcedStops.map((entry) => entry.sessionId), [initialBinding.bridgeSessionId]);
    assert.match(forcedStops[0]?.detail || '', /用户确认 \/clear/);
    assert.match(sent.at(-1)?.text || '', /旧任务已按确认请求终止/);
  });

  it('views and updates global non-channel config with /set and applies it to /new', async () => {
    const store = initTestContext({ dynamicSettings: true });
    const sent: any[] = [];
    const adapter = createGroupCapableAdapter({ sent });
    const address = { channelType: 'feishu', chatId: 'chat-set-command' } as const;
    const deps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
    };
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-set-workspace-'));

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set',
        messageId: 'incoming-set-show',
      } as any,
      '/set',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /全局配置/);
    assert.match(sent.at(-1)?.text || '', /通用配置/);
    assert.match(sent.at(-1)?.text || '', /runtime\.agent/);
    assert.match(sent.at(-1)?.text || '', /session\.tmux_capture_lines/);
    assert.doesNotMatch(sent.at(-1)?.text || '', /GlobalRuntime \/ Codex/);
    assert.doesNotMatch(sent.at(-1)?.text || '', /runtime\.codex\.provider/);
    assert.doesNotMatch(sent.at(-1)?.text || '', /channels/);
    assert.equal(sent.at(-1)?.richCard?.title, '全局配置');
    assert.equal(sent.at(-1)?.richCard?.subtitle, '写入 ~/.codelark/config.toml · 通用配置');
    assert.equal(sent.at(-1)?.richCard?.updateKey, `thread-card:set:${address.channelType}:${address.chatId}`);
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, undefined);
    assert.equal(sent.at(-1)?.richCard?.form?.submitCallbackData, buildCommandCallbackData('/set --group runtime'));
    assert.equal(sent.at(-1)?.richCard?.form?.layout, 'two_column');
    assert.equal(sent.at(-1)?.richCard?.form?.actionDividerBefore, true);
    assert.deepEqual(sent.at(-1)?.richCard?.footer, [
      'YOLO模式：允许 agent 无需审批绕过沙箱。',
      'Provider：选择使用何种方式运行 agent，例如 tmux、pty 或 sdk。',
    ]);
    assert.deepEqual(
      sent.at(-1)?.richCard?.selects?.[0]?.options.map((option: any) => option.text),
      ['通用配置', 'Codex', 'Claude', 'Bridge', '通道配置（feishu-default）'],
    );
    assert.deepEqual(sent.at(-1)?.richCard?.sections, []);
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.elementId),
      ['runtime', 'tmuxAutoEnter', 'tmuxEchoInput'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.label),
      ['默认 agent', 'tmux 自动回车', '回显 tmux 输出'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.formName),
      ['rt', 'tmux_enter', 'tmux_echo'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.extraInputs?.map((input: any) => input.elementId),
      ['defaultWorkspaceRoot', 'tmuxCaptureLines'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.extraInputs?.map((input: any) => input.formName),
      ['ws_root', 'tmux_lines'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.extraInputs?.map((input: any) => input.label),
      ['默认工作目录', 'tmux 输出行数'],
    );
    assert.equal(getThreadTableMessageRecord(address, 'set')?.messageId, 'reply-1');
    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    assert.equal(store.listSessions().length, 0);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set --group codex',
        messageId: 'incoming-set-codex-card',
      } as any,
      '/set --group codex',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /Codex/);
    assert.match(sent.at(-1)?.text || '', /runtime\.codex\.provider/);
    assert.match(sent.at(-1)?.text || '', /runtime\.codex\.network_access/);
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, undefined);
    assert.equal(sent.at(-1)?.richCard?.subtitle, '写入 ~/.codelark/config.toml · Codex');
    assert.equal(sent.at(-1)?.richCard?.form?.submitCallbackData, buildCommandCallbackData('/set --group runtime.codex'));
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.elementId).slice(0, 4),
      ['defaultMode', 'defaultProvider', 'codexSkipGitRepoCheck', 'codexSandboxMode'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.formName).slice(0, 4),
      ['cdx_mode', 'cdx_provider', 'cdx_skip_git', 'cdx_sandbox'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.label).slice(0, 2),
      ['YOLO模式', 'Provider（运行方式）'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.selects?.find((select: any) => select.elementId === 'defaultProvider')?.options.map((option: any) => option.text),
      ['sdk', 'pty', 'tmux'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.selects?.find((select: any) => select.elementId === 'codexSandboxMode')?.options.map((option: any) => option.text),
      ['workspace-write', 'read-only'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.extraInputs?.map((input: any) => input.elementId),
      ['defaultModel'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.extraInputs?.map((input: any) => input.formName),
      ['cdx_model'],
    );

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set',
        messageId: 'incoming-set-form',
        callbackData: buildCommandCallbackData('/set --group runtime.codex'),
        raw: {
          event: {
            context: {
              open_message_id: 'reply-2',
            },
            action: {
              form_value: {
                cdx_provider: 'tmux',
                cdx_network: 'off',
              },
            },
          },
        },
      } as any,
      '/set --group runtime.codex',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /已保存全局配置/);
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, 'reply-2');
    assert.equal(sent.at(-1)?.richCard?.title, '全局配置');
    assert.equal(getThreadTableMessageRecord(address, 'set')?.messageId, 'reply-2');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider'), 'tmux');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.codex.networkAccess'), false);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set --group runtime',
        messageId: 'incoming-set-runtime-card',
      } as any,
      '/set --group runtime',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /通用配置/);
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, undefined);
    assert.equal(sent.at(-1)?.richCard?.subtitle, '写入 ~/.codelark/config.toml · 通用配置');
    assert.deepEqual(sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.elementId), ['runtime', 'tmuxAutoEnter', 'tmuxEchoInput']);
    assert.deepEqual(sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.label), [
      '默认 agent',
      'tmux 自动回车',
      '回显 tmux 输出',
    ]);
    assert.equal(getThreadTableMessageRecord(address, 'set')?.messageId, 'reply-4');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set --group runtime.claude',
        messageId: 'incoming-set-runtime-select-claude',
        callbackData: buildCommandCallbackData('/set --group runtime.claude'),
        raw: {
          event: {
            context: {
              open_message_id: 'reply-4',
            },
          },
        },
      } as any,
      '/set --group runtime.claude',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /Claude/);
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, 'reply-4');
    assert.equal(sent.at(-1)?.richCard?.subtitle, '写入 ~/.codelark/config.toml · Claude');
    assert.equal(getThreadTableMessageRecord(address, 'set')?.messageId, 'reply-4');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set',
        messageId: 'incoming-set-runtime-form',
        callbackData: buildCommandCallbackData('/set --group runtime'),
        raw: {
          event: {
            context: {
              open_message_id: 'reply-4',
            },
            action: {
              form_value: {
                rt: 'claude',
              },
            },
          },
        },
      } as any,
      '/set --group runtime',
      deps,
    );
    assert.equal(createConfigService({ migrate: false, env: {} }).resolve('runtime.agent').source, 'home');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.agent'), 'claude');
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, 'reply-4');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set --group runtime.claude',
        messageId: 'incoming-set-claude-card',
      } as any,
      '/set --group runtime.claude',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /Claude/);
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, undefined);
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.elementId),
      ['claudeMode', 'claudeProvider', 'claudeExecutable', 'claudeReasoningEffort'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.selects?.map((select: any) => select.formName),
      ['cld_mode', 'cld_provider', 'cld_exec', 'cld_rsn_eft'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.extraInputs?.map((input: any) => input.formName),
      ['cld_model', 'cld_idle_min'],
    );

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set',
        messageId: 'incoming-set-claude-form',
        callbackData: buildCommandCallbackData('/set --group runtime.claude'),
        raw: {
          event: {
            context: {
              open_message_id: 'reply-7',
            },
            action: {
              form_value: {
                cld_rsn_eft: 'max',
              },
            },
          },
        },
      } as any,
      '/set --group runtime.claude',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /已保存全局配置/);
    assert.equal(sent.at(-1)?.richCardUpdateMessageId, 'reply-7');
    assert.equal(getThreadTableMessageRecord(address, 'set')?.messageId, 'reply-7');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.claude.reasoningEffort'), 'max');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set --group channels.feishu',
        messageId: 'incoming-set-channel-card',
      } as any,
      '/set --group channels.feishu',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /通道配置（feishu-default）/);
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.extraInputs?.map((input: any) => input.elementId).slice(0, 3),
      ['historyMessageLimit', 'streamStatusIdleStartSeconds', 'streamStatusCheckIntervalSeconds'],
    );
    assert.deepEqual(
      sent.at(-1)?.richCard?.form?.extraInputs?.map((input: any) => input.formName).slice(0, 3),
      ['hist_limit', 'stream_idle_sec', 'stream_check_sec'],
    );

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set',
        messageId: 'incoming-set-channel-form',
        callbackMessageId: 'reply-channel-card',
        raw: {
          event: {
            action: {
              form_value: {
                hist_limit: '11',
              },
            },
          },
        },
      } as any,
      '/set --group channels.feishu',
      deps,
    );
    assert.equal(createConfigService({ migrate: false, env: {} }).snapshot().config.channels[0]?.config.historyMessageLimit, 11);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/set defaultWorkspaceRoot ${workspaceRoot}`,
        messageId: 'incoming-set-workspace',
      } as any,
      `/set defaultWorkspaceRoot ${workspaceRoot}`,
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /已更新全局配置/);
    assert.match(sent.at(-1)?.text || '', /bridge\.default_workspace/);
    assert.match(sent.at(-1)?.text || '', /config\.toml/);
    assert.doesNotMatch(sent.at(-1)?.text || '', /config\.env|config\.json/);
    assert.equal(fs.existsSync(HOME_CONFIG_TOML_PATH), true);
    assert.equal(fs.existsSync(CONFIG_PATH), false);
    assert.equal(fs.existsSync(CONFIG_JSON_PATH), false);
    assert.equal(createConfigService({ migrate: false, env: {} }).resolve('bridge.defaultWorkspace').source, 'home');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('bridge.defaultWorkspace'), workspaceRoot);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set runtime claude',
        messageId: 'incoming-set-runtime',
      } as any,
      '/set runtime claude',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /runtime\.agent.*claude/s);
    assert.equal(createConfigService({ migrate: false, env: {} }).resolve('runtime.agent').source, 'home');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.agent'), 'claude');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set defaultMode yolo',
        messageId: 'incoming-set-mode',
      } as any,
      '/set defaultMode yolo',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /runtime\.codex\.yolo_mode.*yolo/s);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set defaultProvider tmux',
        messageId: 'incoming-set-provider',
      } as any,
      '/set defaultProvider tmux',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /runtime\.codex\.provider.*tmux/s);
    assert.equal(createConfigService({ migrate: false, env: {} }).resolve('runtime.codex.provider').source, 'home');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider'), 'tmux');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set defaultProvider pty',
        messageId: 'incoming-set-provider-pty',
      } as any,
      '/set defaultProvider pty',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /runtime\.codex\.provider.*pty/s);
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider'), 'pty');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set defualtProvider sdk',
        messageId: 'incoming-set-provider-typo-alias',
      } as any,
      '/set defualtProvider sdk',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /runtime\.codex\.provider.*sdk/s);
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider'), 'sdk');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set defaultProvider default',
        messageId: 'incoming-set-provider-reset',
      } as any,
      '/set defaultProvider default',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /runtime\.codex\.provider.*auto/s);
    assert.equal(createConfigService({ migrate: false, env: {} }).resolve('runtime.codex.provider').source, 'home');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider'), '');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set codexNetworkAccess off',
        messageId: 'incoming-set-network',
      } as any,
      '/set codexNetworkAccess off',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /runtime\.codex\.network_access.*off/s);
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.codex.networkAccess'), false);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set codexReasoningEffort minimal',
        messageId: 'incoming-set-reasoning-minimal',
      } as any,
      '/set codexReasoningEffort minimal',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /runtime\.codex\.reasoning_effort.*minimal/s);
    assert.match(sent.at(-1)?.text || '', /禁用 web search/);
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.codex.reasoningEffort'), 'minimal');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set claudeExecutable ccr',
        messageId: 'incoming-set-claude-executable',
      } as any,
      '/set claudeExecutable ccr',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /runtime\.claude\.executable.*ccr/s);
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.claude.executable'), 'ccr');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set claudeDefaultModel claude-sonnet-test',
        messageId: 'incoming-set-claude-model',
      } as any,
      '/set claudeDefaultModel claude-sonnet-test',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /runtime\.claude\.model.*claude-sonnet-test/s);
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.claude.model'), 'claude-sonnet-test');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set claudeReasoningEffort m',
        messageId: 'incoming-set-claude-reasoning-m',
      } as any,
      '/set claudeReasoningEffort m',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /runtime\.claude\.reasoning_effort.*max/s);
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.claude.reasoningEffort'), 'max');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set historyMessageLimit 12',
        messageId: 'incoming-set-history',
      } as any,
      '/set historyMessageLimit 12',
      deps,
    );
    const configAfterHistory = createConfigService({ migrate: false, env: {} }).snapshot();
    assert.equal(configAfterHistory.provenance.get('channels.feishu-default.config.historyMessageLimit')?.source, 'home');
    assert.equal(configAfterHistory.config.channels[0]?.config.historyMessageLimit, 12);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/set defaultMode impossible',
        messageId: 'incoming-set-invalid',
      } as any,
      '/set defaultMode impossible',
      deps,
    );
    assert.match(sent.at(-1)?.text || '', /配置未更新/);
    assert.match(sent.at(-1)?.text || '', /normal 或 yolo/);
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.codex.yoloMode'), 'on');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/new set-proj ./set-proj',
        messageId: 'incoming-new-after-set',
      } as any,
      '/new set-proj ./set-proj',
      deps,
    );
    const binding = store.getChannelChat(address.channelType, adapter.createdGroups.at(-1)!.chatId);
    assert.ok(binding);
    assert.equal(getSessionWorkingDirectory(store.getSession(binding!.bridgeSessionId)), path.join(workspaceRoot, 'set-proj'));
    assert.equal(store.getSession(binding!.bridgeSessionId)?.runtime?.codex?.mode, undefined);
  });

  it('views and updates current Feishu channel group mention requirement with /require-at', async () => {
    initTestContext({ dynamicSettings: true });
    createConfigService({ migrate: false, env: {} }).set({ kind: 'home' }, {
      runtime: { agent: 'codex', codex: { yoloMode: 'off' } },
      channels: [{
        id: 'feishu',
        alias: '飞书',
        provider: 'feishu',
        enabled: true,
        config: {
          appId: 'app-id',
          appSecret: 'app-secret',
        },
      }],
    });
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-mention-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-mention-command' } as const;
    const deps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/require-at',
        messageId: 'incoming-mention-show',
      } as any,
      '/require-at',
      deps,
    );
    assert.match(sent.at(-1) || '', /群聊 @bot 设置/);
    assert.match(sent.at(-1) || '', /off/);
    assert.match(sent.at(-1) || '', /读取群组中所有消息/);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/require-at on',
        messageId: 'incoming-mention-on',
      } as any,
      '/require-at on',
      deps,
    );
    assert.match(sent.at(-1) || '', /已更新群聊 @bot 设置/);
    assert.match(sent.at(-1) || '', /on/);
    assert.match(sent.at(-1) || '', /config\.toml/);
    assert.doesNotMatch(sent.at(-1) || '', /config\.env|config\.json/);
    assert.match(sent.at(-1) || '', /im\.message\.receive_v1/);
    const requireOn = createConfigService({ migrate: false }).snapshot().config.channels
      .find((channel) => channel.id === 'feishu')?.config.requireMention;
    assert.equal(requireOn, true);
    assert.match(fs.readFileSync(HOME_CONFIG_TOML_PATH, 'utf-8'), /require_mention = true/);
    assert.equal(fs.existsSync(CONFIG_PATH), false);
    assert.equal(fs.existsSync(CONFIG_JSON_PATH), false);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/require-at off',
        messageId: 'incoming-mention-off',
      } as any,
      '/require-at off',
      deps,
    );
    assert.match(sent.at(-1) || '', /off/);
    const requireOff = createConfigService({ migrate: false }).snapshot().config.channels
      .find((channel) => channel.id === 'feishu')?.config.requireMention;
    assert.equal(requireOff, false);
    assert.match(fs.readFileSync(HOME_CONFIG_TOML_PATH, 'utf-8'), /require_mention = false/);
    assert.equal(fs.existsSync(CONFIG_PATH), false);
    assert.equal(fs.existsSync(CONFIG_JSON_PATH), false);
  });

  it('blocks thread switching while the current task is running unless forced', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-switch-running' } as const;
    const initialBinding = router.createBinding(address, 'D:\\workspace\\running-old');
    const activeTask = { abortController: new AbortController() };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/thread 0',
        messageId: 'incoming-switch-running-1',
      } as any,
      '/thread 0',
      {
        getActiveTask: (sessionId) => sessionId === initialBinding.bridgeSessionId ? activeTask : undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.match(sent.at(-1) || '', /当前会话仍在运行/);
    assert.match(sent.at(-1) || '', /--force/);
    assert.equal(
      store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId,
      initialBinding.bridgeSessionId,
    );

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/thread 0 --force',
        messageId: 'incoming-switch-running-2',
      } as any,
      '/thread 0 --force',
      {
        getActiveTask: (sessionId) => sessionId === initialBinding.bridgeSessionId ? activeTask : undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const forcedBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.notEqual(forcedBinding?.bridgeSessionId, initialBinding.bridgeSessionId);
    assert.equal(store.getSession(forcedBinding!.bridgeSessionId)?.runtime?.codex?.mode, undefined);
    assert.match(sent.at(-1) || '', /已切换到临时 BridgeSession/);
    assert.ok(readAuditSummaries().some((summary) => (
      summary.includes('Binding change: action=switch_draft')
      && summary.includes('reason=forced')
    )));
  });

  it('force-stops a stale running session even when no active task remains in memory', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    const forcedStops: Array<{ sessionId: string; detail?: string }> = [];
    const healthEnds: Array<{ sessionId: string; outcome: string; detail?: string }> = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-stop-stale' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-stop-stale' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\stop-stale');
    store.updateSession(binding.bridgeSessionId, {
      runtime_status: 'idle',
      health_status: 'suspected_stream_ui_stall',
      health_reason: '任务仍在继续，但流式 UI 刷新请求已长时间未完成，疑似卡住。',
    });

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/stop',
        messageId: 'incoming-stop-stale',
      } as any,
      '/stop',
      {
        getActiveTask: () => undefined,
        forceStopSession: async (sessionId, detail) => {
          forcedStops.push({ sessionId, detail });
          return false;
        },
        recordInteractiveHealthEnd: (sessionId, outcome, detail) => {
          healthEnds.push({ sessionId, outcome, detail });
        },
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.deepEqual(forcedStops, [{
      sessionId: binding.bridgeSessionId,
      detail: '用户执行 /stop，已停止当前任务。',
    }]);
    assert.deepEqual(healthEnds, [{
      sessionId: binding.bridgeSessionId,
      outcome: 'aborted',
      detail: '用户执行 /stop，已停止当前任务。',
    }]);
    assert.match(sent[0] || '', /旧会话「Bridge: chat-stop-stale」任务已停止/);
  });

  it('does not repin an already pinned thread table message after in-place refresh', async () => {
    initTestContext();
    const pinned: string[] = [];
    const unpinned: string[] = [];
    const adapter: any = {
      pinMessage: async (_chatId: string, messageId: string) => {
        pinned.push(messageId);
        return { ok: true, messageId };
      },
      unpinMessage: async (_chatId: string, messageId: string) => {
        unpinned.push(messageId);
        return { ok: true, messageId };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-t-pin' } as const;

    await persistAndPinLatestThreadTableMessage(adapter, address, 'bound', 'message-1');
    await flushThreadTablePinJobs();
    await persistAndPinLatestThreadTableMessage(adapter, address, 'bound', 'message-1');
    await flushThreadTablePinJobs();

    assert.deepEqual(pinned, ['message-1']);
    assert.deepEqual(unpinned, []);
    assert.equal(getThreadTableMessageRecord(address, 'bound')?.messageId, 'message-1');
    assert.equal(getThreadTableMessageRecord(address, 'bound')?.pinnedMessageId, 'message-1');
  });

  it('persists thread table messages without waiting for slow pin APIs', async () => {
    initTestContext();
    const pinCanFinish = createDeferred<void>();
    const pinned: string[] = [];
    const adapter: any = {
      pinMessage: async (_chatId: string, messageId: string) => {
        pinned.push(messageId);
        await pinCanFinish.promise;
        return { ok: true, messageId };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-t-pin-background' } as const;

    await persistAndPinLatestThreadTableMessage(adapter, address, 'bound', 'message-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(pinned, ['message-1']);
    assert.equal(getThreadTableMessageRecord(address, 'bound')?.messageId, 'message-1');
    assert.equal(getThreadTableMessageRecord(address, 'bound')?.pinnedMessageId, undefined);

    pinCanFinish.resolve();
    await flushThreadTablePinJobs();

    assert.equal(getThreadTableMessageRecord(address, 'bound')?.pinnedMessageId, 'message-1');
  });

  it('renders /t rich card content at the default 20 rows with 50/100 selectors', async () => {
    initTestContext();
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'session_index.jsonl'), { force: true });

    for (let index = 0; index < 200; index += 1) {
      const padded = String(index + 1).padStart(3, '0');
      const timestamp = new Date(Date.UTC(2026, 4, 28, 0, 0, index)).toISOString();
      writeCodexSessionJsonlFixture({
        threadId: `thread-${padded}`,
        workDir: `/tmp/project-${padded}`,
        lines: [
          {
            timestamp,
            type: 'session_meta',
            payload: {
              id: `thread-${padded}`,
              timestamp,
              cwd: `/tmp/project-${padded}`,
              originator: 'Codex CLI',
            },
          },
        ],
      });
    }

    const sent: Array<{ text: string; richCard?: OutboundRichCard }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        sent.push(message);
        return { ok: true, messageId: `reply-t-default-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-t-default' } as const;

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/t',
        messageId: 'incoming-t-default',
      } as any,
      '/t',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const message = sent.at(-1);
    assert.match(message?.text || '', /本地会话（Codex20）/);
    assert.doesNotMatch(message?.text || '', /已达到 100 条显示上限/);
    assert.equal(message?.richCard?.title, '');
    assert.equal(message?.richCard?.tableBlocks?.[0]?.table.rows.length, 20);
    assert.equal(message?.richCard?.tableBlocks?.[0]?.selects?.[0]?.options.length, 20);
    assert.deepEqual(message?.richCard?.tableBlocks?.[0]?.selects?.[1]?.options.map((option) => option.text), ['显示 20', '显示 50', '显示 100']);
    assert.deepEqual(message?.richCard?.tableBlocks?.[0]?.selects?.[2]?.options.map((option) => option.text), ['Codex', 'Claude']);
    assert.deepEqual(
      message?.richCard?.tableBlocks?.[0]?.actions?.map((row) => row.map((action) => action.text)),
      [['接管', '归档', '新建'], ['解绑', '刷新']],
    );
    assert.equal(message?.richCard?.tableBlocks?.[0]?.actions?.every((row) => row.length <= 3), true);
    assert.doesNotMatch(message?.richCard?.footer?.join('\n') || '', /已达到 100 条显示上限/);

    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
  });

  it('renders /t as one active-runtime table with a Codex/Claude selector', async () => {
    const store = initTestContext();
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'session_index.jsonl'), { force: true });
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-command-t-panels-home-'));
    const previousClaudeHome = process.env.CODELARK_CLAUDE_HOME;
    process.env.CODELARK_CLAUDE_HOME = homeDir;
    const codexThreadId = '019e7d66-0000-7000-8000-000000000021';
    const claudeSessionId = '019e7d66-0000-7000-8000-000000000022';
    const claudeCwd = '/tmp/thread-panels-claude';
    writeCodexSessionJsonlFixture({
      threadId: codexThreadId,
      workDir: '/tmp/thread-panels-codex',
    });
    writeClaudeJsonlFixture({
      homeDir,
      cwd: claudeCwd,
      sessionId: claudeSessionId,
      timestamp: '2026-06-02T00:00:01.000Z',
      text: 'panel claude',
    });

    const sent: Array<{ text: string; richCard?: OutboundRichCard }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        sent.push(message);
        return { ok: true, messageId: `reply-t-panels-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-t-panels' } as const;

    try {
      await handleBridgeCommand(adapter, {
        address,
        text: `/t ${claudeSessionId}`,
        messageId: 'incoming-t-panels-switch',
      } as any, `/t ${claudeSessionId}`, {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      });
      assert.equal(getSessionActiveRuntime(store.getSession(store.getChannelChat(address.channelType, address.chatId)!.bridgeSessionId)), 'claude');

      await handleBridgeCommand(adapter, {
        address,
        text: '/t',
        messageId: 'incoming-t-panels-list',
      } as any, '/t', {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      });

      const card = sent.at(-1)?.richCard;
      assert.equal(card?.template, 'blue');
      assert.equal(card?.panels, undefined);
      assert.equal(card?.title, '');
      assert.equal(card?.tableBlocks?.length, 1);
      assert.deepEqual(card?.tableBlocks?.[0]?.actions?.map((row) => row.map((action) => action.text)), [['接管', '归档', '新建'], ['解绑', '刷新']]);
      assert.equal(card?.tableBlocks?.[0]?.selects?.[0]?.id, 'claude_select');
      assert.equal(card?.tableBlocks?.[0]?.selects?.[1]?.id, 'claude_limit_select');
      assert.equal(card?.tableBlocks?.[0]?.selects?.[2]?.id, 'thread_runtime_select');
      assert.equal(card?.tableBlocks?.[0]?.table.rows.length, 1);
      assert.match(String(card?.tableBlocks?.[0]?.table.rows[0]?.thread_id || ''), new RegExp(claudeSessionId));
    } finally {
      if (previousClaudeHome === undefined) {
        delete process.env.CODELARK_CLAUDE_HOME;
      } else {
        process.env.CODELARK_CLAUDE_HOME = previousClaudeHome;
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    }
  });

  it('counts visible user input turns in /t while skipping Codex context loading records', async () => {
    initTestContext();
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'session_index.jsonl'), { force: true });
    const threadId = '019e7d66-0000-7000-8000-000000000023';
    writeCodexSessionJsonlFixture({
      threadId,
      workDir: '/tmp/thread-user-turns',
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: '/tmp/thread-user-turns',
            originator: 'Codex CLI',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '第一轮真实输入' },
        },
        {
          timestamp: '2026-05-28T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '<environment_context>loaded</environment_context>' },
        },
        {
          timestamp: '2026-05-28T00:00:03.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '<codex_internal_context source="goal">goal</codex_internal_context>' },
        },
        {
          timestamp: '2026-05-28T00:00:04.000Z',
          type: 'event_msg',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第二轮真实输入' }] },
        },
      ],
    });

    const sent: Array<{ text: string; richCard?: OutboundRichCard }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        sent.push(message);
        return { ok: true, messageId: `reply-t-user-turns-${sent.length}` };
      },
    };

    await handleBridgeCommand(
      adapter,
      {
        address: { channelType: 'feishu', chatId: 'chat-t-user-turns' },
        text: '/t',
        messageId: 'incoming-t-user-turns',
      } as any,
      '/t',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.match(sent.at(-1)?.text || '', /用户输入轮数/);
    assert.equal(sent.at(-1)?.richCard?.tableBlocks?.[0]?.table.rows[0]?.user_input_turns, "<font color='grey-500'>2</font>");

    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
  });

  it('archives the current Codex thread with /t archive and unbinds the chat', async () => {
    const store = initTestContext();
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'archived_sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'session_index.jsonl'), { force: true });

    const { sessionPath } = writeCodexSessionJsonlFixture({
      threadId: '019e7d66-0000-7000-8000-000000000001',
      workDir: '/tmp/archive-current',
    });
    const address = { channelType: 'feishu', chatId: 'chat-t-archive-current' } as const;
    const binding = router.bindToCodexThread(address, '019e7d66-0000-7000-8000-000000000001', {
      workingDirectory: '/tmp/archive-current',
      codexTitle: 'Archive current',
    });
    assert.ok(binding);

    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-t-archive-current-${sent.length}` };
      },
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/t archive',
        messageId: 'incoming-t-archive-current',
      } as any,
      '/t archive',
      {
        getActiveTask: () => ({ abortController: new AbortController() }),
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.match(sent.at(-1) || '', /已归档本地 Codex 会话/);
    assert.match(sent.at(-1) || '', /解除绑定.*1/s);
    assert.equal(fs.existsSync(sessionPath), false);
    const archivedEntries = fs.readdirSync(path.join(process.env.CODEX_HOME!, 'archived_sessions'));
    assert.equal(archivedEntries.length, 1);
    assert.match(archivedEntries[0] || '', /019e7d66-0000-7000-8000-000000000001\.jsonl$/);
    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    assert.equal(store.listChannelChats().some((item) => item.bridgeSessionId === binding.bridgeSessionId), false);
    assert.equal(store.getSession(binding.bridgeSessionId), null);

    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'archived_sessions'), { recursive: true, force: true });
  });

  it('archives a selected Codex thread with /t archive using the global list index', async () => {
    const store = initTestContext();
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'archived_sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'session_index.jsonl'), { force: true });

    const older = writeCodexSessionJsonlFixture({
      threadId: '019e7d66-0000-7000-8000-000000000101',
      workDir: '/tmp/archive-index-old',
      lines: [{
        timestamp: '2026-05-28T00:00:01.000Z',
        type: 'session_meta',
        payload: {
          id: '019e7d66-0000-7000-8000-000000000101',
          timestamp: '2026-05-28T00:00:01.000Z',
          cwd: '/tmp/archive-index-old',
          originator: 'Codex CLI',
        },
      }],
    });
    const newer = writeCodexSessionJsonlFixture({
      threadId: '019e7d66-0000-7000-8000-000000000102',
      workDir: '/tmp/archive-index-new',
      lines: [{
        timestamp: '2026-05-28T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '019e7d66-0000-7000-8000-000000000102',
          timestamp: '2026-05-28T00:00:00.000Z',
          cwd: '/tmp/archive-index-new',
          originator: 'Codex CLI',
        },
      }],
    });
    const address = { channelType: 'feishu', chatId: 'chat-t-archive-index' } as const;
    router.bindToCodexThread(address, '019e7d66-0000-7000-8000-000000000101', {
      workingDirectory: '/tmp/archive-index-old',
      codexTitle: 'Archive index old',
    });

    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-t-archive-index-${sent.length}` };
      },
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/t archive 1',
        messageId: 'incoming-t-archive-index',
      } as any,
      '/t archive 1',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.match(sent.at(-1) || '', /019e7d66-0000-7000-8000-000000000102/);
    assert.equal(fs.existsSync(older.sessionPath), true);
    assert.equal(fs.existsSync(newer.sessionPath), false);
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, store.findSessionByCodexThreadId('019e7d66-0000-7000-8000-000000000101')?.id);
    const archivedEntries = fs.readdirSync(path.join(process.env.CODEX_HOME!, 'archived_sessions'));
    assert.equal(archivedEntries.length, 1);
    assert.match(archivedEntries[0] || '', /019e7d66-0000-7000-8000-000000000102\.jsonl$/);

    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'archived_sessions'), { recursive: true, force: true });
  });

  it('archives a bound Codex thread with /t archive using the binding id', async () => {
    const store = initTestContext();
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'archived_sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'session_index.jsonl'), { force: true });

    const { sessionPath } = writeCodexSessionJsonlFixture({
      threadId: '019e7d66-0000-7000-8000-000000000201',
      workDir: '/tmp/archive-binding-id',
      lines: [{
        timestamp: '2026-05-28T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '019e7d66-0000-7000-8000-000000000201',
          timestamp: '2026-05-28T00:00:00.000Z',
          cwd: '/tmp/archive-binding-id',
          originator: 'Codex CLI',
        },
      }],
    });
    const address = { channelType: 'feishu', chatId: 'chat-t-archive-binding-id' } as const;
    const binding = router.bindToCodexThread(address, '019e7d66-0000-7000-8000-000000000201', {
      workingDirectory: '/tmp/archive-binding-id',
      codexTitle: 'Archive binding id',
    });

    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-t-archive-binding-${sent.length}` };
      },
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/t archive ${binding.id.slice(0, 8)}`,
        messageId: 'incoming-t-archive-binding',
      } as any,
      `/t archive ${binding.id.slice(0, 8)}`,
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.match(sent.at(-1) || '', /已归档本地 Codex 会话/);
    assert.match(sent.at(-1) || '', /archive-binding-id/);
    assert.equal(fs.existsSync(sessionPath), false);
    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    const archivedEntries = fs.readdirSync(path.join(process.env.CODEX_HOME!, 'archived_sessions'));
    assert.equal(archivedEntries.length, 1);
    assert.match(archivedEntries[0] || '', /019e7d66-0000-7000-8000-000000000201\.jsonl$/);

    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'archived_sessions'), { recursive: true, force: true });
  });

  it('deprecates /t ls and renders actionable rich cards for empty /t and /auto ls tables', async () => {
    initTestContext();
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'session_index.jsonl'), { force: true });
    const richCards: OutboundRichCard[] = [];
    const texts: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        texts.push(message.text);
        if (message.richCard) richCards.push(message.richCard);
        return { ok: true, messageId: `reply-empty-${richCards.length}` };
      },
    };
    const emptyAddress = { channelType: 'feishu', chatId: 'chat-empty-t' } as const;

    await handleBridgeCommand(
      adapter,
      {
        address: emptyAddress,
        text: '/t ls',
        messageId: 'incoming-empty-t-ls',
      } as any,
      '/t ls',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.match(texts.at(-1) || '', /已废除 `\/t ls`/);
    assert.equal(richCards.length, 0);

    await handleBridgeCommand(
      adapter,
      {
        address: emptyAddress,
        text: '/t',
        messageId: 'incoming-empty-t',
      } as any,
      '/t',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.doesNotMatch(texts.at(-1) || '', /没有找到本地 Codex 会话/);
    assert.equal(richCards.at(-1)?.title, '');
    assert.equal(richCards.at(-1)?.tableBlocks?.[0]?.table.rows.length, 0);
    assert.deepEqual(richCards.at(-1)?.tableBlocks?.[0]?.selects?.map((select) => select.id), ['codex_limit_select', 'thread_runtime_select']);
    assert.deepEqual(richCards.at(-1)?.tableBlocks?.[0]?.selects?.[0]?.options.map((option) => option.text), ['显示 20', '显示 50', '显示 100']);
    assert.deepEqual(
      richCards.at(-1)?.tableBlocks?.[0]?.actions?.map((row) => row.map((action) => action.text)),
      [['接管', '归档', '新建'], ['解绑', '刷新']],
    );

    const autoAddress = { channelType: 'feishu', chatId: 'chat-empty-auto' } as const;
    router.createBinding(autoAddress, 'D:\\workspace\\empty-auto');
    await handleBridgeCommand(
      adapter,
      {
        address: autoAddress,
        text: '/auto ls',
        messageId: 'incoming-empty-auto-ls',
      } as any,
      '/auto ls',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(richCards.at(-1)?.title, '当前聊天自动化任务（0）');
    assert.equal(richCards.at(-1)?.template, 'green');
    assert.equal(richCards.at(-1)?.table?.rows.length, 0);
    assert.equal(richCards.at(-1)?.selects, undefined);
    assert.deepEqual(richCards.at(-1)?.actions?.flat().map((action) => action.text), ['安装skill', '刷新']);
  });

  it('shows another chat bridge_id in the /t global list', async () => {
    initTestContext();
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'session_index.jsonl'), { force: true });
    writeCodexSessionJsonlFixture({
      threadId: '019e7d66-0000-7000-8000-000000000301',
      workDir: 'D:\\workspace\\shared-other',
    });

    const otherAddress = { channelType: 'feishu', chatId: 'chat-other-binding' } as const;
    const otherBinding = router.bindToCodexThread(otherAddress, '019e7d66-0000-7000-8000-000000000301', {
      workingDirectory: 'D:\\workspace\\shared-other',
      codexTitle: 'Other Chat Thread',
    });
    const sent: Array<{ text: string; richCard?: OutboundRichCard }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        sent.push(message);
        return { ok: true, messageId: `reply-other-binding-${sent.length}` };
      },
    };

    await handleBridgeCommand(
      adapter,
      {
        address: { channelType: 'feishu', chatId: 'chat-current-binding-view' },
        text: '/t',
        messageId: 'incoming-other-binding-view',
      } as any,
      '/t',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const row = sent.at(-1)?.richCard?.tableBlocks?.[0]?.table.rows?.find((candidate) => (
      String(candidate.thread_id || '').includes('019e7d66-0000-7000-8000-000000000301')
    ));
    assert.ok(row);
    assert.equal(row.index, "<number_tag background_color='grey-500' font_color='white'>1</number_tag>");
    assert.match(String(row.bridge_id || ''), new RegExp(`<font color='grey-500'>${otherBinding.bridgeSessionId.slice(0, 8)}</font>`));
    assert.match(sent.at(-1)?.text || '', new RegExp(otherBinding.bridgeSessionId.slice(0, 8)));
  });

  it('requires confirmation before /t takes over a session bound to another chat', async () => {
    const store = initTestContext();
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'session_index.jsonl'), { force: true });
    const threadId = '019e7d66-0000-7000-8000-000000000401';
    writeCodexSessionJsonlFixture({
      threadId,
      workDir: 'D:\\workspace\\takeover-other',
    });

    const otherAddress = { channelType: 'feishu', chatId: 'chat-takeover-other' } as const;
    const currentAddress = { channelType: 'feishu', chatId: 'chat-takeover-current' } as const;
    const otherBinding = router.bindToCodexThread(otherAddress, threadId, {
      workingDirectory: 'D:\\workspace\\takeover-other',
      codexTitle: 'Takeover Other',
    });
    const sent: Array<{ text: string; richCard?: OutboundRichCard }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        sent.push(message);
        return { ok: true, messageId: `reply-takeover-${sent.length}` };
      },
    };
    const deps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
    };

    await handleBridgeCommand(adapter, {
      address: currentAddress,
      text: `/t ${threadId}`,
      messageId: 'incoming-takeover-ask',
    } as any, `/t ${threadId}`, deps);

    assert.match(sent.at(-1)?.text || '', /确认接管会话/);
    assert.equal(sent.at(-1)?.richCard?.title, '确认接管会话');
    assert.equal(store.getChannelChat(otherAddress.channelType, otherAddress.chatId)?.id, otherBinding.id);
    assert.equal(store.getChannelChat(currentAddress.channelType, currentAddress.chatId), null);

    await handleBridgeCommand(adapter, {
      address: currentAddress,
      text: `/t ${threadId} --takeover-yes`,
      messageId: 'incoming-takeover-confirm',
    } as any, `/t ${threadId} --takeover-yes`, deps);

    assert.match(sent.at(-1)?.text || '', /已切换到本地 Codex 会话/);
    assert.equal(store.getChannelChat(otherAddress.channelType, otherAddress.chatId), null);
    assert.equal(store.getChannelChat(currentAddress.channelType, currentAddress.chatId)?.bridgeSessionId, otherBinding.bridgeSessionId);
  });

  it('rejects /t takeover when the target session is running', async () => {
    const store = initTestContext();
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'session_index.jsonl'), { force: true });
    const threadId = '019e7d66-0000-7000-8000-000000000402';
    writeCodexSessionJsonlFixture({
      threadId,
      workDir: 'D:\\workspace\\takeover-running',
    });
    const otherAddress = { channelType: 'feishu', chatId: 'chat-takeover-running-other' } as const;
    const currentAddress = { channelType: 'feishu', chatId: 'chat-takeover-running-current' } as const;
    const otherBinding = router.bindToCodexThread(otherAddress, threadId, {
      workingDirectory: 'D:\\workspace\\takeover-running',
      codexTitle: 'Takeover Running',
    });
    store.updateSession(otherBinding.bridgeSessionId, { runtime_status: 'running' });

    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-takeover-running-${sent.length}` };
      },
    };

    await handleBridgeCommand(adapter, {
      address: currentAddress,
      text: `/t ${threadId}`,
      messageId: 'incoming-takeover-running',
    } as any, `/t ${threadId}`, {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
    });

    assert.match(sent.at(-1) || '', /不能接管正在运行的会话/);
    assert.equal(store.getChannelChat(otherAddress.channelType, otherAddress.chatId)?.id, otherBinding.id);
    assert.equal(store.getChannelChat(currentAddress.channelType, currentAddress.chatId), null);
  });

  it('unbinds the current chat with /t unbind and creates a fresh temporary binding', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-t-unbind-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-t-unbind' } as const;
    const original = router.createBinding(address, 'D:\\workspace\\unbind-original');
    const originalSession = store.getSession(original.bridgeSessionId);
    assert.ok(originalSession);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/t unbind',
        messageId: 'incoming-t-unbind',
      } as any,
      '/t unbind',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const nextBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(nextBinding);
    assert.notEqual(nextBinding.id, original.id);
    assert.notEqual(nextBinding.bridgeSessionId, original.bridgeSessionId);
    assert.equal(store.getSession(original.bridgeSessionId)?.id, original.bridgeSessionId);
    assert.equal(store.getSession(nextBinding.bridgeSessionId)?.session_type, 'normal');
    assert.equal(store.getSession(nextBinding.bridgeSessionId)?.hidden, true);
    assert.match(sent.at(-1) || '', /当前聊天已解绑/);
    assert.match(sent.at(-1) || '', /新的临时 BridgeSession/);

    const draftSessionId = nextBinding.bridgeSessionId;
    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/t ${original.bridgeSessionId}`,
        messageId: 'incoming-t-unbind-switch-back',
      } as any,
      `/t ${original.bridgeSessionId}`,
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, original.bridgeSessionId);
    assert.equal(store.getSession(draftSessionId), null);
    assert.match(sent.at(-1) || '', /已切换到 Bridge 会话/);
  });

  it('switches /t targets directly without activation subcommands', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-t-name-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-t-name' } as const;
    router.createBinding(address, 'D:\\workspace\\current-name');
    const firstSession = store.createSession('前端修复', 'test-model', undefined, 'D:\\workspace\\first-name');
    const secondSession = store.createSession('后端修复', 'test-model', undefined, 'D:\\workspace\\second-name');
    const first = router.bindToSession(address, firstSession.id);
    assert.ok(first);
    store.updateSession(first.bridgeSessionId, { name: '前端修复' });
    store.updateSession(secondSession.id, { name: '后端修复' });

    const deps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/t 后端修复',
        messageId: 'incoming-t-direct-name',
      } as any,
      '/t 后端修复',
      deps,
    );
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, secondSession.id);
    assert.match(sent.at(-1) || '', /已切换到 Bridge 会话|当前线程已切换/);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/t ${first.bridgeSessionId}`,
        messageId: 'incoming-t-direct-bridge-id',
      } as any,
      `/t ${first.bridgeSessionId}`,
      deps,
    );
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.id, first.id);

    const codexTitleSession = store.createSession('', 'test-model', undefined, 'D:\\workspace\\codex-title-only');
    store.updateSession(codexTitleSession.id, { name: '', runtime: { codex: { title: '标题回退' } } });

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/t 标题回退',
        messageId: 'incoming-t-direct-codex-title-fallback',
      } as any,
      '/t 标题回退',
      deps,
    );
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, codexTitleSession.id);
    assert.match(sent.at(-1) || '', /已切换到 Bridge 会话|当前线程已切换/);

  });

  it('creates, lists, and removes /auto tasks on the current bridge session', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    const richCards: OutboundRichCard[] = [];
    const richCardUpdateMessageIds: Array<string | undefined> = [];
    const started: string[] = [];
    const stopped: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard; richCardUpdateMessageId?: string }) => {
        sent.push(message.text);
        if (message.richCard) richCards.push(message.richCard);
        richCardUpdateMessageIds.push(message.richCardUpdateMessageId);
        return { ok: true, messageId: `reply-auto-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-auto' } as const;
    const firstSession = store.createSession('auto-first', 'test-model', undefined, 'D:\\workspace\\auto-first');
    const second = router.createBinding(address, 'D:\\workspace\\auto-second');
    store.updateSession(firstSession.id, { last_progress_at: '2026-06-01T08:00:00.000Z' }, { touch: false });
    store.updateSession(second.bridgeSessionId, { last_progress_at: '2026-06-01T09:00:00.000Z' }, { touch: false });
    const scriptDir = path.join(process.env.CODEX_HOME!, 'auto-scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, `clk-auto-${Date.now()}.sh`);
    fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nprintf "check progress\\n"\n', 'utf-8');
    fs.chmodSync(scriptPath, 0o755);

    const deps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
      startAutoTask: (taskId: string) => { started.push(taskId); },
      stopAutoTask: (taskId: string) => { stopped.push(taskId); },
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/auto-script new ${scriptPath} 3`,
        messageId: 'incoming-auto-new',
      } as any,
      `/auto-script new ${scriptPath} 3`,
      deps,
    );

    const secondTasks = listAutoTasks({ bridgeSessionId: second.bridgeSessionId, includeCompleted: true });
    assert.equal(secondTasks.length, 1);
    assert.equal(secondTasks[0].bridgeSessionId, second.bridgeSessionId);
    assert.equal((secondTasks[0] as any).bindingId, undefined);
    assert.deepEqual(started, [secondTasks[0].id]);
    assert.match(sent.at(-1) || '', /已创建自动化任务/);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/auto ls',
        messageId: 'incoming-auto-ls',
      } as any,
      '/auto ls',
      deps,
    );

    assert.match(sent.at(-1) || '', /当前聊天自动化任务/);
    assert.match(sent.at(-1) || '', /session runtime-id/);
    assert.equal(richCards.at(-1)?.template, 'green');
    assert.equal(richCards.at(-1)?.title, '当前聊天自动化任务（1）');
    assert.equal(richCards.at(-1)?.updateKey, `thread-card:auto:${address.channelType}:${address.chatId}`);
    assert.equal(richCards.at(-1)?.updateTtlMs, null);
    assert.equal(richCardUpdateMessageIds.at(-1), undefined);
    assert.equal(getThreadTableMessageRecord(address, 'auto')?.messageId, 'reply-auto-2');
    assert.deepEqual(richCards.at(-1)?.table?.columns.map((column) => column.name), [
      'index',
      'session_title',
      'task',
      'trigger_timing',
      'created_at',
      'triggered_count',
      'last_triggered_at',
      'times',
      'runtime_id',
      'command',
    ]);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/t ${firstSession.id}`,
        messageId: 'incoming-auto-switch',
      } as any,
      `/t ${firstSession.id}`,
      deps,
    );
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, firstSession.id);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/auto ls',
        messageId: 'incoming-auto-ls-first',
      } as any,
      '/auto ls',
      deps,
    );
    assert.match(sent.at(-1) || '', /当前聊天自动化任务/);
    assert.equal(richCardUpdateMessageIds.at(-1), undefined);
    assert.equal(getThreadTableMessageRecord(address, 'auto')?.messageId, 'reply-auto-4');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/auto set 1 2',
        messageId: 'incoming-auto-set',
      } as any,
      '/auto set 1 2',
      deps,
    );
    assert.match(sent.at(-1) || '', /已更新自动化任务次数/);
    assert.equal(listAutoTasks({ bridgeSessionId: second.bridgeSessionId, includeCompleted: true })[0].times, 2);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/t ${second.bridgeSessionId}`,
        messageId: 'incoming-auto-switch-back',
      } as any,
      `/t ${second.bridgeSessionId}`,
      deps,
    );
    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/auto rm 1',
        messageId: 'incoming-auto-rm',
      } as any,
      '/auto rm 1',
      deps,
    );

    assert.equal(listAutoTasks({ bridgeSessionId: second.bridgeSessionId, includeCompleted: true }).length, 0);
    assert.deepEqual(stopped, [secondTasks[0].id]);
    assert.match(sent.at(-1) || '', /已删除自动化任务/);
  });

  it('renders /auto task runtime identity for Claude sessions', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    const richCards: OutboundRichCard[] = [];
    const started: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        sent.push(message.text);
        if (message.richCard) richCards.push(message.richCard);
        return { ok: true, messageId: `reply-auto-claude-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-auto-claude' } as const;
    const binding = router.createBinding(address, '/tmp/auto-claude');
    const claudeSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    store.updateSession(binding.bridgeSessionId, {
      runtime: {
        activeRuntime: 'claude',
        claude: { sessionId: claudeSessionId, cwd: '/tmp/auto-claude' },
        general: { workingDirectory: '/tmp/auto-claude' },
      },
    });
    const scriptDir = path.join(process.env.CODEX_HOME!, 'auto-scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, `clk-auto-claude-${Date.now()}.sh`);
    fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nprintf "check claude\\n"\n', 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
    const deps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
      startAutoTask: (taskId: string) => { started.push(taskId); },
    };

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/auto-script new ${scriptPath} 2`,
        messageId: 'incoming-auto-claude-new',
      } as any,
      `/auto-script new ${scriptPath} 2`,
      deps,
    );

    assert.match(sent.at(-1) || '', /session runtime-id/);
    assert.match(sent.at(-1) || '', new RegExp(claudeSessionId));
    const tasks = listAutoTasks({ bridgeSessionId: binding.bridgeSessionId, includeCompleted: true });
    assert.equal(tasks.length, 1);
    assert.deepEqual(started, [tasks[0].id]);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/auto ls',
        messageId: 'incoming-auto-claude-ls',
      } as any,
      '/auto ls',
      deps,
    );

    assert.match(sent.at(-1) || '', /session runtime-id/);
    assert.match(sent.at(-1) || '', new RegExp(claudeSessionId));
    assert.equal(richCards.at(-1)?.table?.columns.some((column) => column.name === 'runtime_id'), true);
  });

  it('rejects /auto scripts outside Codex home', async () => {
    initTestContext();
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-auto-outside-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-auto-outside' } as const;
    router.createBinding(address, 'D:\\workspace\\auto-outside');
    const scriptPath = path.join(os.tmpdir(), `clk-auto-outside-${Date.now()}.sh`);
    fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nprintf "check progress\\n"\n', 'utf-8');
    fs.chmodSync(scriptPath, 0o755);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: `/auto-script new ${scriptPath} 1`,
        messageId: 'incoming-auto-outside-new',
      } as any,
      `/auto-script new ${scriptPath} 1`,
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.match(sent.at(-1) || '', /自动化脚本必须位于 Codex home 下/);
  });

  it('maps /stop to C-c for a running tmux provider mirror turn', async () => {
    const store = initTestContext();
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    const sent: string[] = [];
    const forcedStops: Array<{ sessionId: string; detail?: string }> = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-stop-tmux-provider' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-stop-tmux-provider' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\stop-tmux-provider');
    store.updateSession(binding.bridgeSessionId, {
      runtime: {
        general: { tmuxSessionName: 'alpha' },
      },
      mirror_status: 'watching',
      runtime_status: 'running',
      health_status: 'running_active',
    });
    createConfigService({ migrate: false, env: {} }).set(
      { kind: 'session', sessionId: binding.bridgeSessionId },
      { runtime: { codex: { provider: 'tmux' } } },
    );

    try {
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/stop',
          messageId: 'incoming-stop-tmux-provider',
        } as any,
        '/stop',
        {
          getActiveTask: () => undefined,
          forceStopSession: async (sessionId, detail) => {
            forcedStops.push({ sessionId, detail });
            return false;
          },
          diagnoseSessionHealth: async () => null,
          diagnoseAllActiveSessions: async () => [],
        },
      );

      const log = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(log, /send-keys -t alpha C-c/);
      assert.deepEqual(forcedStops, []);
      assert.match(sent[0] || '', /已发送停止按键/);
      assert.match(sent[0] || '', /tmux send-keys -t alpha C-c/);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) {
        delete process.env.TMUX_FAKE_LOG;
      } else {
        process.env.TMUX_FAKE_LOG = oldFakeLog;
      }
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('renames the current /t binding and rejects ambiguous identifier-like names', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    const renamedGroups: Array<{ chatId: string; name: string }> = [];
    const richCards: OutboundRichCard[] = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string; richCard?: OutboundRichCard }) => {
        sent.push(message.text);
        if (message.richCard) richCards.push(message.richCard);
        return { ok: true, messageId: `reply-rename-${sent.length}` };
      },
      renameGroupChat: async (chatId: string, name: string) => {
        renamedGroups.push({ chatId, name });
        return { chatId, chatKind: 'group' as const, name };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-rename', chatKind: 'group' as const } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\rename');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/t rename 12345',
        messageId: 'incoming-rename-1',
      } as any,
      '/t rename 12345',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(store.getSession(binding.bridgeSessionId)?.name, 'Bridge: chat-rename');
    assert.match(sent[0] || '', /名称不能是纯数字/);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/t rename 前端修复',
        messageId: 'incoming-rename-2',
      } as any,
      '/t rename 前端修复',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.equal(store.getSession(binding.bridgeSessionId)?.name, '前端修复');
    assert.deepEqual(renamedGroups, [{ chatId: 'chat-rename', name: '前端修复' }]);
    assert.match(sent[1] || '', /当前线程已重命名/);
    assert.match(sent[1] || '', /群聊名称.*前端修复/s);
    assert.match(sent[1] || '', /bridge_id/);
    assert.equal(richCards.length, 0);
    assert.equal(fs.existsSync(path.join(DATA_DIR, 'ui-session-meta.json')), false);
  });

  it('prints file content with /cat and escapes embedded fences', async () => {
    initTestContext();
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu-default',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-cat' };
      },
    };
    const address = { channelType: 'feishu-default', chatId: 'chat-cat' } as const;
    const tempRoot = fs.mkdtempSync(path.join(DATA_DIR, 'clk-cat-'));
    const filePath = path.join(tempRoot, 'demo.md');
    fs.writeFileSync(filePath, ['line1', '```', 'line3'].join('\n'), 'utf-8');
    router.createBinding(address, tempRoot);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/cat demo.md',
        messageId: 'incoming-cat',
      } as any,
      '/cat demo.md',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.match(sent[0] || '', /````text/);
  });

  it('sends a local file with /file', async () => {
    initTestContext();
    const sent: any[] = [];
    const adapter: any = {
      channelType: 'feishu-default',
      provider: 'feishu',
      send: async (message: any) => {
        sent.push(message);
        return { ok: true, messageId: `reply-${sent.length}` };
      },
    };
    const address = { channelType: 'feishu-default', chatId: 'chat-file' } as const;
    const tempRoot = fs.mkdtempSync(path.join(DATA_DIR, 'clk-file-'));
    const filePath = path.join(tempRoot, 'hello.txt');
    fs.writeFileSync(filePath, 'hello', 'utf-8');
    router.createBinding(address, tempRoot);

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/file hello.txt',
        messageId: 'incoming-file',
      } as any,
      '/file hello.txt',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    assert.ok(sent.some((m) => Array.isArray(m.attachments) && m.attachments.length === 1));
    assert.match(String(sent.at(-1)?.text || ''), /已发送文件/);
  });

  it('reports tmux selection prompts through shared attach and screen inspection', async () => {
    initTestContext();
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldCaptureText = process.env.TMUX_FAKE_CAPTURE_TEXT;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_CAPTURE_TEXT = [
      'A task is already running.',
      'Do you want to replace the current goal?',
      '› 1. Replace current goal',
      '  2. Cancel',
      'Press enter to confirm or esc to cancel',
    ].join('\n');

    try {
      const sent: string[] = [];
      const adapter: any = {
        channelType: 'feishu',
        send: async (message: { text: string }) => {
          sent.push(message.text);
          return { ok: true, messageId: `reply-tmux-selection-${sent.length}` };
        },
      };
      const address = { channelType: 'feishu', chatId: 'chat-tmux-selection' } as const;
      const deps = {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      };

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-attach alpha',
          messageId: 'incoming-tmux-selection-attach',
        } as any,
        '/tmux-attach alpha',
        deps,
      );
      assert.match(sent.at(-1) || '', /已绑定 tmux session/);
      assert.match(sent.at(-1) || '', /Selection.*Codex goal selection prompt/s);
      assert.match(sent.at(-1) || '', /默认动作：cancel/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-screen',
          messageId: 'incoming-tmux-selection-screen',
        } as any,
        '/tmux-screen',
        deps,
      );
      assert.match(sent.at(-1) || '', /tmux 当前屏幕状态/);
      assert.match(sent.at(-1) || '', /检测到 Codex goal selection prompt/);
      assert.match(sent.at(-1) || '', /tmux has-session -t alpha/);
      assert.match(sent.at(-1) || '', /tmux capture-pane -t alpha -p -S -0/);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldCaptureText === undefined) delete process.env.TMUX_FAKE_CAPTURE_TEXT;
      else process.env.TMUX_FAKE_CAPTURE_TEXT = oldCaptureText;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('binds a tmux session, sends literal text and tmux-key special keys, and returns a capture', async () => {
    const store = initTestContext();
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;

    try {
      const sent: string[] = [];
      const richCards: any[] = [];
      const adapter: any = {
        channelType: 'feishu',
        send: async (message: { text: string; richCard?: any }) => {
          sent.push(message.text);
          if (message.richCard) richCards.push(message.richCard);
          return { ok: true, messageId: `reply-tmux-${sent.length}` };
        },
      };
      const address = { channelType: 'feishu', chatId: 'chat-tmux' } as const;
      const deps = {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      };

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-switch',
          messageId: 'incoming-tmux-switch',
        } as any,
        '/tmux-switch',
        deps,
      );
      assert.match(sent.at(-1) || '', /alpha/);
      assert.match(sent.at(-1) || '', /\/tmux-attach <session>|\/tmux-attach &lt;session&gt;/);
      assert.match(sent.at(-1) || '', /真实 tmux 底层命令/);
      assert.match(sent.at(-1) || '', /tmux list-sessions -F/);
      assert.equal(richCards.at(-1)?.title, 'tmux session 选择');
      assert.deepEqual(
        richCards.at(-1)?.table?.columns?.map((column: any) => column.name),
        ['session', 'windows', 'attached', 'command'],
      );
      assert.equal(richCards.at(-1)?.table?.freezeFirstColumn, false);
      assert.equal(richCards.at(-1)?.table?.rows?.[0]?.session, 'alpha');
      assert.match(richCards.at(-1)?.table?.rows?.[0]?.command || '', /^\/tmux-attach /);
      assert.equal(richCards.at(-1)?.selects?.[0]?.options?.[0]?.text, 'alpha');
      assert.match(richCards.at(-1)?.selects?.[0]?.options?.[0]?.callbackData || '', /^clk-command:/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-attach alpha',
          messageId: 'incoming-tmux-attach',
        } as any,
        '/tmux-attach alpha',
        deps,
      );
      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      const session = binding ? store.getSession(binding.bridgeSessionId) : null;
      assert.equal(session?.runtime?.general?.tmuxSessionName, 'alpha');
      assert.equal(getSessionTmuxSessionName(store.getSession(binding.bridgeSessionId)), 'alpha');
      assert.match(sent.at(-1) || '', /已绑定 tmux session/);
      assert.match(sent.at(-1) || '', /```sh/);
      assert.match(sent.at(-1) || '', /alpha-screen/);
      assert.match(sent.at(-1) || '', /tmux has-session -t alpha/);
      assert.match(sent.at(-1) || '', /tmux capture-pane -t alpha -p -S -0/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-set lines 120',
          messageId: 'incoming-tmux-set',
        } as any,
        '/tmux-set lines 120',
        deps,
      );
      const updatedSession = binding ? store.getSession(binding.bridgeSessionId) : null;
      assert.equal(updatedSession?.runtime?.general?.captureLines, undefined);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('session.tmuxCaptureLines', {
          kind: 'session',
          sessionId: binding.bridgeSessionId,
        }),
        120,
      );
      store.updateSession(binding.bridgeSessionId, { runtime: { general: { captureLines: undefined } } });
      assert.equal(getSessionTmuxCaptureLines(store.getSession(binding.bridgeSessionId)), 120);
      assert.doesNotMatch(sent.at(-1) || '', /真实 tmux 底层命令/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-set enter on',
          messageId: 'incoming-tmux-set-enter-on',
        } as any,
        '/tmux-set enter on',
        deps,
      );
      const autoEnterSession = binding ? store.getSession(binding.bridgeSessionId) : null;
      assert.equal(autoEnterSession?.runtime?.general?.autoEnter, undefined);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('session.tmuxAutoEnter', {
          kind: 'session',
          sessionId: binding.bridgeSessionId,
        }),
        true,
      );
      store.updateSession(binding.bridgeSessionId, { runtime: { general: { autoEnter: undefined } } });
      assert.equal(getSessionTmuxAutoEnter(store.getSession(binding.bridgeSessionId)), true);
      assert.match(sent.at(-1) || '', /自动回车.*on/s);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-set echo on',
          messageId: 'incoming-tmux-set-echo-on',
        } as any,
        '/tmux-set echo on',
        deps,
      );
      const echoOnSession = binding ? store.getSession(binding.bridgeSessionId) : null;
      assert.equal(echoOnSession?.runtime?.general?.echoInput, undefined);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('session.tmuxEchoInput', {
          kind: 'session',
          sessionId: binding.bridgeSessionId,
        }),
        true,
      );
      store.updateSession(binding.bridgeSessionId, { runtime: { general: { echoInput: undefined } } });
      assert.equal(getSessionTmuxEchoInput(store.getSession(binding.bridgeSessionId)), true);
      assert.match(sent.at(-1) || '', /输入回显.*on/s);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux echo visible',
          messageId: 'incoming-tmux-echo-visible',
        } as any,
        '/tmux echo visible',
        deps,
      );
      const echoResponse = sent.at(-1) || '';
      assert.match(echoResponse, /tmux 输入回显/);
      assert.match(echoResponse, /echo visible/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-set echo off',
          messageId: 'incoming-tmux-set-echo-off',
        } as any,
        '/tmux-set echo off',
        deps,
      );
      const echoOffSession = binding ? store.getSession(binding.bridgeSessionId) : null;
      assert.equal(echoOffSession?.runtime?.general?.echoInput, undefined);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('session.tmuxEchoInput', {
          kind: 'session',
          sessionId: binding.bridgeSessionId,
        }),
        false,
      );

      const beforeProviderForwardSent = sent.length;
      const beforeProviderForwardLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux provider hidden',
          messageId: 'incoming-tmux-provider-forward',
        } as any,
        '/tmux provider hidden',
        { ...deps, tmuxProviderAutoForward: true },
      );
      assert.equal(sent.length, beforeProviderForwardSent);
      const providerForwardLogDelta = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeProviderForwardLog.length);
      assert.match(providerForwardLogDelta, /send-keys -t alpha -l provider hidden/);
      assert.match(providerForwardLogDelta, /send-keys -t alpha Enter/);
      assert.doesNotMatch(providerForwardLogDelta, /capture-pane/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux echo auto',
          messageId: 'incoming-tmux-auto-enter',
        } as any,
        '/tmux echo auto',
        deps,
      );
      const autoEnterResponse = sent.at(-1) || '';
      assert.match(autoEnterResponse, /tmux send-keys -t alpha -l 'echo auto'/);
      assert.match(autoEnterResponse, /tmux send-keys -t alpha Enter/);

      const longLiteral = `long-${'0123456789'.repeat(130)}`;
      const beforeLongLiteralLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: `/tmux ${longLiteral}`,
          messageId: 'incoming-tmux-long-literal',
        } as any,
        `/tmux ${longLiteral}`,
        deps,
      );
      const longLiteralLogDelta = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeLongLiteralLog.length);
      assert.match(longLiteralLogDelta, /load-buffer -b clk-paste-/);
      assert.match(longLiteralLogDelta, /paste-buffer -d -p -b clk-paste-/);
      assert.ok((longLiteralLogDelta.match(/send-keys -t alpha End/g) || []).length >= 3);
      assert.doesNotMatch(longLiteralLogDelta, new RegExp(`send-keys -t alpha -l ${longLiteral}`));
      assert.match(longLiteralLogDelta, /send-keys -t alpha Enter/);

      const beforeExplicitEnterLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      const beforeExplicitEnterCount = (beforeExplicitEnterLog.match(/send-keys -t alpha Enter/g) || []).length;
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux echo <literal>',
          messageId: 'incoming-tmux-auto-enter-explicit',
        } as any,
        '/tmux echo <literal>',
        deps,
      );
      const afterExplicitEnterLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      const afterExplicitEnterCount = (afterExplicitEnterLog.match(/send-keys -t alpha Enter/g) || []).length;
      assert.equal(afterExplicitEnterCount - beforeExplicitEnterCount, 1);
      const explicitEnterLogDelta = afterExplicitEnterLog.slice(beforeExplicitEnterLog.length);
      assert.match(explicitEnterLogDelta, /send-keys -t alpha -l echo <literal>/);

      const beforeKeyOnlyLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux <C-c>',
          messageId: 'incoming-tmux-direct-key-only',
        } as any,
        '/tmux <C-c>',
        deps,
      );
      const keyOnlyResponse = sent.at(-1) || '';
      assert.match(keyOnlyResponse, /tmux send-keys -t alpha C-c/);
      assert.doesNotMatch(keyOnlyResponse, /tmux send-keys -t alpha -l '<C-c>'/);
      const keyOnlyLogDelta = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeKeyOnlyLog.length);
      assert.match(keyOnlyLogDelta, /send-keys -t alpha C-c/);
      assert.doesNotMatch(keyOnlyLogDelta, /send-keys -t alpha Enter/);
      assert.doesNotMatch(keyOnlyLogDelta, /send-keys -t alpha -l <C-c>/);

      const beforeKeySequenceLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux <C-c><Enter>',
          messageId: 'incoming-tmux-direct-key-sequence',
        } as any,
        '/tmux <C-c><Enter>',
        deps,
      );
      const keySequenceResponse = sent.at(-1) || '';
      assert.match(keySequenceResponse, /tmux send-keys -t alpha C-c/);
      assert.match(keySequenceResponse, /tmux send-keys -t alpha Enter/);
      assert.doesNotMatch(keySequenceResponse, /tmux send-keys -t alpha -l '<C-c><Enter>'/);
      const keySequenceLogDelta = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeKeySequenceLog.length);
      assert.match(keySequenceLogDelta, /send-keys -t alpha C-c/);
      assert.match(keySequenceLogDelta, /send-keys -t alpha Enter/);
      assert.doesNotMatch(keySequenceLogDelta, /send-keys -t alpha -l <C-c><Enter>/);

      const beforeInvalidKeyLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux <entent>',
          messageId: 'incoming-tmux-invalid-direct-key',
        } as any,
        '/tmux <entent>',
        deps,
      );
      const invalidKeyResponse = sent.at(-1) || '';
      assert.match(invalidKeyResponse, /特殊键序列不合法|不支持的特殊键/);
      const invalidKeyLogDelta = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeInvalidKeyLog.length);
      assert.doesNotMatch(invalidKeyLogDelta, /send-keys/);

      const beforeMixedDirectLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux <C-c> hello',
          messageId: 'incoming-tmux-direct-mixed-falls-back-literal',
        } as any,
        '/tmux <C-c> hello',
        deps,
      );
      const mixedDirectResponse = sent.at(-1) || '';
      assert.match(mixedDirectResponse, /tmux send-keys -t alpha -l '<C-c> hello'/);
      assert.match(mixedDirectResponse, /tmux send-keys -t alpha Enter/);
      const mixedDirectLogDelta = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeMixedDirectLog.length);
      assert.match(mixedDirectLogDelta, /send-keys -t alpha -l <C-c> hello/);
      assert.doesNotMatch(mixedDirectLogDelta, /send-keys -t alpha C-c/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-set enter off',
          messageId: 'incoming-tmux-set-enter-off',
        } as any,
        '/tmux-set enter off',
        deps,
      );
      const autoEnterOffSession = binding ? store.getSession(binding.bridgeSessionId) : null;
      assert.equal(autoEnterOffSession?.runtime?.general?.autoEnter, undefined);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('session.tmuxAutoEnter', {
          kind: 'session',
          sessionId: binding.bridgeSessionId,
        }),
        false,
      );

      const beforeAutoEnterOffLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux echo off',
          messageId: 'incoming-tmux-auto-enter-off',
        } as any,
        '/tmux echo off',
        deps,
      );
      const autoEnterOffResponse = sent.at(-1) || '';
      assert.match(autoEnterOffResponse, /tmux send-keys -t alpha -l 'echo off'/);
      assert.doesNotMatch(autoEnterOffResponse, /tmux send-keys -t alpha Enter/);
      const afterAutoEnterOffLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      const autoEnterOffLogDelta = afterAutoEnterOffLog.slice(beforeAutoEnterOffLog.length);
      assert.match(autoEnterOffLogDelta, /send-keys -t alpha -l echo off/);
      assert.doesNotMatch(autoEnterOffLogDelta, /send-keys -t alpha Enter/);

      const beforeScreenLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-screen',
          messageId: 'incoming-screen',
        } as any,
        '/tmux-screen',
        deps,
      );
      const screenResponse = sent.at(-1) || '';
      assert.match(screenResponse, /tmux 当前屏幕状态/);
      assert.match(screenResponse, /```sh/);
      assert.match(screenResponse, /alpha-screen/);
      assert.match(screenResponse, /真实 tmux 底层命令/);
      assert.match(screenResponse, /tmux capture-pane -t alpha -p -S -120/);
      const screenLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      const screenLogDelta = screenLog.slice(beforeScreenLog.length);
      assert.match(screenLogDelta, /capture-pane -t alpha -p -S -120/);
      assert.doesNotMatch(screenLogDelta, /send-keys/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-screen 42',
          messageId: 'incoming-screen-lines',
        } as any,
        '/tmux-screen 42',
        deps,
      );
      const tempLinesResponse = sent.at(-1) || '';
      assert.match(tempLinesResponse, /展示行数.*42/s);
      assert.match(tempLinesResponse, /tmux capture-pane -t alpha -p -S -42/);
      const afterTempLinesSession = binding ? store.getSession(binding.bridgeSessionId) : null;
      assert.equal(getSessionTmuxCaptureLines(afterTempLinesSession), 120);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-screen 5s',
          messageId: 'incoming-screen-watch-default-lines',
        } as any,
        '/tmux-screen 5s',
        deps,
      );
      const defaultLinesWatchResponse = sent.at(-1) || '';
      assert.match(defaultLinesWatchResponse, /展示行数.*120/s);
      assert.match(defaultLinesWatchResponse, /定时刷新.*5s/s);
      assert.match(defaultLinesWatchResponse, /tmux capture-pane -t alpha -p -S -120/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-screen 30 1s',
          messageId: 'incoming-screen-watch',
        } as any,
        '/tmux-screen 30 1s',
        deps,
      );
      const watchResponse = sent.at(-1) || '';
      assert.match(watchResponse, /展示行数.*30/s);
      assert.match(watchResponse, /定时刷新.*3s/s);
      assert.match(watchResponse, /\/tmux-screen stop/);
      assert.match(watchResponse, /tmux capture-pane -t alpha -p -S -30/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-screen lines 120 every 5s',
          messageId: 'incoming-screen-invalid-legacy',
        } as any,
        '/tmux-screen lines 120 every 5s',
        deps,
      );
      assert.match(sent.at(-1) || '', /tmux 屏幕用法/);
      assert.doesNotMatch(sent.at(-1) || '', /lines 120 every/);
      assert.doesNotMatch(sent.at(-1) || '', /真实 tmux 底层命令/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-screen stop',
          messageId: 'incoming-screen-stop',
        } as any,
        '/tmux-screen stop',
        deps,
      );
      assert.match(sent.at(-1) || '', /已停止 tmux 屏幕定时刷新/);
      assert.doesNotMatch(sent.at(-1) || '', /真实 tmux 底层命令/);
      assert.equal(_testOnlyTmuxScreenMonitors.activeCount(), 0);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-key /goal 分析一下这个仓库<Enter>',
          messageId: 'incoming-tmux-slash-send',
        } as any,
        '/tmux-key /goal 分析一下这个仓库<Enter>',
        deps,
      );

      const slashResponse = sent.at(-1) || '';
      assert.match(slashResponse, /真实 tmux 底层命令/);
      assert.match(slashResponse, /tmux send-keys -t alpha -l '\/goal 分析一下这个仓库'/);
      assert.match(slashResponse, /tmux send-keys -t alpha Enter/);
      assert.doesNotMatch(slashResponse, /Option\/Alt/);

      const slashCommandLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(slashCommandLog, /send-keys -t alpha -l \/goal 分析一下这个仓库/);
      assert.match(slashCommandLog, /send-keys -t alpha Enter/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-key <Cmd+Backspace>',
          messageId: 'incoming-tmux-delete-line',
        } as any,
        '/tmux-key <Cmd+Backspace>',
        deps,
      );
      const deleteLineResponse = sent.at(-1) || '';
      assert.match(deleteLineResponse, /tmux send-keys -t alpha C-u/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-key pwd<Enter><Cmd+C>',
          messageId: 'incoming-tmux-send',
        } as any,
        '/tmux-key pwd<Enter><Cmd+C>',
        deps,
      );

      const response = sent.at(-1) || '';
      assert.match(response, /```sh/);
      assert.match(response, /alpha-screen/);
      assert.match(response, /真实 tmux 底层命令/);
      assert.match(response, /tmux send-keys -t alpha -l pwd/);
      assert.match(response, /tmux send-keys -t alpha Enter/);
      assert.match(response, /tmux send-keys -t alpha C-c/);
      assert.doesNotMatch(response, /Option\/Alt/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-keys git status<Enter>',
          messageId: 'incoming-tmux-keys-alias',
        } as any,
        '/tmux-keys git status<Enter>',
        deps,
      );
      const aliasResponse = sent.at(-1) || '';
      assert.match(aliasResponse, /tmux send-keys -t alpha -l 'git status'/);
      assert.match(aliasResponse, /tmux send-keys -t alpha Enter/);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux - starts with dash',
          messageId: 'incoming-tmux-leading-dash',
        } as any,
        '/tmux - starts with dash',
        deps,
      );
      const leadingDashResponse = sent.at(-1) || '';
      assert.match(leadingDashResponse, /tmux send-keys -t alpha -l -- '- starts with dash'/);
      assert.doesNotMatch(leadingDashResponse, /unknown option/);

      const log = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(log, /send-keys -t alpha -l pwd/);
      assert.match(log, /send-keys -t alpha -l git status/);
      assert.match(log, /send-keys -t alpha -l -- - starts with dash/);
      assert.match(log, /send-keys -t alpha -l echo auto/);
      assert.match(log, /send-keys -t alpha -l echo <literal>/);
      assert.match(log, /send-keys -t alpha -l <C-c> hello/);
      assert.match(log, /send-keys -t alpha -l echo off/);
      assert.match(log, /send-keys -t alpha Enter/);
      assert.match(log, /send-keys -t alpha C-c/);
      assert.match(log, /send-keys -t alpha C-u/);
      assert.match(log, /capture-pane -t alpha -p -S -120/);
      assert.match(log, /capture-pane -t alpha -p -S -42/);
      assert.match(log, /capture-pane -t alpha -p -S -30/);
    } finally {
      _testOnlyTmuxScreenMonitors.stopAll();
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) {
        delete process.env.TMUX_FAKE_LOG;
      } else {
        process.env.TMUX_FAKE_LOG = oldFakeLog;
      }
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('skips the tmux provider auto-forward stream card while the session is already running', async () => {
    const store = initTestContext();
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;

    try {
      const sent: string[] = [];
      const streamEvents: Array<{ kind: string; text?: string; streamKey?: string }> = [];
      const adapter: any = {
        channelType: 'feishu',
        supportsStructuredStreamingUi: () => true,
        send: async (message: { text: string }) => {
          sent.push(message.text);
          return { ok: true, messageId: `reply-tmux-running-${sent.length}` };
        },
        onMessageStart: (_chatId: string, streamKey?: string) => {
          streamEvents.push({ kind: 'start', streamKey });
        },
        onStreamText: (_chatId: string, text: string, streamKey?: string) => {
          streamEvents.push({ kind: 'text', text, streamKey });
        },
        onStreamStatus: (_chatId: string, text: string, streamKey?: string) => {
          streamEvents.push({ kind: 'status', text, streamKey });
        },
        onStreamEnd: async (_chatId: string, _status: string, text: string, streamKey?: string) => {
          streamEvents.push({ kind: 'end', text, streamKey });
          return true;
        },
      };
      const address = { channelType: 'feishu', chatId: 'chat-tmux-provider-running-forward' } as const;
      const deps = {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      };

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-attach alpha',
          messageId: 'incoming-tmux-running-attach',
        } as any,
        '/tmux-attach alpha',
        deps,
      );
      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      store.updateSession(binding.bridgeSessionId, { runtime_status: 'running' });

      const beforeProviderForwardSent = sent.length;
      const beforeProviderForwardLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux provider running',
          messageId: 'incoming-tmux-running-provider-forward',
        } as any,
        '/tmux provider running',
        { ...deps, tmuxProviderAutoForward: true },
      );

      assert.equal(sent.length, beforeProviderForwardSent);
      assert.deepEqual(streamEvents.filter((event) => /^provider-tmux:/.test(event.streamKey || '')), []);
      const providerForwardLogDelta = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeProviderForwardLog.length);
      assert.match(providerForwardLogDelta, /send-keys -t alpha -l provider running/);
      assert.match(providerForwardLogDelta, /send-keys -t alpha Enter/);
      assert.doesNotMatch(providerForwardLogDelta, /capture-pane/);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('recovers missing tmux provider sessions for explicit /tmux commands', async () => {
    const settings = makeSettings();
    settings.set('bridge_default_provider', 'tmux');
    const store = new JsonFileStore(settings, { dynamicSettings: true });
    createConfigService({ migrate: false, env: {} }).set({ kind: 'home' }, {
      runtime: { codex: { provider: 'tmux' } },
    });
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;

    try {
      const sent: string[] = [];
      const adapter: any = {
        channelType: 'feishu',
        send: async (message: { text: string }) => {
          sent.push(message.text);
          return { ok: true, messageId: `reply-tmux-recover-${sent.length}` };
        },
      };
      const address = { channelType: 'feishu', chatId: 'chat-tmux-provider-recover' } as const;
      const deps = {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      };
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-tmux-provider-recover-'));

      const binding = router.createBinding(address, workDir);
      assert.ok(binding);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, undefined);

      const threadId = '019e824e-10ef-7430-985d-4349ce6a15f9';
      const tmuxSession = `codex_${threadId}`;
      store.updateSessionCodexThreadId(binding.bridgeSessionId, threadId);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux hi manual',
          messageId: 'incoming-tmux-recover-manual',
        } as any,
        '/tmux hi manual',
        deps,
      );
      assert.doesNotMatch(sent.at(-1) || '', /tmux session 不存在/);
      let log = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(log, new RegExp(`has-session -t ${tmuxSession}`));
      assert.match(log, new RegExp(`new-session -d -s ${tmuxSession}`));
      assert.match(log, new RegExp(`resume ${threadId}`));
      assert.match(log, new RegExp(`send-keys -t ${tmuxSession} -l hi manual`));
      assert.match(log, new RegExp(`send-keys -t ${tmuxSession} Enter`));

      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, undefined);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.general?.tmuxSessionName, tmuxSession);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('routes /tmux angle-bracket stories as all-key or all-literal commands', async () => {
    initTestContext();
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;

    try {
      const sent: string[] = [];
      const adapter: any = {
        channelType: 'feishu',
        send: async (message: { text: string }) => {
          sent.push(message.text);
          return { ok: true, messageId: `reply-tmux-story-${sent.length}` };
        },
      };
      const address = { channelType: 'feishu', chatId: 'chat-tmux-angle-story' } as const;
      const deps = {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      };

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-attach alpha',
          messageId: 'incoming-tmux-story-attach',
        } as any,
        '/tmux-attach alpha',
        deps,
      );

      const beforeStoryLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux 命令1：使用<qaq>',
          messageId: 'incoming-tmux-story-literal-1',
        } as any,
        '/tmux 命令1：使用<qaq>',
        deps,
      );
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux <C-c>',
          messageId: 'incoming-tmux-story-key',
        } as any,
        '/tmux <C-c>',
        deps,
      );
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux 忽略刚才的命令，转而使用<waw>',
          messageId: 'incoming-tmux-story-literal-2',
        } as any,
        '/tmux 忽略刚才的命令，转而使用<waw>',
        deps,
      );

      const storyLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeStoryLog.length);
      assert.match(storyLog, /send-keys -t alpha -l 命令1：使用<qaq>/);
      assert.match(storyLog, /send-keys -t alpha C-c/);
      assert.match(storyLog, /send-keys -t alpha -l 忽略刚才的命令，转而使用<waw>/);
      assert.doesNotMatch(storyLog, /send-keys -t alpha qaq/);
      assert.doesNotMatch(storyLog, /send-keys -t alpha waw/);

      assert.match(sent.at(-3) || '', /tmux send-keys -t alpha -l '命令1：使用<qaq>'/);
      assert.match(sent.at(-2) || '', /tmux send-keys -t alpha C-c/);
      assert.doesNotMatch(sent.at(-2) || '', /tmux send-keys -t alpha -l '<C-c>'/);
      assert.match(sent.at(-1) || '', /tmux send-keys -t alpha -l '忽略刚才的命令，转而使用<waw>'/);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) {
        delete process.env.TMUX_FAKE_LOG;
      } else {
        process.env.TMUX_FAKE_LOG = oldFakeLog;
      }
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('updates a streaming card for timed tmux screen refresh when supported', async () => {
    const store = initTestContext();
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;

    const address = { channelType: 'feishu', chatId: 'chat-tmux-card' } as const;
    const sent: string[] = [];
    const cardTexts: Array<{ chatId: string; text: string; streamKey?: string }> = [];
    const cardStatuses: Array<{ chatId: string; text: string; streamKey?: string }> = [];
    const cardActions: Array<{ chatId: string; actions: any[][]; streamKey?: string }> = [];
    const cardEnds: Array<{ chatId: string; status: string; text: string; streamKey?: string }> = [];
    const adapter: any = {
      channelType: 'feishu',
      provider: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: `reply-tmux-card-${sent.length}` };
      },
      supportsStructuredStreamingUi: () => true,
      onStreamText: (chatId: string, text: string, streamKey?: string) => {
        cardTexts.push({ chatId, text, streamKey });
      },
      onStreamStatus: (chatId: string, text: string, streamKey?: string) => {
        cardStatuses.push({ chatId, text, streamKey });
      },
      onStreamActions: (chatId: string, actions: any[][], streamKey?: string) => {
        cardActions.push({ chatId, actions, streamKey });
      },
      onStreamEnd: async (chatId: string, status: string, text: string, streamKey?: string) => {
        cardEnds.push({ chatId, status, text, streamKey });
        return true;
      },
    };
    const deps = {
      getActiveTask: () => undefined,
      diagnoseSessionHealth: async () => null,
      diagnoseAllActiveSessions: async () => [],
    };
    let monitorStarted = false;

    try {
      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-attach alpha',
          messageId: 'incoming-tmux-card-attach',
        } as any,
        '/tmux-attach alpha',
        deps,
      );
      sent.length = 0;

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-screen 5s',
          messageId: 'incoming-tmux-card-screen',
        } as any,
        '/tmux-screen 5s',
        deps,
      );
      monitorStarted = true;

      assert.equal(sent.length, 0);
      assert.equal(cardTexts.length, 1);
      assert.equal(cardTexts[0].chatId, address.chatId);
      assert.match(cardTexts[0].streamKey || '', /^tmux-screen:/);
      assert.match(cardTexts[0].text, /tmux 当前屏幕状态/);
      assert.match(cardTexts[0].text, /alpha-screen/);
      assert.match(cardTexts[0].text, /定时刷新.*5s/s);
      assert.doesNotMatch(cardTexts[0].text, /真实 tmux 底层命令/);
      assert.equal(cardStatuses.length, 1);
      assert.match(cardStatuses[0].text, /tmux alpha/);
      assert.match(cardStatuses[0].text, /every 5s/);
      assert.equal(cardActions.length, 1);
      assert.equal(cardActions[0].chatId, address.chatId);
      assert.equal(cardActions[0].streamKey, cardTexts[0].streamKey);
      assert.equal(cardActions[0].actions[0][0].text, '停止');
      assert.match(cardActions[0].actions[0][0].callbackData, /^tmux-screen:stop:/);
      assert.equal(cardActions[0].actions[0][0].type, 'danger');
      assert.equal(cardActions[0].actions[0][0].disabled, false);

      await handleBridgeCommand(
        adapter,
        {
          address,
          text: '/tmux-screen stop',
          messageId: 'incoming-tmux-card-stop',
        } as any,
        '/tmux-screen stop',
        deps,
      );
      monitorStarted = false;

      assert.match(sent.at(-1) || '', /已停止 tmux 屏幕定时刷新/);
      assert.equal(cardActions.length, 2);
      assert.equal(cardActions[1].actions[0][0].text, '已停止');
      assert.equal(cardActions[1].actions[0][0].disabled, true);
      assert.equal(cardEnds.length, 1);
      assert.equal(cardEnds[0].chatId, address.chatId);
      assert.equal(cardEnds[0].status, 'interrupted');
      assert.match(cardEnds[0].text, /已停止 tmux 屏幕定时刷新/);
      assert.equal(cardEnds[0].streamKey, cardTexts[0].streamKey);
    } finally {
      if (monitorStarted) {
        await handleBridgeCommand(
          adapter,
          {
            address,
            text: '/tmux-screen stop',
            messageId: 'incoming-tmux-card-cleanup',
          } as any,
          '/tmux-screen stop',
          deps,
        );
      }
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) {
        delete process.env.TMUX_FAKE_LOG;
      } else {
        process.env.TMUX_FAKE_LOG = oldFakeLog;
      }
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });
});
