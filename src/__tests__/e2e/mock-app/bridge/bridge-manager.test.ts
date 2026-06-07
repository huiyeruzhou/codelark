import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CODELARK_HOME, DEFAULT_WORKSPACE_ROOT } from '../../../../configuration/paths.js';
import { createConfigService } from '../../../../configuration/service.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { getBridgeContext, initBridgeContext } from '../../../../bridge/host/context.js';
import { _testOnly, start, stop } from '../../../../bridge/host/manager.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../../../../channels/contracts.js';
import { buildCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import {
  normalizeReasoningEffort,
  parseLocalSessionListArgs,
} from '../../../../bridge/command/aliases.js';
import {
  buildLocalRuntimeSessionsCommandResponse,
  buildLocalRuntimeSessionsCommandCard,
  formatCommandDateTime,
  formatMirrorStatus,
  formatRuntimeStatus,
} from '../../../../bridge/command/presentation.js';
import {
  toUserVisibleBindingError,
  toUserVisibleCommandError,
} from '../../../../bridge/command/errors.js';
import { createMirrorSubscription } from '../../../../bridge/mirror/subscription-state.js';
import { saveStartupNoticeTarget } from '../../../../bridge/host/startup-notice-target.js';
import * as router from '../../../../bridge/host/channel-router.js';
import {
  getSessionWorkingDirectory,
  mergeSessionRuntimeUpdates,
  setSessionActiveRuntimeUpdate,
  setSessionClaudeIdentityUpdate,
} from '../../../../domain/session-runtime.js';
import type { OutboundMessage, OutboundRichCard, PermissionGateway, SendResult } from '../../../../domain/index.js';
import type { LifecycleHooks, LLMProvider, StreamChatParams } from '../../../../runtime/contracts.js';
import { writeCodexSessionJsonlFixture } from '../../../helpers/bridge/test-bridge-utils.js';
import { getClaudeProjectDir, isArchivedClaudeSession } from '../../../../runtime/claude/session-jsonl.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');
const CONFIG_TOML_PATH = path.join(CODELARK_HOME, 'config.toml');

