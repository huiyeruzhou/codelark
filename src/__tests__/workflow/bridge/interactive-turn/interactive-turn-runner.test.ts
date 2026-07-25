import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { createConfigService } from '../../../../configuration/service.js';
import type { ConfigPatch } from '../../../../configuration/schema.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { getBridgeContext, initBridgeContext } from '../../../../bridge/host/context.js';
import { BaseChannelAdapter, type StructuredStreamingUiActionButton, type StructuredStreamingUiMetadata, type StructuredStreamingUiSnapshot } from '../../../../channels/contracts.js';
import type { ChannelChat, InboundMessage, OutboundAttachment, OutboundMessage, SendResult, StreamingHistoryItem, TaskProgressInfo, ToolCallInfo } from '../../../../domain/index.js';
import * as router from '../../../../bridge/host/channel-router.js';
import { formatInteractiveRuntimeStatus, runInteractiveMessage, type InteractiveTaskState } from '../../../../bridge/turn/interactive/runner.js';
import type { PermissionRequestInfo } from '../../../../bridge/turn/interactive/sdk-conversation-engine.js';
import {
  buildInteractiveStreamCardMetadata,
  resolveInteractiveTurnEnvironment,
  resolveInteractiveTurnRuntimeSettings,
} from '../../../../bridge/turn/interactive/turn-environment.js';
import type { ActiveBridgeTurn } from '../../../../bridge/turn/turn-types.js';
import { getCodexSessionByThreadIdSafe } from '../../../../bridge/session/support.js';
import { ThreadDisplayService } from '../../../../bridge/session/thread-display-resolver.js';
import { writeCodexSessionJsonlFixture } from '../../../helpers/bridge/test-bridge-utils.js';
import { formatFooterClockTime } from '../../../../shared/progress/footer.js';

const DATA_DIR = path.join(CODELARK_HOME, 'data');
const CONFIG_TOML_PATH = path.join(CODELARK_HOME, 'config.toml');

function makeSettings(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
    ...Object.entries(overrides),
  ]);
}

function resolveTestInteractiveTurnEnvironment(
  address: InboundMessage['address'],
  messageId: string,
) {
  return resolveInteractiveTurnEnvironment(address, messageId, {
    resolveBinding: (targetAddress) => router.resolve(targetAddress),
    getBridgeSession: (sessionId) => getBridgeContext().store.getSession(sessionId),
    codexThreadExists: (threadId) => Boolean(getCodexSessionByThreadIdSafe(threadId, 'interactive turn test classify')),
  });
}

function resolveTestInteractiveTurnRuntimeSettings(channelType?: string) {
  return resolveInteractiveTurnRuntimeSettings(
    channelType,
    (key) => getBridgeContext().store.getSetting(key),
  );
}

function setSessionConfigToml(sessionId: string, patch: ConfigPatch): void {
  createConfigService({ migrate: false, env: {} }).set(
    { kind: 'session', sessionId },
    patch,
  );
}

class FakeFeishuStreamingAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu-default';
  readonly provider = 'feishu';
  readonly streamedTexts: string[] = [];
  readonly streamedStatuses: string[] = [];
  readonly streamedTools: ToolCallInfo[][] = [];
  readonly streamedHistories: StreamingHistoryItem[][] = [];
  readonly streamedTasks: TaskProgressInfo[][] = [];
  readonly streamedActions: StructuredStreamingUiActionButton[][][] = [];
  readonly streamEnds: Array<{ status: 'completed' | 'interrupted' | 'error'; text: string }> = [];
  readonly streamMetadata: StructuredStreamingUiMetadata[] = [];
  readonly messageStarts: Array<{ chatId: string; streamKey?: string }> = [];
  readonly messageEnds: Array<{ chatId: string; streamKey?: string }> = [];
  readonly sentMessages: OutboundMessage[] = [];
  streamEndResult = false;
  private streamUiActive = false;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true; }
  consumeOne(): Promise<InboundMessage | null> { return Promise.resolve(null); }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.sentMessages.push(message);
    return { ok: true, messageId: 'sent-1' };
  }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }

  supportsStructuredStreamingUi(): boolean {
    return true;
  }

  hasActiveStreamingUi(): boolean {
    return this.streamUiActive;
  }

  onMessageStart(chatId: string, streamKey?: string): void {
    this.messageStarts.push({ chatId, streamKey });
  }

  onMessageEnd(chatId: string, streamKey?: string): void {
    this.messageEnds.push({ chatId, streamKey });
  }

  onStreamText(_chatId: string, fullText: string): void {
    this.streamUiActive = true;
    this.streamedTexts.push(fullText);
  }

  onStreamStatus(_chatId: string, statusText: string): void {
    this.streamUiActive = true;
    this.streamedStatuses.push(statusText);
  }

  onStreamMetadata(_chatId: string, metadata: StructuredStreamingUiMetadata): void {
    this.streamMetadata.push(metadata);
  }

  onToolEvent(_chatId: string, tools: ToolCallInfo[]): void {
    this.streamUiActive = true;
    this.streamedTools.push(tools.map((tool) => ({ ...tool })));
  }

  onStreamHistory(_chatId: string, items: StreamingHistoryItem[]): void {
    this.streamUiActive = true;
    this.streamedHistories.push(items.map((item) =>
      item.type === 'tool_panel' ? { ...item, tools: item.tools.map((tool) => ({ ...tool })) } : { ...item }));
  }

  onTaskEvent(_chatId: string, tasks: TaskProgressInfo[]): void {
    this.streamUiActive = true;
    this.streamedTasks.push(tasks.map((task) => ({ ...task })));
  }

  onStreamActions(_chatId: string, actions: StructuredStreamingUiActionButton[][]): void {
    this.streamedActions.push(actions.map((row) => row.map((action) => ({ ...action }))));
  }

  getStructuredStreamingUiSnapshot(): StructuredStreamingUiSnapshot | null {
    return {
      active: this.streamUiActive,
      lastAttemptAt: Date.now(),
      lastUpdateAt: Date.now(),
    };
  }

  async onStreamEnd(
    _chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
  ): Promise<boolean> {
    this.streamEnds.push({ status, text: responseText });
    return this.streamEndResult;
  }
}

function assertStreamMetadataHasBinding(adapter: FakeFeishuStreamingAdapter): void {
  const metadata = adapter.streamMetadata.at(-1);
  assert.ok(metadata?.title);
  const tags = (metadata.tags || []).join(' ');
  assert.match(tags, /bridge_id:/);
  assert.doesNotMatch(tags, /bridge_session_id:/);
  assert.doesNotMatch(tags, /codex_thread_id:/);
  assert.doesNotMatch(tags, /creator:/);
  assert.doesNotMatch(tags, /provider:/);
  assert.match(tags, /\bsdk\b/);
}

function createManualIntervalClock(start = 0) {
  let now = start;
  let nextId = 1;
  const intervals = new Map<number, { callback: () => void; intervalMs: number; nextAt: number }>();

  return {
    now: () => now,
    setInterval(callback: () => void, intervalMs: number): number {
      const id = nextId++;
      intervals.set(id, {
        callback,
        intervalMs,
        nextAt: now + intervalMs,
      });
      return id;
    },
    clearInterval(handle: unknown): void {
      intervals.delete(handle as number);
    },
    advance(ms: number): void {
      now += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [id, interval] of Array.from(intervals.entries())) {
          if (interval.nextAt > now) continue;
          interval.nextAt += interval.intervalMs;
          interval.callback();
          if (!intervals.has(id)) continue;
          fired = true;
        }
      }
    },
    activeCount(): number {
      return intervals.size;
    },
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type ScriptedTurnCallbacks = {
  onPartialText?: (text: string) => void;
  onPermissionRequest?: (request: PermissionRequestInfo) => Promise<void>;
  onToolEvent?: (
    toolId: string,
    toolName: string,
    status: 'running' | 'complete' | 'error',
    detail?: { input?: unknown; output?: string; isError?: boolean },
  ) => void;
  onStatusNote?: (note: string | null) => void;
  onThinkingNote?: (note: string) => void;
  onPromptPrepared?: (prompt: string) => void;
  onTaskEvent?: (tasks: TaskProgressInfo[]) => void;
  onContextUsage?: (usage: {
    modelContextWindow?: number;
    lastTokenUsage?: { inputTokens?: number; outputTokens?: number };
    totalTokenUsage?: { inputTokens?: number; outputTokens?: number };
  }) => void;
  onRuntimeIdentity?: (identity: {
    runtime: 'codex' | 'claude' | 'kimi';
    sessionId: string;
    cwd?: string;
    transcriptPath?: string;
  }) => void | Promise<void>;
  abortSignal: AbortSignal;
};