function writeHomeConfigToml(content: string): () => void {
  const previous = fs.existsSync(CONFIG_TOML_PATH) ? fs.readFileSync(CONFIG_TOML_PATH, 'utf-8') : null;
  fs.mkdirSync(CODELARK_HOME, { recursive: true });
  fs.writeFileSync(CONFIG_TOML_PATH, content, 'utf-8');
  return () => {
    if (previous === null) fs.rmSync(CONFIG_TOML_PATH, { force: true });
    else fs.writeFileSync(CONFIG_TOML_PATH, previous, 'utf-8');
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return tomlString(String(value ?? ''));
}

function writeHomeChannelsToml(channels: Array<{
  id: string;
  alias: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}>): void {
  const lines = ['schema_version = 2', ''];
  for (const channel of channels) {
    lines.push(
      '[[channels]]',
      `id = ${tomlString(channel.id)}`,
      `alias = ${tomlString(channel.alias)}`,
      'provider = "feishu"',
      `enabled = ${channel.enabled}`,
      '',
      '[channels.config]',
    );
    for (const [key, value] of Object.entries(channel.config || {})) {
      lines.push(`${key} = ${tomlValue(value)}`);
    }
    lines.push('');
  }
  writeHomeConfigToml(lines.join('\n'));
}

function writeClaudeJsonlFixture(params: {
  homeDir: string;
  cwd: string;
  sessionId: string;
  timestamp?: string;
  text?: string;
}): string {
  const projectDir = getClaudeProjectDir(params.cwd, params.homeDir);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${params.sessionId}.jsonl`);
  fs.writeFileSync(filePath, [
    JSON.stringify({
      type: 'user',
      uuid: `${params.sessionId}-user`,
      sessionId: params.sessionId,
      cwd: params.cwd,
      timestamp: params.timestamp || '2026-06-02T00:00:00.000Z',
      message: { role: 'user', content: params.text || 'hello claude lifecycle' },
    }),
  ].join('\n') + '\n', 'utf-8');
  return filePath;
}

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

const noopLlm: LLMProvider = {
  streamChat(_params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  },
};

const noopPermissions: PermissionGateway = {
  resolvePendingPermission: () => false,
};

const noopLifecycle: LifecycleHooks = {};

describe('bridge-manager model prompt context', () => {
  it('appends adapter-provided quote context after the user prompt', () => {
    const prompt = _testOnly.appendModelContextText(
      '按这个窗口发',
      [
        '<quoted_message platform="feishu" message_id="card-parent-1" message_type="interactive">',
        '<interactive_card>',
        '{"schema":"2.0"}',
        '</interactive_card>',
        '</quoted_message>',
      ].join('\n'),
    );

    assert.equal(prompt, [
      '按这个窗口发',
      '',
      '<quoted_message platform="feishu" message_id="card-parent-1" message_type="interactive">',
      '<interactive_card>',
      '{"schema":"2.0"}',
      '</interactive_card>',
      '</quoted_message>',
    ].join('\n'));
  });

  it('appends cloud document chat binding context for group-backed document chats', () => {
    const prompt = _testOnly.appendModelContextText(
      '请看一下这份文档',
      undefined,
      _testOnly.buildCloudDocumentChatContextText({
        id: 'binding-doc-chat',
        channelType: 'feishu',
        chatId: 'oc_doc_chat',
        bridgeSessionId: 'session-doc-chat',
        cloudDocumentChat: {
          provider: 'feishu',
          fileType: 'docx',
          fileToken: 'doc-token',
          commentId: 'comment-1',
        },
        createdAt: '2026-06-04T00:00:00.000Z',
        updatedAt: '2026-06-04T00:00:00.000Z',
      }),
    );

    assert.match(prompt, /<cloud_document_chat>/);
    assert.match(prompt, /file_type：docx/);
    assert.match(prompt, /file_token：doc-token/);
    assert.match(prompt, /comment_id：comment-1/);
    assert.match(prompt, /lark-cli docs \+fetch/);
  });
});

function installFakeTmux(): { binDir: string; logPath: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bridge-manager-fake-tmux-'));
  const logPath = path.join(binDir, 'tmux.log');
  const tmuxPath = path.join(binDir, 'tmux');
  fs.writeFileSync(logPath, '', 'utf-8');
  fs.writeFileSync(tmuxPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TMUX_FAKE_LOG"
case "$1" in
  list-sessions)
    printf 'alpha\\t1\\t0\\t0\\t0\\n'
    printf 'beta\\t2\\t1\\t0\\t0\\n'
    exit 0
    ;;
  has-session)
    target="$3"
    if [[ "$target" == "alpha" || "$target" == "beta" ]]; then
      exit 0
    fi
    exit 1
    ;;
  capture-pane)
    printf 'fake tmux screen\\nOpenAI Codex\\n› \\n'
    exit 0
    ;;
  send-keys)
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

class InvalidConfigAdapter extends BaseChannelAdapter {
  readonly channelType: string;
  readonly provider: string;

  constructor(instance?: { id?: string; provider?: string; alias?: string }) {
    super();
    this.channelType = instance?.id || 'invalid';
    this.provider = instance?.provider || 'invalid';
    Object.defineProperty(this, 'alias', {
      value: instance?.alias,
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return false; }
  async consumeOne() { return null; }
  async send() { return { ok: true, messageId: 'dummy' }; }
  validateConfig(): string | null { return 'invalid config'; }
  isAuthorized(): boolean { return true; }
}

class ThrowStartAdapter extends BaseChannelAdapter {
  static stopCalls: string[] = [];

  readonly channelType: string;
  readonly provider: string;

  constructor(instance?: { id?: string; provider?: string; alias?: string }) {
    super();
    this.channelType = instance?.id || 'throw-start';
    this.provider = instance?.provider || 'throw-start';
    Object.defineProperty(this, 'alias', {
      value: instance?.alias,
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  async start(): Promise<void> {
    throw new Error('start boom');
  }
  async stop(): Promise<void> {
    ThrowStartAdapter.stopCalls.push(this.channelType);
  }
  isRunning(): boolean { return false; }
  async consumeOne() { return null; }
  async send() { return { ok: true, messageId: 'dummy' }; }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }
}

class StartupNoticeAdapter extends BaseChannelAdapter {
  static sentMessages: OutboundMessage[] = [];
  static groupChats = new Map<string, { chatId: string; chatKind: 'p2p' | 'group'; name?: string } | null>();
  static groupChatErrors = new Map<string, string>();
  static groupChatInfoHooks = new Map<string, () => Promise<void> | void>();

  readonly channelType: string;
  readonly provider: string;
  private running = false;
  private waiters: Array<(msg: null) => void> = [];

  constructor(instance?: { id?: string; provider?: string; alias?: string }) {
    super();
    this.channelType = instance?.id || 'startup-notice-main';
    this.provider = instance?.provider || 'startup-notice';
    Object.defineProperty(this, 'alias', {
      value: instance?.alias,
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> {
    this.running = false;
    for (const resolve of this.waiters.splice(0)) {
      resolve(null);
    }
  }
  isRunning(): boolean { return this.running; }
  consumeOne(): Promise<null> {
    if (!this.running) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
  async send(message: OutboundMessage): Promise<SendResult> {
    StartupNoticeAdapter.sentMessages.push(message);
    return { ok: true, messageId: `startup-${StartupNoticeAdapter.sentMessages.length}` };
  }
  async getGroupChatInfo(chatId: string) {
    await StartupNoticeAdapter.groupChatInfoHooks.get(chatId)?.();
    const error = StartupNoticeAdapter.groupChatErrors.get(chatId);
    if (error) throw new Error(error);
    if (!StartupNoticeAdapter.groupChats.has(chatId)) {
      return { chatId, chatKind: 'p2p' as const };
    }
    return StartupNoticeAdapter.groupChats.get(chatId) || null;
  }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }
}

describe('bridge-manager resolveNewWorkingDirectory', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(path.join(CODELARK_HOME, 'config'), { recursive: true, force: true });
    fs.rmSync(CONFIG_TOML_PATH, { force: true });
  });

  it('resolves a relative project name inside the configured workspace root', () => {
    const restore = writeHomeConfigToml(`
schema_version = 2

[bridge]
default_workspace = 'D:\\workspace'
`);
    try {
      const store = new JsonFileStore(makeSettings());
      initBridgeContext({
        store,
        llm: noopLlm,
        permissions: noopPermissions,
        lifecycle: noopLifecycle,
      });

      const resolved = _testOnly.resolveNewWorkingDirectory('proj1');
      assert.deepEqual(resolved, {
        ok: true,
        workDir: path.resolve('D:\\workspace', 'proj1'),
      });
    } finally {
      restore();
    }
  });

  it('rejects relative paths that escape the configured workspace root', () => {
    const restore = writeHomeConfigToml(`
schema_version = 2

[bridge]
default_workspace = 'D:\\workspace'
`);
    try {
      const store = new JsonFileStore(makeSettings());
      initBridgeContext({
        store,
        llm: noopLlm,
        permissions: noopPermissions,
        lifecycle: noopLifecycle,
      });

      const resolved = _testOnly.resolveNewWorkingDirectory('..\\evil');
      assert.equal(resolved.ok, false);
      if (!resolved.ok) {
        assert.match(resolved.message, /不能使用 \.\.|越界/);
      }
    } finally {
      restore();
    }
  });

  it('falls back to ~ when no workspace root is configured', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });

    const resolved = _testOnly.resolveNewWorkingDirectory('proj1');
    assert.deepEqual(resolved, {
      ok: true,
      workDir: path.resolve(os.homedir(), 'proj1'),
    });
  });

  it('expands leading tilde paths to the user home directory', () => {
    const oldHome = process.env.HOME;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-home-'));
    process.env.HOME = homeDir;
    try {
      const store = new JsonFileStore(makeSettings());
      initBridgeContext({
        store,
        llm: noopLlm,
        permissions: noopPermissions,
        lifecycle: noopLifecycle,
      });

      const resolved = _testOnly.resolveNewWorkingDirectory('~/proj1');
      assert.deepEqual(resolved, {
        ok: true,
        workDir: path.resolve(homeDir, 'proj1'),
      });
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
    }
  });

  it('treats dot-slash /new arguments as relative paths', () => {
    const restore = writeHomeConfigToml(`
schema_version = 2

[bridge]
default_workspace = 'D:\\workspace'
`);
    try {
      const store = new JsonFileStore(makeSettings());
      initBridgeContext({
        store,
        llm: noopLlm,
        permissions: noopPermissions,
        lifecycle: noopLifecycle,
      });

      const resolved = _testOnly.resolveNewWorkingDirectory('./hi');
      assert.deepEqual(resolved, {
        ok: true,
        workDir: path.resolve('D:\\workspace', 'hi'),
      });
    } finally {
      restore();
    }
  });

  it('reuses the current formal session directory when /new has no args', () => {
    createConfigService({ migrate: false, env: {} }).set(
      { kind: 'session', sessionId: 'session-1' },
      { session: { workspace: 'D:\\workspace\\project-a' } },
    );
    const resolved = _testOnly.resolveNewSessionWorkingDirectory(
      '',
      {
        id: 'binding-1',
        channelType: 'feishu',
        chatId: 'chat-1',
        bridgeSessionId: 'session-1',
        createdAt: '2026-03-25T00:00:00.000Z',
        updatedAt: '2026-03-25T00:00:00.000Z',
      },
      {
        id: 'session-1',
        name: 'Project A',
        runtime: {
          codex: { model: 'test-model' },
        },
        session_type: 'normal',
      },
    );
    assert.deepEqual(resolved, {
      ok: true,
      workDir: path.resolve('D:\\workspace\\project-a'),
    });
  });

  it('reuses the global default directory when /new has no args and the current chat is not bound', () => {
    const restore = writeHomeConfigToml(`
schema_version = 2

[bridge]
default_workspace = 'D:\\workspace'
`);
    try {
      const store = new JsonFileStore(makeSettings());
      initBridgeContext({
        store,
        llm: noopLlm,
        permissions: noopPermissions,
        lifecycle: noopLifecycle,
      });

      const resolved = _testOnly.resolveNewSessionWorkingDirectory('', null, null);
      assert.deepEqual(resolved, {
        ok: true,
        workDir: path.resolve('D:\\workspace'),
      });
    } finally {
      restore();
    }
  });

  it('reuses the current draft session directory when /new has no args', () => {
    createConfigService({ migrate: false, env: {} }).set(
      { kind: 'session', sessionId: 'session-1' },
      { session: { workspace: 'D:\\codelark\\runtime\\draft' } },
    );
    const resolved = _testOnly.resolveNewSessionWorkingDirectory(
      '',
      {
        id: 'binding-1',
        channelType: 'feishu',
        chatId: 'chat-1',
        bridgeSessionId: 'session-1',
        createdAt: '2026-03-25T00:00:00.000Z',
        updatedAt: '2026-03-25T00:00:00.000Z',
      },
      {
        id: 'session-1',
        name: 'Draft:feishu:chat-1',
        runtime: {
          codex: { model: 'test-model' },
        },
        session_type: 'draft',
      },
    );
    assert.deepEqual(resolved, {
      ok: true,
      workDir: path.resolve('D:\\codelark\\runtime\\draft'),
    });
  });
});

describe('bridge-manager resolveCommandAlias', () => {
  it('maps command aliases that change routing behavior', () => {
    const cases: Array<[string, string, string]> = [
      ['/', '', '/current'],
      ['/check', '', '/health'],
      ['//', '', '//'],
      ['/t', '', '/threads'],
      ['/t', 'all', '/threads'],
      ['/t', 'n 10', '/threads'],
      ['/t', 'archive', '/t'],
      ['/t', 'archive 1', '/t'],
      ['/t', '1', '/thread'],
      ['/m', '', '/mode'],
      ['/p', 'tmux', '/provider'],
      ['/r', 'high', '/reasoning'],
      ['/n', 'proj1', '/new'],
      ['/h', '', '/help'],
    ];

    for (const [command, args, expected] of cases) {
      assert.equal(_testOnly.resolveCommandAlias(command, args), expected);
    }
  });

  it('treats double slash as an escaped model prompt prefix', () => {
    assert.equal(_testOnly.isBridgeCommandText('/status'), true);
    assert.equal(_testOnly.isBridgeCommandText('/check'), true);
    assert.equal(_testOnly.isBridgeCommandText('//status'), false);
    assert.equal(_testOnly.toModelPromptText('//status'), '/status');
    assert.equal(_testOnly.toModelPromptText('//'), '/');
  });

  it('classifies runtime config commands as session conversation barriers', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    const address = { channelType: 'feishu', chatId: 'chat-runtime-barrier' } as const;
    const binding = router.createBinding(address, '/tmp/runtime-barrier');
    const inbound = (text: string, callbackData?: string) => ({
      address,
      text,
      callbackData,
      messageId: `msg-${text || callbackData || 'callback'}`,
      timestamp: Date.now(),
    });

    for (const [text, jobKind] of [
      ['/runtime claude', 'command:runtime'],
      ['/m yolo', 'command:mode'],
      ['/r 5', 'command:reasoning'],
      ['/sb workspace-write', 'command:sandbox'],
      ['/net on', 'command:network'],
      ['/model gpt-5.4', 'command:model'],
      ['/cd ~/work', 'command:cd'],
      ['/provider tmux', 'command:provider'],
      ['/t rename 新标题', 'command:t:rename'],
      ['/t unbind', 'command:t:unbind'],
      ['/t 1', 'command:thread'],
    ] as const) {
      assert.deepEqual(_testOnly.adapterSessionLane(inbound(text) as any, 'command'), {
        sessionId: binding.bridgeSessionId,
        jobKind,
        blocksConversation: true,
      });
    }

    assert.deepEqual(_testOnly.adapterSessionLane(inbound('/tmux hello') as any, 'command'), {
      sessionId: binding.bridgeSessionId,
      jobKind: 'command:tmux',
      blocksConversation: false,
    });
    assert.equal(_testOnly.adapterSessionLane(inbound('/t') as any, 'command'), null);
    assert.equal(_testOnly.adapterSessionLane(inbound('/t ls') as any, 'command'), null);

    assert.deepEqual(
      _testOnly.adapterSessionLane(inbound('', buildCommandCallbackData('/current-config codex', binding.bridgeSessionId)) as any, 'callback'),
      {
        sessionId: binding.bridgeSessionId,
        jobKind: 'command:current-config',
        blocksConversation: true,
      },
    );
    assert.deepEqual(
      _testOnly.adapterSessionLane(inbound('', 'clk-thread-action:global:switch') as any, 'callback'),
      {
        sessionId: binding.bridgeSessionId,
        jobKind: 'command:t:switch',
        blocksConversation: true,
      },
    );
    assert.equal(_testOnly.adapterImmediateLane(inbound('/stop') as any, 'command')?.laneKind, 'control');
    assert.equal(_testOnly.adapterImmediateLane(inbound('/shell git status') as any, 'command')?.laneKind, 'job');
  });

  it('parses local runtime session list requests', () => {
    assert.deepEqual(parseLocalSessionListArgs(''), { showAll: false, limit: 20 });
    assert.deepEqual(parseLocalSessionListArgs('all'), { showAll: true, limit: 100 });
    assert.deepEqual(parseLocalSessionListArgs('n 100'), { showAll: false, limit: 100 });
    assert.deepEqual(parseLocalSessionListArgs('n 500'), { showAll: false, limit: 100 });
  });

  it('renders local runtime session list titles with the actual displayed count', () => {
    const response = buildLocalRuntimeSessionsCommandResponse(
      [
        {
          runtime: 'codex' as const,
          threadId: 'thread-1',
          filePath: 'D:\\codex\\sessions\\1.jsonl',
          cwd: 'D:\\workspace\\project-a',
          originator: 'Codex Desktop',
          firstSeenAt: '2026-03-31T00:00:00.000Z',
          lastEventAt: '2026-03-31T00:00:00.000Z',
          title: 'Project A',
          activeEstimate: false,
        },
        {
          runtime: 'codex' as const,
          threadId: 'thread-2',
          filePath: 'D:\\codex\\sessions\\2.jsonl',
          cwd: 'D:\\workspace\\project-b',
          originator: 'Codex Desktop',
          firstSeenAt: '2026-03-31T00:00:00.000Z',
          lastEventAt: '2026-03-31T00:00:00.000Z',
          title: 'Project B',
          activeEstimate: false,
        },
      ],
      false,
      false,
      20,
    );
    assert.match(response, /^本地会话（Codex2）/);
    assert.match(response, /标题\s+目录\s+上一次活动\s+用户输入轮数\s+bridge_id\s+thread_id\s+Creator/);
    assert.match(response, /Project A\s+D:\\workspace\\project-a\s+03\/31 \d\d:00\s+-\s+thread-1\s+Desktop/);
  });

  it('renders all-thread list titles with the actual displayed count', () => {
    const response = buildLocalRuntimeSessionsCommandResponse(
      [
        {
          runtime: 'codex' as const,
          threadId: 'thread-1',
          filePath: 'D:\\codex\\sessions\\1.jsonl',
          cwd: 'D:\\workspace\\project-a',
          originator: 'Codex Desktop',
          firstSeenAt: '2026-03-31T00:00:00.000Z',
          lastEventAt: '2026-03-31T00:00:00.000Z',
          title: 'Project A',
          activeEstimate: false,
        },
      ],
      false,
      true,
      100,
    );
    assert.match(response, /^本地会话（Codex1）/);
  });

  it('adds a visible notice when the local runtime session text list reaches its limit', () => {
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      runtime: 'codex' as const,
      threadId: `thread-${index + 1}`,
      filePath: `/tmp/thread-${index + 1}.jsonl`,
      cwd: `/tmp/project-${index + 1}`,
      originator: 'Codex Desktop',
      firstSeenAt: '2026-03-31T00:00:00.000Z',
      lastEventAt: '2026-03-31T00:00:00.000Z',
      title: `Project ${index + 1}`,
      activeEstimate: false,
    }));

    const response = buildLocalRuntimeSessionsCommandResponse(sessions, true, true, 100);
    assert.match(response, /已达到 100 条显示上限/);
  });

  it('keeps bound thread text markers attached so Feishu does not show literal star-space labels', () => {
    const response = buildLocalRuntimeSessionsCommandResponse(
      [{
        runtime: 'codex' as const,
        threadId: 'thread-1',
        filePath: '/tmp/thread-1.jsonl',
        cwd: '/tmp/project-1',
        originator: 'Codex Desktop',
        firstSeenAt: '2026-03-31T00:00:00.000Z',
        lastEventAt: '2026-03-31T00:00:00.000Z',
        title: 'Project 1',
        activeEstimate: false,
      }],
      false,
      false,
      20,
      [{
        threadId: 'thread-1',
        bindingId: 'binding-1',
        bridgeSessionId: 'bridge-session-1',
        active: false,
      }],
    );

    assert.match(response, /\*1\s+Project 1/);
    assert.doesNotMatch(response, /\* 1/);
  });

  it('builds local runtime session rich cards up to the card limit without text fallback', () => {
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      runtime: 'codex' as const,
      threadId: `thread-${index + 1}`,
      filePath: `/tmp/thread-${index + 1}.jsonl`,
      cwd: `/tmp/project-${index + 1}`,
      originator: 'Codex Desktop',
      firstSeenAt: '2026-03-31T00:00:00.000Z',
      lastEventAt: '2026-03-31T00:00:00.000Z',
      title: `Project ${index + 1}`,
      activeEstimate: false,
    }));

    const card = buildLocalRuntimeSessionsCommandCard(sessions, true, 100);
    assert.equal(card?.template, 'blue');
    assert.equal(card?.tableBlocks?.[0]?.table.rows.length, 100);
    assert.equal(card?.tableBlocks?.[0]?.selects?.[0]?.options.length, 100);
    assert.ok(card?.tableBlocks?.[0]?.actions?.flat().some((action) => action.text === '归档'));
    assert.match(card?.footer?.[0] || '', /已达到 100 条显示上限/);
    assert.deepEqual(card?.tableBlocks?.[0]?.table.columns.map((column) => column.name), [
      'index',
      'title',
      'cwd',
      'last_active',
      'user_input_turns',
      'bridge_id',
      'thread_id',
      'creator',
    ]);
    const activeCard = buildLocalRuntimeSessionsCommandCard(sessions.slice(0, 2), false, undefined, [{
      threadId: 'thread-1',
      bindingId: 'binding-1',
      bridgeSessionId: 'bridge-session-1',
      active: true,
    }]);
    const activeTable = activeCard?.tableBlocks?.[0]?.table;
    assert.equal(activeTable?.columns[0]?.horizontalAlign, 'center');
    assert.equal(activeTable?.rows?.[0]?.index, "**<number_tag background_color='green-350' font_color='white'>1</number_tag>**");
    assert.equal(activeTable?.rows?.[0]?.title, '**Project 1**');
    assert.equal(activeTable?.rows?.[0]?.bridge_id, '**bridge-s**');
    assert.equal(activeTable?.rows?.[0]?.thread_id, '**thread-1**');
    const otherChatCard = buildLocalRuntimeSessionsCommandCard(sessions.slice(0, 2), false, undefined, [{
      threadId: 'thread-1',
      bindingId: 'other-binding-1',
      bridgeSessionId: 'other-bridge-1',
      active: false,
    }]);
    const otherTable = otherChatCard?.tableBlocks?.[0]?.table;
    assert.equal(otherTable?.rows?.[0]?.index, "<number_tag background_color='grey-500' font_color='white'>1</number_tag>");
    assert.match(String(otherTable?.rows?.[0]?.title || ''), /^<font color='grey-500'>Project 1<\/font>$/);
    assert.match(String(otherTable?.rows?.[0]?.bridge_id || ''), /^<font color='grey-500'>other-br<\/font>$/);
    assert.match(String(activeTable?.rows?.[1]?.title || ''), /^<font color='grey-500'>/);

    const bridgeCard = buildLocalRuntimeSessionsCommandCard(sessions.slice(0, 1), false, undefined, [], [{
      title: 'Bridge Draft',
      cwd: '/tmp/bridge-draft',
      lastActiveAt: '2026-03-31T00:00:00.000Z',
      threadId: '',
      bridgeSessionId: 'bridge-session-1',
      bindingId: 'bridge-binding-1',
      active: true,
      originator: 'Bridge',
    }]);
    assert.equal(bridgeCard?.title, '');
    assert.equal(bridgeCard?.tableBlocks?.[0]?.table.rows.length, 1);
    assert.doesNotMatch(JSON.stringify(bridgeCard), /Bridge Draft/);
  });

  it('maps numeric reasoning aliases to supported effort levels', () => {
    assert.equal(normalizeReasoningEffort('0'), null);
    assert.equal(normalizeReasoningEffort('1'), 'minimal');
    assert.equal(normalizeReasoningEffort('2'), 'low');
    assert.equal(normalizeReasoningEffort('3'), 'medium');
    assert.equal(normalizeReasoningEffort('4'), 'high');
    assert.equal(normalizeReasoningEffort('5'), 'xhigh');
    assert.equal(normalizeReasoningEffort('xhigh'), 'xhigh');
    assert.equal(normalizeReasoningEffort('9'), null);
  });

  it('builds distinct stream keys for separate IM turns in the same session', () => {
    const first = _testOnly.buildInteractiveStreamKey('session-1', 'msg-1');
    const second = _testOnly.buildInteractiveStreamKey('session-1', 'msg-2');
    assert.notEqual(first, second);
    assert.equal(first, 'im:session-1:msg-1');
  });

  it('builds stable mirror stream keys from session and turn identity', () => {
    const withTurnId = _testOnly.buildMirrorStreamKey('session-1', 'turn-1', '2026-03-27T10:00:00.000Z');
    const fallback = _testOnly.buildMirrorStreamKey('session-1', null, '2026-03-27T10:00:00.000Z');
    assert.equal(withTurnId, 'mirror:session-1:turn-1');
    assert.equal(fallback, 'mirror:session-1:2026-03-27T10:00:00.000Z');
  });

  it('changes adapter config fingerprint when alias or config changes', () => {
    const base = _testOnly.buildAdapterConfigFingerprint({
      id: 'feishu-main',
      provider: 'feishu',
      alias: '主飞书',
      enabled: true,
      config: {
        appId: 'app-id',
        appSecret: 'secret',
        site: 'feishu',
        allowedUsers: ['u1'],
        streamingEnabled: true,
        feedbackMarkdownEnabled: true,
      },
    });
    const changedAlias = _testOnly.buildAdapterConfigFingerprint({
      id: 'feishu-main',
      provider: 'feishu',
      alias: '备份飞书',
      enabled: true,
      config: {
        appId: 'app-id',
        appSecret: 'secret',
        site: 'feishu',
        allowedUsers: ['u1'],
        streamingEnabled: true,
        feedbackMarkdownEnabled: true,
      },
    });
    const changedConfig = _testOnly.buildAdapterConfigFingerprint({
      id: 'feishu-main',
      provider: 'feishu',
      alias: '主飞书',
      enabled: true,
      config: {
        appId: 'app-id',
        appSecret: 'secret',
        site: 'lark',
        allowedUsers: ['u1'],
        streamingEnabled: true,
        feedbackMarkdownEnabled: true,
      },
    });
    assert.notEqual(base, changedAlias);
    assert.notEqual(base, changedConfig);
  });

  it('surfaces binding conflict errors to the user', () => {
    const message = toUserVisibleBindingError(
      new Error('该会话已绑定到飞书聊天 oc_xxx。一个会话只能绑定一个聊天。'),
      '切换失败。',
    );
    assert.equal(message, '该会话已绑定到飞书聊天 oc_xxx。一个会话只能绑定一个聊天。');
  });

  it('falls back to the default binding error message for unknown failures', () => {
    const message = toUserVisibleBindingError('boom', '切换失败。');
    assert.equal(message, '切换失败。');
  });

  it('formats chat labels with display names when available', () => {
    const label = _testOnly.formatBindingChatLabel({
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      channelAlias: '飞书',
      chatId: 'oc_xxx',
      chatDisplayName: '张乐',
    } as never);
    assert.equal(label, '飞书 聊天 张乐');
  });

  it('maps unexpected /history failures to a user-visible hint', () => {
    const message = toUserVisibleCommandError('/history', new Error('boom'));
    assert.equal(message, '读取历史记录失败，请稍后重试。');
  });

  it('falls back to a generic user-visible error for other commands', () => {
    const message = toUserVisibleCommandError('/model', new Error('boom'));
    assert.equal(message, '/model 执行失败，请稍后重试。');
  });

  it('suppresses an IM-triggered mirror turn until task_complete', () => {
    const sessionId = 'session-suppress-turn';
    _testOnly.beginMirrorSuppression(sessionId, '整理一下readme ，主要以功能说明为主，不需要把修改的内容都写进去。');

    const filtered = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        type: 'message',
        role: 'user',
        content: '整理一下readme ，主要以功能说明为主，不需要把修改的内容都写进去。',
        signature: 'sig-user',
        timestamp: '2026-03-26T06:25:26.708Z',
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'README 已经整理成以功能说明为主的版本了。',
        signature: 'sig-assistant',
        timestamp: '2026-03-26T06:25:40.000Z',
      },
      {
        type: 'task_complete',
        role: 'assistant',
        content: 'README 已经整理成以功能说明为主的版本了。',
        signature: 'sig-complete',
        timestamp: '2026-03-26T06:33:19.604Z',
      },
    ] as never);

    assert.deepEqual(filtered, []);
  });

  it('releases mirror suppression after task_complete', () => {
    const sessionId = 'session-suppress-release';
    _testOnly.beginMirrorSuppression(sessionId, 'hello');
    _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        type: 'message',
        role: 'user',
        content: 'hello',
        signature: 'sig-user',
        timestamp: '2026-03-26T06:25:26.708Z',
      },
      {
        type: 'task_complete',
        role: 'assistant',
        content: 'done',
        signature: 'sig-complete',
        timestamp: '2026-03-26T06:33:19.604Z',
      },
    ] as never);

    const laterRecord = {
      type: 'message',
      role: 'user',
      content: 'Codex 后续新消息',
      signature: 'sig-later',
      timestamp: '2026-03-26T06:40:00.000Z',
    };
    const filtered = _testOnly.filterSuppressedMirrorRecords(sessionId, [laterRecord] as never);
    assert.deepEqual(filtered, [laterRecord]);
  });

  it('keeps SDK-settled mirror suppression alive until the delayed terminal event', () => {
    const originalNow = Date.now;
    let now = new Date('2026-03-26T06:25:26.000Z').getTime();
    Date.now = () => now;
    try {
      const sessionId = 'session-sdk-settle-delayed-terminal';
      const suppressionId = _testOnly.beginMirrorSuppression(sessionId, 'hello');

      const initialRecords = _testOnly.filterSuppressedMirrorRecords(sessionId, [
        {
          type: 'task_started',
          content: '',
          signature: 'sig-start',
          timestamp: '2026-03-26T06:25:26.000Z',
          turnId: 'turn-sdk',
        },
        {
          type: 'message',
          role: 'user',
          content: 'hello',
          signature: 'sig-user',
          timestamp: '2026-03-26T06:25:26.708Z',
          turnId: 'turn-sdk',
        },
        {
          type: 'message',
          role: 'assistant',
          content: 'sdk-visible response mirrored later',
          signature: 'sig-assistant',
          timestamp: '2026-03-26T06:25:27.000Z',
          turnId: 'turn-sdk',
        },
      ] as never);
      assert.deepEqual(initialRecords, []);

      _testOnly.settleMirrorSuppression(sessionId, suppressionId, 10_000);
      now += 9_000;

      const delayedTail = _testOnly.filterSuppressedMirrorRecords(sessionId, [
        {
          type: 'message',
          role: 'assistant',
          content: 'tail before terminal',
          signature: 'sig-tail',
          timestamp: '2026-03-26T06:25:35.000Z',
          turnId: 'turn-sdk',
        },
      ] as never);
      assert.deepEqual(delayedTail, []);
      assert.equal(_testOnly.isMirrorSuppressed(sessionId), true);

      const terminal = _testOnly.filterSuppressedMirrorRecords(sessionId, [
        {
          type: 'task_complete',
          role: 'assistant',
          content: 'sdk-visible response mirrored later',
          signature: 'sig-complete',
          timestamp: '2026-03-26T06:25:36.000Z',
          turnId: 'turn-sdk',
        },
      ] as never);
      assert.deepEqual(terminal, []);
      assert.equal(_testOnly.isMirrorSuppressed(sessionId), false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('suppresses SDK mirror tail records even when the prompt record was already consumed before subscription', () => {
    const originalNow = Date.now;
    let now = new Date('2026-03-26T06:25:26.000Z').getTime();
    Date.now = () => now;
    try {
      const sessionId = 'session-sdk-missed-prompt-tail';
      const suppressionId = _testOnly.beginMirrorSuppression(sessionId, '继续，我已经为你打开了权限');

      const leakedTail = _testOnly.filterSuppressedMirrorRecords(sessionId, [
        {
          type: 'message',
          role: 'assistant',
          content: '好的，谢谢！现在我开始修复。',
          signature: 'sig-assistant-before-prompt-match',
          timestamp: '2026-03-26T06:25:27.000Z',
          turnId: 'assistant-fragment-1',
        },
        {
          type: 'task_complete',
          role: 'assistant',
          content: '好的，谢谢！现在我开始修复。',
          signature: 'sig-complete-before-prompt-match',
          timestamp: '2026-03-26T06:25:27.100Z',
          turnId: 'assistant-fragment-1',
        },
        {
          type: 'tool_started',
          content: '',
          signature: 'sig-tool-before-prompt-match',
          timestamp: '2026-03-26T06:25:28.000Z',
          turnId: 'tool-fragment-1',
          toolName: 'Edit',
        },
      ] as never);
      assert.deepEqual(leakedTail, []);

      _testOnly.settleMirrorSuppression(sessionId, suppressionId, 10_000);
      now += 9_000;

      const delayedTail = _testOnly.filterSuppressedMirrorRecords(sessionId, [
        {
          type: 'message',
          role: 'assistant',
          content: 'tail before timeout',
          signature: 'sig-delayed-tail-before-timeout',
          timestamp: '2026-03-26T06:25:35.000Z',
          turnId: 'assistant-fragment-2',
        },
      ] as never);
      assert.deepEqual(delayedTail, []);
    } finally {
      Date.now = originalNow;
    }
  });

  it('logs and stops SDK-settled mirror suppression when terminal does not arrive in time', () => {
    const originalNow = Date.now;
    const originalError = console.error;
    let now = new Date('2026-03-26T06:25:26.000Z').getTime();
    const errors: unknown[][] = [];
    Date.now = () => now;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const sessionId = 'session-sdk-settle-terminal-timeout';
      const suppressionId = _testOnly.beginMirrorSuppression(sessionId, 'hello');

      _testOnly.filterSuppressedMirrorRecords(sessionId, [
        {
          type: 'task_started',
          content: '',
          signature: 'sig-start-timeout',
          timestamp: '2026-03-26T06:25:26.000Z',
          turnId: 'turn-timeout',
        },
        {
          type: 'message',
          role: 'user',
          content: 'hello',
          signature: 'sig-user-timeout',
          timestamp: '2026-03-26T06:25:26.708Z',
          turnId: 'turn-timeout',
        },
      ] as never);
      _testOnly.settleMirrorSuppression(sessionId, suppressionId, 10_000);

      now += 10_001;
      assert.equal(_testOnly.isMirrorSuppressed(sessionId), false);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]?.[0]), /Timed out waiting for terminal mirror record/);

      const staleTail = _testOnly.filterSuppressedMirrorRecords(sessionId, [
        {
          type: 'message',
          role: 'assistant',
          content: 'late duplicate tail',
          signature: 'sig-late-tail',
          timestamp: '2026-03-26T06:25:37.000Z',
          turnId: 'turn-timeout',
        },
        {
          type: 'task_complete',
          role: 'assistant',
          content: 'late duplicate terminal',
          signature: 'sig-late-complete',
          timestamp: '2026-03-26T06:25:38.000Z',
          turnId: 'turn-timeout',
        },
      ] as never);
      assert.deepEqual(staleTail, []);

      const laterRecord = {
        type: 'message',
        role: 'assistant',
        content: 'new visible mirror reply',
        signature: 'sig-visible-after-timeout',
        timestamp: '2026-03-26T06:25:39.000Z',
        turnId: 'turn-next',
      };
      const released = _testOnly.filterSuppressedMirrorRecords(sessionId, [laterRecord] as never);
      assert.deepEqual(released, [laterRecord]);
    } finally {
      Date.now = originalNow;
      console.error = originalError;
    }
  });

  it('keeps an aborted mirror turn suppressed until its terminal event', () => {
    const sessionId = 'session-suppress-abort';
    const suppressionId = _testOnly.beginMirrorSuppression(sessionId, 'hello');

    _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        type: 'task_started',
        content: '',
        signature: 'sig-start',
        timestamp: '2026-03-26T06:25:20.000Z',
        turnId: 'turn-1',
      },
      {
        type: 'message',
        role: 'user',
        content: 'hello',
        signature: 'sig-user',
        timestamp: '2026-03-26T06:25:26.708Z',
        turnId: 'turn-1',
      },
    ] as never);

    assert.equal(_testOnly.isMirrorSuppressed(sessionId), true);

    _testOnly.abortMirrorSuppression(sessionId, suppressionId);

    assert.equal(_testOnly.isMirrorSuppressed(sessionId), true);

    const oldTurnTail = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        type: 'message',
        role: 'assistant',
        content: 'old tail',
        signature: 'sig-old-tail',
        timestamp: '2026-03-26T06:25:40.000Z',
        turnId: 'turn-1',
      },
    ] as never);
    assert.deepEqual(oldTurnTail, []);

    const aborted = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        type: 'task_aborted',
        role: 'assistant',
        content: 'stopped',
        signature: 'sig-aborted',
        timestamp: '2026-03-26T06:25:50.000Z',
        turnId: 'turn-1',
      },
    ] as never);
    assert.deepEqual(aborted, []);
    assert.equal(_testOnly.isMirrorSuppressed(sessionId), false);

    const newTurnRecord = {
      type: 'message',
      role: 'assistant',
      content: 'new turn response',
      signature: 'sig-new-turn',
      timestamp: '2026-03-26T06:26:00.000Z',
      turnId: 'turn-2',
    };
    const released = _testOnly.filterSuppressedMirrorRecords(sessionId, [newTurnRecord] as never);
    assert.deepEqual(released, [newTurnRecord]);
  });

  it('does not leak a stopped mirror tail when terminal records arrive after the abort window', () => {
    const originalNow = Date.now;
    let now = new Date('2026-03-26T06:25:26.000Z').getTime();
    Date.now = () => now;
    try {
      const sessionId = 'session-suppress-abort-no-turn-id';
      const suppressionId = _testOnly.beginMirrorSuppression(sessionId, 'hello');

      _testOnly.filterSuppressedMirrorRecords(sessionId, [
        {
          type: 'message',
          role: 'user',
          content: 'hello',
          signature: 'sig-user-no-turn',
          timestamp: '2026-03-26T06:25:26.708Z',
        },
      ] as never);

      _testOnly.abortMirrorSuppression(sessionId, suppressionId);
      now += 5_000;

      const stoppedTail = _testOnly.filterSuppressedMirrorRecords(sessionId, [
        {
          type: 'message',
          role: 'assistant',
          content: 'tail that should not become a mirror reply',
          signature: 'sig-tail-no-turn',
          timestamp: '2026-03-26T06:25:30.000Z',
        },
        {
          type: 'task_complete',
          role: 'assistant',
          content: 'tail that should not become a mirror reply',
          signature: 'sig-complete-no-turn',
          timestamp: '2026-03-26T06:25:31.000Z',
        },
      ] as never);
      assert.deepEqual(stoppedTail, []);
      assert.equal(_testOnly.isMirrorSuppressed(sessionId), false);

      const laterRecord = {
        type: 'message',
        role: 'assistant',
        content: 'new visible mirror reply',
        signature: 'sig-later-no-turn',
        timestamp: '2026-03-26T06:26:00.000Z',
      };
      const released = _testOnly.filterSuppressedMirrorRecords(sessionId, [laterRecord] as never);
      assert.deepEqual(released, [laterRecord]);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe('bridge-manager status formatting', () => {
  beforeEach(() => {
    writeHomeConfigToml(`
schema_version = 2

[runtime.codex]
model = "test-model"
`);
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
  });

  it('resolves the displayed model from the most specific available source', () => {
    createConfigService({ migrate: false, env: {} }).set(
      { kind: 'session', sessionId: 's-model' },
      { runtime: { codex: { model: 'session-model' } } },
    );
    assert.equal(
      _testOnly.resolveDisplayedModel(
        { model: 'binding-model' } as never,
        { id: 's-model', runtime: { codex: { model: 'legacy-session-model' } } },
        'configured-model',
        'codex-default',
      ),
      'session-model',
    );
    assert.equal(
      _testOnly.resolveDisplayedModel(
        null,
        { id: 's-model', runtime: { codex: { model: 'legacy-session-model' } } },
        'configured-model',
        'codex-default',
      ),
      'session-model',
    );
    assert.equal(
      _testOnly.resolveDisplayedModel(null, { id: 's-empty', runtime: { codex: { model: 'legacy-session-model' } } }, 'configured-model', 'codex-default'),
      'configured-model',
    );
    assert.equal(
      _testOnly.resolveDisplayedModel(null, { id: 's-empty', runtime: { codex: { model: 'legacy-session-model' } } }, null, 'codex-default'),
      'codex-default',
    );
    assert.equal(
      _testOnly.resolveDisplayedModel(null, { id: 's-empty', runtime: { codex: { model: 'legacy-session-model' } } }, null, null),
      'default',
    );
  });

  it('marks CLI-only models in the displayed label when metadata is available', () => {
    assert.equal(_testOnly.formatDisplayedModel('gpt-5.3-codex-spark'), 'gpt-5.3-codex-spark（仅 IM / CLI）');
    assert.equal(_testOnly.formatDisplayedModel('gpt-5.4'), 'gpt-5.4');
  });

  it('formats runtime states with queued counts', () => {
    assert.equal(formatRuntimeStatus({ id: 's-1', runtime_status: 'idle' }), '空闲');
    assert.equal(formatRuntimeStatus({ id: 's-1', runtime_status: 'running' }), '运行中');
    assert.equal(
      formatRuntimeStatus({ id: 's-1', runtime_status: 'queued', queued_count: 2 }),
      '排队中（2）',
    );
  });

  it('formats mirror state summaries', () => {
    assert.equal(formatMirrorStatus({ id: 's-1', mirror_status: 'inactive' }), '未监听');
    assert.equal(
      formatMirrorStatus({ id: 's-1', mirror_status: 'stale' }),
      '待恢复（暂时没定位到本地 Codex thread 文件）',
    );
    assert.equal(
      formatMirrorStatus({
        id: 's-1',
        mirror_status: 'watching',
        mirror_last_event_at: '2026-03-25T08:00:00.000Z',
      }),
      `监听中 · 最近同步 ${formatCommandDateTime('2026-03-25T08:00:00.000Z')}`,
    );
  });

  it('formats mirror event batches for IM delivery', () => {
    const rendered = _testOnly.formatMirrorMessage('Current Thread', 'Codex prompt', 'Codex answer');

    assert.equal(rendered, '<Current Thread>\n\n我: Codex prompt\n\ncodex: Codex answer');
  });

  it('formats mirror assistant labels from v2 runtime agent config', () => {
    const restore = writeHomeConfigToml(`
schema_version = 2

[runtime]
agent = "claude"
`);
    try {
      const rendered = _testOnly.formatMirrorMessage('Current Thread', 'prompt', 'answer');

      assert.equal(rendered, '<Current Thread>\n\n我: prompt\n\nclaude: answer');
    } finally {
      restore();
    }
  });

  it('returns an empty mirror message when there is no text', () => {
    const rendered = _testOnly.formatMirrorMessage('Current Thread', '', '');

    assert.equal(rendered, '');
  });

  it('formats markdown mirror headers with a combined user and codex layout', () => {
    const rendered = _testOnly.formatMirrorMessage(
      'Current Thread',
      'Codex prompt',
      '- item 1\n- item 2',
      true,
    );

    assert.equal(rendered, '**`<Current Thread>`**\n\n**我:** Codex prompt\n\n**codex:**\n- item 1\n- item 2');
  });

  it('formats mirror goal status at the top of markdown mirror messages', () => {
    const rendered = _testOnly.formatMirrorMessage(
      'Current Thread',
      null,
      'Codex answer',
      true,
      false,
      true,
      { status: 'active', objective: '分析 mirror goal 事件' },
    );

    assert.equal(
      rendered,
      '> ⚙️ **Goal Active**: 分析 mirror goal 事件\n\n**`<Current Thread>`**\n\n**codex:** Codex answer',
    );
  });

  it('formats goal interruption and resume as quoted system notices', () => {
    const interrupted = _testOnly.formatMirrorMessage(
      'Current Thread',
      null,
      '',
      true,
      false,
      true,
      { status: 'blocked', objective: '等待用户确认' },
    );
    const resumed = _testOnly.formatMirrorMessage(
      'Current Thread',
      null,
      '',
      true,
      false,
      true,
      { status: 'active', objective: '继续处理' },
    );

    assert.match(interrupted, /^> ⚙️ \*\*Goal Blocked\*\*: 等待用户确认/);
    assert.match(resumed, /^> ⚙️ \*\*Goal Active\*\*: 继续处理/);
  });

  it('rewrites known wrapped codex prompts into a compact user mirror label', () => {
    const wrapped = [
      '# Review findings:',
      '',
      '## Finding 1 (src/entrypoints/cli.ts:151-153) [added]',
      '[P2] demo',
      '',
      '## My request for Codex:',
      'ok,当前调整已经可以收尾了吗',
    ].join('\n');

    assert.equal(
      _testOnly.formatMirrorUserText(wrapped),
      '（基于 Review findings）\nok,当前调整已经可以收尾了吗',
    );
  });

  it('keeps raw mirror user text when no known wrapper marker is present', () => {
    const plain = '普通用户消息\n第二行';
    assert.equal(_testOnly.formatMirrorUserText(plain), plain);

    const unknownWrapped = [
      '# Unknown wrapper:',
      '',
      '## My request for Codex:',
      '保留原文',
    ].join('\n');
    assert.equal(_testOnly.formatMirrorUserText(unknownWrapped), unknownWrapped);
  });

  it('buffers Codex user mirror text into the active turn instead of finalizing immediately', () => {
    const subscription = {
      pendingTurn: null,
      sessionId: 'session-1',
      threadId: 'thread-1',
    } as { pendingTurn: unknown; threadId: string };

    const finalized = _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'user-1',
        type: 'message',
        role: 'user',
        content: 'codex prompt',
        timestamp: '2026-03-25T08:00:00.000Z',
      },
    ]);

    assert.deepEqual(finalized, []);
    assert.deepEqual(subscription.pendingTurn, {
      startedAtMs: Date.parse('2026-03-25T08:00:00.000Z'),
      lastActivityAtMs: Date.parse('2026-03-25T08:00:00.000Z'),
      lastContentResponseAtMs: null,
      turnId: null,
      streamKey: 'mirror:session-1:2026-03-25T08:00:00.000Z',
      startedAt: '2026-03-25T08:00:00.000Z',
      lastActivityAt: '2026-03-25T08:00:00.000Z',
      lastContentResponseAt: null,
      lastResponseAt: null,
      lastStatusText: null,
      lastStatusAt: 0,
      statusNote: null,
      userText: 'codex prompt',
      lastAssistantText: null,
      lastCommentaryText: null,
      streamedText: '',
      streamStarted: false,
      taskItems: [],
      toolCalls: new Map(),
      historyItems: [{ type: 'markdown', role: 'user', content: 'codex prompt' }],
      historyTextSnapshot: '',
      contextUsage: null,
    });
  });

  it('buffers mirror records until task_complete arrives', () => {
    const subscription = {
      pendingTurn: null,
      sessionId: 'session-1',
      threadId: 'thread-1',
    } as { pendingTurn: unknown; threadId: string };

    const finalized = _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'start',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'user',
        type: 'message',
        role: 'user',
        content: 'codex prompt',
        timestamp: '2026-03-25T08:00:00.500Z',
        turnId: 'turn-1',
      },
      {
        signature: 'commentary',
        type: 'message',
        role: 'commentary',
        content: 'thinking',
        timestamp: '2026-03-25T08:00:01.000Z',
      },
      {
        signature: 'assistant',
        type: 'message',
        role: 'assistant',
        content: 'final answer',
        timestamp: '2026-03-25T08:00:02.000Z',
      },
      {
        signature: 'complete',
        type: 'task_complete',
        role: 'assistant',
        content: 'final answer',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.deepEqual(finalized, [
      {
        streamKey: 'mirror:session-1:turn-1',
        userText: 'codex prompt',
        text: 'final answer',
        signature: 'complete',
        timestamp: '2026-03-25T08:00:03.000Z',
        status: 'completed',
      },
    ]);
    assert.equal(subscription.pendingTurn, null);
  });

  it('waits for visible mirror content before opening a mirror stream card', () => {
    _testOnly.resetStateForTests();
    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const streamEvents: string[] = [];
    state.adapters.set('feishu', {
      channelType: 'feishu',
      provider: 'feishu',
      isRunning: () => true,
      onMirrorStreamStart: (_chatId: string, streamKey: string) => {
        streamEvents.push(`start:${streamKey}`);
      },
      onStreamMetadata: (_chatId: string, metadata: any, streamKey: string) => {
        streamEvents.push(`metadata:${streamKey}:${metadata.title}:${(metadata.tags || []).join(',')}`);
      },
      onStreamText: (_chatId: string, text: string, streamKey: string) => {
        streamEvents.push(`text:${streamKey}:${text}`);
      },
      onStreamStatus: (_chatId: string, text: string, streamKey: string) => {
        streamEvents.push(`status:${streamKey}:${text}`);
      },
      onStreamEnd: async () => true,
    });

    const subscription = {
      pendingTurn: null,
      sessionId: 'session-1',
      threadId: 'thread-1',
      channelType: 'feishu',
      chatId: 'chat-1',
    } as { pendingTurn: any; threadId: string };

    const originalDateNow = Date.now;
    Date.now = () => Date.parse('2026-03-25T08:00:00.700Z');
    try {
      _testOnly.consumeMirrorRecords(subscription as any, [
        {
          signature: 'start',
          type: 'task_started',
          content: '',
          timestamp: '2026-03-25T08:00:00.000Z',
          turnId: 'turn-1',
        },
      ]);

      assert.equal(subscription.pendingTurn?.streamStarted, false);
      assert.deepEqual(streamEvents, []);

      _testOnly.consumeMirrorRecords(subscription as any, [
        {
          signature: 'user',
          type: 'message',
          role: 'user',
          content: 'codex prompt',
          timestamp: '2026-03-25T08:00:00.500Z',
          turnId: 'turn-1',
        },
      ]);

      assert.equal(subscription.pendingTurn?.streamStarted, true);
      assert.deepEqual(streamEvents, [
        'metadata:mirror:session-1:turn-1:本地会话:effort:medium,model:test-model,bridge_id:session-,mirror',
        'start:mirror:session-1:turn-1',
        'text:mirror:session-1:turn-1:我: codex prompt\n\ncodex:',
        'status:mirror:session-1:turn-1:处理中',
      ]);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('normalizes wrapped Codex user prompts before opening a mirror stream card', () => {
    _testOnly.resetStateForTests();
    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const streamEvents: string[] = [];
    state.adapters.set('feishu', {
      channelType: 'feishu',
      provider: 'feishu',
      isRunning: () => true,
      onMirrorStreamStart: (_chatId: string, streamKey: string) => {
        streamEvents.push(`start:${streamKey}`);
      },
      onStreamMetadata: (_chatId: string, metadata: any, streamKey: string) => {
        streamEvents.push(`metadata:${streamKey}:${metadata.title}:${(metadata.tags || []).join(',')}`);
      },
      onStreamText: (_chatId: string, text: string, streamKey: string) => {
        streamEvents.push(`text:${streamKey}:${text}`);
      },
      onStreamStatus: (_chatId: string, text: string, streamKey: string) => {
        streamEvents.push(`status:${streamKey}:${text}`);
      },
      onStreamEnd: async () => true,
    });

    const subscription = {
      pendingTurn: null,
      sessionId: 'session-1',
      threadId: 'thread-1',
      channelType: 'feishu',
      chatId: 'chat-1',
    } as { pendingTurn: any; threadId: string };

    const originalDateNow = Date.now;
    Date.now = () => Date.parse('2026-03-25T08:00:00.700Z');
    try {
      _testOnly.consumeMirrorRecords(subscription as any, [
        {
          signature: 'user',
          type: 'message',
          role: 'user',
          content: [
            '# Review findings:',
            '',
            '## Finding 1 (src/entrypoints/cli.ts:151-153) [added]',
            '[P2] demo',
            '',
            '## My request for Codex:',
            'ok,当前调整已经可以收尾了吗',
          ].join('\n'),
          timestamp: '2026-03-25T08:00:00.500Z',
          turnId: 'turn-1',
        },
      ]);

      assert.equal(subscription.pendingTurn?.userText, '（基于 Review findings）\nok,当前调整已经可以收尾了吗');
      assert.deepEqual(streamEvents, [
        'metadata:mirror:session-1:turn-1:本地会话:effort:medium,model:test-model,bridge_id:session-,mirror',
        'start:mirror:session-1:turn-1',
        'text:mirror:session-1:turn-1:我:\n（基于 Review findings）\nok,当前调整已经可以收尾了吗\n\ncodex:',
        'status:mirror:session-1:turn-1:处理中',
      ]);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('hides outbound artifact blocks from mirror stream text', () => {
    _testOnly.resetStateForTests();
    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const streamedTexts: string[] = [];
    state.adapters.set('feishu', {
      channelType: 'feishu',
      provider: 'feishu',
      isRunning: () => true,
      onMirrorStreamStart: () => {},
      onStreamText: (_chatId: string, text: string) => {
        streamedTexts.push(text);
      },
      onStreamStatus: () => {},
      onStreamEnd: async () => true,
    });

    const subscription = {
      pendingTurn: null,
      sessionId: 'session-1',
      threadId: 'thread-1',
      channelType: 'feishu',
      chatId: 'chat-1',
    } as { pendingTurn: any; threadId: string };

    _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'user',
        type: 'message',
        role: 'user',
        content: 'codex prompt',
        timestamp: '2026-03-25T08:00:00.500Z',
        turnId: 'turn-1',
      },
      {
        signature: 'assistant',
        type: 'message',
        role: 'assistant',
        content: [
          'done',
          '',
          '<clk-send>{"type":"image","path":"D:\\\\workspace\\\\out.png","caption":"截图"}</clk-send>',
        ].join('\n'),
        timestamp: '2026-03-25T08:00:01.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.ok(streamedTexts.at(-1)?.includes('done'));
    assert.equal(streamedTexts.some((text) => text.includes('clk-send')), false);
  });

  it('sends outbound artifacts from finalized mirror turns as attachments', async () => {
    _testOnly.resetStateForTests();
    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const sentMessages: OutboundMessage[] = [];
    const streamEnds: Array<{ status: 'completed' | 'interrupted'; text: string; streamKey?: string }> = [];
    state.adapters.set('feishu', {
      channelType: 'feishu',
      provider: 'feishu',
      isRunning: () => true,
      send: async (message: OutboundMessage): Promise<SendResult> => {
        sentMessages.push(message);
        return { ok: true, messageId: `sent-${sentMessages.length}` };
      },
      onStreamEnd: async (
        _chatId: string,
        status: 'completed' | 'interrupted',
        text: string,
        streamKey?: string,
      ): Promise<boolean> => {
        streamEnds.push({ status, text, streamKey });
        return true;
      },
    });

    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: null,
      lastDeliveredAt: null,
    });

    const result = await _testOnly.deliverMirrorTurns(subscription, [{
      streamKey: 'mirror:session-1:turn-1',
      userText: 'codex prompt',
      text: [
        '结果如下',
        '',
        '<clk-send>{"type":"image","path":"D:\\\\workspace\\\\out.png","caption":"结果图"}</clk-send>',
      ].join('\n'),
      signature: 'complete',
      timestamp: '2026-03-25T08:00:03.000Z',
      status: 'completed',
    }]);

    assert.deepEqual(result, { deliveredCount: 1 });
    assert.equal(streamEnds.length, 1);
    assert.ok(streamEnds[0]?.text.includes('结果如下'));
    assert.doesNotMatch(streamEnds[0]?.text || '', /clk-send/);
    assert.deepEqual(sentMessages.map((message) => ({
      text: message.text,
      attachments: message.attachments,
    })), [
      {
        text: '结果图',
        attachments: undefined,
      },
      {
        text: '',
        attachments: [{
          kind: 'image',
          path: 'D:\\workspace\\out.png',
          caption: '结果图',
          name: undefined,
        }],
      },
    ]);
    assert.equal(subscription.lastDeliveredAt, '2026-03-25T08:00:03.000Z');
  });

  it('refreshes mirror stream status with runtime and last response age during long-running turns', () => {
    _testOnly.resetStateForTests();
    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const statusEvents: string[] = [];
    state.adapters.set('feishu', {
      channelType: 'feishu',
      provider: 'feishu',
      isRunning: () => true,
      onStreamText: () => {},
      onStreamStatus: (_chatId: string, text: string, streamKey: string) => {
        statusEvents.push(`status:${streamKey}:${text}`);
      },
      onStreamEnd: async () => true,
    });

    const subscription = {
      pendingTurn: {
        turnId: 'turn-1',
        streamKey: 'mirror:session-1:turn-1',
        startedAt: '2026-03-25T08:00:00.000Z',
        lastActivityAt: '2026-03-25T08:04:40.000Z',
        lastResponseAt: '2026-03-25T08:04:40.000Z',
        lastStatusText: null,
        lastStatusAt: 0,
        userText: 'codex prompt',
        lastAssistantText: 'thinking',
        lastCommentaryText: null,
        streamedText: 'thinking',
        streamStarted: true,
        toolCalls: new Map(),
      },
      sessionId: 'session-1',
      threadId: 'thread-1',
      channelType: 'feishu',
      chatId: 'chat-1',
    } as { pendingTurn: any; threadId: string };

    _testOnly.refreshMirrorStreamingStatus(
      subscription as any,
      Date.parse('2026-03-25T08:05:00.000Z'),
      { idleStartMs: 180_000, heartbeatMs: 10_000 },
    );

    assert.deepEqual(statusEvents, [
      'status:mirror:session-1:turn-1:已运行 5分，上次响应距今 20秒',
    ]);
  });

  it('retries mirror stream status when the adapter rejects the previous status update', () => {
    _testOnly.resetStateForTests();
    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const statusEvents: string[] = [];
    let failNext = true;
    state.adapters.set('feishu', {
      channelType: 'feishu',
      provider: 'feishu',
      isRunning: () => true,
      onStreamText: () => {},
      onStreamStatus: (_chatId: string, text: string, streamKey: string) => {
        statusEvents.push(`status:${streamKey}:${text}`);
        if (failNext) {
          failNext = false;
          throw new Error('status failed');
        }
      },
      onStreamEnd: async () => true,
    });

    const subscription = {
      pendingTurn: {
        turnId: 'turn-1',
        streamKey: 'mirror:session-1:turn-1',
        startedAt: '2026-03-25T08:00:00.000Z',
        lastActivityAt: '2026-03-25T08:04:40.000Z',
        lastResponseAt: '2026-03-25T08:04:40.000Z',
        lastStatusText: null,
        lastStatusAt: 0,
        userText: 'codex prompt',
        lastAssistantText: 'thinking',
        lastCommentaryText: null,
        streamedText: 'thinking',
        streamStarted: true,
        toolCalls: new Map(),
      },
      sessionId: 'session-1',
      threadId: 'thread-1',
      channelType: 'feishu',
      chatId: 'chat-1',
    } as { pendingTurn: any; threadId: string };

    _testOnly.refreshMirrorStreamingStatus(
      subscription as any,
      Date.parse('2026-03-25T08:05:00.000Z'),
      { idleStartMs: 180_000, heartbeatMs: 10_000 },
    );
    assert.equal(subscription.pendingTurn.lastStatusText, null);

    _testOnly.refreshMirrorStreamingStatus(
      subscription as any,
      Date.parse('2026-03-25T08:05:00.000Z'),
      { idleStartMs: 180_000, heartbeatMs: 10_000 },
    );

    assert.deepEqual(statusEvents, [
      'status:mirror:session-1:turn-1:已运行 5分，上次响应距今 20秒',
      'status:mirror:session-1:turn-1:已运行 5分，上次响应距今 20秒',
    ]);
    assert.equal(subscription.pendingTurn.lastStatusText, '已运行 5分，上次响应距今 20秒');
  });

  it('keeps the original mirror stream key when turnId arrives after streaming has started', () => {
    const subscription = {
      pendingTurn: null,
      sessionId: 'session-1',
      threadId: 'thread-1',
    } as { pendingTurn: any; threadId: string };

    _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'user',
        type: 'message',
        role: 'user',
        content: 'codex prompt',
        timestamp: '2026-03-25T08:00:00.000Z',
      },
    ]);

    assert.equal(subscription.pendingTurn?.streamKey, 'mirror:session-1:2026-03-25T08:00:00.000Z');

    const finalized = _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'start',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.500Z',
        turnId: 'turn-1',
      },
      {
        signature: 'complete',
        type: 'task_complete',
        role: 'assistant',
        content: 'final answer',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.deepEqual(finalized, [
      {
        streamKey: 'mirror:session-1:2026-03-25T08:00:00.000Z',
        userText: 'codex prompt',
        text: 'final answer',
        signature: 'complete',
        timestamp: '2026-03-25T08:00:03.000Z',
        status: 'completed',
      },
    ]);
    assert.equal(subscription.pendingTurn, null);
  });

  it('accumulates streamed mirror text instead of replacing earlier chunks', () => {
    const subscription = {
      pendingTurn: null,
      sessionId: 'session-1',
      threadId: 'thread-1',
    } as { pendingTurn: any; threadId: string };

    _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'start',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'commentary-1',
        type: 'message',
        role: 'commentary',
        content: 'thinking step 1',
        timestamp: '2026-03-25T08:00:01.000Z',
      },
      {
        signature: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: 'partial answer',
        timestamp: '2026-03-25T08:00:02.000Z',
      },
      {
        signature: 'assistant-2',
        type: 'message',
        role: 'assistant',
        content: 'final answer',
        timestamp: '2026-03-25T08:00:03.000Z',
      },
    ]);

    assert.equal(
      subscription.pendingTurn?.streamedText,
      'thinking step 1\n\npartial answer\n\nfinal answer',
    );
  });

  it('keeps tool-only mirror turns finalizable so streaming cards can close cleanly', () => {
    const subscription = {
      pendingTurn: null,
      sessionId: 'session-1',
      threadId: 'thread-1',
    } as { pendingTurn: unknown; threadId: string };

    const finalized = _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'start',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'tool-start',
        type: 'tool_started',
        content: '',
        timestamp: '2026-03-25T08:00:01.000Z',
        toolId: 'call-1',
        toolName: 'shell_command',
      },
      {
        signature: 'tool-finish',
        type: 'tool_finished',
        content: 'Exit code: 0',
        timestamp: '2026-03-25T08:00:02.000Z',
        toolId: 'call-1',
        isError: false,
      },
      {
        signature: 'complete',
        type: 'task_complete',
        role: 'assistant',
        content: '',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.deepEqual(finalized, [
      {
        streamKey: 'mirror:session-1:turn-1',
        userText: null,
        text: '',
        signature: 'complete',
        timestamp: '2026-03-25T08:00:03.000Z',
        status: 'completed',
      },
    ]);
    assert.equal(subscription.pendingTurn, null);
  });

  it('drains buffered mirror records after a busy window ends', () => {
    const subscription = {
      pendingTurn: null,
      sessionId: 'session-1',
      threadId: 'thread-1',
      bufferedRecords: [
        {
          signature: 'user-1',
          type: 'message',
          role: 'user',
          content: 'codex prompt',
          timestamp: '2026-03-25T08:00:00.000Z',
        },
      ],
    } as { pendingTurn: unknown; threadId: string; bufferedRecords: unknown[] };

    const finalized = _testOnly.consumeBufferedMirrorTurns(
      subscription as any,
      Date.parse('2026-03-25T08:00:30.000Z'),
    );

    assert.deepEqual(finalized, []);
    assert.deepEqual(subscription.bufferedRecords, []);
    assert.deepEqual(subscription.pendingTurn, {
      startedAtMs: Date.parse('2026-03-25T08:00:00.000Z'),
      lastActivityAtMs: Date.parse('2026-03-25T08:00:00.000Z'),
      lastContentResponseAtMs: null,
      turnId: null,
      streamKey: 'mirror:session-1:2026-03-25T08:00:00.000Z',
      startedAt: '2026-03-25T08:00:00.000Z',
      lastActivityAt: '2026-03-25T08:00:00.000Z',
      lastContentResponseAt: null,
      lastResponseAt: null,
      lastStatusText: null,
      lastStatusAt: 0,
      statusNote: null,
      userText: 'codex prompt',
      lastAssistantText: null,
      lastCommentaryText: null,
      streamedText: '',
      streamStarted: false,
      taskItems: [],
      toolCalls: new Map(),
      historyItems: [{ type: 'markdown', role: 'user', content: 'codex prompt' }],
      historyTextSnapshot: '',
      contextUsage: null,
    });
  });

  it('checks buffered pending turns for timeout even when no new file data arrived', () => {
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      bufferedRecords: [],
      pendingTurn: {
        turnId: 'turn-1',
        streamKey: 'mirror:session-1:turn-1',
        startedAt: '2026-03-25T08:00:00.000Z',
        lastActivityAt: '2026-03-25T08:00:00.000Z',
        lastStatusText: null,
        lastStatusAt: 0,
        userText: null,
        lastAssistantText: 'stale answer',
        lastCommentaryText: null,
        streamedText: 'stale answer',
        streamStarted: false,
        toolCalls: new Map(),
      },
    } as { pendingTurn: unknown; threadId: string; bufferedRecords: unknown[] };

    const finalized = _testOnly.consumeBufferedMirrorTurns(
      subscription as any,
      Date.parse('2026-03-25T08:10:01.000Z'),
    );

    assert.deepEqual(finalized, [
      {
        streamKey: 'mirror:session-1:turn-1',
        userText: null,
        text: 'stale answer',
        signature: 'timeout:thread-1:turn-1',
        timestamp: '2026-03-25T08:00:00.000Z',
        status: 'interrupted',
        timedOut: true,
      },
    ]);
    assert.deepEqual(subscription.bufferedRecords, []);
    assert.equal(subscription.pendingTurn, null);
  });

  it('keeps an active mirror stream open past the buffer timeout so status can keep refreshing', () => {
    _testOnly.resetStateForTests();
    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const statusEvents: string[] = [];
    state.adapters.set('feishu', {
      channelType: 'feishu',
      provider: 'feishu',
      isRunning: () => true,
      onStreamText: () => {},
      onStreamStatus: (_chatId: string, text: string, streamKey: string) => {
        statusEvents.push(`status:${streamKey}:${text}`);
      },
      onStreamEnd: async () => true,
    });

    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      channelType: 'feishu',
      chatId: 'chat-1',
      bufferedRecords: [],
      pendingTurn: {
        turnId: 'turn-1',
        streamKey: 'mirror:session-1:turn-1',
        startedAt: '2026-03-25T08:00:00.000Z',
        lastActivityAt: '2026-03-25T08:00:00.000Z',
        lastResponseAt: '2026-03-25T08:00:00.000Z',
        lastStatusText: null,
        lastStatusAt: 0,
        userText: 'codex prompt',
        lastAssistantText: 'still running',
        lastCommentaryText: null,
        streamedText: 'still running',
        streamStarted: true,
        toolCalls: new Map(),
      },
    } as { pendingTurn: any; threadId: string; bufferedRecords: unknown[] };

    const finalized = _testOnly.consumeBufferedMirrorTurns(
      subscription as any,
      Date.parse('2026-03-25T08:10:01.000Z'),
    );

    assert.deepEqual(finalized, []);
    assert.ok(subscription.pendingTurn);

    _testOnly.refreshMirrorStreamingStatus(
      subscription as any,
      Date.parse('2026-03-25T08:10:01.000Z'),
      { idleStartMs: 180_000, heartbeatMs: 10_000 },
    );

    assert.deepEqual(statusEvents, [
      'status:mirror:session-1:turn-1:已运行 10分1秒，上次响应距今 10分1秒',
    ]);
  });

  it('suppresses all mirror records from an IM-originated turn until task_complete', () => {
    const sessionId = 'session-self-echo';
    _testOnly.beginMirrorSuppression(sessionId, '来自 IM 的问题');

    const filtered = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        signature: 'start',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'user-self',
        type: 'message',
        role: 'user',
        content: '来自 IM 的问题',
        timestamp: '2026-03-25T08:00:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'assistant-self',
        type: 'message',
        role: 'assistant',
        content: '来自 IM 的回复',
        timestamp: '2026-03-25T08:00:02.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'codex-commentary',
        type: 'message',
        role: 'commentary',
        content: 'Codex 旧任务还在继续思考',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'codex-turn',
      },
      {
        signature: 'codex-complete',
        type: 'task_complete',
        role: 'assistant',
        content: 'Codex 旧任务完成',
        timestamp: '2026-03-25T08:00:03.500Z',
        turnId: 'codex-turn',
      },
      {
        signature: 'assistant-self-final',
        type: 'message',
        role: 'assistant',
        content: '来自 IM 的最终回复',
        timestamp: '2026-03-25T08:00:03.800Z',
        turnId: 'turn-1',
      },
      {
        signature: 'complete',
        type: 'task_complete',
        role: 'assistant',
        content: '来自 IM 的回复',
        timestamp: '2026-03-25T08:00:04.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.deepEqual(filtered, [
      {
        signature: 'codex-commentary',
        type: 'message',
        role: 'commentary',
        content: 'Codex 旧任务还在继续思考',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'codex-turn',
      },
      {
        signature: 'codex-complete',
        type: 'task_complete',
        role: 'assistant',
        content: 'Codex 旧任务完成',
        timestamp: '2026-03-25T08:00:03.500Z',
        turnId: 'codex-turn',
      },
    ]);
  });

  it('releases later Codex mirror records after the IM-originated turn completes', () => {
    const sessionId = 'session-self-echo-next-batch';
    _testOnly.beginMirrorSuppression(sessionId, '来自 IM 的问题');

    const suppressed = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        signature: 'start',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'user-self',
        type: 'message',
        role: 'user',
        content: '来自 IM 的问题',
        timestamp: '2026-03-25T08:00:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'assistant-self',
        type: 'message',
        role: 'assistant',
        content: '来自 IM 的回复',
        timestamp: '2026-03-25T08:00:02.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'complete',
        type: 'task_complete',
        role: 'assistant',
        content: '来自 IM 的回复',
        timestamp: '2026-03-25T08:00:04.000Z',
        turnId: 'turn-1',
      },
    ]);

    const released = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        signature: 'user-codex',
        type: 'message',
        role: 'user',
        content: '来自 Codex的新消息',
        timestamp: '2026-03-25T08:00:05.000Z',
      },
      {
        signature: 'assistant-codex',
        type: 'message',
        role: 'assistant',
        content: '来自 Codex的回复',
        timestamp: '2026-03-25T08:00:05.500Z',
      },
    ]);

    assert.deepEqual(suppressed, []);
    assert.deepEqual(released, [
      {
        signature: 'user-codex',
        type: 'message',
        role: 'user',
        content: '来自 Codex的新消息',
        timestamp: '2026-03-25T08:00:05.000Z',
      },
      {
        signature: 'assistant-codex',
        type: 'message',
        role: 'assistant',
        content: '来自 Codex的回复',
        timestamp: '2026-03-25T08:00:05.500Z',
      },
    ]);
  });

  it('normalizes unicode punctuation when suppressing IM-originated mirror prompts', () => {
    const sessionId = 'session-unicode-punctuation';
    _testOnly.beginMirrorSuppression(sessionId, '整理一下readme ,主要以功能说明为主,不需要把修改的内容都写进去。');

    const filtered = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        signature: 'user-self',
        type: 'message',
        role: 'user',
        content: '整理一下readme ，主要以功能说明为主，不需要把修改的内容都写进去。',
        timestamp: '2026-03-25T08:00:01.000Z',
      },
      {
        signature: 'assistant-self',
        type: 'message',
        role: 'assistant',
        content: '这是 IM 自己那轮的回复',
        timestamp: '2026-03-25T08:00:02.000Z',
      },
      {
        signature: 'complete',
        type: 'task_complete',
        role: 'assistant',
        content: '这是 IM 自己那轮的回复',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.deepEqual(filtered, []);
  });

  it('supports multiple queued IM suppressions without leaking a delayed earlier completion', () => {
    const sessionId = 'session-queued-suppressions';
    _testOnly.beginMirrorSuppression(sessionId, '第一条 IM 消息');
    _testOnly.beginMirrorSuppression(sessionId, '第二条 IM 消息');

    const filtered = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        signature: 'start-1',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'user-1',
        type: 'message',
        role: 'user',
        content: '第一条 IM 消息',
        timestamp: '2026-03-25T08:00:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: '第一条回复',
        timestamp: '2026-03-25T08:00:02.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'start-2',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'turn-2',
      },
      {
        signature: 'user-2',
        type: 'message',
        role: 'user',
        content: '第二条 IM 消息',
        timestamp: '2026-03-25T08:00:04.000Z',
        turnId: 'turn-2',
      },
      {
        signature: 'assistant-2',
        type: 'message',
        role: 'assistant',
        content: '第二条回复',
        timestamp: '2026-03-25T08:00:05.000Z',
        turnId: 'turn-2',
      },
      {
        signature: 'complete-2',
        type: 'task_complete',
        role: 'assistant',
        content: '第二条回复',
        timestamp: '2026-03-25T08:00:06.000Z',
        turnId: 'turn-2',
      },
      {
        signature: 'complete-1',
        type: 'task_complete',
        role: 'assistant',
        content: '第一条回复',
        timestamp: '2026-03-25T08:00:07.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.deepEqual(filtered, []);
  });

  it('flushes a buffered mirror turn after the idle timeout', () => {
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: {
        turnId: 'turn-1',
        streamKey: 'mirror:session-1:turn-1',
        startedAt: '2026-03-25T08:00:00.000Z',
        lastActivityAt: '2026-03-25T08:00:00.000Z',
        userText: null,
        lastAssistantText: 'stale answer',
      },
    } as { pendingTurn: unknown; threadId: string };

    const flushed = _testOnly.flushTimedOutMirrorTurn(
      subscription as any,
      Date.parse('2026-03-25T08:10:01.000Z'),
    );

    assert.deepEqual(flushed, {
      streamKey: 'mirror:session-1:turn-1',
      userText: null,
      text: 'stale answer',
      signature: 'timeout:thread-1:turn-1',
      timestamp: '2026-03-25T08:00:00.000Z',
      status: 'interrupted',
      timedOut: true,
    });
    assert.equal(subscription.pendingTurn, null);
  });

  it('appends a timeout notice after the mirror content', () => {
    const rendered = _testOnly.formatMirrorMessage('Current Thread', 'Codex prompt', 'stale answer', true);
    const withNotice = _testOnly.appendMirrorTimeoutNotice(rendered, true);

    assert.equal(
      withNotice,
      '**`<Current Thread>`**\n\n**我:** Codex prompt\n\n**codex:** stale answer\n\n> 超时提醒：长时间没有收到新的本地会话输出，本次流式同步已先结束；如果本地会话后续继续产出内容，会重新开始新一轮同步。',
    );
  });
});

describe('bridge-manager stop handling', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
  });

  it('aborts the active IM task only when /stop is received', async () => {
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'msg-stop' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-stop' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\stop');

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const abortController = new AbortController();
    state.activeTasks.set(binding.bridgeSessionId, {
      id: 'task-stop',
      abortController,
      adapter,
      address,
      streamKey: 'stream-stop',
      sessionId: binding.bridgeSessionId,
      hasStreamingCards: false,
      structuredStreamUiActive: false,
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'incoming-stop',
      address,
      text: '/stop',
      timestamp: Date.now(),
    });

    assert.equal(abortController.signal.aborted, true);
    assert.equal(state.activeTasks.has(binding.bridgeSessionId), false);
    assert.match(sent[0] || '', /旧会话「Bridge: chat-stop」任务已停止/);
  });

});

describe('bridge-manager doctor handling', () => {
  it('keeps the original Feishu message id for the generated doctor prompt', () => {
    const address = { channelType: 'feishu', chatId: 'chat-doctor' } as const;
    const msg = {
      messageId: 'om_valid_original_message',
      address,
      text: '/doctor mirror clk_ask',
      timestamp: Date.now(),
      callbackData: 'callback-to-clear',
      callbackMessageId: 'callback-message-to-clear',
      updateId: 123,
    };

    const rewritten = _testOnly.buildDoctorPromptMessage(msg, 'doctor prompt');

    assert.equal(rewritten.messageId, 'om_valid_original_message');
    assert.equal(rewritten.text, 'doctor prompt');
    assert.equal(rewritten.callbackData, undefined);
    assert.equal(rewritten.callbackMessageId, undefined);
    assert.equal(rewritten.updateId, undefined);
  });
});

describe('bridge-manager channel lifecycle events', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
  });

  it('archives the local session when the adapter reports a removed chat', async () => {
    const store = getBridgeContext().store;
    const adapter = new StartupNoticeAdapter({
      id: 'feishu-main',
      provider: 'feishu',
      alias: 'Feishu Main',
    });
    const address = {
      channelType: 'feishu-main',
      channelProvider: 'feishu',
      channelAlias: 'Feishu Main',
      chatId: 'oc_removed',
      chatKind: 'group' as const,
    };
    const binding = router.createBinding(address, 'D:\\workspace\\removed-chat');
    const session = store.getSession(binding.bridgeSessionId);
    assert.ok(session);

    await _testOnly.handleMessage(adapter, {
      messageId: 'im.chat.disbanded_v1:evt-removed',
      address,
      text: '',
      timestamp: Date.now(),
      channelEvent: {
        type: 'chat_removed',
        reason: 'chat_disbanded',
        eventType: 'im.chat.disbanded_v1',
      },
    });

    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    assert.equal(store.getSession(binding.bridgeSessionId), null);
    assert.equal(store.listChannelChats().some((item) => item.id === binding.id), false);
    const audit = fs.readFileSync(path.join(DATA_DIR, 'audit.jsonl'), 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { summary?: string });
    assert.match(audit.at(-1)?.summary || '', /ChannelChat archived: chat disbanded/);
    assert.match(audit.at(-1)?.summary || '', /action=bridge_delete/);
  });

  it('archives the linked Codex thread when a removed chat has a local thread', async () => {
    const store = getBridgeContext().store;
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'archived_sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CODEX_HOME!, 'session_index.jsonl'), { force: true });

    const adapter = new StartupNoticeAdapter({
      id: 'feishu-main',
      provider: 'feishu',
      alias: 'Feishu Main',
    });
    const address = {
      channelType: 'feishu-main',
      channelProvider: 'feishu',
      channelAlias: 'Feishu Main',
      chatId: 'oc_removed_codex',
      chatKind: 'group' as const,
    };
    const threadId = '019e7d66-0000-7000-8000-00000000c0de';
    const { sessionPath } = writeCodexSessionJsonlFixture({
      threadId,
      workDir: '/tmp/lifecycle-archive-codex',
    });
    const binding = router.bindToCodexThread(address, threadId, {
      workingDirectory: '/tmp/lifecycle-archive-codex',
      codexTitle: 'Lifecycle Archive Codex',
    });
    assert.ok(binding);

    await _testOnly.handleMessage(adapter, {
      messageId: 'im.chat.disbanded_v1:evt-removed-codex',
      address,
      text: '',
      timestamp: Date.now(),
      channelEvent: {
        type: 'chat_removed',
        reason: 'chat_disbanded',
        eventType: 'im.chat.disbanded_v1',
      },
    });

    assert.equal(fs.existsSync(sessionPath), false);
    const archivedEntries = fs.readdirSync(path.join(process.env.CODEX_HOME!, 'archived_sessions'));
    assert.equal(archivedEntries.length, 1);
    assert.match(archivedEntries[0] || '', /019e7d66-0000-7000-8000-00000000c0de\.jsonl$/);
    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    assert.equal(store.getSession(binding.bridgeSessionId), null);
    assert.equal(store.listChannelChats().some((item) => item.id === binding.id), false);
    const audit = fs.readFileSync(path.join(DATA_DIR, 'audit.jsonl'), 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { summary?: string });
    assert.match(audit.at(-1)?.summary || '', /ChannelChat archived: chat disbanded/);
    assert.match(audit.at(-1)?.summary || '', /action=codex_archive/);
    assert.match(audit.at(-1)?.summary || '', new RegExp(`thread=${threadId}`));
  });

  it('archives the linked Claude Code JSONL session when a group chat is disbanded', async () => {
    const store = getBridgeContext().store;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-lifecycle-claude-home-'));
    const previousClaudeHome = process.env.CODELARK_CLAUDE_HOME;
    process.env.CODELARK_CLAUDE_HOME = homeDir;

    const adapter = new StartupNoticeAdapter({
      id: 'feishu-main',
      provider: 'feishu',
      alias: 'Feishu Main',
    });
    const address = {
      channelType: 'feishu-main',
      channelProvider: 'feishu',
      channelAlias: 'Feishu Main',
      chatId: 'oc_removed_claude',
      chatKind: 'group' as const,
    };
    const claudeSessionId = '019e7d66-0000-7000-8000-00000000c1a0';
    const cwd = '/tmp/lifecycle-archive-claude';
    writeClaudeJsonlFixture({
      homeDir,
      cwd,
      sessionId: claudeSessionId,
      text: 'lifecycle archive claude',
    });
    const session = store.createSession('Lifecycle Archive Claude', 'default', undefined, cwd, 'normal');
    store.updateSession(session.id, mergeSessionRuntimeUpdates(
      {},
      setSessionActiveRuntimeUpdate('claude'),
      setSessionClaudeIdentityUpdate(claudeSessionId, cwd),
    ));
    const binding = router.bindToSession(address, session.id);
    assert.ok(binding);

    try {
      await _testOnly.handleMessage(adapter, {
        messageId: 'im.chat.disbanded_v1:evt-removed-claude',
        address,
        text: '',
        timestamp: Date.now(),
        channelEvent: {
          type: 'chat_removed',
          reason: 'chat_disbanded',
          eventType: 'im.chat.disbanded_v1',
        },
      });

      assert.equal(isArchivedClaudeSession(claudeSessionId, cwd), true);
      assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
      assert.equal(store.getSession(binding.bridgeSessionId), null);
      assert.equal(store.listChannelChats().some((item) => item.id === binding.id), false);
      const audit = fs.readFileSync(path.join(DATA_DIR, 'audit.jsonl'), 'utf-8')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { summary?: string });
      assert.match(audit.at(-1)?.summary || '', /ChannelChat archived: chat disbanded/);
      assert.match(audit.at(-1)?.summary || '', /action=claude_archive/);
      assert.match(audit.at(-1)?.summary || '', new RegExp(`claude_session=${claudeSessionId}`));
    } finally {
      if (previousClaudeHome === undefined) {
        delete process.env.CODELARK_CLAUDE_HOME;
      } else {
        process.env.CODELARK_CLAUDE_HOME = previousClaudeHome;
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('bridge-manager startup runtime cleanup', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(CONFIG_TOML_PATH, { force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
  });

  it('resets persisted running and queued sessions back to idle on startup', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const session = store.createSession('Desktop: stale', '', undefined, 'D:\\workspace\\stale', 'code');
    store.updateSession(session.id, {
      runtime_status: 'running',
      queued_count: 2,
      last_runtime_update_at: '2026-04-01T00:00:00.000Z',
    });

    await start();

    const refreshed = store.getSession(session.id);
    assert.equal(refreshed?.runtime_status, 'idle');
    assert.equal(refreshed?.queued_count || 0, 0);
  });

  it('sends a startup status notice to active bound chats', async () => {
    StartupNoticeAdapter.sentMessages = [];
    StartupNoticeAdapter.groupChats = new Map();
    registerAdapterFactory('feishu', (instance) => new StartupNoticeAdapter(instance as any));

    writeHomeChannelsToml([{
      id: 'startup-notice-main',
      alias: 'Startup Notice',
      enabled: true,
    }]);
    const settings = makeSettings();
    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-startup',
      userId: 'user-startup',
      displayName: 'Startup Chat',
    }, 'D:\\workspace\\startup');

    try {
      await start();
      for (let i = 0; i < 20 && StartupNoticeAdapter.sentMessages.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await stop();
    }

    assert.equal(StartupNoticeAdapter.sentMessages.length, 1);
    const notice = StartupNoticeAdapter.sentMessages[0];
    assert.equal(notice.address.chatId, 'chat-startup');
    assert.equal(store.getChannelChat('startup-notice-main', 'chat-startup')?.chatKind, 'p2p');
    assert.match(notice.text, /Bridge 已启动/);
    assert.match(notice.text, /全局状态/);
    assert.match(notice.text, /Adapter/);
    assert.equal(notice.richCard?.title, 'Bridge 已启动');
    assert.equal(notice.richCard?.template, 'turquoise');
    assert.equal(notice.richCard?.sections[0]?.markdown, notice.text.replace(/^Bridge 已启动\n\n/, ''));
    assert.match(notice.richCard?.sections[0]?.markdown || '', /全局状态/);
  });

  it('includes Feishu event subscriptions but not permission imports in the startup card', async () => {
    StartupNoticeAdapter.sentMessages = [];
    StartupNoticeAdapter.groupChats = new Map();
    registerAdapterFactory('feishu', (instance) => new StartupNoticeAdapter(instance as any));

    writeHomeChannelsToml([{
      id: 'startup-notice-main',
      alias: 'Startup Notice',
      enabled: true,
      config: { app_id: 'cli_test_app', site: 'feishu' },
    }]);
    const settings = makeSettings();
    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-startup',
      chatKind: 'p2p',
      userId: 'user-startup',
      displayName: 'Startup Chat',
    }, 'D:\\workspace\\startup');

    try {
      await start();
      for (let i = 0; i < 20 && StartupNoticeAdapter.sentMessages.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await stop();
    }

    const notice = StartupNoticeAdapter.sentMessages[0];
    assert.match(notice.text, /飞书配置检查/);
    assert.doesNotMatch(notice.text, /im:message:send_as_bot/);
    assert.doesNotMatch(notice.text, /cardkit:card:write/);
    assert.doesNotMatch(notice.text, /权限：/);
    assert.match(notice.text, /im\.chat\.disbanded_v1/);
    assert.match(notice.text, /https:\/\/open\.feishu\.cn\/app\/cli_test_app\/event\?tab=callback/);
    const richMarkdown = notice.richCard?.sections.map((section) => section.markdown || '').join('\n') || '';
    assert.match(richMarkdown, /im\.chat\.member\.bot\.deleted_v1/);
    assert.doesNotMatch(richMarkdown, /im:message:send_as_bot/);
    assert.doesNotMatch(notice.richCard?.sections[0]?.markdown || '', /飞书配置检查/);
    assert.equal(notice.richCard?.sections.filter((section) => section.title === '飞书配置检查').length, 1);
  });

  it('sends the startup card to the saved hot-update trigger chat before falling back to p2p', async () => {
    StartupNoticeAdapter.sentMessages = [];
    StartupNoticeAdapter.groupChats = new Map();
    registerAdapterFactory('feishu', (instance) => new StartupNoticeAdapter(instance as any));

    writeHomeChannelsToml([{
      id: 'startup-notice-main',
      alias: 'Startup Notice',
      enabled: true,
    }]);
    const settings = makeSettings();
    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-p2p',
      chatKind: 'p2p',
      userId: 'user-p2p',
      displayName: 'Fallback DM',
    }, 'D:\\workspace\\p2p');
    saveStartupNoticeTarget({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-hot-update-source',
      chatKind: 'group',
      userId: 'user-hot-update',
      displayName: 'Hot Update Source',
    });

    try {
      await start();
      for (let i = 0; i < 20 && StartupNoticeAdapter.sentMessages.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await stop();
    }

    assert.equal(StartupNoticeAdapter.sentMessages.length, 1);
    assert.equal(StartupNoticeAdapter.sentMessages[0].address.chatId, 'chat-hot-update-source');
  });

  it('backfills missing ChannelChat kinds from the provider chat info on startup', async () => {
    StartupNoticeAdapter.sentMessages = [];
    StartupNoticeAdapter.groupChats = new Map([
      ['chat-p2p-missing-kind', { chatId: 'chat-p2p-missing-kind', chatKind: 'p2p', name: 'Backfilled DM' }],
      ['chat-group-missing-kind', { chatId: 'chat-group-missing-kind', chatKind: 'group', name: 'Backfilled Group' }],
    ]);
    registerAdapterFactory('feishu', (instance) => new StartupNoticeAdapter(instance as any));

    writeHomeChannelsToml([{
      id: 'startup-notice-main',
      alias: 'Startup Notice',
      enabled: true,
    }]);
    const settings = makeSettings();
    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-p2p-missing-kind',
      userId: 'user-p2p',
      displayName: 'Backfilled DM',
    }, 'D:\\workspace\\p2p');
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-group-missing-kind',
      displayName: 'Backfilled Group',
    }, 'D:\\workspace\\group');

    try {
      await start();
      for (let i = 0; i < 20 && StartupNoticeAdapter.sentMessages.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await stop();
    }

    assert.equal(store.getChannelChat('startup-notice-main', 'chat-p2p-missing-kind')?.chatKind, 'p2p');
    assert.equal(store.getChannelChat('startup-notice-main', 'chat-group-missing-kind')?.chatKind, 'group');
    assert.equal(StartupNoticeAdapter.sentMessages.length, 1);
    assert.equal(StartupNoticeAdapter.sentMessages[0].address.chatId, 'chat-p2p-missing-kind');
  });

  it('archives missing provider chats on startup and reports them in the startup notice', async () => {
    StartupNoticeAdapter.sentMessages = [];
    StartupNoticeAdapter.groupChats = new Map([
      ['chat-alive', { chatId: 'chat-alive', chatKind: 'p2p', name: 'Alive DM' }],
      ['chat-missing', null],
    ]);
    registerAdapterFactory('feishu', (instance) => new StartupNoticeAdapter(instance as any));

    writeHomeChannelsToml([{
      id: 'startup-notice-main',
      alias: 'Startup Notice',
      enabled: true,
    }]);
    const settings = makeSettings();
    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
    const aliveBinding = router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-alive',
      chatKind: 'p2p',
      userId: 'user-alive',
      displayName: 'Alive DM',
    }, 'D:\\workspace\\alive');
    const missingBinding = router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-missing',
      chatKind: 'group',
      userId: 'user-missing',
      displayName: 'Missing Group',
    }, 'D:\\workspace\\missing');

    try {
      await start();
      for (let i = 0; i < 20 && StartupNoticeAdapter.sentMessages.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await stop();
    }

    assert.equal(StartupNoticeAdapter.sentMessages.length, 1);
    const notice = StartupNoticeAdapter.sentMessages[0];
    assert.equal(notice.address.chatId, 'chat-alive');
    assert.match(notice.text, /有一个群聊已不在，因此已对这个对话做了归档/);
    assert.match(notice.text, /Missing Group/);
    assert.equal(store.getChannelChat('startup-notice-main', 'chat-alive')?.id, aliveBinding.id);
    assert.equal(store.getChannelChat('startup-notice-main', 'chat-missing'), null);
    assert.equal(store.getSession(missingBinding.bridgeSessionId), null);
    assert.match(notice.richCard?.sections.map((section) => section.markdown || '').join('\n') || '', /Missing Group/);
    assert.doesNotMatch(notice.richCard?.sections[0]?.markdown || '', /启动检查/);
    assert.equal(notice.richCard?.sections.filter((section) => section.title === '启动检查').length, 1);
  });

  it('checks startup channel chats concurrently instead of waiting for each chat serially', async () => {
    StartupNoticeAdapter.groupChats = new Map([
      ['chat-slow-a', { chatId: 'chat-slow-a', chatKind: 'group', name: 'Slow A' }],
      ['chat-slow-b', { chatId: 'chat-slow-b', chatKind: 'group', name: 'Slow B' }],
    ]);
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    StartupNoticeAdapter.groupChatInfoHooks = new Map([
      ['chat-slow-a', () => new Promise<void>((resolve) => {
        started.push('chat-slow-a');
        releases.set('chat-slow-a', resolve);
      })],
      ['chat-slow-b', () => new Promise<void>((resolve) => {
        started.push('chat-slow-b');
        releases.set('chat-slow-b', resolve);
      })],
    ]);
    registerAdapterFactory('feishu', (instance) => new StartupNoticeAdapter(instance as any));

    writeHomeChannelsToml([{
      id: 'startup-notice-main',
      alias: 'Startup Notice',
      enabled: true,
    }]);
    const settings = makeSettings();
    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-slow-a',
      chatKind: 'group',
      displayName: 'Slow A',
    }, 'D:\\workspace\\slow-a');
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-slow-b',
      chatKind: 'group',
      displayName: 'Slow B',
    }, 'D:\\workspace\\slow-b');

    try {
      await _testOnly.syncConfiguredAdapters({ startLoops: false });
      const check = _testOnly.reconcileStartupChannelChats();
      for (let i = 0; i < 20 && started.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      assert.deepEqual(new Set(started), new Set(['chat-slow-a', 'chat-slow-b']));
      releases.get('chat-slow-a')?.();
      releases.get('chat-slow-b')?.();
      assert.deepEqual(await check, { archivedMissingChats: [], checkErrors: [] });
    } finally {
      releases.get('chat-slow-a')?.();
      releases.get('chat-slow-b')?.();
      StartupNoticeAdapter.groupChatInfoHooks = new Map();
      await stop();
    }
  });

  it('does not re-check known p2p chats during startup channel chat reconciliation', async () => {
    StartupNoticeAdapter.groupChats = new Map([
      ['chat-group', { chatId: 'chat-group', chatKind: 'group', name: 'Group' }],
    ]);
    const checked: string[] = [];
    StartupNoticeAdapter.groupChatInfoHooks = new Map([
      ['chat-p2p', () => { checked.push('chat-p2p'); }],
      ['chat-group', () => { checked.push('chat-group'); }],
    ]);
    registerAdapterFactory('feishu', (instance) => new StartupNoticeAdapter(instance as any));

    writeHomeChannelsToml([{
      id: 'startup-notice-main',
      alias: 'Startup Notice',
      enabled: true,
    }]);
    const settings = makeSettings();
    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-p2p',
      chatKind: 'p2p',
      userId: 'user-p2p',
      displayName: 'Known DM',
    }, 'D:\\workspace\\p2p');
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-group',
      chatKind: 'group',
      displayName: 'Known Group',
    }, 'D:\\workspace\\group');

    try {
      await _testOnly.syncConfiguredAdapters({ startLoops: false });
      assert.deepEqual(await _testOnly.reconcileStartupChannelChats(), {
        archivedMissingChats: [],
        checkErrors: [],
      });
      assert.deepEqual(checked, ['chat-group']);
    } finally {
      StartupNoticeAdapter.groupChatInfoHooks = new Map();
      await stop();
    }
  });

  it('sends the startup notice before slow channel chat checks finish', async () => {
    StartupNoticeAdapter.sentMessages = [];
    StartupNoticeAdapter.groupChats = new Map([
      ['chat-slow-group', { chatId: 'chat-slow-group', chatKind: 'group', name: 'Slow Group' }],
    ]);
    let slowCheckStarted = false;
    let releaseSlowCheck: () => void = () => {};
    StartupNoticeAdapter.groupChatInfoHooks = new Map([
      ['chat-slow-group', () => new Promise<void>((resolve) => {
        slowCheckStarted = true;
        releaseSlowCheck = resolve;
      })],
    ]);
    registerAdapterFactory('feishu', (instance) => new StartupNoticeAdapter(instance as any));

    writeHomeChannelsToml([{
      id: 'startup-notice-main',
      alias: 'Startup Notice',
      enabled: true,
    }]);
    const settings = makeSettings();
    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-p2p',
      chatKind: 'p2p',
      userId: 'user-p2p',
      displayName: 'Notice DM',
    }, 'D:\\workspace\\p2p');
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-slow-group',
      chatKind: 'group',
      displayName: 'Slow Group',
    }, 'D:\\workspace\\slow-group');

    try {
      await _testOnly.syncConfiguredAdapters({ startLoops: false });
      const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
      state.running = true;
      state.startedAt = new Date().toISOString();

      const flow = _testOnly.runStartupNotificationFlow({ channelChatCheckNoticeBudgetMs: 10 });
      for (let i = 0; i < 20 && StartupNoticeAdapter.sentMessages.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      assert.equal(StartupNoticeAdapter.sentMessages.length, 1);
      assert.equal(StartupNoticeAdapter.sentMessages[0].address.chatId, 'chat-p2p');
      assert.equal(slowCheckStarted, true);

      releaseSlowCheck();
      await flow;
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(StartupNoticeAdapter.sentMessages.length, 1);
    } finally {
      releaseSlowCheck();
      StartupNoticeAdapter.groupChatInfoHooks = new Map();
      await stop();
    }
  });

  it('keeps ChannelChats when the startup provider check cannot confirm whether the chat exists', async () => {
    StartupNoticeAdapter.sentMessages = [];
    StartupNoticeAdapter.groupChats = new Map([
      ['chat-alive', { chatId: 'chat-alive', chatKind: 'p2p', name: 'Alive DM' }],
      ['chat-error', { chatId: 'chat-error', chatKind: 'group', name: 'Uncertain Group' }],
    ]);
    StartupNoticeAdapter.groupChatErrors = new Map([
      ['chat-error', 'permission denied'],
    ]);
    registerAdapterFactory('feishu', (instance) => new StartupNoticeAdapter(instance as any));

    writeHomeChannelsToml([{
      id: 'startup-notice-main',
      alias: 'Startup Notice',
      enabled: true,
    }]);
    const settings = makeSettings();
    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
    router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-alive',
      chatKind: 'p2p',
      userId: 'user-alive',
      displayName: 'Alive DM',
    }, 'D:\\workspace\\alive');
    const uncertainBinding = router.createBinding({
      channelType: 'startup-notice-main',
      channelProvider: 'feishu',
      channelAlias: 'Startup Notice',
      chatId: 'chat-error',
      chatKind: 'group',
      displayName: 'Uncertain Group',
    }, 'D:\\workspace\\uncertain');

    try {
      await start();
      for (let i = 0; i < 20 && StartupNoticeAdapter.sentMessages.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await stop();
      StartupNoticeAdapter.groupChatErrors = new Map();
    }

    assert.equal(StartupNoticeAdapter.sentMessages.length, 1);
    const notice = StartupNoticeAdapter.sentMessages[0];
    assert.match(notice.text, /以下群聊暂时无法确认，未修改数据/);
    assert.match(notice.text, /Uncertain Group/);
    assert.match(notice.text, /permission denied/);
    assert.equal(store.getChannelChat('startup-notice-main', 'chat-error')?.id, uncertainBinding.id);
    assert.equal(store.getSession(uncertainBinding.bridgeSessionId)?.id, uncertainBinding.bridgeSessionId);
  });
});

describe('bridge-manager mirror subscription recovery', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
  });

  it('clears dangling Codex thread ids after repeated missing Codex thread lookups', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const address = { channelType: 'feishu-default', chatId: 'chat-dangling' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\dangling');
    store.updateSessionCodexThreadId(binding.bridgeSessionId, 'missing-thread-id');

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    state.running = true;
    state.adapters.set(address.channelType, {
      channelType: address.channelType,
      provider: 'feishu',
      isRunning: () => false,
    });

    await _testOnly.reconcileMirrorSubscriptions();
    await _testOnly.reconcileMirrorSubscriptions();

    assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, 'missing-thread-id');
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, binding.bridgeSessionId);

    await _testOnly.reconcileMirrorSubscriptions();

    assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId || '', '');
    assert.equal(state.mirrorSubscriptions.size, 0);
  });

  it('does not create mirror subscriptions for cloud document comment bindings', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-doc-mirror-skip-'));
    const threadId = '019e8f00-0000-7000-9000-000000000001';
    writeCodexSessionJsonlFixture({ threadId, workDir });
    const address = {
      channelType: 'feishu-default',
      chatId: 'doc:docx:doc-token:comment:comment-1',
    } as const;
    const binding = router.createBinding(address, workDir);
    store.updateSessionCodexThreadId(binding.bridgeSessionId, threadId);

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    state.running = true;
    state.adapters.set(address.channelType, {
      channelType: address.channelType,
      provider: 'feishu',
      isRunning: () => true,
    });

    await _testOnly.reconcileMirrorSubscriptions();

    assert.equal(state.mirrorSubscriptions.has(binding.id), false);
    assert.equal(state.mirrorSubscriptions.size, 0);
  });

  it('does not reject mirror reconcile when mirror session state persistence fails', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const address = { channelType: 'feishu-default', chatId: 'chat-sync-failure' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\sync-failure');
    store.updateSessionCodexThreadId(binding.bridgeSessionId, 'missing-thread-id');

    const originalUpdateSession = store.updateSession.bind(store);
    (store as unknown as { updateSession: typeof store.updateSession }).updateSession = (() => {
      throw {};
    }) as typeof store.updateSession;

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    state.running = true;
    state.adapters.set(address.channelType, {
      channelType: address.channelType,
      provider: 'feishu',
      isRunning: () => false,
    });

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await assert.doesNotReject(_testOnly.reconcileMirrorSubscriptions());
    } finally {
      console.error = originalError;
      (store as unknown as { updateSession: typeof store.updateSession }).updateSession = originalUpdateSession;
    }

    assert.ok(errors.some((line) => line.includes('Failed to sync mirror session state')));
  });

  it('keeps a suspended mirror subscription suspended until the timeout elapses', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const address = { channelType: 'feishu-default', chatId: 'chat-suspended' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\suspended');
    store.updateSessionCodexThreadId(binding.bridgeSessionId, 'thread-suspended');

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    state.running = true;
    state.adapters.set(address.channelType, {
      channelType: address.channelType,
      provider: 'feishu',
      isRunning: () => false,
    });
    state.mirrorSubscriptions.set(binding.id, {
      ...createMirrorSubscription({
        bindingId: binding.id,
        sessionId: binding.bridgeSessionId,
        channelType: address.channelType,
        chatId: address.chatId,
        threadId: 'thread-suspended',
        filePath: null,
        lastDeliveredAt: null,
      }),
      consecutiveFailures: 3,
      suspendedUntil: Date.now() + 60_000,
    });

    const suspendedUntil = state.mirrorSubscriptions.get(binding.id)?.suspendedUntil;
    await _testOnly.reconcileMirrorSubscriptions();

    assert.equal(state.mirrorSubscriptions.get(binding.id)?.suspendedUntil, suspendedUntil);
    assert.equal(state.mirrorSubscriptions.get(binding.id)?.consecutiveFailures, 3);
  });

  it('keeps one mirror subscription for the current ChannelChat target', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const address = { channelType: 'feishu-default', chatId: 'chat-mirror-multi' } as const;
    const bindingA = router.bindToCodexThread(address, 'thread-mirror-a', {
      workingDirectory: 'D:\\workspace\\mirror-a',
      displayName: 'mirror-a',
    });
    const bindingB = router.bindToCodexThread(address, 'thread-mirror-b', {
      workingDirectory: 'D:\\workspace\\mirror-b',
      displayName: 'mirror-b',
    });

    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, bindingB.bridgeSessionId);
    assert.equal(bindingB.id, bindingA.id);

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    state.running = true;
    state.adapters.set(address.channelType, {
      channelType: address.channelType,
      provider: 'feishu',
      isRunning: () => true,
    });

    await _testOnly.reconcileMirrorSubscriptions();

    assert.deepEqual(
      Array.from(state.mirrorSubscriptions.keys()).sort(),
      [bindingB.id],
    );

    store.deleteChannelChat(bindingB.id);
    await _testOnly.reconcileMirrorSubscriptions();

    assert.deepEqual(Array.from(state.mirrorSubscriptions.keys()), []);
  });

  it('clears mirrorSyncInFlight even when subscription set planning throws', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    (store as unknown as { listChannelChats: typeof store.listChannelChats }).listChannelChats = (() => {
      throw new Error('bindings boom');
    }) as typeof store.listChannelChats;

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    state.running = true;

    await assert.doesNotReject(_testOnly.reconcileMirrorSubscriptions());
    assert.equal(state.mirrorSyncInFlight, false);
  });
});

describe('bridge-manager invalid adapter logging', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(CONFIG_TOML_PATH, { force: true });
    registerAdapterFactory('feishu', (instance) => new InvalidConfigAdapter(instance as any));
    _testOnly.resetStateForTests();
  });

  it('logs unchanged invalid adapter configs only once', async () => {
    writeHomeChannelsToml([{
      id: 'feishu-invalid-main',
      alias: 'Invalid Feishu',
      enabled: true,
    }]);
    const settings = makeSettings();

    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await _testOnly.syncConfiguredAdapters({ startLoops: false });
      await _testOnly.syncConfiguredAdapters({ startLoops: false });
    } finally {
      console.warn = originalWarn;
    }

    const matching = warnings.filter((line) => line.includes('feishu-invalid-main adapter not valid'));
    assert.equal(matching.length, 1);
  });

  it('stops removed adapters and clears runtime bookkeeping', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const stopped: string[] = [];
    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    state.adapters.set('feishu-default', {
      channelType: 'feishu-default',
      provider: 'feishu',
      stop: async () => {
        stopped.push('feishu-default');
      },
      isRunning: () => false,
    });
    state.adapterMeta.set('feishu-default', {
      lastMessageAt: null,
      lastError: null,
      configFingerprint: 'old',
    });
    state.loopAborts.set('feishu-default', new AbortController());

    await _testOnly.syncConfiguredAdapters({ startLoops: false });

    assert.deepEqual(stopped, ['feishu-default']);
    assert.equal(state.adapters.has('feishu-default'), false);
    assert.equal(state.adapterMeta.has('feishu-default'), false);
    assert.equal(state.loopAborts.has('feishu-default'), false);
  });

  it('does not retain adapters that fail during start', async () => {
    ThrowStartAdapter.stopCalls = [];
    registerAdapterFactory('feishu', (instance) => new ThrowStartAdapter(instance as any));

    writeHomeChannelsToml([{
      id: 'feishu-throw-start-main',
      alias: 'Throw Start',
      enabled: true,
    }]);
    const settings = makeSettings();

    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    await _testOnly.syncConfiguredAdapters({ startLoops: false });

    assert.equal(state.adapters.has('feishu-throw-start-main'), false);
    assert.equal(state.adapterMeta.has('feishu-throw-start-main'), false);
    assert.deepEqual(ThrowStartAdapter.stopCalls, ['feishu-throw-start-main']);
  });
});

describe('bridge-manager new session handling', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
  });

  it('keeps the current task running when /new --force creates another IM session', async () => {
    const sent: string[] = [];
    const createdGroups: Array<{ chatId: string; chatKind: 'group'; name: string }> = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'msg-new' };
      },
      createGroupChat: async (input: { name: string }) => {
        const group = {
          chatId: `chat-new-group-${createdGroups.length + 1}`,
          chatKind: 'group' as const,
          name: `[TestBot]${input.name}`,
        };
        createdGroups.push(group);
        return group;
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-new' } as const;
    const oldWorkDir = path.join(os.tmpdir(), 'clk-old-session');
    const newWorkDir = path.join(os.tmpdir(), 'clk-new-session');
    const binding = router.createBinding(address, oldWorkDir);

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const abortController = new AbortController();
    state.activeTasks.set(binding.bridgeSessionId, {
      id: 'task-old',
      abortController,
      adapter,
      address,
      requestMessageId: 'incoming-old',
      streamKey: 'stream-old',
      sessionId: binding.bridgeSessionId,
      hasStreamingCards: false,
      structuredStreamUiActive: false,
      lastActivityAt: Date.now(),
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'incoming-new',
      address,
      text: `/new ${newWorkDir} --force`,
      timestamp: Date.now(),
    });

    const currentBinding = router.resolve(address);
    const newGroupBinding = getBridgeContext().store.getChannelChat('feishu', createdGroups[0]?.chatId || '');
    assert.equal(abortController.signal.aborted, false);
    assert.equal(currentBinding.bridgeSessionId, binding.bridgeSessionId);
    assert.ok(newGroupBinding);
    assert.notEqual(newGroupBinding.bridgeSessionId, binding.bridgeSessionId);
    assert.equal(state.activeTasks.get(binding.bridgeSessionId)?.id, 'task-old');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /旧任务在运行，它不会被终止/);
  });

  it('does not write an old task Codex thread id back onto the current binding after /new', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const address = { channelType: 'feishu', chatId: 'chat-new-binding' } as const;
    const oldBinding = router.createBinding(address, path.join(os.tmpdir(), 'clk-old-binding'));
    const oldSessionId = oldBinding.bridgeSessionId;

    const newBinding = router.createBinding(address, path.join(os.tmpdir(), 'clk-new-binding'));
    const newSessionId = newBinding.bridgeSessionId;

    assert.equal(newBinding.id, oldBinding.id);
    assert.notEqual(newSessionId, oldSessionId);

    _testOnly.persistCodexThreadUpdate(oldSessionId, 'thread-old', false);

    const currentBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.equal(store.getSession(oldSessionId)?.runtime?.codex?.threadId, 'thread-old');
    assert.equal(store.getSession(newSessionId)?.runtime?.codex?.threadId || '', '');
    assert.equal(currentBinding?.bridgeSessionId, newSessionId);
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.id, oldBinding.id);
  });

  it('keeps the current Codex thread after a transient resume process-exit error', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const address = { channelType: 'feishu', chatId: 'chat-resume-error' } as const;
    const binding = router.createBinding(address, path.join(os.tmpdir(), 'clk-resume-error'));
    store.updateSessionCodexThreadId(binding.bridgeSessionId, 'thread-keep');

    _testOnly.persistCodexThreadUpdate(
      binding.bridgeSessionId,
      null,
      true,
      'Codex 会话恢复失败，上一轮执行进程未正常退出。请稍后重试。',
    );

    const currentBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, 'thread-keep');
    assert.equal(currentBinding?.bridgeSessionId, binding.bridgeSessionId);
    assert.equal(_testOnly.computeCodexThreadUpdate(null, true, 'timeout waiting for child process to exit'), null);
    assert.equal(_testOnly.computeCodexThreadUpdate(null, true, 'resuming session with different model'), '');
  });
});

describe('channel-router defaults', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('binds new chats to a hidden temporary session in the default workspace', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });

    const binding = router.resolve({
      channelType: 'feishu',
      chatId: 'chat-default-mode',
      userId: 'ou_abcdef999999',
    });
    const session = store.getSession(binding.bridgeSessionId);

    assert.equal(session?.runtime?.codex?.mode, undefined);
    assert.equal(session?.hidden, true);
    assert.equal(session?.session_type, 'normal');
    assert.equal(session?.name, 'ou_abcdef');
    assert.equal(getSessionWorkingDirectory(session), DEFAULT_WORKSPACE_ROOT);
  });
});