type ScriptedTurnStep = (callbacks: ScriptedTurnCallbacks) => void | Promise<void>;

class ScriptedSessionSimulator {
  readonly adapter = new FakeFeishuStreamingAdapter();
  readonly taskStateMap = new Map<string, InteractiveTaskState>();
  readonly deliveredTexts: string[] = [];
  readonly healthEvents: Array<{ type: string; detail?: string }> = [];
  readonly mirrorSuppressions: Array<{ sessionId: string; prompt: string }> = [];
  readonly settledMirrorSuppressions: Array<{ sessionId: string; suppressionId: string | null; durationMs?: number }> = [];
  readonly abortedMirrorSuppressions: Array<{ sessionId: string; suppressionId: string | null }> = [];
  readonly forwardedPermissions: Array<PermissionRequestInfo & { replyToMessageId?: string }> = [];
  readonly registeredBridgeTurns: ActiveBridgeTurn[] = [];
  readonly mirrorResetSessionIds: string[] = [];
  reconcileMirrorCount = 0;
  readonly address: InboundMessage['address'];
  resolveDisplayInfo?: (binding: ChannelChat) => {
    title: string;
    bridgeSessionId?: string | null;
    threadId?: string | null;
    executionProvider?: string | null;
    creatorKind?: string | null;
    reasoningEffort?: string | null;
    model?: string | null;
  };

  constructor(chatId = 'chat-basic-dialogue', workspace = 'D:\\workspace\\basic-dialogue') {
    this.address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId,
      userId: `${chatId}-user`,
    };
    router.createBinding(this.address, workspace);
  }

  sessionId(): string {
    return router.resolve(this.address)?.bridgeSessionId || '';
  }

  setRuntimeProvider(runtime: 'codex' | 'claude' | 'kimi', provider: 'sdk' | 'pty' | 'tmux'): void {
    const sessionId = this.sessionId();
    assert.ok(sessionId, 'scripted simulator binding must have a session id');
    getBridgeContext().store.updateSession(sessionId, {
      runtime: runtime === 'claude'
        ? {
            activeRuntime: 'claude',
          }
        : runtime === 'kimi'
          ? {
              activeRuntime: 'kimi',
            }
          : {
              activeRuntime: 'codex',
            },
    });
    setSessionConfigToml(
      sessionId,
      runtime === 'claude'
        ? { runtime: { claude: { provider } } }
        : runtime === 'kimi'
          ? { runtime: { kimi: { provider: 'tmux' } } }
          : { runtime: { codex: { provider: provider === 'tmux' ? 'tmux' : provider === 'pty' ? 'pty' : 'sdk' } } },
    );
  }

  async send(turn: {
    messageId: string;
    text: string;
    preparedPrompt?: string;
    steps: ScriptedTurnStep[];
    finalText: string;
    codexThreadId?: string | null;
  }): Promise<void> {
    await runInteractiveMessage(
      this.adapter,
      {
        messageId: turn.messageId,
        address: this.address,
        text: turn.text,
        timestamp: Date.now(),
      },
      turn.text,
      undefined,
      {
        registerInteractiveTask: (task) => {
          this.taskStateMap.set(task.sessionId, task);
        },
        registerBridgeTurn: (turn) => {
          this.registeredBridgeTurns.push(turn);
        },
        resetMirrorSessionForInteractiveRun: (sessionId) => {
          this.mirrorResetSessionIds.push(sessionId);
        },
        isCurrentInteractiveTask: (sessionId, taskId) => this.taskStateMap.get(sessionId)?.id === taskId,
        touchInteractiveTask: (sessionId, taskId) => {
          const task = this.taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = Date.now();
        },
        recordInteractiveHealthStart: (_sessionId, detail) => {
          this.healthEvents.push({ type: 'start', detail });
        },
        recordInteractiveHealthProgress: (_sessionId, type, detail) => {
          this.healthEvents.push({ type, detail });
        },
        recordInteractiveHealthTool: (_sessionId, _toolId, toolName, status) => {
          this.healthEvents.push({ type: `tool:${status}`, detail: toolName });
        },
        recordInteractiveHealthEnd: (_sessionId, outcome, detail) => {
          this.healthEvents.push({ type: `end:${outcome}`, detail });
        },
        beginMirrorSuppression: (sessionId, prompt) => {
          this.mirrorSuppressions.push({ sessionId, prompt });
          return `suppression-${this.mirrorSuppressions.length}`;
        },
        abortMirrorSuppression: (sessionId, suppressionId) => {
          this.abortedMirrorSuppressions.push({ sessionId, suppressionId: suppressionId || null });
        },
        settleMirrorSuppression: (sessionId, suppressionId, durationMs) => {
          this.settledMirrorSuppressions.push({ sessionId, suppressionId: suppressionId || null, durationMs });
        },
        releaseInteractiveTask: (sessionId, taskId) => {
          if (this.taskStateMap.get(sessionId)?.id === taskId) this.taskStateMap.delete(sessionId);
        },
        deliverResponse: async (_adapter, _address, responseText) => {
          this.deliveredTexts.push(responseText);
        },
        persistCodexThreadUpdate() {},
        reconcileMirrorSubscriptions: async () => {
          this.reconcileMirrorCount += 1;
        },
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        ...(this.resolveDisplayInfo ? { resolveInteractiveTurnDisplayInfo: this.resolveDisplayInfo } : {}),
        forwardPermissionRequest: (_adapter, _address, permissionRequestId, toolName, toolInput, _sessionId, suggestions, replyToMessageId) => {
          this.forwardedPermissions.push({
            permissionRequestId,
            toolName,
            toolInput,
            suggestions,
            replyToMessageId,
          });
          void this.adapter.send({
            address: _address,
            text: `Permission Required: ${toolName}`,
            replyToMessageId,
            inlineButtons: [[
              { text: 'Allow', callbackData: `perm:allow:${permissionRequestId}` },
              { text: 'Deny', callbackData: `perm:deny:${permissionRequestId}` },
            ]],
          });
        },
        processMessageImpl: async (
          _binding,
          _text,
          onPermission,
          abortSignal,
          _files,
          onPartialText,
          onToolEvent,
          onTaskEvent,
          onStatusNote,
          onPromptPrepared,
          options,
        ) => {
          onPromptPrepared?.(turn.preparedPrompt || turn.text);
          const effectiveAbortSignal = abortSignal || new AbortController().signal;
          const callbacks: ScriptedTurnCallbacks = {
            onPartialText,
            onToolEvent,
            onStatusNote,
            onPromptPrepared,
            onPermissionRequest: onPermission,
            onTaskEvent,
            onContextUsage: options?.onContextUsage,
            onThinkingNote: options?.onThinkingNote,
            onRuntimeIdentity: options?.onRuntimeIdentity,
            abortSignal: effectiveAbortSignal,
          };
          for (const step of turn.steps) {
            if (effectiveAbortSignal.aborted) break;
            await step(callbacks);
          }
          return {
            responseText: effectiveAbortSignal.aborted ? '' : turn.finalText,
            outboundAttachments: [],
            tokenUsage: null,
            hasError: effectiveAbortSignal.aborted,
            errorMessage: effectiveAbortSignal.aborted ? 'Task stopped by user' : '',
            permissionRequests: [],
            codexThreadId: turn.codexThreadId || null,
          };
        },
      },
    );
  }
}

describe('interactive-turn runner', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    createConfigService({ migrate: false, env: {} }).set(
      { kind: 'home' },
      { runtime: { codex: { provider: 'sdk' } } },
    );
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat() {
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      },
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });
  });

  it('reads stream status timing from v2 config instead of legacy settings', () => {
    const previous = fs.existsSync(CONFIG_TOML_PATH) ? fs.readFileSync(CONFIG_TOML_PATH, 'utf-8') : null;
    fs.writeFileSync(CONFIG_TOML_PATH, `
schema_version = 2

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
stream_status_idle_start_seconds = 7
stream_status_check_interval_seconds = 3
`, 'utf-8');
    try {
      const settings = resolveInteractiveTurnRuntimeSettings('feishu', (key) => {
        if (key === 'bridge_stream_status_idle_start_seconds') return '999';
        if (key === 'bridge_stream_status_check_interval_seconds') return '999';
        return null;
      });

      assert.equal(settings.statusTiming.idleStartMs, 7_000);
      assert.equal(settings.statusTiming.heartbeatMs, 3_000);
    } finally {
      if (previous === null) fs.rmSync(CONFIG_TOML_PATH, { force: true });
      else fs.writeFileSync(CONFIG_TOML_PATH, previous, 'utf-8');
    }
  });

  it('simulates a basic dialogue turn with controlled tool, context, and stream-card checkpoints', async () => {
    const simulator = new ScriptedSessionSimulator();
    const toolCanFinish = createDeferred();
    const toolStarted = createDeferred();
    const permissionForwarded = createDeferred();

    const run = simulator.send({
      messageId: 'incoming-basic-dialogue-1',
      text: '请先检查项目状态',
      preparedPrompt: '请先检查项目状态',
      finalText: 'BASIC_DIALOGUE_DONE',
      codexThreadId: 'codex-basic-thread',
      steps: [
        async ({ onStatusNote, onRuntimeIdentity }) => {
          onStatusNote?.('provider preload complete');
          await onRuntimeIdentity?.({ runtime: 'codex', sessionId: 'codex-basic-thread' });
        },
        ({ onPartialText, onContextUsage }) => {
          onPartialText?.('我会先检查项目状态。');
          onContextUsage?.({
            modelContextWindow: 200_000,
            lastTokenUsage: {
              inputTokens: 42_000,
              outputTokens: 1_200,
            },
          });
        },
        async ({ onPermissionRequest }) => {
          await onPermissionRequest?.({
            permissionRequestId: 'perm-basic-1',
            toolName: 'Bash',
            toolInput: { cmd: 'npm test -- --smoke' },
            suggestions: [{ match: 'Bash' }],
          });
          permissionForwarded.resolve();
        },
        ({ onTaskEvent }) => {
          onTaskEvent?.([{
            text: 'Goal Active: 验证基本对话链路',
            status: 'in_progress',
          }]);
        },
        async ({ onToolEvent, onStatusNote }) => {
          onStatusNote?.('running representative tool');
          onToolEvent?.('tool-basic-1', 'Bash', 'running', { input: { cmd: 'npm test -- --smoke' } });
          toolStarted.resolve();
          await toolCanFinish.promise;
          onToolEvent?.('tool-basic-1', 'Bash', 'complete', { output: 'smoke ok' });
        },
        ({ onPartialText }) => {
          onPartialText?.('我会先检查项目状态。\n工具完成，准备总结。');
        },
      ],
    });

    await permissionForwarded.promise;
    assert.equal(simulator.forwardedPermissions[0]?.permissionRequestId, 'perm-basic-1');
    assert.equal(simulator.forwardedPermissions[0]?.replyToMessageId, 'incoming-basic-dialogue-1');
    assert.match(simulator.adapter.sentMessages[0]?.text || '', /Permission Required: Bash/);
    assert.equal(simulator.adapter.sentMessages[0]?.replyToMessageId, 'incoming-basic-dialogue-1');

    await toolStarted.promise;
    assert.match(simulator.adapter.streamedTexts.at(-1) || '', /我会先检查项目状态/);
    assert.match(simulator.adapter.streamedStatuses.at(-1) || '', /running representative tool/);
    assert.equal(simulator.adapter.streamedTools.at(-1)?.[0]?.name, 'Bash');
    assert.equal(simulator.adapter.streamedTools.at(-1)?.[0]?.status, 'running');
    assert.equal(simulator.adapter.streamedTasks.at(-1)?.[0]?.text, 'Goal Active: 验证基本对话链路');
    assert.equal(simulator.adapter.streamedTasks.at(-1)?.[0]?.status, 'in_progress');
    assert.deepEqual(simulator.deliveredTexts, []);

    toolCanFinish.resolve();
    await run;

    assert.equal(simulator.adapter.streamEnds.length, 1);
    assert.equal(simulator.adapter.streamEnds[0]?.status, 'completed');
    assert.match(simulator.adapter.streamEnds[0]?.text || '', /BASIC_DIALOGUE_DONE/);
    assert.match(simulator.adapter.streamEnds[0]?.text || '', /Context: 42k\(21%\) · ↑42k ↓1\.2k/);
    assert.equal(simulator.adapter.streamedTools.at(-1)?.[0]?.status, 'complete');
    const latestHistory = simulator.adapter.streamedHistories.at(-1) || [];
    assert.deepEqual(latestHistory.map((item) => item.type), [
      'markdown',
      'markdown',
      'tool_panel',
      'markdown',
    ]);
    assert.equal(latestHistory[0]?.type === 'markdown' ? latestHistory[0].role : '', 'user');
    assert.match(latestHistory[0]?.type === 'markdown' ? latestHistory[0].content : '', /请先检查项目状态/);
    assert.match(latestHistory[1]?.type === 'markdown' ? latestHistory[1].content : '', /我会先检查项目状态/);
    assert.deepEqual(
      latestHistory[2]?.type === 'tool_panel'
        ? latestHistory[2].tools.map((tool) => `${tool.name}:${tool.status}`)
        : [],
      ['Bash:complete'],
    );
    assert.match(latestHistory[3]?.type === 'markdown' ? latestHistory[3].content : '', /工具完成，准备总结/);
    assert.equal(simulator.taskStateMap.size, 0);
    assert.deepEqual(simulator.deliveredTexts, []);
    assert.deepEqual(simulator.mirrorSuppressions, [{
      sessionId: router.resolve(simulator.address)?.bridgeSessionId || '',
      prompt: '请先检查项目状态',
    }]);
    assert.equal(simulator.settledMirrorSuppressions[0]?.durationMs, 10_000);
    assert.deepEqual(simulator.abortedMirrorSuppressions, []);
    assertStreamMetadataHasBinding(simulator.adapter);
  });

  it('keeps one scripted session isolated across the basic dialogue provider sequence', async () => {
    const simulator = new ScriptedSessionSimulator('chat-basic-dialogue-sequence');
    const sessionId = simulator.sessionId();
    const phases: Array<{
      key: string;
      runtime: 'codex' | 'claude' | 'kimi';
      provider: 'sdk' | 'pty' | 'tmux';
      progressSource: ActiveBridgeTurn['progressSource'];
      finalSource: ActiveBridgeTurn['finalSource'];
    }> = [
      { key: 'codex-sdk', runtime: 'codex', provider: 'sdk', progressSource: 'sdk_stream', finalSource: 'sdk_result' },
      { key: 'claude-sdk', runtime: 'claude', provider: 'sdk', progressSource: 'sdk_stream', finalSource: 'sdk_result' },
      { key: 'kimi-tmux', runtime: 'kimi', provider: 'tmux', progressSource: 'kimi_jsonl', finalSource: 'kimi_task_complete' },
      { key: 'codex-tmux', runtime: 'codex', provider: 'tmux', progressSource: 'codex_jsonl', finalSource: 'codex_task_complete' },
      { key: 'claude-pty', runtime: 'claude', provider: 'pty', progressSource: 'claude_jsonl', finalSource: 'claude_task_complete' },
      { key: 'codex-pty', runtime: 'codex', provider: 'pty', progressSource: 'codex_jsonl', finalSource: 'codex_task_complete' },
    ];

    for (const [index, phase] of phases.entries()) {
      simulator.setRuntimeProvider(phase.runtime, phase.provider);
      const marker = `BASIC_DIALOGUE_${phase.key.toUpperCase().replace(/-/g, '_')}_DONE`;
      await simulator.send({
        messageId: `incoming-basic-dialogue-${index + 1}`,
        text: `basic dialogue ${phase.key}`,
        preparedPrompt: `prepared basic dialogue ${phase.key}`,
        finalText: marker,
        codexThreadId: phase.runtime === 'codex' ? `${phase.key}-thread` : null,
        steps: [
          async ({ onStatusNote, onThinkingNote, onRuntimeIdentity }) => {
            onStatusNote?.(`provider preload complete: ${phase.key}`);
            if (phase.runtime === 'kimi') {
              onThinkingNote?.('Kimi 正在整理上下文和下一步操作');
            }
            await onRuntimeIdentity?.({
              runtime: phase.runtime,
              sessionId: `${phase.key}-thread`,
              cwd: `D:\\workspace\\${phase.key}`,
            });
          },
          ({ onPartialText, onContextUsage, onTaskEvent, onToolEvent }) => {
            onPartialText?.(`${phase.key} partial text`);
            onContextUsage?.({
              modelContextWindow: 200_000,
              lastTokenUsage: {
                inputTokens: 20_000 + index * 1_000,
                outputTokens: 500 + index * 100,
              },
            });
            onTaskEvent?.([{
              text: `Goal Active: ${phase.key} provider isolation`,
              status: 'in_progress',
            }]);
            onToolEvent?.(`tool-${phase.key}`, 'Bash', 'running', { input: { cmd: `echo ${phase.key}` } });
            onToolEvent?.(`tool-${phase.key}`, 'Bash', 'complete', { output: `${phase.key} ok` });
          },
        ],
      });

      const registered = simulator.registeredBridgeTurns.at(-1);
      assert.equal(registered?.sessionId, sessionId);
      assert.equal(registered?.runtime, phase.runtime);
      assert.equal(registered?.progressSource, phase.progressSource);
      assert.equal(registered?.finalSource, phase.finalSource);
    }

    assert.equal(new Set(simulator.registeredBridgeTurns.map((turn) => turn.sessionId)).size, 1);
    assert.deepEqual(simulator.registeredBridgeTurns.map((turn) => `${turn.runtime}:${turn.progressSource}:${turn.finalSource}`), [
      'codex:sdk_stream:sdk_result',
      'claude:sdk_stream:sdk_result',
      'kimi:kimi_jsonl:kimi_task_complete',
      'codex:codex_jsonl:codex_task_complete',
      'claude:claude_jsonl:claude_task_complete',
      'codex:codex_jsonl:codex_task_complete',
    ]);
    assert.ok(simulator.adapter.streamedStatuses.some((status) => status.includes('provider preload complete: codex-sdk')));
    assert.ok(simulator.adapter.streamedStatuses.some((status) => status.includes('provider preload complete: claude-pty')));
    assert.ok(simulator.adapter.streamedStatuses.some((status) => status.includes('当前思考：Kimi 正在整理上下文和下一步操作')));
    assert.ok(simulator.adapter.streamedTasks.some((tasks) => tasks.some((task) => task.text === 'Goal Active: codex-sdk provider isolation')));
    assert.ok(simulator.adapter.streamedTools.some((tools) => tools.some((tool) => tool.name === 'Bash' && tool.status === 'complete')));
    assert.deepEqual(simulator.mirrorSuppressions, [
      {
        sessionId,
        prompt: 'prepared basic dialogue codex-sdk',
      },
      {
        sessionId,
        prompt: 'prepared basic dialogue claude-sdk',
      },
    ]);
    assert.deepEqual(simulator.settledMirrorSuppressions.map((entry) => entry.durationMs), [10_000, 10_000]);
    assert.ok(simulator.reconcileMirrorCount >= 4);
    assert.deepEqual(new Set(simulator.mirrorResetSessionIds), new Set([sessionId]));
    assert.equal(simulator.taskStateMap.size, 0);
  });

  it('builds SDK stream card title and tags from binding display metadata', () => {
    const binding: ChannelChat = {
      id: 'binding-123456789',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      bridgeSessionId: 'bridge-session-123456789',
      createdAt: '2026-05-14T00:00:00.000Z',
      updatedAt: '2026-05-14T00:00:00.000Z',
    };
    const metadata = buildInteractiveStreamCardMetadata(binding, () => ({
      title: 'Project A',
      bridgeSessionId: 'bridge-session-123456789',
      threadId: 'codex-thread-123456789',
      runtime: 'codex',
      executionProvider: 'tmux',
      creatorKind: 'vscode',
      reasoningEffort: 'high',
      model: 'gpt-5-codex',
    }));

    assert.equal(metadata.title, 'Project A');
    assert.deepEqual(metadata.tags, [
      'codex',
      'effort:high',
      'model:gpt-5-codex',
      'bridge_id:bridge-s',
      'sdk',
    ]);
  });

  it('does not emit an empty SDK stream card title when display metadata is blank', () => {
    const binding: ChannelChat = {
      id: 'binding-empty-title',
      channelType: 'feishu-default',
      chatId: 'chat-empty-title',
      bridgeSessionId: 'bridge-session-empty-title',
      createdAt: '2026-05-14T00:00:00.000Z',
      updatedAt: '2026-05-14T00:00:00.000Z',
    };
    const metadata = buildInteractiveStreamCardMetadata(binding, () => ({
      title: '',
      bridgeSessionId: 'bridge-session-empty-title',
      threadId: 'codex-thread-empty-title',
      executionProvider: 'sdk',
      creatorKind: 'bridge',
    }));

    assert.equal(metadata.title, 'bridge-s');
    assert.deepEqual(metadata.tags, ['codex', 'bridge_id:bridge-s', 'sdk']);
  });

  it('uses the BridgeSession name for Codex SDK stream card metadata without a thread title', async () => {
    const simulator = new ScriptedSessionSimulator('chat-codex-sdk-title');
    const sessionId = simulator.sessionId();
    const store = getBridgeContext().store;
    store.updateSession(sessionId, {
      name: 'Codex Bridge Title',
      runtime: {
        activeRuntime: 'codex',
        general: { workingDirectory: '/tmp/codex-sdk-title' },
      },
    });
    setSessionConfigToml(sessionId, { runtime: { codex: { provider: 'sdk', model: 'gpt-test-model' } } });
    simulator.resolveDisplayInfo = (binding) => ({
      title: '',
      bridgeSessionId: binding.bridgeSessionId,
      threadId: '',
      runtime: 'codex',
      executionProvider: 'sdk',
      creatorKind: 'bridge',
      reasoningEffort: 'medium',
      model: 'gpt-test-model',
    });

    await simulator.send({
      messageId: 'incoming-codex-sdk-title',
      text: 'hello codex title',
      steps: [
        ({ onPartialText }) => onPartialText?.('Codex title response'),
      ],
      finalText: 'Codex title response',
    });

    assert.equal(simulator.adapter.streamMetadata[0]?.title, 'Codex Bridge Title');
  });

  it('prefers the BridgeSession name for Claude SDK stream card metadata', async () => {
    const simulator = new ScriptedSessionSimulator('chat-claude-sdk-title');
    const sessionId = simulator.sessionId();
    const store = getBridgeContext().store;
    store.updateSession(sessionId, {
      name: 'Claude Bridge Title',
      runtime: {
        activeRuntime: 'claude',
        general: { workingDirectory: '/tmp/claude-sdk-title' },
      },
    });
    setSessionConfigToml(sessionId, { runtime: { claude: { provider: 'sdk', model: 'claude-sonnet-test' } } });
    simulator.resolveDisplayInfo = (binding) => ({
      title: '',
      bridgeSessionId: binding.bridgeSessionId,
      threadId: '',
      runtime: 'claude',
      executionProvider: 'sdk',
      creatorKind: 'bridge',
      reasoningEffort: 'default',
      model: 'claude-sonnet-test',
    });

    await simulator.send({
      messageId: 'incoming-claude-sdk-title',
      text: 'hello claude title',
      steps: [
        ({ onPartialText }) => onPartialText?.('Claude title response'),
      ],
      finalText: 'Claude title response',
    });

    assert.equal(simulator.adapter.streamMetadata[0]?.title, 'Claude Bridge Title');
    assert.match((simulator.adapter.streamMetadata[0]?.tags || []).join(' '), /\bclaude\b/);
    assert.doesNotMatch((simulator.adapter.streamMetadata[0]?.tags || []).join(' '), /\bcodex\b/);
  });

  it('uses the bridge session title for SDK stream cards before a Codex thread title exists', async () => {
    const simulator = new ScriptedSessionSimulator('chat-sdk-session-title', 'D:\\workspace\\sdk-session-title');
    const sessionId = simulator.sessionId();
    const store = getBridgeContext().store;
    store.updateSession(sessionId, {
      name: 'chat-sdk-session-title',
      runtime: {
        activeRuntime: 'codex',
        general: { workingDirectory: 'D:\\workspace\\sdk-session-title' },
      },
    });
    setSessionConfigToml(sessionId, { runtime: { codex: { provider: 'sdk', model: 'gpt-test-model' } } });
    simulator.resolveDisplayInfo = (binding) => (
      new ThreadDisplayService(store).binding(binding, { stripInternalPrefix: true })
    );

    await simulator.send({
      messageId: 'incoming-sdk-session-title',
      text: '检查卡片 title',
      steps: [
        ({ onPartialText }) => onPartialText?.('SDK 正在返回内容'),
      ],
      finalText: 'SDK 最终回复',
      codexThreadId: null,
    });

    assert.equal(simulator.adapter.streamMetadata[0]?.title, 'chat-sdk-session-title');
    assert.equal(simulator.adapter.streamMetadata.at(-1)?.title, 'chat-sdk-session-title');
    assert.equal(store.getSession(sessionId)?.runtime?.codex?.title, undefined);
  });

  it('formats the persistent runtime status text', () => {
    assert.equal(formatInteractiveRuntimeStatus(0), '已运行 0s');
    assert.equal(formatInteractiveRuntimeStatus(65_000), '已运行 1m5s');
    assert.equal(formatInteractiveRuntimeStatus(3_661_000, 10_000), '已运行 1h1m1s · 上次响应 10s');
    assert.equal(formatInteractiveRuntimeStatus(1_000, 70_000), '已运行 1s · 上次响应 1m10s');
    assert.equal(formatInteractiveRuntimeStatus(1_000, 3_600_000), '已运行 1s · 上次响应 1h');
    assert.equal(formatInteractiveRuntimeStatus(1_000, 3_610_000), '已运行 1s · 上次响应 1h10s');
    assert.equal(formatInteractiveRuntimeStatus(1_000, 3_720_000), '已运行 1s · 上次响应 1h2m');
    assert.equal(formatInteractiveRuntimeStatus(1_000, 3_730_000), '已运行 1s · 上次响应 1h2m10s');
  });

  it('shows status-only stream updates for Claude background preparation without suppressing fallback text', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    adapter.streamEndResult = true;
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-claude-status-only',
      userId: 'user-claude-status-only',
    } as const;
    const binding = router.createBinding(address, '/tmp/claude-status-only');
    const store = getBridgeContext().store;
    store.updateSession(binding.bridgeSessionId, {
      runtime: {
        activeRuntime: 'claude',
        claude: {},
      },
    });
    setSessionConfigToml(binding.bridgeSessionId, { runtime: { claude: { provider: 'sdk' } } });
    const taskStateMap = new Map<string, InteractiveTaskState>();

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-claude-status-only',
        address,
        text: 'hello claude',
        timestamp: Date.now(),
      },
      'hello claude',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask() {},
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return ''; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          await _adapter.send({ address: _address, text: responseText });
          return { ok: true };
        },
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (
          _binding,
          _text,
          _onPermission,
          _abortSignal,
          _files,
          _onPartialText,
          _onToolEvent,
          _onTaskEvent,
          onStatusNote,
        ) => {
          onStatusNote?.('已为Claude Code sdk 注入 Router 环境。');
          return {
            responseText: 'Claude fallback response',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
      },
    );

    assert.ok(adapter.streamedStatuses.some((status) => status.includes('已为Claude Code sdk 注入 Router 环境。')));
    assert.equal(adapter.streamEnds.at(-1)?.status, 'completed');
    assert.equal(adapter.streamEnds.at(-1)?.text, 'Claude fallback response');
    assert.equal(adapter.sentMessages.length, 0);
    assert.deepEqual(adapter.streamedTexts, ['Claude fallback response']);
  });

  it('delivers Claude SDK errors as Feishu replies instead of waiting for mirror output', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-claude-sdk-error',
      userId: 'user-claude-sdk-error',
    } as const;
    const binding = router.createBinding(address, '/tmp/claude-sdk-error');
    const store = getBridgeContext().store;
    store.updateSession(binding.bridgeSessionId, {
      runtime: {
        activeRuntime: 'claude',
      },
    });
    setSessionConfigToml(binding.bridgeSessionId, { runtime: { claude: { provider: 'sdk' } } });
    const taskStateMap = new Map<string, InteractiveTaskState>();

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-claude-sdk-error',
        address,
        text: 'hello claude sdk',
        timestamp: Date.now(),
      },
      'hello claude sdk',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask() {},
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return ''; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          await _adapter.send({ address: _address, text: responseText });
          return { ok: true };
        },
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (
          _binding,
          _text,
          _onPermission,
          _abortSignal,
          _files,
          _onPartialText,
          _onToolEvent,
          _onTaskEvent,
          _onStatusNote,
          _onPromptPrepared,
          options,
        ) => {
          await options?.onRuntimeIdentity?.({ runtime: 'claude', sessionId: 'claude-sdk-session' });
          return {
            responseText: '',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: true,
            errorMessage: 'Claude Code returned an error result: Not logged in · Please run /login',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
      },
    );

    assert.equal(adapter.streamEnds.at(-1)?.status, 'error');
    assert.match(adapter.streamEnds.at(-1)?.text || '', /Not logged in/);
    assert.match(adapter.streamEnds.at(-1)?.text || '', /bridge_session_id:/);
    assert.equal(adapter.sentMessages.length, 0);
  });

  it('uses the Chinese file description prompt for attachment-only messages', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-attachment-only',
      userId: 'user-attachment-only',
    } as const;
    router.createBinding(address, 'D:\\workspace\\attachment-only');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    let capturedPrompt = '';
    let capturedFiles: InboundMessage['attachments'];

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-attachment-only-1',
        address,
        text: '',
        timestamp: Date.now(),
        attachments: [{
          id: 'file-1',
          name: 'report.pdf',
          type: 'application/pdf',
          size: 128,
          data: Buffer.from('file').toString('base64'),
        }],
      },
      '',
      [{
        id: 'file-1',
        name: 'report.pdf',
        type: 'application/pdf',
        size: 128,
        data: Buffer.from('file').toString('base64'),
      }],
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = Date.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return ''; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse() {},
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (_binding, promptText, _onPermission, _abortSignal, files) => {
          capturedPrompt = promptText;
          capturedFiles = files;
          return {
            responseText: '',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
      },
    );

    assert.equal(capturedPrompt, '简单地描述文件');
    assert.equal(capturedFiles?.[0]?.name, 'report.pdf');
    assert.equal(taskStateMap.size, 0);
  });

  it('keeps runtime visible and adds last response age after 10 seconds without a response', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-heartbeat',
      userId: 'user-heartbeat',
    } as const;
    router.createBinding(address, 'D:\\workspace\\heartbeat');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();
    const deliveredTexts: string[] = [];

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-1'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('第一段输出');
          assert.equal(adapter.streamedStatuses[0], `${formatFooterClockTime(0)} · 已运行 0s`);
          assert.equal(adapter.streamedStatuses.at(-1), `${formatFooterClockTime(0)} · 已运行 0s`);

          clock.advance(5_000);
          assert.equal(adapter.streamedStatuses.at(-1), `${formatFooterClockTime(0)} · 已运行 0s`);

          clock.advance(5_000);
          assert.equal(adapter.streamedStatuses.at(-1), `${formatFooterClockTime(10_000)} · 已运行 10s · 上次响应 10s`);

          onPartialText?.('第一段输出\n第二段输出');
          assert.equal(adapter.streamedStatuses.at(-1), `${formatFooterClockTime(10_000)} · 已运行 10s · 上次响应 0s`);

          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 10_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(deliveredTexts, []);
    assert.equal(adapter.streamEnds.length, 1);
    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assertStreamMetadataHasBinding(adapter);
    assert.match(adapter.streamEnds[0]?.text || '', /最终回复/);
    assert.equal(clock.activeCount(), 0);

    const statusCountAfterFinish = adapter.streamedStatuses.length;
    clock.advance(10_000);
    assert.equal(adapter.streamedStatuses.length, statusCountAfterFinish);
    assert.equal(adapter.messageStarts.length, 1);
    assert.equal(adapter.messageEnds.length, 1);
  });

  it('resets last response age when tool progress updates the status area', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-tool-status-age',
      userId: 'user-tool-status-age',
    } as const;
    router.createBinding(address, 'D:\\workspace\\tool-status-age');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-tool-status-age-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-tool-status-age'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse() {},
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText, onToolEvent) => {
          onPartialText?.('第一段输出');
          clock.advance(10_000);
          assert.equal(adapter.streamedStatuses.at(-1), `${formatFooterClockTime(10_000)} · 已运行 10s · 上次响应 10s`);

          clock.advance(5_000);
          onToolEvent?.('tool-1', 'Bash', 'running');
          assert.equal(adapter.streamedStatuses.at(-1), `${formatFooterClockTime(15_000)} · 已运行 15s · 上次响应 0s`);

          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 10_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );

    assert.equal(clock.activeCount(), 0);
  });

  it('keeps SDK tool input and output in streaming cards', async () => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat() {
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      },
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });

    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-tool-details',
      userId: 'user-tool-details',
    } as const;
    router.createBinding(address, 'D:\\workspace\\tool-details');
    const taskStateMap = new Map<string, InteractiveTaskState>();

    await runInteractiveMessage(
      adapter,
      {
            messageId: 'incoming-tool-details-1',
        address,
        text: 'hello',
        timestamp: Date.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask() {},
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-tool-details'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse() {},
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, _onPartialText, onToolEvent) => {
          onToolEvent?.('tool-1', 'shell_command', 'running', {
            input: { command: 'cat secret-input.txt' },
          });
          onToolEvent?.('tool-1', '', 'complete', {
            output: 'secret-output',
          });
          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
      },
    );

    assert.ok(adapter.streamedTools.length >= 1);
    const latestTools = adapter.streamedTools.at(-1) || [];
    assert.equal(latestTools[0]?.name, 'shell_command');
    assert.equal(latestTools[0]?.status, 'complete');
    assert.equal(latestTools[0]?.input, 'cat secret-input.txt');
    assert.equal(latestTools[0]?.output, 'secret-output');
  });

  it('finalizes a hanging task from an external terminal Codex event', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-external-terminal',
      userId: 'user-external-terminal',
    } as const;
    router.createBinding(address, 'D:\\workspace\\external-terminal');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();
    const processStarted = createDeferred<void>();
    const neverFinish = createDeferred<{
      responseText: string;
      outboundAttachments: [];
      tokenUsage: null;
      hasError: boolean;
      errorMessage: string;
      permissionRequests: [];
      codexThreadId: null;
    }>();
    const deliveredTexts: string[] = [];
    const healthEnds: Array<{ outcome: string; detail?: string }> = [];

    const runPromise = runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-external-terminal-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd(_sessionId, outcome, detail) {
          healthEnds.push({ outcome, detail });
        },
        beginMirrorSuppression() { return 'suppression-external-terminal'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('第一段输出');
          processStarted.resolve();
          return neverFinish.promise;
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 10_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );

    await processStarted.promise;
    const sessionId = Array.from(taskStateMap.keys())[0];
    assert.ok(sessionId);
    const task = taskStateMap.get(sessionId);
    assert.ok(task?.finalizeFromExternalTerminal);

    const finalized = await task.finalizeFromExternalTerminal(
      'completed',
      '检测到Codex thread已完成当前任务。',
      'Codex 最终回复',
    );
    await runPromise;

    assert.equal(finalized, false);
    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assertStreamMetadataHasBinding(adapter);
    assert.match(adapter.streamEnds[0]?.text || '', /Codex 最终回复/);
    assert.deepEqual(deliveredTexts, []);
    assert.deepEqual(healthEnds, [{
      outcome: 'completed',
      detail: '检测到Codex thread已完成当前任务。',
    }]);
    assert.equal(taskStateMap.size, 0);
    assert.equal(clock.activeCount(), 0);
    assert.equal(adapter.messageStarts.length, 1);
    assert.equal(adapter.messageEnds.length, 1);

    const statusCountAfterFinish = adapter.streamedStatuses.length;
    clock.advance(10_000);
    assert.equal(adapter.streamedStatuses.length, statusCountAfterFinish);
  });

  it('does not put mirror terminal final text into the direct status card', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    adapter.streamEndResult = true;
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-codex-pty-mirror-direct-status',
      userId: 'user-codex-pty-mirror-direct-status',
    } as const;
    const binding = router.createBinding(address, '/tmp/codex-pty-mirror-direct-status');
    const store = getBridgeContext().store;
    store.updateSession(binding.bridgeSessionId, {
      runtime: {
        activeRuntime: 'codex',
      },
    });
    setSessionConfigToml(binding.bridgeSessionId, { runtime: { codex: { provider: 'pty' } } });

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const processStarted = createDeferred<void>();
    const neverFinish = createDeferred<{
      responseText: string;
      outboundAttachments: [];
      tokenUsage: null;
      hasError: boolean;
      errorMessage: string;
      permissionRequests: [];
      codexThreadId: null;
    }>();
    const deliveredTexts: string[] = [];

    const runPromise = runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-codex-pty-mirror-direct-status-1',
        address,
        text: 'hello mirror',
        timestamp: Date.now(),
      },
      'hello mirror',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask() {},
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-codex-pty-mirror-direct-status'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (
          _binding,
          _text,
          _onPermission,
          _abortSignal,
          _files,
          _onPartialText,
          _onToolEvent,
          _onTaskEvent,
          onStatusNote,
          onPromptPrepared,
          options,
        ) => {
          onPromptPrepared?.('hello mirror');
          onStatusNote?.('Codex PTY 正在运行。');
          await options?.onRuntimeIdentity?.({ runtime: 'codex', sessionId: 'codex-pty-thread-1' });
          processStarted.resolve();
          return neverFinish.promise;
        },
      },
    );

    await processStarted.promise;
    const task = Array.from(taskStateMap.values())[0];
    assert.ok(task?.finalizeFromExternalTerminal);

    const finalized = await task.finalizeFromExternalTerminal(
      'completed',
      '检测到Codex pty thread已完成当前任务。',
      'Codex PTY mirror 最终回复',
    );
    await runPromise;

    assert.equal(finalized, true);
    assert.equal(adapter.streamEnds.at(-1)?.status, 'completed');
    assert.doesNotMatch(adapter.streamEnds.at(-1)?.text || '', /Codex PTY mirror 最终回复/);
    assert.deepEqual(deliveredTexts, []);
    assert.equal(taskStateMap.size, 0);
  });

  it('sends outbound artifacts when an external terminal event finalizes the stream card', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    adapter.streamEndResult = true;
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-external-terminal-artifact',
      userId: 'user-external-terminal-artifact',
    } as const;
    router.createBinding(address, 'D:\\workspace\\external-terminal-artifact');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();
    const processStarted = createDeferred<void>();
    const neverFinish = createDeferred<{
      responseText: string;
      outboundAttachments: [];
      tokenUsage: null;
      hasError: boolean;
      errorMessage: string;
      permissionRequests: [];
      codexThreadId: null;
    }>();
    const delivered: Array<{ text: string; attachments: OutboundAttachment[] }> = [];

    const runPromise = runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-external-terminal-artifact-1',
        address,
        text: 'send image',
        timestamp: clock.now(),
      },
      'send image',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-external-terminal-artifact'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText, _sessionId, _replyTo, attachments = []) {
          delivered.push({ text: responseText, attachments });
        },
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('正在生成截图');
          processStarted.resolve();
          return neverFinish.promise;
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 10_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );

    await processStarted.promise;
    const sessionId = Array.from(taskStateMap.keys())[0];
    assert.ok(sessionId);
    const task = taskStateMap.get(sessionId);
    assert.ok(task?.finalizeFromExternalTerminal);

    const finalized = await task.finalizeFromExternalTerminal(
      'completed',
      '检测到Codex thread已完成当前任务。',
      [
        'Codex 最终回复',
        '',
        '<clk-send>{"type":"image","path":"D:\\\\workspace\\\\out.png","caption":"截图"}</clk-send>',
      ].join('\n'),
    );
    await runPromise;

    assert.equal(finalized, true);
    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assertStreamMetadataHasBinding(adapter);
    assert.match(adapter.streamEnds[0]?.text || '', /Codex 最终回复/);
    assert.deepEqual(delivered, [{
      text: '',
      attachments: [{
        kind: 'image',
        path: 'D:\\workspace\\out.png',
        caption: '截图',
        name: undefined,
      }],
    }]);
    assert.doesNotMatch(adapter.streamEnds[0]?.text || '', /clk-send/);
    assert.equal(taskStateMap.size, 0);
    assert.equal(clock.activeCount(), 0);
  });

  it('merges Codex terminal artifacts when the SDK stream finishes first', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    adapter.streamEndResult = true;
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-sdk-first-terminal-artifact',
      userId: 'user-sdk-first-terminal-artifact',
    } as const;
    writeCodexSessionJsonlFixture({
      threadId: 'codex-thread-sdk-first-terminal-artifact',
      workDir: 'D:\\workspace\\sdk-first-terminal-artifact',
    });
    router.bindToCodexThread(address, 'codex-thread-sdk-first-terminal-artifact', {
      workingDirectory: 'D:\\workspace\\sdk-first-terminal-artifact',
      displayName: 'Codex artifact thread',
    });

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const delivered: Array<{ text: string; attachments: OutboundAttachment[] }> = [];
    const terminalFinalizeResult = createDeferred<boolean>();
    let capturedAbortSignal: AbortSignal | undefined;

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-sdk-first-terminal-artifact-1',
        address,
        text: 'send image',
        timestamp: Date.now(),
      },
      'send image',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = Date.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return ''; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText, _sessionId, _replyTo, attachments = []) {
          delivered.push({ text: responseText, attachments });
        },
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (
          _binding,
          _text,
          _onPermission,
          abortSignal,
          _files,
          onPartialText,
          _onToolEvent,
          _onTaskEvent,
          _onStatusNote,
          onPromptPrepared,
        ) => {
          capturedAbortSignal = abortSignal;
          onPromptPrepared?.('send image');
          onPartialText?.('SDK 流回复');
          setTimeout(() => {
            const task = Array.from(taskStateMap.values())[0];
            if (!task?.finalizeFromExternalTerminal) {
              terminalFinalizeResult.reject(new Error('missing active task'));
              return;
            }
            task.finalizeFromExternalTerminal(
              'completed',
              '检测到Codex thread已完成当前任务。',
              [
                'Codex 最终回复',
                '',
                '<clk-send>{"type":"image","path":"D:\\\\workspace\\\\out.png","caption":"截图"}</clk-send>',
              ].join('\n'),
            ).then(terminalFinalizeResult.resolve, terminalFinalizeResult.reject);
          }, 0);
          return {
            responseText: 'SDK 流回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            codexThreadId: 'codex-thread-sdk-first-terminal-artifact',
          };
        },
        codexTerminalFinalizationTimeoutMs: 50,
      },
    );

    assert.equal(await terminalFinalizeResult.promise, true);
    assert.equal(capturedAbortSignal?.aborted, false);
    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assertStreamMetadataHasBinding(adapter);
    assert.match(adapter.streamEnds[0]?.text || '', /Codex 最终回复/);
    assert.deepEqual(delivered, [{
      text: '',
      attachments: [{
        kind: 'image',
        path: 'D:\\workspace\\out.png',
        caption: '截图',
        name: undefined,
      }],
    }]);
    assert.equal(taskStateMap.size, 0);
  });

  it('does not show silence before the configured startup threshold', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-threshold',
      userId: 'user-threshold',
    } as const;
    router.createBinding(address, 'D:\\workspace\\threshold');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-threshold-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-threshold'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse() {},
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('第一段输出');
          assert.equal(adapter.streamedStatuses.at(-1), `${formatFooterClockTime(0)} · 已运行 0s`);

          clock.advance(30_000);
          assert.equal(adapter.streamedStatuses.at(-1), `${formatFooterClockTime(30_000)} · 已运行 30s`);

          clock.advance(150_000);
          assert.equal(adapter.streamedStatuses.at(-1), `${formatFooterClockTime(180_000)} · 已运行 3m · 上次响应 3m`);

          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 180_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );
  });

  it('resets last activity age when tool progress is updated', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-tool-age',
      userId: 'user-tool-age',
    } as const;
    router.createBinding(address, 'D:\\workspace\\tool-age');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-tool-age-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-tool-age'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse() {},
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (
          _binding,
          _text,
          _onPermission,
          _abortSignal,
          _files,
          onPartialText,
          onToolEvent,
        ) => {
          onPartialText?.('第一段输出');
          clock.advance(180_000);
          onToolEvent?.('tool-1', 'shell_command', 'running');
          assert.equal(adapter.streamedStatuses.at(-1), `${formatFooterClockTime(180_000)} · 已运行 3m · 上次响应 0s`);

          clock.advance(10_000);
          assert.equal(adapter.streamedStatuses.at(-1), `${formatFooterClockTime(190_000)} · 已运行 3m10s · 上次响应 10s`);

          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 180_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );
  });

  it('skips normal text delivery when the structured stream UI already finalized the reply', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-card-final',
      userId: 'user-card-final',
    } as const;
    router.createBinding(address, 'D:\\workspace\\card-final');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const deliveredTexts: string[] = [];

    adapter.onStreamEnd = async (
      _chatId: string,
      status: 'completed' | 'interrupted' | 'error',
      responseText: string,
    ): Promise<boolean> => {
      adapter.streamEnds.push({ status, text: responseText });
      return true;
    };

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-card-final-1',
        address,
        text: 'hello',
        timestamp: Date.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = Date.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-card-final'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (
          _binding,
          _text,
          _onPermission,
          _abortSignal,
          _files,
          onPartialText,
          _onToolEvent,
          _onTaskEvent,
          _onStatusNote,
          _onPromptPrepared,
          options,
        ) => {
          onPartialText?.('第一段输出');
          options?.onContextUsage?.({
            modelContextWindow: 200_000,
            lastTokenUsage: {
              inputTokens: 125_300,
              outputTokens: 4_600,
            },
          });
          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
      },
    );

    assert.deepEqual(deliveredTexts, []);
    assert.equal(adapter.streamEnds.length, 1);
    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assertStreamMetadataHasBinding(adapter);
    assert.match(adapter.streamEnds[0]?.text || '', /最终回复/);
    assert.match(adapter.streamEnds[0]?.text || '', /Context: 125k\(63%\) · ↑125k ↓4\.6k/);
  });

  it('finalizes a stopped structured stream as interrupted without sending an error reply', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-stop',
      userId: 'user-stop',
    } as const;
    router.createBinding(address, 'D:\\workspace\\stop');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const deliveredTexts: string[] = [];

    adapter.onStreamEnd = async (
      _chatId: string,
      status: 'completed' | 'interrupted' | 'error',
      responseText: string,
    ): Promise<boolean> => {
      adapter.streamEnds.push({ status, text: responseText });
      return true;
    };

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-stop-1',
        address,
        text: 'hello',
        timestamp: Date.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = Date.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-stop'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (binding) => {
          const task = taskStateMap.get(binding.bridgeSessionId);
          task?.abortController.abort();
          return {
            responseText: '',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: true,
            errorMessage: 'Task stopped by user',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
      },
    );

    assert.equal(adapter.streamEnds[0]?.status, 'interrupted');
    assertStreamMetadataHasBinding(adapter);
    assert.deepEqual(deliveredTexts, []);
  });

  it('sends a stale task notice instead of the old reply when the chat binding has been removed', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      channelAlias: '飞书',
      chatId: 'chat-stale-task',
      userId: 'user-stale-task',
      displayName: '旧任务',
    } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\old-task');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const deliveredTexts: string[] = [];

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-stale-1',
        address,
        text: 'hello',
        timestamp: Date.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = Date.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-stale'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        listInteractiveTurnBindings(channelType) {
          return getBridgeContext().store.listChannelChats(channelType);
        },
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('旧会话流式内容');
          getBridgeContext().store.deleteChannelChat(binding.id);
          return {
            responseText: '旧会话最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
      },
    );

    assert.equal(deliveredTexts.length, 0);
    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assert.match(adapter.streamEnds[0]?.text || '', /旧会话「旧任务」任务已结束/);
  });

  it('releases the turn before stream finalization ACK while preserving finalization cleanup order', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-finalize',
      userId: 'user-finalize',
    } as const;
    router.createBinding(address, 'D:\\workspace\\finalize');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();
    const deliveredTexts: string[] = [];
    const finalizeStarted = createDeferred<void>();
    const releaseFinalize = createDeferred<void>();

    adapter.onStreamEnd = async (
      _chatId: string,
      status: 'completed' | 'interrupted' | 'error',
      responseText: string,
    ): Promise<boolean> => {
      adapter.streamEnds.push({ status, text: responseText });
      finalizeStarted.resolve();
      clock.advance(10_000);
      await releaseFinalize.promise;
      return false;
    };

    const runPromise = runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-finalize-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-finalize'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistCodexThreadUpdate() {},
        resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
        resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('第一段输出');
          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            codexThreadId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 10_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );

    await finalizeStarted.promise;
    const statusCountWhileFinalizing = adapter.streamedStatuses.length;
    await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('interactive turn waited for stream finalization ACK')), 100)),
    ]);
    assert.equal(taskStateMap.size, 0);
    assert.equal(adapter.messageEnds.length, 0, 'UI cleanup must wait until stream finalization settles');
    releaseFinalize.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(adapter.streamedStatuses.length, statusCountWhileFinalizing);
    assert.deepEqual(deliveredTexts, []);
    assert.equal(clock.activeCount(), 0);
    assert.equal(adapter.messageEnds.length, 1);
  });

  it('includes masked error diagnostics in the streaming card when Codex fails', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-error-diag',
      userId: 'user-error-diag',
    } as const;
    router.createBinding(address, 'D:\\workspace\\error-diag');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const deliveredTexts: string[] = [];
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      await runInteractiveMessage(
        adapter,
        {
          messageId: 'incoming-error-diag-1',
          address,
          text: 'hello',
          timestamp: Date.now(),
        },
        'hello',
        undefined,
        {
          registerInteractiveTask(task) {
            taskStateMap.set(task.sessionId, task);
          },
          resetMirrorSessionForInteractiveRun() {},
          isCurrentInteractiveTask(sessionId, taskId) {
            return taskStateMap.get(sessionId)?.id === taskId;
          },
          touchInteractiveTask() {},
          recordInteractiveHealthStart() {},
          recordInteractiveHealthProgress() {},
          recordInteractiveHealthTool() {},
          recordInteractiveHealthEnd() {},
          beginMirrorSuppression() { return 'suppression-error-diag'; },
          abortMirrorSuppression() {},
          settleMirrorSuppression() {},
          releaseInteractiveTask(sessionId, taskId) {
            if (taskStateMap.get(sessionId)?.id === taskId) {
              taskStateMap.delete(sessionId);
            }
          },
          async deliverResponse(_adapter, _address, responseText) {
            deliveredTexts.push(responseText);
          },
          persistCodexThreadUpdate() {},
          resolveInteractiveTurnEnvironment: resolveTestInteractiveTurnEnvironment,
          resolveInteractiveTurnRuntimeSettings: resolveTestInteractiveTurnRuntimeSettings,
          processMessageImpl: async () => {
            return {
              responseText: '',
              outboundAttachments: [],
              tokenUsage: null,
              hasError: true,
              errorMessage: 'Turn failed: token=secret123456',
              permissionRequests: [],
              codexThreadId: 'thread-1',
            };
          },
        },
      );
    } finally {
      console.error = originalError;
    }

    assert.equal(adapter.streamEnds.length, 1);
    assert.equal(adapter.streamEnds[0]?.status, 'error');
    assert.match(adapter.streamEnds[0]?.text || '', /Error\b/);
    assert.match(adapter.streamEnds[0]?.text || '', /bridge_session_id:/);
    assert.ok(!(adapter.streamEnds[0]?.text || '').includes('secret123456'));
    assert.deepEqual(deliveredTexts, []);
    const tags = (adapter.streamMetadata.at(-1)?.tags || []).join(' ');
    assert.match(tags, /\bsdk\b/);
    assert.doesNotMatch(tags, /thread_id:/);
    assert.ok(errors.length >= 1);
  });
});
