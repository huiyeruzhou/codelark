import '../../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CODELARK_HOME } from '../../../../../configuration/paths.js';
import {
  LEGACY_CONFIG_ENV_PATH as CONFIG_PATH,
  LEGACY_CONFIG_JSON_PATH as CONFIG_JSON_PATH,
} from '../../../../../configuration/migrations/legacy/paths.js';
import { createConfigService } from '../../../../../configuration/service.js';
import { createAdapterRuntime } from '../../../../../channels/adapter-runtime/runtime.js';
import { getClaudeProjectDir } from '../../../../../runtime/claude/session-jsonl.js';
import { CodexRoutingProvider } from '../../../../../runtime/codex/routing-provider.js';
import { findSessionFileByThreadId } from '../../../../../runtime/codex/tmux-provider.js';
import { computeKimiWorkspaceDirName, isArchivedKimiSession } from '../../../../../runtime/kimi/session-index.js';
import { _testOnly, registerAdapter } from '../../../../../bridge/host/manager.js';
import { _testOnlyTmuxCore, createTmuxCliCore } from '../../../../../bridge/tmux/core.js';
import * as router from '../../../../../bridge/session/channel-router.js';
import { createMirrorSubscription } from '../../../../../bridge/mirror/subscription-state.js';
import { listEveryTasks } from '../../../../../bridge/automation/every-tasks.js';
import { buildCommandCallbackData, parseCommandCallbackData } from '../../../../../bridge/command/callbacks.js';
import { LARGE_FILE_UPLOAD_THRESHOLD_BYTES } from '../../../../../bridge/command/file-upload-confirmations.js';
import {
  getSessionActiveRuntime,
  getSessionRuntimeTmuxSessionName,
  getSessionWorkingDirectory,
} from '../../../../../domain/session-runtime.js';
import type { LLMProvider, StreamChatParams } from '../../../../../runtime/contracts.js';
import {
  BRIDGE_TEST_DATA_DIR,
  initBridgeTestContext,
  inboundMessage,
  makeBridgeSettings,
  RecordingAdapter,
  resetBridgeTestState,
  writeCodexSessionJsonlFixture,
} from '../../../../helpers/bridge/test-bridge-utils.js';

interface RecordedLlmCall {
  sessionId: string;
  runtime?: string;
  codexThreadId: string;
  prompt: string;
  codexProvider?: string;
  claudeExecutable?: string;
  sandboxMode?: string;
  networkAccessEnabled?: boolean;
  modelReasoningEffort?: string;
  permissionMode?: string;
  codexMode?: string;
}

interface ControlledLlmCall extends RecordedLlmCall {
  controller: ReadableStreamDefaultController<string>;
}

const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const execFileAsync = promisify(execFile);

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

function writeHomeConfigToml(content: string): void {
  fs.mkdirSync(CODELARK_HOME, { recursive: true });
  fs.writeFileSync(path.join(CODELARK_HOME, 'config.toml'), content, 'utf-8');
}

function getSessionCodexProviderToml(sessionId: string): unknown {
  return createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider', {
    kind: 'session',
    sessionId,
  });
}

function getSessionClaudeProviderToml(sessionId: string): unknown {
  return createConfigService({ migrate: false, env: {} }).get('runtime.claude.provider', {
    kind: 'session',
    sessionId,
  });
}

function getSessionKimiProviderToml(sessionId: string): unknown {
  return createConfigService({ migrate: false, env: {} }).get('runtime.kimi.provider', {
    kind: 'session',
    sessionId,
  });
}

function getSessionTomlSnapshot(sessionId: string): any {
  return createConfigService({ migrate: false, env: {} }).snapshot({
    kind: 'session',
    sessionId,
  }).config;
}

function getSessionTmuxAutoEnterToml(sessionId: string): unknown {
  return createConfigService({ migrate: false, env: {} }).get('session.tmuxAutoEnter', {
    kind: 'session',
    sessionId,
  });
}

function writeKimiWireFixture(params: {
  homeDir: string;
  cwd: string;
  sessionId: string;
  timestamp: string;
  text: string;
  assistantText?: string;
  thinkText?: string;
  title?: string;
}): string {
  const sessionDir = path.join(
    params.homeDir,
    'sessions',
    computeKimiWorkspaceDirName(params.cwd),
    params.sessionId,
  );
  const wireDir = path.join(sessionDir, 'agents', 'main');
  fs.mkdirSync(wireDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    createdAt: params.timestamp,
    updatedAt: params.timestamp,
    title: params.title || params.text,
  }));
  const filePath = path.join(wireDir, 'wire.jsonl');
  const baseTime = Date.parse(params.timestamp);
  const lines: Array<Record<string, unknown>> = [
    {
      type: 'context.append_message',
      time: baseTime,
      message: { role: 'user', content: params.text },
    },
  ];
  if (params.thinkText) {
    lines.push({
      type: 'context.append_loop_event',
      time: baseTime + 500,
      event: {
        type: 'content.part',
        turnId: `${params.sessionId}-turn`,
        part: { type: 'think', think: params.thinkText },
      },
    });
  }
  if (params.assistantText) {
    lines.push({
      type: 'context.append_loop_event',
      time: baseTime + 1000,
      event: {
        type: 'content.part',
        turnId: `${params.sessionId}-turn`,
        part: { type: 'text', text: params.assistantText },
      },
    });
  }
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8');
  fs.mkdirSync(params.homeDir, { recursive: true });
  fs.appendFileSync(path.join(params.homeDir, 'session_index.jsonl'), `${JSON.stringify({
    sessionId: params.sessionId,
    sessionDir,
    workDir: params.cwd,
  })}\n`, 'utf-8');
  return filePath;
}

function writeFakeKimiExecutable(binDir: string, params: {
  sessionId: string;
  ctrlCPath: string;
  keyLogPath: string;
  launchLogPath: string;
  omitResumedSessionHeader?: boolean;
}): string {
  const executablePath = path.join(binDir, 'kimi');
  const scriptPath = path.join(binDir, 'fake-kimi.cjs');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const fallbackSessionId = ${JSON.stringify(params.sessionId)};
const ctrlCPath = ${JSON.stringify(params.ctrlCPath)};
const keyLogPath = ${JSON.stringify(params.keyLogPath)};
const launchLogPath = ${JSON.stringify(params.launchLogPath)};
const omitResumedSessionHeader = ${JSON.stringify(params.omitResumedSessionHeader === true)};
const kimiHome = process.env.KIMI_CODE_HOME;
if (!kimiHome) {
  process.stderr.write('KIMI_CODE_HOME is required\\n');
  process.exit(2);
}

const resumeIndex = process.argv.indexOf('-r');
const resumed = resumeIndex >= 0 && Boolean(process.argv[resumeIndex + 1]);
const sessionId = resumed ? process.argv[resumeIndex + 1] : fallbackSessionId;
const sessionDir = path.join(kimiHome, 'sessions', 'wd_mock-app', sessionId);
const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
fs.appendFileSync(launchLogPath, JSON.stringify({ argv: process.argv.slice(2), resumed, cwd: process.cwd() }) + '\\n');
fs.mkdirSync(path.dirname(wirePath), { recursive: true });
fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
  createdAt: '2026-06-27T10:13:00.000Z',
  updatedAt: '2026-06-27T10:13:00.000Z',
  title: 'Fake Kimi mock-app plain message',
}, null, 2) + '\\n');
fs.writeFileSync(wirePath, '');
fs.appendFileSync(path.join(kimiHome, 'session_index.jsonl'), JSON.stringify({
  sessionId,
  sessionDir,
  workDir: process.cwd(),
}) + '\\n');

process.stdout.write('Kimi Code fake mock-app\\n');
if (!(resumed && omitResumedSessionHeader)) process.stdout.write('Session: ' + sessionId + '\\n');
process.stdout.write('│ > \\ncontext: 0% (0/256k)\\n');

if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();

let turnCount = 0;
let ctrlCCount = 0;
let pendingPrompt = '';
const appendWire = (entry) => fs.appendFileSync(wirePath, JSON.stringify(entry) + '\\n');
const recordCtrlC = () => {
  const previous = fs.existsSync(ctrlCPath) ? Number(fs.readFileSync(ctrlCPath, 'utf8')) || 0 : 0;
  fs.writeFileSync(ctrlCPath, String(previous + 1));
};
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(keyLogPath, JSON.stringify({ hex: chunk.toString('hex'), text: chunk.toString('utf8') }) + '\\n');
  const inputText = chunk.toString('utf8');
  const submitted = (chunk.length === 1 && chunk[0] === 0x0d) || chunk.includes(0x13);
  if (!submitted && !inputText.startsWith('\\u001b[')) {
    pendingPrompt += inputText;
  }
  if (submitted && pendingPrompt) {
    turnCount += 1;
    const now = Date.now();
    const turnId = 'turn-' + turnCount;
    const stepUuid = 'step-' + turnCount;
    const response = turnCount === 1 ? 'Kimi mock-app plain response' : 'Kimi mock-app continued response ' + turnCount;
    appendWire({ type: 'context.append_message', time: now, message: { role: 'user', content: pendingPrompt } });
    pendingPrompt = '';
    appendWire({ type: 'context.append_loop_event', time: now + 1, event: { type: 'step.begin', turnId, stepUuid } });
    appendWire({ type: 'context.append_loop_event', time: now + 2, event: { type: 'content.part', turnId, part: { type: 'think', think: 'mock kimi thinking ' + turnCount } } });
    appendWire({ type: 'context.append_loop_event', time: now + 3, event: { type: 'content.part', turnId, part: { type: 'text', text: response } } });
    appendWire({ type: 'context.append_loop_event', time: now + 4, event: { type: 'step.end', turnId, stepUuid } });
    appendWire({ type: 'usage.record', time: now + 5, usage: { inputOther: 7, inputCacheRead: 11, inputCacheCreation: 0, output: 3 } });
  }
  for (const byte of chunk) {
    if (byte !== 0x03) continue;
    ctrlCCount += 1;
    recordCtrlC();
    if (ctrlCCount >= 2) {
      process.stdout.write('\\nTo resume this session: kimi -r ' + sessionId + '\\n');
      setTimeout(() => {
        if (process.env.TMUX_PANE) {
          try { execFileSync('tmux', ['kill-session', '-t', process.env.TMUX_PANE]); } catch {}
        }
        process.exit(0);
      }, 50);
    }
  }
});

setInterval(() => {}, 1000);
`, 'utf-8');

  fs.writeFileSync(executablePath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf-8');
  fs.chmodSync(executablePath, 0o755);
  return executablePath;
}

function writeResumeOnlyFakeKimiExecutable(binDir: string, params: {
  sessionId: string;
  wirePath: string;
  keyLogPath: string;
  launchLogPath: string;
  responseText: string;
  thinkText: string;
}): string {
  const executablePath = path.join(binDir, 'kimi');
  const scriptPath = path.join(binDir, 'fake-kimi-resume.cjs');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');

const sessionId = ${JSON.stringify(params.sessionId)};
const wirePath = ${JSON.stringify(params.wirePath)};
const keyLogPath = ${JSON.stringify(params.keyLogPath)};
const launchLogPath = ${JSON.stringify(params.launchLogPath)};
const responseText = ${JSON.stringify(params.responseText)};
const thinkText = ${JSON.stringify(params.thinkText)};
const resumeIndex = process.argv.indexOf('-r');
const resumed = resumeIndex >= 0 && process.argv[resumeIndex + 1] === sessionId;
fs.appendFileSync(launchLogPath, JSON.stringify({ argv: process.argv.slice(2), resumed, cwd: process.cwd() }) + '\\n');
process.stdout.write('Kimi Code fake resume\\nSession: ' + sessionId + '\\n');
process.stdout.write('│ > \\ncontext: 0% (0/256k)\\n');

if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();

let turnCount = 0;
let pendingPrompt = '';
const appendWire = (entry) => fs.appendFileSync(wirePath, JSON.stringify(entry) + '\\n');
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(keyLogPath, JSON.stringify({ hex: chunk.toString('hex'), text: chunk.toString('utf8') }) + '\\n');
  const inputText = chunk.toString('utf8');
  const submitted = (chunk.length === 1 && chunk[0] === 0x0d) || chunk.includes(0x13);
  if (!submitted && !inputText.startsWith('\\u001b[')) {
    pendingPrompt += inputText;
  }
  if (submitted && pendingPrompt) {
    turnCount += 1;
    const now = Date.now();
    const turnId = 'turn-resume-' + turnCount;
    const stepUuid = 'step-resume-' + turnCount;
    const currentResponse = turnCount === 1
      ? responseText
      : turnCount === 2 ? 'Kimi accepted card answer' : 'Kimi continued after follow-up';
    appendWire({ type: 'context.append_message', time: now, message: { role: 'user', content: pendingPrompt } });
    pendingPrompt = '';
    appendWire({ type: 'context.append_loop_event', time: now + 1, event: { type: 'step.begin', turnId, stepUuid } });
    appendWire({ type: 'context.append_loop_event', time: now + 2, event: { type: 'content.part', turnId, part: { type: 'think', think: thinkText + ' ' + turnCount } } });
    appendWire({ type: 'context.append_loop_event', time: now + 3, event: { type: 'content.part', turnId, part: { type: 'text', text: currentResponse } } });
    appendWire({ type: 'context.append_loop_event', time: now + 4, event: { type: 'step.end', turnId, stepUuid } });
    appendWire({ type: 'usage.record', time: now + 5, usage: { inputOther: 7, inputCacheRead: 11, inputCacheCreation: 0, output: 3 } });
  }
  if (chunk.includes(0x03)) {
    setTimeout(() => process.exit(0), 20);
  }
});

setInterval(() => {}, 1000);
`, 'utf-8');

  fs.writeFileSync(executablePath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf-8');
  fs.chmodSync(executablePath, 0o755);
  return executablePath;
}

function setSessionCodexProviderToml(sessionId: string, provider: 'sdk' | 'tmux'): void {
  createConfigService({ migrate: false, env: {} }).set(
    { kind: 'session', sessionId },
    { runtime: { codex: { provider } } },
  );
}

function setSessionClaudeProviderToml(sessionId: string, provider: 'sdk' | 'tmux'): void {
  createConfigService({ migrate: false, env: {} }).set(
    { kind: 'session', sessionId },
    { runtime: { claude: { provider } } },
  );
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
      message: { role: 'user', content: params.text || 'hello claude e2e' },
    }),
  ].join('\n') + '\n', 'utf-8');
  return filePath;
}

class StreamingRecordingAdapter extends RecordingAdapter {
  readonly streamEvents: Array<{
    kind: 'message_start' | 'message_end' | 'mirror_start' | 'metadata' | 'status' | 'text' | 'end';
    chatId: string;
    streamKey?: string;
    text?: string;
    status?: string;
  }> = [];
  readonly reactions: Array<{ action: 'add' | 'remove'; messageId: string; emojiType?: string; reactionId?: string }> = [];
  private activeStreams = new Set<string>();

  onMessageStart(chatId: string, streamKey?: string): void {
    this.streamEvents.push({ kind: 'message_start', chatId, streamKey });
  }

  onMessageEnd(chatId: string, streamKey?: string): void {
    this.streamEvents.push({ kind: 'message_end', chatId, streamKey });
  }

  onMirrorStreamStart(chatId: string, streamKey?: string): void {
    if (streamKey) this.activeStreams.add(streamKey);
    this.streamEvents.push({ kind: 'mirror_start', chatId, streamKey });
  }

  onStreamMetadata(chatId: string, _metadata: unknown, streamKey?: string): void {
    this.streamEvents.push({ kind: 'metadata', chatId, streamKey });
  }

  onStreamStatus(chatId: string, statusText: string, streamKey?: string): void {
    if (streamKey) this.activeStreams.add(streamKey);
    this.streamEvents.push({ kind: 'status', chatId, streamKey, text: statusText });
  }

  onStreamText(chatId: string, fullText: string, streamKey?: string): void {
    if (streamKey) this.activeStreams.add(streamKey);
    this.streamEvents.push({ kind: 'text', chatId, streamKey, text: fullText });
  }

  async onStreamEnd(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    streamKey?: string,
  ): Promise<boolean> {
    this.streamEvents.push({ kind: 'end', chatId, streamKey, status, text: responseText });
    if (streamKey) this.activeStreams.delete(streamKey);
    return true;
  }

  supportsStructuredStreamingUi(): boolean {
    return true;
  }

  hasActiveStreamingUi(_chatId: string, streamKey?: string): boolean {
    return Boolean(streamKey && this.activeStreams.has(streamKey));
  }

  async addMessageReaction(messageId: string, emojiType: string): Promise<string | null> {
    const reactionId = `reaction-${this.reactions.length + 1}`;
    this.reactions.push({ action: 'add', messageId, emojiType, reactionId });
    return reactionId;
  }

  async removeMessageReaction(messageId: string, reactionId: string, emojiType?: string): Promise<void> {
    this.reactions.push({ action: 'remove', messageId, emojiType, reactionId });
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForCondition(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Timed out waiting for condition.'));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

async function waitForMirrorCondition(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    await _testOnly.reconcileMirrorSubscriptions();
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for mirror condition.');
}

async function runThroughAdapterRuntime(
  adapter: RecordingAdapter,
  message: ReturnType<typeof inboundMessage>,
  done: () => boolean = () => adapter.sent.length > 0,
): Promise<void> {
  const state = {
    adapters: new Map(),
    adapterMeta: new Map(),
    invalidAdapters: new Map(),
    loopAborts: new Map(),
    running: true,
  };
  const queue = [message];
  adapter.consumeOne = async () => queue.shift() || null;
  adapter.isRunning = () => queue.length > 0;
  const runtime = createAdapterRuntime(() => state, {
    notifyAdapterSetChanged: () => {},
    handleMessage: (targetAdapter, msg) => _testOnly.handleMessage(targetAdapter, msg),
    processWithSessionLock: async (_sessionId, fn) => fn(),
    isCommandMessage: (msg) => _testOnly.isBridgeCommandText(msg.text),
    resolveSessionIdForMessage: (msg) => router.resolve(msg.address).bridgeSessionId,
    shouldBypassSessionLock: (msg) => _testOnly.shouldRouteTerminalAppendInline(msg),
    getImmediateLane: (msg, category) => _testOnly.adapterImmediateLane(msg, category),
    getSessionLane: (msg, category) => _testOnly.adapterSessionLane(msg, category),
  });
  runtime.runAdapterLoop(adapter);
  await waitForCondition(done);
  state.running = false;
}

function createRecordingLlm(calls: RecordedLlmCall[]): LLMProvider {
  return {
    streamChat(params: StreamChatParams): ReadableStream<string> {
      calls.push({
        sessionId: params.sessionId,
        runtime: params.runtime,
        codexThreadId: params.codexThreadId || '',
        prompt: params.prompt,
        codexProvider: params.codexProvider,
        claudeExecutable: params.claudeExecutable,
        sandboxMode: params.sandboxMode,
        networkAccessEnabled: params.networkAccessEnabled,
        modelReasoningEffort: params.modelReasoningEffort,
        permissionMode: params.permissionMode,
        codexMode: params.codexMode,
      });
      return new ReadableStream({
        start(controller) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: `回复：${params.prompt}` })}\n`);
          controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }) })}\n`);
          controller.close();
        },
      });
    },
  };
}

function createControlledLlm(calls: ControlledLlmCall[]): LLMProvider {
  return {
    streamChat(params: StreamChatParams): ReadableStream<string> {
      return new ReadableStream({
        start(controller) {
          calls.push({
            sessionId: params.sessionId,
            codexThreadId: params.codexThreadId || '',
            prompt: params.prompt,
            controller,
          });
        },
      });
    },
  };
}

function finishControlledCall(call: ControlledLlmCall, responseText: string): void {
  call.controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: responseText })}\n`);
  call.controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }) })}\n`);
  call.controller.close();
}

function readAuditSummaries(): string[] {
  const auditJsonPath = path.join(BRIDGE_TEST_DATA_DIR, 'audit.json');
  const auditJsonlPath = path.join(BRIDGE_TEST_DATA_DIR, 'audit.jsonl');
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

function latestCreatedGroupAddress(adapter: RecordingAdapter): { channelType: 'feishu'; chatId: string } {
  const group = adapter.createdGroups.at(-1);
  assert.ok(group);
  return { channelType: 'feishu', chatId: group.chatId };
}

async function createNewGroupSession(
  store: ReturnType<typeof initBridgeTestContext>,
  adapter: RecordingAdapter,
  sourceAddress: { channelType: 'feishu'; chatId: string; userId?: string },
  commandText: string,
  messageId: string,
): Promise<{
  address: { channelType: 'feishu'; chatId: string };
  binding: NonNullable<ReturnType<typeof store.getChannelChat>>;
}> {
  await _testOnly.handleMessage(adapter, inboundMessage(sourceAddress, commandText, messageId));
  const address = latestCreatedGroupAddress(adapter);
  const binding = store.getChannelChat(address.channelType, address.chatId);
  assert.ok(binding);
  return { address, binding };
}

function createExistingChannelChat(
  store: ReturnType<typeof initBridgeTestContext>,
  address: { channelType: string; chatId: string; chatKind?: 'group' | 'direct' },
  options: {
    workDir: string;
    name?: string;
    model?: string;
  },
): {
  binding: NonNullable<ReturnType<typeof store.getChannelChat>>;
  sessionId: string;
} {
  const session = store.createSession(
    options.name || address.chatId,
    options.model || 'test-model',
    undefined,
    options.workDir,
  );
  const binding = store.upsertChannelChat({
    channelType: address.channelType,
    chatId: address.chatId,
    chatKind: address.chatKind,
    bridgeSessionId: session.id,
  });
  return { binding, sessionId: session.id };
}

function appendCodexMirrorTurn(filePath: string, params: {
  timestampPrefix: string;
  turnId: string;
  userText: string;
  assistantText: string;
}): void {
  fs.appendFileSync(filePath, [
    {
      timestamp: `${params.timestampPrefix}:01.000Z`,
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: params.turnId,
      },
    },
    {
      timestamp: `${params.timestampPrefix}:02.000Z`,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: params.userText,
      },
    },
    {
      timestamp: `${params.timestampPrefix}:03.000Z`,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: params.assistantText }],
      },
    },
    {
      timestamp: `${params.timestampPrefix}:04.000Z`,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: params.turnId,
        last_agent_message: params.assistantText,
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
}

function appendClaudeMirrorTurn(params: {
  homeDir: string;
  cwd: string;
  sessionId: string;
  timestampPrefix: string;
  userText: string;
  assistantText: string;
}): string {
  const projectDir = getClaudeProjectDir(params.cwd, params.homeDir);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${params.sessionId}.jsonl`);
  fs.appendFileSync(filePath, [
    {
      type: 'user',
      uuid: `${params.sessionId}-user`,
      sessionId: params.sessionId,
      cwd: params.cwd,
      timestamp: `${params.timestampPrefix}:01.000Z`,
      message: { role: 'user', content: params.userText },
    },
    {
      type: 'assistant',
      uuid: `${params.sessionId}-assistant`,
      parentUuid: `${params.sessionId}-user`,
      sessionId: params.sessionId,
      cwd: params.cwd,
      timestamp: `${params.timestampPrefix}:02.000Z`,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: params.assistantText }],
        stop_reason: 'end_turn',
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
  return filePath;
}

function installFakeTmux(): { binDir: string; logPath: string; statePath: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-e2e-fake-tmux-'));
  const logPath = path.join(binDir, 'tmux.log');
  const statePath = path.join(binDir, 'sessions.txt');
  const tmuxPath = path.join(binDir, 'tmux');
  fs.writeFileSync(logPath, '', 'utf-8');
  fs.writeFileSync(statePath, '', 'utf-8');
  fs.writeFileSync(tmuxPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TMUX_FAKE_LOG"
state="$TMUX_FAKE_STATE"
case "$1" in
  has-session)
    target="$3"
    if grep -Fx -- "$target" "$state" >/dev/null 2>&1; then
      exit 0
    fi
    exit 1
    ;;
  new-session)
    name=""
    prev=""
    for arg in "$@"; do
      if [[ "$prev" == "-s" ]]; then
        name="$arg"
        break
      fi
      prev="$arg"
    done
    if [[ -n "$name" ]] && ! grep -Fx -- "$name" "$state" >/dev/null 2>&1; then
      printf '%s\\n' "$name" >> "$state"
    fi
    if [[ -n "$name" ]]; then
      safe_name="\${name//[^A-Za-z0-9_.-]/_}"
      rm -f "\${state}.\${safe_name}.captures"
    fi
    exit 0
    ;;
  kill-session)
    target="$3"
    tmp="\${state}.tmp"
    grep -Fxv -- "$target" "$state" > "$tmp" 2>/dev/null || true
    mv "$tmp" "$state"
    safe_target="\${target//[^A-Za-z0-9_.-]/_}"
    rm -f "\${state}.\${safe_target}.captures"
    exit 0
    ;;
  send-keys)
    if [[ "\${TMUX_FAKE_EXIT_AFTER_SEND:-}" == "1" ]]; then
      target=""
      prev=""
      for arg in "$@"; do
        if [[ "$prev" == "-t" ]]; then
          target="$arg"
          break
        fi
        prev="$arg"
      done
      if [[ -n "$target" ]]; then
        tmp="\${state}.tmp"
        grep -Fxv -- "$target" "$state" > "$tmp" 2>/dev/null || true
        mv "$tmp" "$state"
      fi
    fi
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
    ready_after="\${TMUX_FAKE_READY_AFTER_CAPTURES:-2}"
    safe_target="\${target//[^A-Za-z0-9_.-]/_}"
    count_file="\${state}.\${safe_target:-default}.captures"
    count=0
    [[ -f "$count_file" ]] && count="$(cat "$count_file" 2>/dev/null || printf '0')"
    count=$((count + 1))
    printf '%s\\n' "$count" > "$count_file"
    if [[ "$count" -le "$ready_after" ]]; then
      printf 'Codex starting...\\n'
    else
      printf 'OpenAI Codex\\n› \\n'
    fi
    exit 0
    ;;
  list-sessions)
    while IFS= read -r name; do
      [[ -n "$name" ]] && printf '%s\\t1\\t0\\t0\\t0\\n' "$name"
    done < "$state"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`, 'utf-8');
  fs.chmodSync(tmuxPath, 0o755);
  _testOnlyTmuxCore.replace(createTmuxCliCore({ executable: tmuxPath }));
  return { binDir, logPath, statePath };
}

async function cleanupFakeTmux(fakeTmux: { binDir: string }): Promise<void> {
  await _testOnly.waitForPendingTmuxSelectionPromptProbes();
  _testOnly.resetStateForTests();
  _testOnlyTmuxCore.reset();
  fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
}

const CODEX_GOAL_SELECTION_SCREEN = [
  'A task is already running.',
  'Do you want to replace the current goal?',
  '› 1. Replace current goal',
  '  2. Cancel',
  'Press enter to confirm or esc to cancel',
  '',
].join('\\n');

function installFailingCodexCli(): { binDir: string; executable: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-e2e-failing-codex-'));
  const executable = path.join(binDir, 'codex');
  fs.writeFileSync(executable, `#!/usr/bin/env bash
printf 'fake local bootstrap failed\\n' >&2
exit 42
`, 'utf-8');
  fs.chmodSync(executable, 0o755);
  return { binDir, executable };
}

function installFakeClaudeExecutable(): { binDir: string; logPath: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-e2e-fake-claude-'));
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

describe('bridge command e2e', () => {
  beforeEach(() => {
    resetBridgeTestState({ cleanCodexHome: true });
    _testOnly.resetStateForTests();
  });

  afterEach(() => {
    _testOnly.resetStateForTests();
  });

  it('acknowledges a direct slash command with Get without waiting for the reaction API', async () => {
    initBridgeTestContext({ dynamicSettings: true });
    const reactionAck = createDeferred<string | null>();
    const reactions: Array<{ messageId: string; emojiType: string }> = [];
    class SlowCommandReactionAdapter extends RecordingAdapter {
      override async addMessageReaction(messageId: string, emojiType: string): Promise<string | null> {
        reactions.push({ messageId, emojiType });
        return reactionAck.promise;
      }
    }
    const adapter = new SlowCommandReactionAdapter();
    registerAdapter(adapter);
    const address = { channelType: 'feishu', chatId: 'chat-command-get', userId: 'ou-command-get' } as const;

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/help', 'incoming-command-get'));

    assert.deepEqual(reactions, [{ messageId: 'incoming-command-get', emojiType: 'Get' }]);
    reactionAck.resolve('reaction-command-get');
  });

  it('creates the hidden BridgeSession before a new chat runs its first status command', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-first-status', userId: 'ou_first_status' } as const;

    await runThroughAdapterRuntime(adapter, inboundMessage(address, '/status', 'incoming-first-status'));

    const binding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(binding);
    assert.equal(store.getSession(binding.bridgeSessionId)?.hidden, true);
    assert.doesNotMatch(adapter.sent.at(-1)?.text || '', /当前聊天.*未绑定/s);
  });

  it('replaces the hidden BridgeSession when the first command takes over a local Codex session', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-first-takeover', userId: 'ou_first_takeover' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-first-takeover-'));
    const threadId = '019e8a00-0000-7000-8000-000000000001';
    writeCodexSessionJsonlFixture({ threadId, workDir });

    await runThroughAdapterRuntime(adapter, inboundMessage(address, `/t ${threadId}`, 'incoming-first-takeover'));

    const binding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(binding);
    const session = store.getSession(binding.bridgeSessionId);
    assert.equal(session?.hidden, false);
    assert.equal(getSessionActiveRuntime(session) || 'codex', 'codex');
    assert.equal(session?.runtime?.codex?.threadId, threadId);
    assert.match(adapter.sent.at(-1)?.text || '', /已切换到本地 Codex 会话/);
  });

  it('keeps the source hidden BridgeSession when the first command creates a new group session', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-first-new', userId: 'ou_first_new' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-first-new-'));

    await runThroughAdapterRuntime(
      adapter,
      inboundMessage(address, `/new first-group ${workDir}`, 'incoming-first-new'),
      () => adapter.createdGroups.length === 1 && adapter.sent.length > 0,
    );

    const sourceBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(sourceBinding);
    assert.equal(store.getSession(sourceBinding.bridgeSessionId)?.hidden, true);
    const groupBinding = store.getChannelChat(address.channelType, adapter.createdGroups[0]!.chatId);
    assert.ok(groupBinding);
    assert.equal(store.getSession(groupBinding.bridgeSessionId)?.hidden, false);
    assert.equal(getSessionWorkingDirectory(store.getSession(groupBinding.bridgeSessionId)), workDir);
  });

  it('handles /new, /his limit, and /his msg through the bridge manager entrypoint', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-e2e', userId: 'ou-history-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-history-e2e-'));

    const { address: groupAddress, binding } = await createNewGroupSession(
      store,
      adapter,
      address,
      `/new history ${workDir}`,
      'incoming-new',
    );
    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    assert.equal(getSessionWorkingDirectory(store.getSession(binding.bridgeSessionId)), workDir);

    store.addMessage(binding.bridgeSessionId, 'user', '端到端用户消息');
    store.addMessage(binding.bridgeSessionId, 'assistant', '**端到端助手回复**\n\n```ts\nconst ok = true;\n```');

    await _testOnly.handleMessage(adapter, inboundMessage(groupAddress, '/his limit 12', 'incoming-limit'));
    assert.match(adapter.sent.at(-1)?.text || '', /config\.toml/);
    const configAfterLimit = createConfigService({ migrate: false }).snapshot();
    assert.equal(configAfterLimit.config.channels[0]?.config.historyMessageLimit, 12);
    assert.deepEqual(configAfterLimit.provenance.get('channels.feishu-default.config.historyMessageLimit'), {
      source: 'home',
      file: path.join(CODELARK_HOME, 'config.toml'),
    });
    assert.equal(fs.existsSync(path.join(CODELARK_HOME, 'config.toml')), true);
    assert.equal(fs.existsSync(CONFIG_PATH), false);
    assert.equal(fs.existsSync(CONFIG_JSON_PATH), false);

    await _testOnly.handleMessage(adapter, inboundMessage(groupAddress, '/ui off', 'incoming-ui-detail-off'));
    assert.doesNotMatch(fs.readFileSync(path.join(CODELARK_HOME, 'config.toml'), 'utf-8'), /showToolCallDetails|show_tool_call_details/);
    assert.match(adapter.sent.at(-1)?.text || '', /UI 显示设置已简化/);
    assert.match(adapter.sent.at(-1)?.text || '', /工具详情.*始终显示/s);

    await _testOnly.handleMessage(adapter, inboundMessage(groupAddress, '/ui on', 'incoming-ui-detail-on'));
    assert.doesNotMatch(fs.readFileSync(path.join(CODELARK_HOME, 'config.toml'), 'utf-8'), /showToolCallDetails|show_tool_call_details/);
    assert.match(adapter.sent.at(-1)?.text || '', /工具详情.*始终显示/s);

    await _testOnly.handleMessage(adapter, inboundMessage(groupAddress, '/his msg', 'incoming-history-msg'));

    const lastText = adapter.sent.at(-1)?.text || '';
    assert.match(lastText, /最近对话（msg）/);
    assert.match(lastText, /返回条数.*2 \/ 配置 12/s);
    assert.match(lastText, /端到端用户消息/);
    assert.match(lastText, /端到端助手回复/);
    const richCard = adapter.sent.at(-1)?.richCard;
    assert.equal(richCard?.title, '最近对话');
    assert.equal(richCard?.template, 'blue');
    assert.equal(richCard?.sections.length, 3);
    assert.equal(richCard?.sections[0]?.fields?.[1]?.[1], 'Bridge 缓存');
    assert.match(richCard?.sections[2]?.markdown || '', /\*\*端到端助手回复\*\*/);
    assert.doesNotMatch(richCard?.sections[2]?.markdown || '', /^```text/);

    await _testOnly.handleMessage(adapter, inboundMessage(groupAddress, '/his msg 1', 'incoming-history-msg-once'));
    assert.equal(createConfigService({ migrate: false }).snapshot().config.channels[0]?.config.historyMessageLimit, 12);
    const temporaryText = adapter.sent.at(-1)?.text || '';
    assert.match(temporaryText, /最近对话（msg）/);
    assert.match(temporaryText, /返回条数.*1 \/ 本次 1（配置 12）/s);
    assert.doesNotMatch(temporaryText, /端到端用户消息/);
    assert.match(temporaryText, /端到端助手回复/);
  });

  it('runs the /every text command chain from list to create, refresh, remove, and refresh', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-every-text-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-every-text-work-'));

    createExistingChannelChat(store, address, { workDir, name: 'every-text' });
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/every', 'incoming-every-text-ls-empty'));
    assert.match(adapter.sent.at(-1)?.text || '', /当前聊天没有 \/every 定时输入/);
    assert.equal(adapter.sent.at(-1)?.richCard?.title, '当前聊天 /every 定时输入（0）');
    assert.deepEqual(adapter.sent.at(-1)?.richCard?.actions?.flat().map((action) => action.text), ['新建', '刷新']);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/every 10m text timer prompt', 'incoming-every-text-new'));
    assert.match(adapter.sent.at(-1)?.text || '', /已创建 \/every 定时输入/);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/every', 'incoming-every-text-ls-created'));
    assert.match(adapter.sent.at(-1)?.text || '', /当前聊天 \/every 定时输入/);
    assert.match(adapter.sent.at(-1)?.text || '', /text timer prompt/);
    assert.equal(adapter.sent.at(-1)?.richCard?.template, 'green');
    assert.equal(adapter.sent.at(-1)?.richCard?.updateKey, `thread-card:every:${address.channelType}:${address.chatId}`);
    assert.equal(adapter.sent.at(-1)?.richCard?.updateTtlMs, null);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/every no 1', 'incoming-every-text-rm'));
    assert.match(adapter.sent.at(-1)?.text || '', /已取消 \/every 定时输入/);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/every', 'incoming-every-text-ls-removed'));
    assert.match(adapter.sent.at(-1)?.text || '', /当前聊天没有 \/every 定时输入/);
    assert.equal(adapter.sent.at(-1)?.richCard?.title, '当前聊天 /every 定时输入（0）');
  });

  it('runs /every interval prompts through the SDK provider on the current session', async () => {
    const calls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({ dynamicSettings: true, llm: createRecordingLlm(calls) });
    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-every-sdk-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-every-sdk-work-'));

    const { sessionId: ownerSessionId } = createExistingChannelChat(store, address, {
      workDir,
      name: 'every-sdk',
    });
    setSessionCodexProviderToml(ownerSessionId, 'sdk');

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/every 1s interval prompt', 'incoming-every-sdk-new'));
      assert.match(adapter.sent.at(-1)?.text || '', /已创建 \/every 定时输入/);
      await waitForCondition(() => calls.length >= 1, 2500);

      assert.equal(calls[0].prompt, 'interval prompt');
      assert.equal(calls[0].sessionId, ownerSessionId);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/every', 'incoming-every-sdk-ls'));
      const listText = adapter.sent.at(-1)?.text || '';
      assert.match(listText, /1 s/);
      assert.match(listText, /interval prompt/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/every no 1', 'incoming-every-sdk-rm'));
      assert.equal(listEveryTasks({ bridgeSessionId: ownerSessionId }).length, 0);
    } finally {
      if (listEveryTasks({ bridgeSessionId: ownerSessionId }).length > 0) {
        await _testOnly.handleMessage(adapter, inboundMessage(address, '/every no 1', 'incoming-every-sdk-cleanup'));
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('runs the /every rich card chain with new form, select, remove, and refresh callbacks', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-every-card-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-every-card-work-'));

    createExistingChannelChat(store, address, {
      workDir,
      name: 'every-card',
    });
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/every', 'incoming-every-card-empty'));

    const card = adapter.sent.at(-1)?.richCard;
    assert.ok(card);
    assert.equal(card.template, 'green');
    assert.equal(card.title, '当前聊天 /every 定时输入（0）');
    assert.equal(card.updateKey, `thread-card:every:${address.channelType}:${address.chatId}`);
    assert.equal(card.updateTtlMs, null);
    const newCallback = card.actions?.flat().find((action) => action.text === '新建')?.callbackData;
    assert.ok(newCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'every-card-new-callback-message'),
      callbackData: newCallback,
      callbackMessageId: 'every-card-message',
    });
    const formCard = adapter.sent.at(-1)?.richCard;
    assert.equal(formCard?.title, '新建 /every 定时输入');
    assert.equal(formCard?.form?.submitText, '创建');
    const submitCallback = formCard?.form?.submitCallbackData;
    assert.ok(submitCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'every-card-form-submit-message'),
      callbackData: submitCallback,
      callbackMessageId: 'every-card-form-message',
      raw: {
        event: {
          action: {
            form_value: {
              every_interval: '5m',
              every_prompt: 'card timer prompt',
            },
          },
        },
      },
    });
    assert.match(adapter.sent.at(-1)?.text || '', /已创建 \/every 定时输入/);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/every', 'incoming-every-card-ls'));
    const listCard = adapter.sent.at(-1)?.richCard;
    const selectCallback = listCard?.selects?.[0]?.options?.[0]?.callbackData;
    const rmCallback = listCard?.actions?.flat().find((action) => action.text === '取消')?.callbackData;
    const refreshCallback = listCard?.actions?.flat().find((action) => action.text === '刷新')?.callbackData;
    assert.ok(selectCallback);
    assert.ok(rmCallback);
    assert.ok(refreshCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'every-card-select-callback-message'),
      callbackData: selectCallback,
      callbackMessageId: 'every-card-message',
    });

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'every-card-rm-callback-message'),
      callbackData: rmCallback,
      callbackMessageId: 'every-card-message',
    });
    assert.match(adapter.sent.at(-1)?.text || '', /已取消 \/every 定时输入/);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'every-card-refresh-message'),
      callbackData: refreshCallback,
      callbackMessageId: 'every-card-message',
    });
    assert.match(adapter.sent.at(-1)?.text || '', /当前聊天没有 \/every 定时输入/);
  });

  it('runs /every interval prompts through the tmux provider on the current session', async () => {
    const calls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: createRecordingLlm(calls),
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-every-tmux-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-every-tmux-work-'));
    let binding: ReturnType<typeof createExistingChannelChat>['binding'] | null = null;

    try {
      binding = createExistingChannelChat(store, address, {
        workDir,
        name: 'every-tmux',
      }).binding;
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime claude', 'incoming-every-tmux-runtime'));
      binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-every-tmux-provider'));
      binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      const tmuxSessionName = `claude_${binding.bridgeSessionId}`;
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.general?.tmuxSessionName, tmuxSessionName);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.claude?.provider, 'tmux');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/every 1s tmux prompt', 'incoming-every-tmux-new'));
      assert.match(adapter.sent.at(-1)?.text || '', /已创建 \/every 定时输入/);
      await waitForCondition(() => {
        const log = fs.readFileSync(fakeTmux.logPath, 'utf-8');
        return (
          log.includes(`send-keys -t ${tmuxSessionName} -l tmux prompt`)
          && log.includes(`send-keys -t ${tmuxSessionName} Enter`)
        );
      }, 2500);

      assert.equal(calls.length, 0);
      const tmuxLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(tmuxLog, new RegExp(`send-keys -t ${tmuxSessionName} -l tmux prompt`));
      assert.match(tmuxLog, new RegExp(`send-keys -t ${tmuxSessionName} Enter`));

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/every no 1', 'incoming-every-tmux-rm'));
      assert.equal(listEveryTasks({ bridgeSessionId: binding.bridgeSessionId }).length, 0);
    } finally {
      if (binding && listEveryTasks({ bridgeSessionId: binding.bridgeSessionId }).length > 0) {
        await _testOnly.handleMessage(adapter, inboundMessage(address, '/every no 1', 'incoming-every-tmux-cleanup'));
      }
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      fs.rmSync(workDir, { recursive: true, force: true });
      await cleanupFakeTmux(fakeTmux);
    }
  });

  it('applies Codex thread card buttons to the currently selected dropdown option', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-card-actions' } as const;
    const threadId = '33333333-3333-4333-8333-333333333333';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-thread-card-'));
    writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [{
        timestamp: '2026-05-28T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: '2026-05-28T00:00:00.000Z',
          cwd: workDir,
          originator: 'Codex CLI',
        },
      }],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-thread-card-list'));
    const card = adapter.sent.at(-1)?.richCard;
    assert.ok(card);
    assert.match(card.updateKey || '', /^thread-card:global:/);
    assert.equal(card.updateTtlMs, null);
    const selectCallback = card.tableBlocks?.[0]?.selects?.[0]?.options?.[0]?.callbackData;
    const switchCallback = card.tableBlocks?.[0]?.actions?.[0]?.[0]?.callbackData;
    assert.equal(card.tableBlocks?.[0]?.actions?.[0]?.[0]?.text, '接管');
    assert.ok(selectCallback);
    assert.ok(switchCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-1'),
      callbackData: selectCallback,
      callbackMessageId: 'reply-1',
    });
    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-1'),
      callbackData: switchCallback,
      callbackMessageId: 'reply-1',
    });

    const binding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(binding);
    assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, threadId);
    assert.match(adapter.sent.at(-1)?.text || '', /已切换到本地 Codex 会话/);
    assert.ok(adapter.sent.at(-1)?.richCard);
    assert.match(adapter.sent.at(-1)?.richCard?.updateKey || '', /^thread-card:global:/);
    assert.equal(adapter.sent.at(-1)?.richCard?.updateTtlMs, null);
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-1');
    assert.equal(adapter.sent.at(-1)?.richCard?.tableBlocks?.[0]?.selects?.[0]?.selectedCallbackData, selectCallback);
  });

  it('removes the temporary BridgeSession after /t unbind then switching to a local session', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-draft-cleanup' } as const;
    const threadId = '33333333-3333-4333-8333-333333333336';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-thread-draft-cleanup-'));
    writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [{
        timestamp: '2026-05-28T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: '2026-05-28T00:00:00.000Z',
          cwd: workDir,
          originator: 'Codex CLI',
        },
      }],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t unbind', 'incoming-thread-draft-unbind'));
    const draftBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(draftBinding);
    assert.equal(store.getSession(draftBinding.bridgeSessionId)?.session_type, 'normal');
    assert.equal(store.getSession(draftBinding.bridgeSessionId)?.hidden, true);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t 1', 'incoming-thread-draft-switch'));

    const active = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(active);
    assert.equal(store.getSession(active.bridgeSessionId)?.runtime?.codex?.threadId, threadId);
    assert.equal(store.getSession(draftBinding.bridgeSessionId), null);
    assert.match(adapter.sent.at(-1)?.text || '', /已切换到本地 Codex 会话/);
  });

  it('renders /t Codex, Claude Code, and Kimi Code runtime groups in the mock app card', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-card-runtime-groups' } as const;
    const { binding: initialBinding } = createExistingChannelChat(store, address, {
      workDir: '/tmp/thread-card-runtime-groups-current',
      name: 'Current running session',
    });
    store.updateSession(initialBinding.bridgeSessionId, {
      runtime_status: 'running',
      health_status: 'running_active',
    });
    const codexThreadId = '33333333-3333-4333-8333-333333333334';
    const claudeSessionId = '33333333-3333-4333-8333-333333333335';
    const kimiSessionId = 'session_33333333-3333-4333-8333-333333333336';
    const codexWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-thread-card-groups-codex-'));
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-thread-card-groups-claude-home-'));
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-thread-card-groups-kimi-home-'));
    const previousClaudeHome = process.env.CODELARK_CLAUDE_HOME;
    const previousKimiHome = process.env.KIMI_CODE_HOME;
    process.env.CODELARK_CLAUDE_HOME = claudeHome;
    process.env.KIMI_CODE_HOME = kimiHome;
    writeCodexSessionJsonlFixture({
      threadId: codexThreadId,
      workDir: codexWorkDir,
      lines: [{
        timestamp: '2026-05-28T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: codexThreadId,
          timestamp: '2026-05-28T00:00:00.000Z',
          cwd: codexWorkDir,
          originator: 'Codex CLI',
        },
      }],
    });
    writeClaudeJsonlFixture({
      homeDir: claudeHome,
      cwd: '/tmp/thread-card-groups-claude',
      sessionId: claudeSessionId,
      timestamp: '2026-05-28T00:00:01.000Z',
      text: 'thread card groups claude',
    });
    writeKimiWireFixture({
      homeDir: kimiHome,
      cwd: '/tmp/thread-card-groups-kimi',
      sessionId: kimiSessionId,
      timestamp: '2026-05-28T00:00:02.000Z',
      text: 'thread card groups kimi',
    });

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-thread-card-runtime-groups'));
      const card = adapter.sent.at(-1)?.richCard;
      assert.ok(card);
      assert.equal(card.template, 'blue');
      assert.equal(card.panels, undefined);
      assert.equal(card.title, '');
      assert.equal(card.tableBlocks?.length, 1);
      assert.equal(card.tableBlocks?.[0]?.selects?.[0]?.id, 'codex_select');
      assert.equal(card.tableBlocks?.[0]?.selects?.[2]?.id, 'runtime_select');
      assert.deepEqual(card.tableBlocks?.[0]?.actions?.map((row) => row.map((action) => action.text)), [['接管', '归档', '新建'], ['解绑', '刷新']]);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/t claude', 'incoming-thread-card-runtime-claude'));
      const claudeCard = adapter.sent.at(-1)?.richCard;
      assert.equal(claudeCard?.tableBlocks?.length, 1);
      assert.equal(claudeCard?.tableBlocks?.[0]?.selects?.[0]?.id, 'claude_select');
      assert.equal(claudeCard?.tableBlocks?.[0]?.selects?.[2]?.id, 'runtime_select');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/t kimi', 'incoming-thread-card-runtime-kimi'));
      const kimiCard = adapter.sent.at(-1)?.richCard;
      assert.equal(kimiCard?.tableBlocks?.length, 1);
      assert.equal(kimiCard?.tableBlocks?.[0]?.selects?.[0]?.id, 'kimi_select');
      assert.equal(kimiCard?.tableBlocks?.[0]?.selects?.[2]?.id, 'runtime_select');
      assert.equal(
        store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId,
        initialBinding.bridgeSessionId,
      );
      assert.equal(store.getSession(initialBinding.bridgeSessionId)?.runtime_status, 'running');
      assert.equal(adapter.sent.some((message) => message.richCard?.title === '确认停止并切换会话'), false);
    } finally {
      if (previousClaudeHome === undefined) {
        delete process.env.CODELARK_CLAUDE_HOME;
      } else {
        process.env.CODELARK_CLAUDE_HOME = previousClaudeHome;
      }
      if (previousKimiHome === undefined) {
        delete process.env.KIMI_CODE_HOME;
      } else {
        process.env.KIMI_CODE_HOME = previousKimiHome;
      }
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  it('opens a named new-session form from the /t rich card create button', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-card-new-form', userId: 'ou-user' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-thread-card-new-form-'));
    createExistingChannelChat(store, address, { workDir, name: 'base-thread' });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-thread-card-new-form-list'));
    const card = adapter.sent.at(-1)?.richCard;
    const createAction = card?.tableBlocks?.flatMap((block) => block.actions?.flat() || []).find((action) => action.text === '新建');
    assert.ok(createAction?.callbackData);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-new-form'),
      callbackData: createAction.callbackData,
      callbackMessageId: 'reply-new-form',
    });

    const formCard = adapter.sent.at(-1)?.richCard;
    assert.equal(formCard?.title, '创建群聊会话');
    assert.equal(formCard?.form?.inputElementId, 'clk_input');
    assert.match(formCard?.form?.inputPlaceholder || '', /merge/);
    assert.equal(formCard?.form?.extraInputs?.[0]?.elementId, 'clk_path');
    assert.equal(formCard?.form?.extraInputs?.[0]?.defaultValue, workDir);
    const submitCallback = formCard?.form?.submitCallbackData;
    assert.ok(submitCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-new-form-submit'),
      callbackData: submitCallback,
      callbackMessageId: 'reply-new-form-submit',
      raw: {
        event: {
          action: {
            form_value: {
              clk_input: 'merge',
              clk_path: workDir,
            },
          },
        },
      },
    });

    assert.equal(adapter.createdGroups.at(-1)?.name, 'merge');
    const binding = store.getChannelChat(address.channelType, adapter.createdGroups.at(-1)?.chatId || '');
    assert.ok(binding);
    assert.equal(getSessionWorkingDirectory(store.getSession(binding.bridgeSessionId)), workDir);
    assert.match(adapter.sent.at(-2)?.text || '', /已创建群聊会话/);
    assert.match(adapter.sent.at(-1)?.text || '', /当前会话/);
  });

  it('opens the same named new-session form when the user sends bare /new', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-bare-new-form', userId: 'ou-user' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bare-new-form-'));
    const session = store.createSession('draft-like-thread', 'test-model', undefined, workDir, undefined, {
      sessionType: 'draft',
      hidden: true,
    });
    store.upsertChannelChat({
      channelType: address.channelType,
      chatId: address.chatId,
      chatKind: 'p2p',
      chatUserId: address.userId,
      bridgeSessionId: session.id,
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/new', 'incoming-bare-new-form'));

    const formCard = adapter.sent.at(-1)?.richCard;
    assert.equal(adapter.createdGroups.length, 0);
    assert.equal(formCard?.title, '创建群聊会话');
    assert.equal(formCard?.form?.inputElementId, 'clk_input');
    assert.equal(formCard?.form?.extraInputs?.[0]?.elementId, 'clk_path');
    assert.equal(formCard?.form?.extraInputs?.[0]?.defaultValue, workDir);
    const submitCallback = formCard?.form?.submitCallbackData;
    assert.ok(submitCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'incoming-bare-new-form-submit'),
      callbackData: submitCallback,
      callbackMessageId: 'incoming-bare-new-form-submit',
      raw: {
        event: {
          action: {
            form_value: {
              clk_input: 'merge',
              clk_path: '',
            },
          },
        },
      },
    });

    assert.equal(adapter.createdGroups.at(-1)?.name, 'merge');
    const binding = store.getChannelChat(address.channelType, adapter.createdGroups.at(-1)?.chatId || '');
    assert.ok(binding);
    assert.equal(getSessionWorkingDirectory(store.getSession(binding.bridgeSessionId)), workDir);
    assert.match(adapter.sent.at(-2)?.text || '', /已创建群聊会话/);
    assert.match(adapter.sent.at(-1)?.text || '', /当前会话/);
  });

  it('archives the selected Codex thread from the /t rich card', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-card-archive' } as const;
    const threadId = '33333333-3333-4333-8333-444444444444';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-thread-card-archive-'));
    const { sessionPath } = writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [{
        timestamp: '2026-05-28T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: '2026-05-28T00:00:00.000Z',
          cwd: workDir,
          originator: 'Codex CLI',
        },
      }],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-thread-card-archive-list'));
    const card = adapter.sent.at(-1)?.richCard;
    const selectCallback = card?.tableBlocks?.[0]?.selects?.[0]?.options?.[0]?.callbackData;
    const archiveCallback = card?.tableBlocks?.flatMap((block) => block.actions?.flat() || []).find((action) => action.text === '归档')?.callbackData;
    assert.ok(selectCallback);
    assert.ok(archiveCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-archive-1'),
      callbackData: selectCallback,
      callbackMessageId: 'reply-archive-1',
    });
    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-archive-1'),
      callbackData: archiveCallback,
      callbackMessageId: 'reply-archive-1',
    });

    assert.match(adapter.sent.at(-1)?.text || '', /已归档本地 Codex 会话/);
    assert.equal(fs.existsSync(sessionPath), false);
    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    assert.match(adapter.sent.at(-1)?.richCardUpdateMessageId || '', /reply-archive-1/);
  });

  it('orders /t global Codex entries by active time without showing Bridge-only sessions', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-global-thread-active-order-e2e' } as const;
    const bridgeWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-global-order-bridge-'));
    const localWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-global-order-local-'));
    const localThreadId = '019e81d3-e5b0-7540-ad14-4f3073b2703b';

    const { binding: bridgeBinding } = createExistingChannelChat(store, address, {
      workDir: bridgeWorkDir,
      name: 'bridge-old',
    });

    const { sessionPath } = writeCodexSessionJsonlFixture({
      threadId: localThreadId,
      workDir: localWorkDir,
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: localThreadId,
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: localWorkDir,
            originator: 'Codex CLI',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Newer local Codex thread' },
        },
      ],
    });
    const futureTime = new Date('2030-01-01T00:00:00.000Z');
    fs.utimesSync(sessionPath, futureTime, futureTime);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-global-order-list'));
    const listText = adapter.sent.at(-1)?.text || '';
    assert.match(listText, /本地会话（Codex1）/);
    assert.match(listText, new RegExp(localThreadId));
    assert.doesNotMatch(listText, new RegExp(bridgeBinding.id.slice(0, 8)));
    const cardJson = JSON.stringify(adapter.sent.at(-1)?.richCard);
    assert.match(cardJson, new RegExp(localThreadId));
    assert.doesNotMatch(cardJson, new RegExp(bridgeBinding.id.slice(0, 8)));

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t 1', 'incoming-global-order-use-local'));
    const active = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(active);
    assert.equal(store.getSession(active.bridgeSessionId)?.runtime?.codex?.threadId, localThreadId);
  });

  it('keeps renamed thread titles identical in /current and /t dropdown surfaces', async () => {
    initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-title-sync' } as const;
    const threadId = '44444444-4444-4444-8444-444444444444';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-title-sync-'));
    writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: workDir,
            originator: 'Codex CLI',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '原始 Codex 标题' },
        },
      ],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t 1', 'incoming-title-bind'));
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t rename 统一后的标题', 'incoming-title-rename'));
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/', 'incoming-title-current'));

    assert.match(adapter.sent.at(-1)?.text || '', /标题.*统一后的标题/s);
    assert.match(adapter.sent.at(-1)?.text || '', /name.*统一后的标题/s);
    assert.match(adapter.sent.at(-1)?.text || '', /codex_title.*原始 Codex 标题/s);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-title-list'));
    const listMessage = adapter.sent.at(-1);
    assert.match(listMessage?.text || '', /统一后的标题/);
    assert.doesNotMatch(listMessage?.text || '', /原始 Codex 标题/);
    assert.equal(listMessage?.richCard?.tableBlocks?.[0]?.table.rows?.[0]?.title, '**统一后的标题**');
    assert.equal(String(listMessage?.richCard?.tableBlocks?.[0]?.table.rows?.[0]?.title || '').replace(/\*/g, ''), '统一后的标题');
    assert.equal(listMessage?.richCard?.tableBlocks?.[0]?.selects?.[0]?.options?.[0]?.text, '1. 统一后的标题');

  });

  it('creates a new Claude /current card from text commands and refreshes that new card in place', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-current-claude-refresh-target', chatKind: 'group' as const } as const;
    createExistingChannelChat(store, address, {
      workDir: '/tmp/current-claude-refresh-target',
      name: 'Current Claude Refresh Target',
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/current', 'incoming-current-initial'));
    assert.equal(adapter.sent.at(-1)?.richCard?.updateKey, `thread-card:current:${address.channelType}:${address.chatId}`);
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, undefined);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/current runtime claude', 'incoming-current-claude-new-card'));
    assert.equal(adapter.sent.at(-1)?.richCard?.selects?.[0]?.selectedCallbackData, 'clk-command::%2Fcurrent-runtime%20claude');
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, undefined);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '/current', 'incoming-current-claude-refresh-callback'),
      callbackMessageId: 'reply-2',
    });
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-2');
    assert.equal(adapter.sent.at(-1)?.richCard?.selects?.[0]?.selectedCallbackData, 'clk-command::%2Fcurrent-runtime%20codex');

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'incoming-current-refresh-raw-message-id'),
      callbackData: buildCommandCallbackData('/current'),
      raw: {
        event: {
          context: {
            message_id: 'reply-2',
          },
          action: {
            value: {
              callback_data: buildCommandCallbackData('/current'),
            },
          },
        },
      },
    });
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-2');
    assert.equal(adapter.sent.at(-1)?.richCard?.selects?.[0]?.selectedCallbackData, 'clk-command::%2Fcurrent-runtime%20codex');

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'incoming-current-runtime-select-claude'),
      callbackData: buildCommandCallbackData('/current-runtime claude'),
      callbackMessageId: 'reply-2',
    });
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-2');
    assert.equal(adapter.sent.at(-1)?.richCard?.selects?.[0]?.selectedCallbackData, 'clk-command::%2Fcurrent-runtime%20claude');

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'incoming-current-runtime-select-codex'),
      callbackData: buildCommandCallbackData('/current-runtime codex'),
      callbackMessageId: 'reply-2',
    });
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-2');
    assert.equal(adapter.sent.at(-1)?.richCard?.selects?.[0]?.selectedCallbackData, 'clk-command::%2Fcurrent-runtime%20codex');

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'incoming-current-runtime-select-kimi'),
      callbackData: buildCommandCallbackData('/current-runtime kimi'),
      callbackMessageId: 'reply-2',
    });
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-2');
    assert.equal(adapter.sent.at(-1)?.richCard?.selects?.[0]?.selectedCallbackData, 'clk-command::%2Fcurrent-runtime%20kimi');
    assert.equal(store.getSession(store.getChannelChat(address.channelType, address.chatId)!.bridgeSessionId)?.runtime?.activeRuntime, 'kimi');
  });

  it('keeps Kimi command state scoped to the Kimi runtime session', async () => {
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu-default', chatId: 'chat-kimi-command-state', chatKind: 'group' as const } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-command-state-'));
    const binDir = path.join(workDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const previousKimiExecutable = process.env.KIMI_CODE_EXECUTABLE;
    process.env.KIMI_CODE_EXECUTABLE = writeFakeKimiExecutable(binDir, {
      sessionId: 'session_kimi_command_state',
      ctrlCPath: path.join(workDir, 'ctrl-c-count.txt'),
      keyLogPath: path.join(workDir, 'key-log.jsonl'),
      launchLogPath: path.join(workDir, 'launch-log.jsonl'),
    });
    let kimiTmuxSessionName: string | undefined;
    const smallFilePath = path.join(workDir, 'kimi-small.txt');
    const largeFilePath = path.join(workDir, 'kimi-large.bin');
    fs.writeFileSync(smallFilePath, 'kimi command-state file payload', 'utf-8');
    fs.closeSync(fs.openSync(largeFilePath, 'w'));
    fs.truncateSync(largeFilePath, LARGE_FILE_UPLOAD_THRESHOLD_BYTES + 1);
    const { binding: codexBinding } = createExistingChannelChat(store, address, {
      workDir,
      name: 'Kimi Command State',
    });

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/status', 'incoming-kimi-command-status'));
      assert.match(adapter.sent.at(-1)?.text || '', /全局状态/);
      assert.match(adapter.sent.at(-1)?.text || '', /Bridge/);
      assert.match(adapter.sent.at(-1)?.text || '', /当前聊天/s);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/require-at off', 'incoming-kimi-command-require-at-off'));
      assert.match(adapter.sent.at(-1)?.text || '', /已更新群聊 @bot 设置/);
      assert.match(adapter.sent.at(-1)?.text || '', /off/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime kimi', 'incoming-kimi-command-runtime'));
      const kimiBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(kimiBinding);
      assert.notEqual(kimiBinding.bridgeSessionId, codexBinding.bridgeSessionId);
      assert.equal(kimiBinding.runtimeBridgeSessionIds?.codex, codexBinding.bridgeSessionId);
      assert.equal(kimiBinding.runtimeBridgeSessionIds?.kimi, kimiBinding.bridgeSessionId);
      const kimiSession = store.getSession(kimiBinding.bridgeSessionId);
      kimiTmuxSessionName = `clk-kimi-${kimiBinding.bridgeSessionId}`;
      assert.equal(kimiSession?.runtime?.activeRuntime, 'kimi');
      assert.equal(getSessionWorkingDirectory(kimiSession), workDir);
      assert.match(adapter.sent.at(-1)?.text || '', /已创建并切换 Runtime/);
      assert.match(adapter.sent.at(-1)?.text || '', /Runtime.*kimi/s);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p', 'incoming-kimi-command-provider-status'));
      assert.match(adapter.sent.at(-1)?.text || '', /当前 Kimi Provider/);
      assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux/s);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p sdk', 'incoming-kimi-command-provider-invalid'));
      assert.match(adapter.sent.at(-1)?.text || '', /Kimi Provider 用法/);
      assert.equal(getSessionTomlSnapshot(kimiBinding.bridgeSessionId).runtime?.kimi?.provider, 'tmux');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p auto', 'incoming-kimi-command-provider-auto-invalid'));
      assert.match(adapter.sent.at(-1)?.text || '', /Kimi Provider 用法/);
      assert.equal(getSessionTomlSnapshot(kimiBinding.bridgeSessionId).runtime?.kimi?.provider, 'tmux');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-kimi-command-provider-tmux'));
      assert.match(adapter.sent.at(-1)?.text || '', /已切换 Kimi Provider/);
      assert.equal(getSessionTomlSnapshot(kimiBinding.bridgeSessionId).runtime?.kimi?.provider, 'tmux');
      const nonKimiRuntimeConfigBeforeUnsupportedCommands = JSON.stringify({
        codex: getSessionTomlSnapshot(kimiBinding.bridgeSessionId).runtime?.codex,
        claude: getSessionTomlSnapshot(kimiBinding.bridgeSessionId).runtime?.claude,
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/model moonshot-auto', 'incoming-kimi-command-model'));
      assert.match(adapter.sent.at(-1)?.text || '', /已更新 Kimi Code 模型/);
      assert.equal(getSessionTomlSnapshot(kimiBinding.bridgeSessionId).runtime?.kimi?.model, 'moonshot-auto');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/r high', 'incoming-kimi-command-reasoning'));
      assert.match(adapter.sent.at(-1)?.text || '', /已更新 Kimi Code Thinking 模式/);
      assert.equal(getSessionTomlSnapshot(kimiBinding.bridgeSessionId).runtime?.kimi?.thinkingMode, 'on');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/sandbox read-only', 'incoming-kimi-command-sandbox'));
      assert.match(adapter.sent.at(-1)?.text || '', /Kimi Code 不支持 Bridge 沙箱设置/);
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/network off', 'incoming-kimi-command-network'));
      assert.match(adapter.sent.at(-1)?.text || '', /Kimi Code 不支持 Bridge 网络开关/);
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/mode yolo', 'incoming-kimi-command-mode'));
      assert.match(adapter.sent.at(-1)?.text || '', /Kimi Code 模式固定/);
      const scopedConfig = getSessionTomlSnapshot(kimiBinding.bridgeSessionId);
      assert.equal(JSON.stringify({
        codex: scopedConfig.runtime?.codex,
        claude: scopedConfig.runtime?.claude,
      }), nonKimiRuntimeConfigBeforeUnsupportedCommands);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/current', 'incoming-kimi-command-current'));
      const currentCard = adapter.sent.at(-1)?.richCard;
      assert.match(adapter.sent.at(-1)?.text || '', /当前会话/);
      assert.equal(currentCard?.selects?.[0]?.selectedCallbackData, 'clk-command::%2Fcurrent-runtime%20kimi');
      assert.equal(currentCard?.tags?.[0], 'kimi');
      assert.match(currentCard?.footer?.join('\n') || '', /当前 agent：.*Kimi Code/s);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/file kimi-small.txt', 'incoming-kimi-command-small-file'));
      const smallFileReply = adapter.sent.find((message) => message.attachments?.some((attachment) => attachment.path === smallFilePath));
      assert.ok(smallFileReply);
      assert.equal(smallFileReply?.attachments?.[0]?.path, smallFilePath);
      assert.equal(smallFileReply?.attachments?.[0]?.name, 'kimi-small.txt');
      assert.match(adapter.sent.at(-1)?.text || '', /已发送文件/);
      assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, kimiBinding.bridgeSessionId);
      assert.equal(store.getSession(kimiBinding.bridgeSessionId)?.runtime?.activeRuntime, 'kimi');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/file kimi-large.bin', 'incoming-kimi-command-large-file'));
      const largeFileReply = adapter.sent.find((message) => message.richCard?.title === '确认上传大文件');
      assert.ok(largeFileReply);
      assert.equal(largeFileReply?.attachments?.length || 0, 0);
      assert.equal(largeFileReply?.richCard?.title, '确认上传大文件');
      assert.match(JSON.stringify(largeFileReply?.richCard?.sections || []), /kimi-large\.bin/);
      assert.match(JSON.stringify(largeFileReply?.richCard?.sections || []), /超过 20 MB/);
      assert.match(JSON.stringify(largeFileReply?.richCard?.actions || []), /%2Ffile%20--confirm-large/);
      assert.match(JSON.stringify(largeFileReply?.richCard?.actions || []), /%2Ffile%20--cancel-large/);
      assert.match(adapter.sent.at(-1)?.text || '', /已发送确认卡片/);
      assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, kimiBinding.bridgeSessionId);
      assert.equal(store.getSession(kimiBinding.bridgeSessionId)?.runtime?.activeRuntime, 'kimi');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/every 1h e2e seed kimi-command-state', 'incoming-kimi-command-every-create'));
      assert.match(adapter.sent.at(-1)?.text || '', /已创建 \/every 定时输入/);
      assert.match(adapter.sent.at(-1)?.text || '', /session runtime-id/);
      assert.match(adapter.sent.at(-1)?.text || '', /kimi-command-state/);
      const everyTasks = listEveryTasks({ bridgeSessionId: kimiBinding.bridgeSessionId });
      assert.equal(everyTasks.length, 1);
      assert.equal(everyTasks[0]?.prompt, 'e2e seed kimi-command-state');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/every', 'incoming-kimi-command-every-list'));
      const everyListReply = adapter.sent.at(-1);
      assert.match(everyListReply?.text || '', /当前聊天 \/every 定时输入/);
      assert.match(everyListReply?.text || '', /session runtime-id/);
      assert.match(everyListReply?.text || '', /kimi-command-state/);
      assert.equal(everyListReply?.richCard?.title, '当前聊天 /every 定时输入（1）');
      assert.equal(everyListReply?.richCard?.table?.columns.some((column) => column.name === 'runtime_id'), true);
      assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, kimiBinding.bridgeSessionId);
      assert.equal(store.getSession(kimiBinding.bridgeSessionId)?.runtime?.activeRuntime, 'kimi');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/every no 1', 'incoming-kimi-command-every-remove'));
      assert.match(adapter.sent.at(-1)?.text || '', /已取消 \/every 定时输入/);
      assert.equal(listEveryTasks({ bridgeSessionId: kimiBinding.bridgeSessionId }).length, 0);
      assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, kimiBinding.bridgeSessionId);
      assert.equal(store.getSession(kimiBinding.bridgeSessionId)?.runtime?.activeRuntime, 'kimi');

      await _testOnly.handleMessage(adapter, {
        ...inboundMessage(address, '', 'incoming-kimi-command-current-codex'),
        callbackData: buildCommandCallbackData('/current-runtime codex'),
        callbackMessageId: 'reply-current-kimi',
      });
      const restoredCodexBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(restoredCodexBinding);
      assert.equal(restoredCodexBinding.bridgeSessionId, codexBinding.bridgeSessionId);
      assert.equal(getSessionActiveRuntime(store.getSession(restoredCodexBinding.bridgeSessionId)) || 'codex', 'codex');

      await _testOnly.handleMessage(adapter, {
        ...inboundMessage(address, '', 'incoming-kimi-command-current-kimi'),
        callbackData: buildCommandCallbackData('/current-runtime kimi'),
        callbackMessageId: 'reply-current-codex',
      });
      const restoredKimiBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(restoredKimiBinding);
      assert.equal(restoredKimiBinding.bridgeSessionId, kimiBinding.bridgeSessionId);
      assert.equal(store.getSession(restoredKimiBinding.bridgeSessionId)?.runtime?.activeRuntime, 'kimi');
      assert.equal(getSessionTomlSnapshot(restoredKimiBinding.bridgeSessionId).runtime?.kimi?.model, 'moonshot-auto');
    } finally {
      if (kimiTmuxSessionName) {
        await execFileAsync('tmux', ['kill-session', '-t', kimiTmuxSessionName]).catch(() => undefined);
      }
      if (previousKimiExecutable === undefined) delete process.env.KIMI_CODE_EXECUTABLE;
      else process.env.KIMI_CODE_EXECUTABLE = previousKimiExecutable;
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('runs Kimi session-management commands with runtime identity and archive state', async () => {
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-kimi-session-management', chatKind: 'group' as const } as const;
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-session-management-home-'));
    const previousKimiHome = process.env.KIMI_CODE_HOME;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-session-management-cwd-'));
    const kimiSessionId = 'session_kimi_session_management';

    process.env.KIMI_CODE_HOME = kimiHome;
    writeKimiWireFixture({
      homeDir: kimiHome,
      cwd,
      sessionId: kimiSessionId,
      timestamp: '2026-06-02T00:00:00.000Z',
      text: 'Kimi session management user text',
      assistantText: 'Kimi session management assistant text',
      title: 'Kimi session management title',
    });

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${kimiSessionId}`, 'incoming-kimi-session-management-bind'));
      let binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      assert.equal(binding.runtimeBridgeSessionIds?.kimi, binding.bridgeSessionId);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.activeRuntime, 'kimi');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/current', 'incoming-kimi-session-management-current'));
      assert.match(adapter.sent.at(-1)?.text || '', /当前会话/);
      assert.match(adapter.sent.at(-1)?.text || '', /runtime.*Kimi Code/s);
      assert.match(adapter.sent.at(-1)?.text || '', new RegExp(kimiSessionId));
      assert.equal(adapter.sent.at(-1)?.richCard?.tags?.[0], 'kimi');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/check', 'incoming-kimi-session-management-check'));
      const checkText = adapter.sent.at(-1)?.text || '';
      assert.match(checkText, /当前会话健康检查/);
      assert.match(checkText, /runtime.*Kimi Code/s);
      assert.match(checkText, /kimi_session_id.*session_kimi_session_management/s);
      assert.match(checkText, /runtime_cwd/s);
      assert.match(checkText, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(checkText, /codex_thread_id|claude_session_id/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-kimi-session-management-list'));
      assert.match(adapter.sent.at(-1)?.text || '', /本地会话/);
      assert.match(adapter.sent.at(-1)?.text || '', /Kimi Code/);
      assert.match(adapter.sent.at(-1)?.text || '', new RegExp(kimiSessionId));

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/t n 50', 'incoming-kimi-session-management-list-50'));
      assert.match(adapter.sent.at(-1)?.text || '', /本地会话/);
      assert.match(adapter.sent.at(-1)?.text || '', /Kimi Code/);
      assert.match(adapter.sent.at(-1)?.text || '', new RegExp(kimiSessionId));

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/t unbind', 'incoming-kimi-session-management-unbind'));
      assert.match(adapter.sent.at(-1)?.text || '', /当前聊天已解绑/);
      assert.match(adapter.sent.at(-1)?.text || '', /新的临时 BridgeSession/);
      const unbound = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(unbound);
      assert.notEqual(unbound.bridgeSessionId, binding.bridgeSessionId);

      await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${kimiSessionId}`, 'incoming-kimi-session-management-rebind'));
      binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.activeRuntime, 'kimi');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/t archive', 'incoming-kimi-session-management-archive'));
      assert.match(adapter.sent.at(-1)?.text || '', /已归档本地 Kimi Code 会话/);
      assert.match(adapter.sent.at(-1)?.text || '', new RegExp(kimiSessionId));
      assert.equal(isArchivedKimiSession(kimiSessionId, cwd), true);
    } finally {
      if (previousKimiHome === undefined) {
        delete process.env.KIMI_CODE_HOME;
      } else {
        process.env.KIMI_CODE_HOME = previousKimiHome;
      }
      fs.rmSync(kimiHome, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('creates a new Claude /set card from text commands and refreshes that new card in place', async () => {
    initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-set-claude-refresh-target', chatKind: 'group' as const } as const;

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/set', 'incoming-set-initial'));
    assert.equal(adapter.sent.at(-1)?.richCard?.updateKey, `thread-card:set:${address.channelType}:${address.chatId}`);
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, undefined);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/set --group runtime.claude', 'incoming-set-claude-new-card'));
    assert.equal(adapter.sent.at(-1)?.richCard?.subtitle, '写入 ~/.codelark/config.toml · Claude');
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, undefined);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '/set --group runtime.claude', 'incoming-set-claude-refresh-callback'),
      callbackMessageId: 'reply-2',
    });
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-2');
    assert.equal(adapter.sent.at(-1)?.richCard?.subtitle, '写入 ~/.codelark/config.toml · Claude');

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'incoming-set-group-select-codex'),
      callbackData: buildCommandCallbackData('/set --group runtime.codex'),
      callbackMessageId: 'reply-2',
    });
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-2');
    assert.equal(adapter.sent.at(-1)?.richCard?.subtitle, '写入 ~/.codelark/config.toml · Codex');

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'incoming-set-group-select-claude'),
      callbackData: buildCommandCallbackData('/set --group runtime.claude'),
      callbackMessageId: 'reply-2',
    });
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-2');
    assert.equal(adapter.sent.at(-1)?.richCard?.subtitle, '写入 ~/.codelark/config.toml · Claude');

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'incoming-set-claude-submit-callback'),
      callbackData: buildCommandCallbackData('/set --group runtime.claude'),
      callbackMessageId: 'reply-2',
      raw: {
        event: {
          action: {
            form_value: {
              cld_rsn_eft: 'max',
            },
          },
        },
      },
    });
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-2');
    assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.claude.reasoningEffort'), 'max');
  });

  it('keeps /set and /current card callbacks in place when Feishu omits card message ids', async () => {
    const previousAgent = process.env.CODELARK_AGENT;
    process.env.CODELARK_AGENT = 'codex';
    try {
      const store = initBridgeTestContext({ dynamicSettings: true });
      const adapter = new RecordingAdapter();
      const setAddress = { channelType: 'feishu', chatId: 'chat-set-missing-message-id', chatKind: 'group' as const } as const;

      await _testOnly.handleMessage(adapter, inboundMessage(setAddress, '/set', 'incoming-set-missing-id-initial'));
      assert.equal(adapter.sent.at(-1)?.richCard?.updateKey, `thread-card:set:${setAddress.channelType}:${setAddress.chatId}`);
      assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, undefined);

      await _testOnly.handleMessage(adapter, {
        ...inboundMessage(setAddress, '', 'incoming-set-missing-id-submit'),
        callbackData: buildCommandCallbackData('/set --group runtime'),
        raw: {
          event: {
            action: {
              form_value: {
                rt: 'claude',
              },
            },
          },
        },
      });

      const runtimeSelect = adapter.sent.at(-1)?.richCard?.form?.selects?.find((select: any) => select.elementId === 'runtime');
      assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-1');
      assert.equal(runtimeSelect?.selectedCallbackData, 'claude');
      assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.agent'), 'claude');
      assert.equal(createConfigService({ migrate: false }).get('runtime.agent'), 'codex');

      const currentAddress = { channelType: 'feishu', chatId: 'chat-current-missing-message-id', chatKind: 'group' as const } as const;
      createExistingChannelChat(store, currentAddress, {
        workDir: '/tmp/current-missing-message-id',
        name: 'Current Missing Message Id',
      });

      await _testOnly.handleMessage(adapter, inboundMessage(currentAddress, '/current', 'incoming-current-missing-id-initial'));
      assert.equal(adapter.sent.at(-1)?.richCard?.updateKey, `thread-card:current:${currentAddress.channelType}:${currentAddress.chatId}`);
      assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, undefined);

      await _testOnly.handleMessage(adapter, {
        ...inboundMessage(currentAddress, '', 'incoming-current-missing-id-refresh'),
        callbackData: buildCommandCallbackData('/current'),
        raw: {
          event: {
            action: {
              value: {
                callback_data: buildCommandCallbackData('/current'),
              },
            },
          },
        },
      });
      assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-3');

      await _testOnly.handleMessage(adapter, {
        ...inboundMessage(currentAddress, '', 'incoming-current-missing-id-submit'),
        callbackData: buildCommandCallbackData('/current-config common'),
        raw: {
          event: {
            action: {
              form_value: {
                clk_name: 'Current Missing Message Id Updated',
              },
            },
          },
        },
      });
      assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-3');
      assert.match(adapter.sent.at(-1)?.text || '', /已保存当前会话配置/);
      assert.equal(
        adapter.sent.at(-1)?.richCard?.selects?.[0]?.selectedCallbackData,
        buildCommandCallbackData('/current-runtime common'),
      );
      assert.equal(adapter.sent.at(-1)?.richCard?.form?.inputDefaultValue, 'Current Missing Message Id Updated');
    } finally {
      if (previousAgent === undefined) {
        delete process.env.CODELARK_AGENT;
      } else {
        process.env.CODELARK_AGENT = previousAgent;
      }
    }
  });

  it('rechecks Codex tmux goal selection in a high-frequency window after each button answer', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH;
    const oldLog = process.env.TMUX_FAKE_LOG;
    const oldState = process.env.TMUX_FAKE_STATE;
    const oldCapture = process.env.TMUX_FAKE_CAPTURE_TEXT;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath || ''}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;
    process.env.TMUX_FAKE_CAPTURE_TEXT = CODEX_GOAL_SELECTION_SCREEN;
    const address = { channelType: 'feishu', chatId: 'chat-tmux-goal-selection-recheck' } as const;
    const { binding } = createExistingChannelChat(store, address, {
      workDir: '/tmp/tmux-goal-selection-recheck',
      name: 'tmux goal selection recheck',
    });
    const threadId = '019eac19-1111-7111-8111-111111111111';
    writeCodexSessionJsonlFixture({
      threadId,
      workDir: '/tmp/tmux-goal-selection-recheck',
      lines: [{
        timestamp: '2026-06-09T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: '2026-06-09T00:00:00.000Z',
          cwd: '/tmp/tmux-goal-selection-recheck',
          originator: 'Codex CLI',
        },
      }],
    });
    store.updateSession(binding.bridgeSessionId, {
      runtime: {
        activeRuntime: 'codex',
        codex: {
          threadId,
        },
        general: {
          workingDirectory: '/tmp/tmux-goal-selection-recheck',
          tmuxSessionName: `codex_${threadId}`,
        },
      },
    });
    setSessionCodexProviderToml(binding.bridgeSessionId, 'tmux');
    fs.writeFileSync(fakeTmux.statePath, `codex_${threadId}\n`, 'utf-8');
    const subscription = createMirrorSubscription({
      bindingId: binding.id,
      sessionId: binding.bridgeSessionId,
      channelType: address.channelType,
      chatId: address.chatId,
      threadId,
      filePath: null,
      lastDeliveredAt: null,
    });
    subscription.pendingTurn = {
      turnId: 'turn-goal-selection-a',
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    } as any;
    bridgeState.mirrorSubscriptions.set(binding.id, subscription);

    try {
      const answerLatestGoalSelection = async (label: string): Promise<void> => {
        await waitForMirrorCondition(
          () => store.listPendingPermissionLinksByChat(address.chatId).length > 0,
          2_000,
        );
        const link = store.listPendingPermissionLinksByChat(address.chatId).at(-1);
        assert.ok(link, label);
        assert.match(link.permissionRequestId, /codex-selection:goal:mirror:/);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await _testOnly.handleMessage(adapter, {
          ...inboundMessage(address, '', `incoming-goal-selection-${label}`),
          callbackData: `codex-tui-selection-choice:${encodeURIComponent(link.permissionRequestId)}:cancel`,
          callbackMessageId: link.messageId,
        });
      };

      await _testOnly.reconcileMirrorSubscriptions();
      await answerLatestGoalSelection('a');

      subscription.pendingTurn = {
        turnId: 'turn-goal-selection-b',
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      } as any;
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await answerLatestGoalSelection('b');

      subscription.pendingTurn = {
        turnId: 'turn-goal-selection-c',
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      } as any;
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await answerLatestGoalSelection('c');

      assert.equal(
        store.listPendingPermissionLinksByChat(address.chatId).length,
        0,
      );
      await waitForCondition(() => {
        const log = fs.readFileSync(fakeTmux.logPath, 'utf-8');
        return (log.match(/send-keys -t codex_019eac19-1111-7111-8111-111111111111:0\.0 Enter/g) || []).length >= 3;
      }, 2_000);
      const tmuxLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(tmuxLog, /send-keys -t codex_019eac19-1111-7111-8111-111111111111:0.0 Down/);
      assert.equal((tmuxLog.match(/send-keys -t codex_019eac19-1111-7111-8111-111111111111:0\.0 Enter/g) || []).length, 3);
    } finally {
      _testOnly.resetStateForTests();
      bridgeState.mirrorSubscriptions.delete(binding.id);
      process.env.TMUX_FAKE_CAPTURE_TEXT = 'OpenAI Codex\\n› ready\\n';
      process.env.PATH = oldPath;
      if (oldLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldLog;
      if (oldState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldState;
      if (oldCapture === undefined) delete process.env.TMUX_FAKE_CAPTURE_TEXT;
      else process.env.TMUX_FAKE_CAPTURE_TEXT = oldCapture;
      await cleanupFakeTmux(fakeTmux);
    }
  });

  it('syncs /t rename to the current group chat name', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-rename-group', chatKind: 'group' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-rename-group-'));
    createExistingChannelChat(store, address, {
      workDir,
      name: '旧标题',
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t rename 新标题', 'incoming-group-rename'));

    assert.equal(adapter.renamedGroups.length, 1);
    assert.deepEqual(adapter.renamedGroups[0], { chatId: address.chatId, name: '新标题' });
    assert.match(adapter.sent.at(-1)?.text || '', /群聊名称.*新标题/s);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('renames only the active runtime BridgeSession after runtime switches', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-rename-active' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-rename-active-'));
    const { binding } = createExistingChannelChat(store, address, {
      workDir,
      name: 'Codex 原标题',
    });

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime claude', 'incoming-runtime-rename-claude'));
      const claudeBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(claudeBinding);
      assert.notEqual(claudeBinding.bridgeSessionId, binding.bridgeSessionId);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/t rename Claude 标题', 'incoming-runtime-rename-title'));
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.name, 'Claude 标题');
      assert.equal(store.getSession(binding.bridgeSessionId)?.name, 'Codex 原标题');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime codex', 'incoming-runtime-rename-codex'));
      const codexBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(codexBinding);
      assert.equal(codexBinding.bridgeSessionId, binding.bridgeSessionId);
      assert.equal(store.getSession(codexBinding.bridgeSessionId)?.name, 'Codex 原标题');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('accepts a text confirmation after /clear sees a running session', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-clear-confirm-text', chatKind: 'group' } as const;
    const oldWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-text-old-'));
    const newWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-text-new-'));
    const { binding } = createExistingChannelChat(store, address, {
      workDir: oldWorkDir,
      name: '旧对话',
    });
    store.updateSession(binding.bridgeSessionId, {
      runtime_status: 'running',
      health_status: 'running_active',
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear 新对话 ${newWorkDir}`, 'incoming-clear-text-prompt'));
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, binding.bridgeSessionId);
    assert.match(adapter.sent.at(-1)?.text || '', /确认清空当前对话/);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '是', 'incoming-clear-text-confirm'));
    const nextBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(nextBinding);
    assert.notEqual(nextBinding!.bridgeSessionId, binding.bridgeSessionId);
    assert.equal(store.getSession(nextBinding!.bridgeSessionId)?.name, '新对话');
    assert.equal(getSessionWorkingDirectory(store.getSession(nextBinding!.bridgeSessionId)), newWorkDir);
    assert.equal(adapter.renamedGroups.length, 1);
    assert.deepEqual(adapter.renamedGroups[0], { chatId: address.chatId, name: '新对话' });
    assert.match(adapter.sent.at(-1)?.text || '', /已清空当前聊天上下文/);
    assert.match(adapter.sent.at(-1)?.text || '', /在当前聊天上下文创建一个新的对话/);
    assert.match(adapter.sent.at(-1)?.text || '', /\/t.*重新附加到之前的对话/s);
    assert.doesNotMatch(adapter.sent.at(-1)?.text || '', /会创建一个新的群聊/);
  });

  it('rejects a stale clear confirmation after the chat is rebound', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-clear-stale-card', chatKind: 'group' } as const;
    const oldWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-stale-old-'));
    const nextWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-stale-next-'));
    const { binding } = createExistingChannelChat(store, address, {
      workDir: oldWorkDir,
      name: '旧对话',
    });
    store.updateSession(binding.bridgeSessionId, {
      runtime_status: 'running',
      health_status: 'running_active',
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear 新对话 ${nextWorkDir}`, 'incoming-clear-stale-prompt'));
    const staleCallback = adapter.sent.at(-1)?.richCard?.actions?.flat()
      .find((action) => action.text === '终止并新建')?.callbackData;
    assert.ok(staleCallback);
    assert.equal(parseCommandCallbackData(staleCallback)?.scopeSessionId, binding.bridgeSessionId);

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear --yes 新对话 ${nextWorkDir}`, 'incoming-clear-stale-rebind'));
    const rebound = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(rebound);
    assert.notEqual(rebound.bridgeSessionId, binding.bridgeSessionId);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'incoming-clear-stale-click'),
      callbackData: staleCallback,
      callbackMessageId: 'clear-stale-card',
    });

    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, rebound.bridgeSessionId);
    assert.match(adapter.sent.at(-1)?.text || '', /这个按钮对应的会话已不再绑定/);
  });

  it('keeps a running attachment unchanged on cancel, then stops before a confirmed /t switch', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-attach-confirm-text', chatKind: 'group' } as const;
    const oldWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-attach-confirm-old-'));
    const newWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-attach-confirm-new-'));
    const { binding } = createExistingChannelChat(store, address, {
      workDir: oldWorkDir,
      name: '运行中的旧会话',
    });
    const target = store.createSession('目标 Kimi 会话', 'k3', undefined, newWorkDir, 'normal', {
      activeRuntime: 'kimi',
    });
    store.updateSession(target.id, {
      runtime_status: 'idle',
      runtime: {
        activeRuntime: 'kimi',
        kimi: {
          sessionId: 'session_attach_confirm_target',
          cwd: newWorkDir,
          provider: 'tmux',
        },
      },
    });
    store.updateSession(binding.bridgeSessionId, {
      runtime_status: 'running',
      health_status: 'running_active',
    });

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${target.id}`, 'incoming-attach-confirm-prompt'));
      assert.match(adapter.sent.at(-1)?.text || '', /确认停止并切换会话/);
      assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, binding.bridgeSessionId);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '否', 'incoming-attach-confirm-cancel'));
      assert.match(adapter.sent.at(-1)?.text || '', /已取消接管/);
      assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, binding.bridgeSessionId);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime_status, 'running');

      await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${target.id}`, 'incoming-attach-confirm-prompt-2'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '是', 'incoming-attach-confirm-yes'));

      const attached = store.getChannelChat(address.channelType, address.chatId);
      assert.equal(attached?.bridgeSessionId, target.id);
      assert.equal(attached?.runtimeBridgeSessionIds?.codex, binding.bridgeSessionId);
      assert.equal(attached?.runtimeBridgeSessionIds?.kimi, target.id);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime_status, 'idle');
      assert.match(adapter.sent.at(-1)?.text || '', /已切换到 Bridge 会话/);
    } finally {
      fs.rmSync(oldWorkDir, { recursive: true, force: true });
      fs.rmSync(newWorkDir, { recursive: true, force: true });
    }
  });

  it('keeps the active runtime and remembered alternate runtime when /clear follows a runtime switch', async () => {
    writeHomeConfigToml(`
schema_version = 2

[runtime.codex]
provider = "sdk"

[runtime.claude]
provider = "sdk"
`);
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-clear-runtime-switch' } as const;
    const oldWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-runtime-old-'));
    const newWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-runtime-new-'));
    const { binding: codexBinding } = createExistingChannelChat(store, address, {
      workDir: oldWorkDir,
      name: 'Codex 保留',
    });

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime claude', 'incoming-clear-runtime-claude'));
      const oldClaudeBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(oldClaudeBinding);
      assert.notEqual(oldClaudeBinding.bridgeSessionId, codexBinding.bridgeSessionId);
      const oldClaudeSessionId = oldClaudeBinding.bridgeSessionId;
      setSessionClaudeProviderToml(oldClaudeBinding.bridgeSessionId, 'tmux');

      await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear Claude新上下文 ${newWorkDir}`, 'incoming-clear-runtime'));
      const newClaudeBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(newClaudeBinding);
      assert.notEqual(newClaudeBinding.bridgeSessionId, oldClaudeSessionId);
      assert.equal(newClaudeBinding.runtimeBridgeSessionIds?.codex, codexBinding.bridgeSessionId);
      assert.equal(newClaudeBinding.runtimeBridgeSessionIds?.claude, newClaudeBinding.bridgeSessionId);
      const newClaudeSession = store.getSession(newClaudeBinding.bridgeSessionId);
      assert.equal(getSessionActiveRuntime(newClaudeSession), 'claude');
      assert.equal(newClaudeSession?.name, 'Claude新上下文');
      assert.equal(getSessionWorkingDirectory(newClaudeSession), newWorkDir);
      assert.equal(getSessionClaudeProviderToml(newClaudeBinding.bridgeSessionId), 'tmux');
      assert.equal(getSessionTmuxAutoEnterToml(newClaudeBinding.bridgeSessionId), true);
      assert.match(adapter.sent.at(-1)?.text || '', /Runtime.*claude|模式.*normal/s);
      assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux/s);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime codex', 'incoming-clear-runtime-codex'));
      const restoredCodexBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(restoredCodexBinding);
      assert.equal(restoredCodexBinding.bridgeSessionId, codexBinding.bridgeSessionId);
      assert.equal(store.getSession(restoredCodexBinding.bridgeSessionId)?.name, 'Codex 保留');
    } finally {
      fs.rmSync(oldWorkDir, { recursive: true, force: true });
      fs.rmSync(newWorkDir, { recursive: true, force: true });
    }
  });

  it('starts tmux provider with current permissions and routes tmux-provider messages through the bridge entrypoint', async () => {
    writeHomeConfigToml(`
schema_version = 2

[runtime.codex]
model = "test-model"
`);
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-e2e-'));

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime',
      });
      const normalThreadId = '019e46bc-f466-71d3-a186-a2ce89051958';
      const normalTmuxSession = `codex_${normalThreadId}`;
      store.updateSessionCodexThreadId(binding.bridgeSessionId, normalThreadId);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/sandbox read-only', 'incoming-runtime-sandbox'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/network on', 'incoming-runtime-network'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/r minimal', 'incoming-runtime-reasoning-minimal'));
      assert.match(adapter.sent.at(-1)?.text || '', /已更新思考级别/);
      assert.match(adapter.sent.at(-1)?.text || '', /禁用 web search/);
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/r ultra', 'incoming-runtime-reasoning'));
      const beforeProviderSentCount = adapter.sent.length;
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-runtime-provider'));
      const providerMessages = adapter.sent.slice(beforeProviderSentCount).map((message) => message.text).join('\n\n');
      assert.doesNotMatch(providerMessages, /正在启动 tmux 后台会话/);
      assert.match(providerMessages, /已切换 Codex Provider/);

      const tmuxSession = store.getSession(binding.bridgeSessionId);
      assert.equal(tmuxSession?.runtime?.codex?.provider, undefined);
      assert.equal(getSessionCodexProviderToml(binding.bridgeSessionId), 'tmux');
      assert.equal(tmuxSession?.runtime?.general?.tmuxSessionName, normalTmuxSession);
      assert.equal(tmuxSession?.runtime?.general?.autoEnter, undefined);
      assert.equal(getSessionTmuxAutoEnterToml(binding.bridgeSessionId), true);
      assert.equal(tmuxSession?.runtime?.codex?.threadId, normalThreadId);

      const startLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(startLog, new RegExp(`has-session -t ${normalTmuxSession}`));
      assert.match(startLog, new RegExp(`new-session -d -s ${normalTmuxSession}`));
      assert.match(startLog, /-- .*codelark-shell-snapshot-[^ \n]+\.sh.*(?:\S+\/)?(?:codex|codelark-codex-[a-f0-9]+\.sh) --model test-model --sandbox read-only/);
      assert.match(startLog, /2> .*codelark-codex-tmux-.*\.log/);
      assert.doesNotMatch(startLog, /-- env .* codex/);
      assert.doesNotMatch(startLog, / new-session .* -e /);
      assert.match(startLog, new RegExp(`--cd ${workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(startLog, /--ask-for-approval on-request/);
      assert.match(startLog, /model_reasoning_effort="ultra"/);
      assert.match(startLog, /--config sandbox_workspace_write.network_access=true/);
      assert.match(startLog, new RegExp(`resume ${normalThreadId}`));

      const beforeRestartLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/provider tmux', 'incoming-runtime-provider-restart'));
      const restartResponse = adapter.sent.at(-1)?.text || '';
      const restartLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeRestartLog.length);
      assert.match(restartResponse, /同名 tmux session 已存在/);
      assert.match(restartResponse, /销毁并重新启动/);
      assert.match(restartLog, new RegExp(`has-session -t ${normalTmuxSession}`));
      assert.match(restartLog, new RegExp(`kill-session -t ${normalTmuxSession}`));
      assert.match(restartLog, new RegExp(`new-session -d -s ${normalTmuxSession}`));
      assert.match(restartLog, new RegExp(`resume ${normalThreadId}`));

      const beforeRoutingLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '普通消息', 'incoming-runtime-plain'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/goal 检查权限', 'incoming-runtime-unknown-command'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '//plan 下一步', 'incoming-runtime-escaped-command'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/tmux /compact', 'incoming-runtime-tmux-command'));

      const unknownCommandResponse = adapter.sent.find((message) => message.text.includes('未知命令：/goal'))?.text || '';
      assert.match(unknownCommandResponse, /未知命令：\/goal/);
      assert.match(unknownCommandResponse, /Agent.*\/\/goal.*\/goal/s);
      const routedLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeRoutingLog.length);
      assert.match(routedLog, new RegExp(`paste-buffer -d -p -b clk-paste-[^ ]+ -t ${normalTmuxSession}`));
      assert.doesNotMatch(routedLog, new RegExp(`send-keys -t ${normalTmuxSession} -l /goal 检查权限`));
      assert.ok((routedLog.match(new RegExp(`paste-buffer -d -p -b clk-paste-[^ ]+ -t ${normalTmuxSession}`, 'g')) || []).length >= 2);
      assert.match(routedLog, new RegExp(`send-keys -t ${normalTmuxSession} -l /compact`));
      assert.ok((routedLog.match(new RegExp(`send-keys -t ${normalTmuxSession} Enter`, 'g')) || []).length >= 3);
      assert.ok(readAuditSummaries().some((summary) => (
        summary.includes('terminal append tmux input actions completed')
          && summary.includes('runtime=codex')
          && summary.includes('provider=tmux')
      )));
      assert.equal(store.getSession(binding.bridgeSessionId)?.health_status, 'running_active');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/clear tmux-mid-turn', 'incoming-runtime-clear-mid-turn'));
      assert.match(adapter.sent.at(-1)?.text || '', /确认清空当前对话/);
      assert.match(adapter.sent.at(-1)?.text || '', /mirror\/健康状态显示仍在运行/);
      assert.equal(adapter.sent.at(-1)?.richCard?.title, '确认清空当前对话');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/clear-cancel', 'incoming-runtime-clear-mid-turn-cancel'));
      assert.match(adapter.sent.at(-1)?.text || '', /已取消 \/clear/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/mode yolo', 'incoming-runtime-defer-mode'));
      assert.match(adapter.sent.at(-1)?.text || '', /已切换模式，请输入\/p tmux重启生效/);
      assert.match(adapter.sent.at(-1)?.text || '', /配置已保存/);
      assert.match(adapter.sent.at(-1)?.text || '', /不会影响已经启动的 Codex TUI/);
      assert.match(adapter.sent.at(-1)?.text || '', /\/p tmux/);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.mode, undefined);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.yoloMode', {
          kind: 'session',
          sessionId: binding.bridgeSessionId,
        }),
        'on',
      );

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/net off', 'incoming-runtime-defer-network'));
      assert.match(adapter.sent.at(-1)?.text || '', /已更新 Codex 网络/);
      assert.match(adapter.sent.at(-1)?.text || '', /重启后的后续请求中生效/);
      assert.notEqual(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.networkAccess, false);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.networkAccess', {
          kind: 'session',
          sessionId: binding.bridgeSessionId,
        }),
        false,
      );

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/r minimal', 'incoming-runtime-defer-reasoning'));
      assert.match(adapter.sent.at(-1)?.text || '', /已更新思考级别/);
      assert.match(adapter.sent.at(-1)?.text || '', /配置已保存/);
      assert.notEqual(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.reasoningEffort, 'minimal');
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.reasoningEffort', {
          kind: 'session',
          sessionId: binding.bridgeSessionId,
        }),
        'minimal',
      );

      store.updateSession(binding.bridgeSessionId, { runtime: { codex: { model: 'old-model' } } });
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/model default', 'incoming-runtime-defer-model'));
      assert.match(adapter.sent.at(-1)?.text || '', /已恢复默认模型/);
      assert.match(adapter.sent.at(-1)?.text || '', /配置已保存/);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.model, 'old-model');
      assert.notEqual(
        createConfigService({ migrate: false, env: {} }).resolve('runtime.codex.model', {
          kind: 'session',
          sessionId: binding.bridgeSessionId,
        }).source,
        'session',
      );

      const beforeStopLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/stop', 'incoming-runtime-stop-tmux-mid-turn'));
      const stopLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeStopLog.length);
      assert.match(adapter.sent.at(-1)?.text || '', /已发送停止按键/);
      assert.match(stopLog, new RegExp(`send-keys -t ${normalTmuxSession} C-c`));
      assert.equal(store.getSession(binding.bridgeSessionId)?.health_status, 'aborted');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p sdk', 'incoming-runtime-provider-sdk'));
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, undefined);
      assert.equal(getSessionCodexProviderToml(binding.bridgeSessionId), 'sdk');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/m yolo', 'incoming-runtime-mode-yolo'));
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.mode, undefined);
      assert.equal(
        createConfigService({ migrate: false, env: {} }).get('runtime.codex.yoloMode', {
          kind: 'session',
          sessionId: binding.bridgeSessionId,
        }),
        'on',
      );

      const yoloThreadId = '019e46bc-f466-71d3-a186-a2ce89051959';
      const yoloTmuxSession = `codex_${yoloThreadId}`;
      store.updateSessionCodexThreadId(binding.bridgeSessionId, yoloThreadId);
      const beforeYoloLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/provider tmux', 'incoming-runtime-provider-tmux-yolo'));
      const yoloLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeYoloLog.length);
      assert.match(yoloLog, new RegExp(`new-session -d -s ${yoloTmuxSession}`));
      assert.match(yoloLog, /-- .*codelark-shell-snapshot-[^ \n]+\.sh.*(?:\S+\/)?(?:codex|codelark-codex-[a-f0-9]+\.sh) --model test-model --dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(yoloLog, /-- env .* codex/);
      assert.doesNotMatch(yoloLog, / new-session .* -e /);
      assert.doesNotMatch(yoloLog, /--sandbox/);
      assert.doesNotMatch(yoloLog, /--ask-for-approval/);
      assert.match(yoloLog, new RegExp(`resume ${yoloThreadId}`));

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/', 'incoming-runtime-status'));
      const statusText = adapter.sent.at(-1)?.text || '';
      assert.match(statusText, /当前会话/);
      assert.match(statusText, /yolo/);
      assert.match(statusText, /tmux/);
      assert.match(statusText, /read-only/);
      assert.match(statusText, /disabled/);
      assert.match(statusText, /当前聊天正在使用 IM 会话/);
      assert.doesNotMatch(statusText, /当前聊天已绑定到一条共享会话/);
      assert.doesNotMatch(statusText, /还没有绑定本地 Codex 会话/);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      await cleanupFakeTmux(fakeTmux);
    }
  });

  it('does not let the Codex tmux provider intercept plain messages after switching to Claude runtime', async () => {
    writeHomeConfigToml(`
schema_version = 2

[runtime.codex]
provider = "tmux"
`);
    const calls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: createRecordingLlm(calls),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-claude-tmux-default' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-tmux-default-'));

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-claude',
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime claude', 'incoming-runtime-claude'));
      const claudeBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(claudeBinding);
      assert.notEqual(claudeBinding.bridgeSessionId, binding.bridgeSessionId);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.activeRuntime, 'claude');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p sdk', 'incoming-provider-claude-sdk'));
      assert.equal(getSessionClaudeProviderToml(claudeBinding.bridgeSessionId), 'sdk');

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'hi', 'incoming-runtime-claude-plain'));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].runtime, 'claude');
      assert.equal(calls[0].sessionId, claudeBinding.bridgeSessionId);
      assert.equal(calls[0].prompt, 'hi');
      assert.equal(calls[0].codexProvider, 'tmux');
      assert.equal(calls[0].codexThreadId, '');
      assert.match(adapter.sent.at(-1)?.text || '', /回复：hi/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('routes plain messages into Claude tmux when the active Claude provider is tmux', async () => {
    const calls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: createRecordingLlm(calls),
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-claude-tmux-forward' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-tmux-forward-'));
    const tmuxSessionName = 'claude_bridge_session';

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-claude-tmux',
      });
      fs.writeFileSync(fakeTmux.statePath, `${tmuxSessionName}\n`, 'utf-8');
      store.updateSession(binding.bridgeSessionId, {
        runtime: {
          activeRuntime: 'claude',
          claude: { provider: 'tmux' },
          general: { tmuxSessionName },
        },
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'hello claude tmux', 'incoming-claude-tmux-plain'));

      assert.equal(calls.length, 0);
      const tmuxLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(tmuxLog, new RegExp(`send-keys -t ${tmuxSessionName} -l hello claude tmux`));
      assert.match(tmuxLog, new RegExp(`send-keys -t ${tmuxSessionName} Enter`));
      assert.ok(readAuditSummaries().some((summary) => (
        summary.includes('terminal append tmux input actions completed')
          && summary.includes('runtime=claude')
          && summary.includes('provider=tmux')
      )));
      assert.equal(store.getSession(binding.bridgeSessionId)?.health_status, 'running_active');

      const beforeFollowUpLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, 'follow up claude tmux', 'incoming-claude-tmux-follow-up'));
      const followUpLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeFollowUpLog.length);
      assert.match(followUpLog, new RegExp(`has-session -t ${tmuxSessionName}`));
      assert.match(followUpLog, new RegExp(`send-keys -t ${tmuxSessionName} -l follow up claude tmux`));
      assert.doesNotMatch(followUpLog, /new-session|\bresume\b/, 'a running follow-up must not relaunch the provider process');
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      fs.rmSync(workDir, { recursive: true, force: true });
      await cleanupFakeTmux(fakeTmux);
    }
  });

  it('notifies the chat instead of forwarding when a Claude tmux pane is dead', async () => {
    const calls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: createRecordingLlm(calls),
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    const oldCaptureText = process.env.TMUX_FAKE_CAPTURE_TEXT;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;
    process.env.TMUX_FAKE_CAPTURE_TEXT = [
      '/bin/bash: line 1: exec: claude: not found',
      '',
      '[exited]',
      'Pane is dead (status 127, Thu Jul  2 22:01:28 2026)',
    ].join('\\n');

    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-claude-tmux-dead' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-tmux-dead-'));
    const tmuxSessionName = 'claude_dead_session';

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-claude-tmux-dead',
      });
      fs.writeFileSync(fakeTmux.statePath, `${tmuxSessionName}\n`, 'utf-8');
      store.updateSession(binding.bridgeSessionId, {
        runtime: {
          activeRuntime: 'claude',
          claude: { provider: 'tmux' },
          general: { tmuxSessionName },
        },
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'do not lose this', 'incoming-claude-tmux-dead'));

      assert.equal(calls.length, 0);
      assert.equal(adapter.sent.length, 1);
      const responseText = adapter.sent[0]?.text || '';
      assert.match(responseText, /Claude Code tmux Provider pane 已退出（exit 127）/);
      assert.match(responseText, /未发送 auto-forward 消息/);
      assert.match(responseText, /exec: claude: not found/);
      assert.match(responseText, /\/p tmux/);
      const tmuxLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(tmuxLog, new RegExp(`capture-pane -t ${tmuxSessionName}:0.0 -p -S -80`));
      assert.doesNotMatch(tmuxLog, /send-keys .*do not lose this/);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      if (oldCaptureText === undefined) delete process.env.TMUX_FAKE_CAPTURE_TEXT;
      else process.env.TMUX_FAKE_CAPTURE_TEXT = oldCaptureText;
      fs.rmSync(workDir, { recursive: true, force: true });
      await cleanupFakeTmux(fakeTmux);
    }
  });

  it('auto-initializes a Claude tmux provider binding on the first plain message', async () => {
    const calls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: createRecordingLlm(calls),
    });
    const fakeTmux = installFakeTmux();
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-tmux-auto-home-'));
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    const oldClaudeHome = process.env.CODELARK_CLAUDE_HOME;
    const oldDiscoveryTimeout = process.env.CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;
    process.env.CODELARK_CLAUDE_HOME = claudeHome;
    process.env.CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS = '1000';

    const adapter = new StreamingRecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-claude-tmux-auto-init' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-tmux-auto-init-'));
    const claudeSessionId = 'claude-tmux-auto-jsonl-session';
    let transcriptPath = '';

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-claude-tmux-auto-init',
      });
      store.updateSession(binding.bridgeSessionId, {
        runtime: {
          activeRuntime: 'claude',
        },
      });
      setSessionClaudeProviderToml(binding.bridgeSessionId, 'tmux');

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'first claude tmux', 'incoming-claude-tmux-auto-init-plain'));
      transcriptPath = appendClaudeMirrorTurn({
        homeDir: claudeHome,
        cwd: workDir,
        sessionId: claudeSessionId,
        timestampPrefix: '2026-06-02T05:10',
        userText: 'first claude tmux',
        assistantText: 'Claude tmux auto response',
      });

      await waitForMirrorCondition(() => adapter.streamEvents.some((event) => (
        event.kind === 'end'
        && event.streamKey?.startsWith('mirror:')
        && /Claude tmux auto response/.test(event.text || '')
      )), 3000);

      assert.equal(calls.length, 0);
      const expectedTmuxSessionName = `claude_${binding.bridgeSessionId}`;
      const session = store.getSession(binding.bridgeSessionId);
      assert.equal(session?.runtime?.general?.tmuxSessionName, expectedTmuxSessionName);
      assert.equal(session?.runtime?.claude?.provider, 'tmux');
      assert.equal(session?.runtime?.claude?.sessionId, claudeSessionId);
      assert.equal(session?.runtime?.claude?.cwd, workDir);
      assert.equal(getSessionTmuxAutoEnterToml(binding.bridgeSessionId), true);
      assert.equal(session?.mirror_status, 'watching');
      const tmuxLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(tmuxLog, new RegExp(`has-session -t ${expectedTmuxSessionName}`));
      assert.match(tmuxLog, new RegExp(`new-session -d -s ${expectedTmuxSessionName}`));
      assert.match(tmuxLog, new RegExp(`send-keys -t ${expectedTmuxSessionName} -l first claude tmux`));
      assert.match(tmuxLog, new RegExp(`send-keys -t ${expectedTmuxSessionName} Enter`));
      assert.ok(adapter.streamEvents.some((event) => (
        event.kind === 'text'
        && event.streamKey?.startsWith('mirror:')
        && /Claude tmux auto response/.test(event.text || '')
      )));
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      if (oldClaudeHome === undefined) delete process.env.CODELARK_CLAUDE_HOME;
      else process.env.CODELARK_CLAUDE_HOME = oldClaudeHome;
      if (oldDiscoveryTimeout === undefined) delete process.env.CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS;
      else process.env.CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS = oldDiscoveryTimeout;
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      if (transcriptPath) fs.rmSync(transcriptPath, { force: true });
      await cleanupFakeTmux(fakeTmux);
    }
  });

  it('auto-initializes a Kimi tmux provider binding on the first plain message', { timeout: 30_000 }, async (t: TestContext) => {
    if (!(await tmuxAvailable())) {
      t.skip('tmux is not available');
      return;
    }

    const previousEnv = {
      KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
      KIMI_CODE_EXECUTABLE: process.env.KIMI_CODE_EXECUTABLE,
      CODELARK_KIMI_EXECUTABLE: process.env.CODELARK_KIMI_EXECUTABLE,
      CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: process.env.CODELARK_KIMI_TMUX_POLL_INTERVAL_MS,
      CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS: process.env.CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS,
      CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: process.env.CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS,
      CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: process.env.CODELARK_KIMI_TMUX_PROMPT_DELAY_MS,
      CODELARK_TMUX_PROVIDER_EXIT_PROBE_DELAY_MS: process.env.CODELARK_TMUX_PROVIDER_EXIT_PROBE_DELAY_MS,
      CODELARK_DEBUG: process.env.CODELARK_DEBUG,
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-kimi-tmux-auto-init-'));
    const kimiHome = path.join(tempDir, 'kimi-home');
    const binDir = path.join(tempDir, 'bin');
    const workDir = path.join(tempDir, 'workspace');
    const ctrlCPath = path.join(tempDir, 'ctrl-c-count');
    const keyLogPath = path.join(tempDir, 'keys.jsonl');
    const launchLogPath = path.join(tempDir, 'launches.jsonl');
    const kimiSessionId = 'session_mock-kimi-plain-e2e';
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(kimiHome, { recursive: true });

    process.env.KIMI_CODE_HOME = kimiHome;
    process.env.KIMI_CODE_EXECUTABLE = writeFakeKimiExecutable(binDir, {
      sessionId: kimiSessionId,
      ctrlCPath,
      keyLogPath,
      launchLogPath,
      omitResumedSessionHeader: true,
    });
    delete process.env.CODELARK_KIMI_EXECUTABLE;
    delete process.env.CODELARK_DEBUG;
    process.env.CODELARK_KIMI_TMUX_POLL_INTERVAL_MS = '50';
    process.env.CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS = '5000';
    process.env.CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS = '5000';
    process.env.CODELARK_KIMI_TMUX_PROMPT_DELAY_MS = '50';
    process.env.CODELARK_TMUX_PROVIDER_EXIT_PROBE_DELAY_MS = '100';

    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: new CodexRoutingProvider(),
    });
    const adapter = new StreamingRecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-kimi-tmux-auto-init' } as const;

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-kimi-tmux-auto-init',
      });
      const expectedKimiSessionId = kimiSessionId;
      store.updateSession(binding.bridgeSessionId, {
        runtime: {
          activeRuntime: 'kimi',
          kimi: { provider: 'tmux' },
          general: { workingDirectory: workDir },
        },
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'first kimi tmux', 'incoming-kimi-tmux-auto-init-plain'));

      await waitForMirrorCondition(() => adapter.streamEvents.some((event) => (
        event.kind === 'end'
        && /Kimi mock-app plain response/.test(event.text || '')
      )), 12_000).catch((error) => {
        const session = store.getSession(binding.bridgeSessionId);
        assert.fail([
          error instanceof Error ? error.message : String(error),
          `kimiSessionId=${session?.runtime?.kimi?.sessionId || ''}`,
          `kimiCwd=${session?.runtime?.kimi?.cwd || ''}`,
          `streamEvents=${JSON.stringify(adapter.streamEvents)}`,
          `sent=${JSON.stringify(adapter.sent.map((message) => ({ text: message.text, richCard: message.richCard?.title })))}`,
          `launchLog=${fs.existsSync(launchLogPath) ? fs.readFileSync(launchLogPath, 'utf-8') : '<missing>'}`,
          `keyLog=${fs.existsSync(keyLogPath) ? fs.readFileSync(keyLogPath, 'utf-8') : '<missing>'}`,
        ].join('\n'));
      });

      const session = store.getSession(binding.bridgeSessionId);
      assert.equal(session?.runtime?.activeRuntime, 'kimi');
      assert.equal(session?.runtime?.kimi?.provider, 'tmux');
      assert.equal(session?.runtime?.kimi?.sessionId, expectedKimiSessionId);
      assert.equal(session?.runtime?.kimi?.cwd, workDir);
      assert.equal(session?.mirror_status, 'watching');
      assert.equal(fs.existsSync(ctrlCPath), false, 'fresh Kimi startup must not kill the initial TUI to discover its session id');

      const keyLog = fs.readFileSync(keyLogPath, 'utf-8');
      assert.match(keyLog, /first kimi tmux/);
      assert.match(keyLog, /"hex":"0d"/, 'fresh Kimi input should submit with Enter');
      assert.match(keyLog, /"hex":"13"/, 'fresh Kimi input should immediately follow Enter with Ctrl-S');
      assert.ok(adapter.streamEvents.some((event) => (
        event.kind === 'status'
        && /当前思考：mock kimi thinking/.test(event.text || '')
      )));

      const launches = fs.readFileSync(launchLogPath, 'utf-8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { argv: string[]; resumed: boolean; cwd: string });
      assert.deepEqual(launches[0]?.argv, ['-y']);
      assert.equal(launches[0]?.resumed, false);
      assert.equal(launches[0]?.cwd, workDir);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '<C-c>', 'incoming-kimi-first-ctrl-c'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '<C-c>', 'incoming-kimi-second-ctrl-c'));
      await waitForCondition(() => fs.existsSync(ctrlCPath) && fs.readFileSync(ctrlCPath, 'utf8') === '2', 5_000);
      await waitForCondition(() => {
        const sessionAfterExit = store.getSession(binding.bridgeSessionId);
        return getSessionRuntimeTmuxSessionName(sessionAfterExit) === undefined;
      }, 5_000);

      const exitedSession = store.getSession(binding.bridgeSessionId);
      assert.equal(exitedSession?.health_status, 'failed');
      assert.match(exitedSession?.health_reason || '', /disappeared .* after auto-forward input/);
      assert.ok(adapter.sent.some((message) => /Kimi tmux Provider 会话已退出/.test(message.text || '')));

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-kimi-provider-restart'));
      const restartedSession = store.getSession(binding.bridgeSessionId);
      assert.equal(getSessionRuntimeTmuxSessionName(restartedSession), `clk-kimi-${binding.bridgeSessionId}`);
      const restartedLaunches = fs.readFileSync(launchLogPath, 'utf-8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { argv: string[]; resumed: boolean; cwd: string });
      assert.equal(restartedLaunches.length, 2);
      assert.deepEqual(restartedLaunches[1]?.argv, ['-r', expectedKimiSessionId, '-y']);
      assert.equal(restartedLaunches[1]?.resumed, true);

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'prompt after Kimi restart', 'incoming-kimi-after-restart'));
      await waitForCondition(() => fs.readFileSync(keyLogPath, 'utf-8').includes('prompt after Kimi restart'), 5_000);

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'runtime command kimi follow-up', 'incoming-kimi-runtime-message-follow-up'));
      await waitForMirrorCondition(() => adapter.streamEvents.some((event) => (
        event.kind === 'end'
        && event.streamKey?.startsWith('mirror:')
        && event.status === 'completed'
        && /Kimi mock-app continued response 2/.test(event.text || '')
      )), 12_000);

      await _testOnly.reconcileMirrorSubscriptions();
      assert.equal(bridgeState.kimiMirrorSubscriptions.get(binding.id)?.pendingTurn, null);
      assert.deepEqual(
        adapter.streamEvents.filter((event) => event.kind === 'mirror_start').map((event) => event.streamKey).sort(),
        adapter.streamEvents.filter((event) => event.kind === 'end' && event.streamKey?.startsWith('mirror:')).map((event) => event.streamKey).sort(),
      );

      const launchesAfterFollowUp = fs.readFileSync(launchLogPath, 'utf-8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { argv: string[]; resumed: boolean; cwd: string });
      assert.equal(launchesAfterFollowUp.length, 2, 'the follow-up must reuse the restarted Kimi tmux process');
      const followUpKeyLog = fs.readFileSync(keyLogPath, 'utf-8');
      assert.match(followUpKeyLog, /runtime command kimi follow-up/);
    } finally {
      const activeBinding = store.getChannelChat(address.channelType, address.chatId);
      if (activeBinding) {
        await execFileAsync('tmux', ['kill-session', '-t', `clk-kimi-${activeBinding.bridgeSessionId}`]).catch(() => {});
      }
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('routes plain Feishu messages through Kimi after /runtime kimi and /p tmux', { timeout: 30_000 }, async (t: TestContext) => {
    if (!(await tmuxAvailable())) {
      t.skip('tmux is not available');
      return;
    }

    const previousEnv = {
      KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
      KIMI_CODE_EXECUTABLE: process.env.KIMI_CODE_EXECUTABLE,
      CODELARK_KIMI_EXECUTABLE: process.env.CODELARK_KIMI_EXECUTABLE,
      CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: process.env.CODELARK_KIMI_TMUX_POLL_INTERVAL_MS,
      CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS: process.env.CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS,
      CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: process.env.CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS,
      CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: process.env.CODELARK_KIMI_TMUX_PROMPT_DELAY_MS,
      CODELARK_DEBUG: process.env.CODELARK_DEBUG,
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-kimi-command-message-'));
    const kimiHome = path.join(tempDir, 'kimi-home');
    const binDir = path.join(tempDir, 'bin');
    const workDir = path.join(tempDir, 'workspace');
    const ctrlCPath = path.join(tempDir, 'ctrl-c-count');
    const keyLogPath = path.join(tempDir, 'keys.jsonl');
    const launchLogPath = path.join(tempDir, 'launches.jsonl');
    const kimiSessionId = 'session_mock-kimi-runtime-message-e2e';
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(kimiHome, { recursive: true });

    process.env.KIMI_CODE_HOME = kimiHome;
    process.env.KIMI_CODE_EXECUTABLE = writeFakeKimiExecutable(binDir, {
      sessionId: kimiSessionId,
      ctrlCPath,
      keyLogPath,
      launchLogPath,
    });
    delete process.env.CODELARK_KIMI_EXECUTABLE;
    delete process.env.CODELARK_DEBUG;
    process.env.CODELARK_KIMI_TMUX_POLL_INTERVAL_MS = '50';
    process.env.CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS = '5000';
    process.env.CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS = '5000';
    process.env.CODELARK_KIMI_TMUX_PROMPT_DELAY_MS = '50';

    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: new CodexRoutingProvider(),
    });
    const adapter = new StreamingRecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-kimi-command-message' } as const;

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-kimi-command-message',
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime kimi', 'incoming-kimi-runtime-command'));
      assert.match(adapter.sent.at(-1)?.text || '', /已创建并切换 Runtime|已切换 Runtime/s);
      assert.match(adapter.sent.at(-1)?.text || '', /Runtime.*kimi/s);
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-kimi-provider-command'));
      assert.match(adapter.sent.at(-1)?.text || '', /当前 Kimi Provider|已设置.*tmux|tmux/s);

      const currentBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(currentBinding);
      const expectedKimiSessionId = kimiSessionId;
      assert.notEqual(currentBinding.bridgeSessionId, binding.bridgeSessionId);
      const configuredSession = store.getSession(currentBinding.bridgeSessionId);
      assert.equal(configuredSession?.runtime?.activeRuntime, 'kimi');
      assert.equal(getSessionKimiProviderToml(currentBinding.bridgeSessionId), 'tmux');
      assert.equal(getSessionWorkingDirectory(configuredSession), workDir);

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'runtime command kimi prompt', 'incoming-kimi-runtime-message-plain'));

      await waitForMirrorCondition(() => adapter.streamEvents.some((event) => (
        event.kind === 'end'
        && event.streamKey?.startsWith('mirror:')
        && event.status === 'completed'
        && /Kimi mock-app plain response/.test(event.text || '')
      )), 12_000).catch((error) => {
        const activeBinding = store.getChannelChat(address.channelType, address.chatId);
        const session = activeBinding ? store.getSession(activeBinding.bridgeSessionId) : undefined;
        assert.fail([
          error instanceof Error ? error.message : String(error),
          `kimiSessionId=${session?.runtime?.kimi?.sessionId || ''}`,
          `activeRuntime=${session?.runtime?.activeRuntime || ''}`,
          `streamEvents=${JSON.stringify(adapter.streamEvents)}`,
          `sent=${JSON.stringify(adapter.sent.map((message) => ({ text: message.text, richCard: message.richCard?.title })))}`,
          `launchLog=${fs.existsSync(launchLogPath) ? fs.readFileSync(launchLogPath, 'utf-8') : '<missing>'}`,
          `keyLog=${fs.existsSync(keyLogPath) ? fs.readFileSync(keyLogPath, 'utf-8') : '<missing>'}`,
        ].join('\n'));
      });

      const activeBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(activeBinding);
      const updatedSession = store.getSession(activeBinding.bridgeSessionId);
      assert.equal(updatedSession?.runtime?.activeRuntime, 'kimi');
      assert.equal(getSessionKimiProviderToml(activeBinding.bridgeSessionId), 'tmux');
      assert.equal(updatedSession?.runtime?.kimi?.sessionId, expectedKimiSessionId);
      assert.equal(updatedSession?.runtime?.kimi?.cwd, workDir);
      assert.equal(updatedSession?.mirror_status, 'watching');
      await _testOnly.reconcileMirrorSubscriptions();
      assert.equal(bridgeState.kimiMirrorSubscriptions.get(currentBinding.id)?.pendingTurn, null);
      assert.deepEqual(
        adapter.streamEvents.filter((event) => event.kind === 'mirror_start').map((event) => event.streamKey).sort(),
        adapter.streamEvents.filter((event) => event.kind === 'end' && event.streamKey?.startsWith('mirror:')).map((event) => event.streamKey).sort(),
      );

      const keyLog = fs.readFileSync(keyLogPath, 'utf-8');
      assert.match(keyLog, /runtime command kimi prompt/);
      assert.match(keyLog, /"hex":"13"/, 'Kimi tmux provider should send Ctrl-S after /runtime + /p seeded prompt');
      assert.ok(adapter.streamEvents.some((event) => (
        event.kind === 'status'
        && event.streamKey?.startsWith('mirror:')
        && /当前思考：mock kimi thinking/.test(event.text || '')
      )));

      const launches = fs.readFileSync(launchLogPath, 'utf-8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { argv: string[]; resumed: boolean; cwd: string });
      assert.deepEqual(launches[0]?.argv, ['-y']);
      assert.equal(launches[0]?.resumed, false);
      assert.equal(launches[0]?.cwd, workDir);
    } finally {
      const activeBinding = store.getChannelChat(address.channelType, address.chatId);
      if (activeBinding) {
        await execFileAsync('tmux', ['kill-session', '-t', `clk-kimi-${activeBinding.bridgeSessionId}`]).catch(() => {});
      }
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('continues a /t-bound Kimi Code session on the next plain Feishu message', { timeout: 30_000 }, async (t: TestContext) => {
    if (!(await tmuxAvailable())) {
      t.skip('tmux is not available');
      return;
    }

    const previousEnv = {
      KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
      KIMI_CODE_EXECUTABLE: process.env.KIMI_CODE_EXECUTABLE,
      CODELARK_KIMI_EXECUTABLE: process.env.CODELARK_KIMI_EXECUTABLE,
      CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: process.env.CODELARK_KIMI_TMUX_POLL_INTERVAL_MS,
      CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS: process.env.CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS,
      CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: process.env.CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS,
      CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: process.env.CODELARK_KIMI_TMUX_PROMPT_DELAY_MS,
      CODELARK_DEBUG: process.env.CODELARK_DEBUG,
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-kimi-tmux-bound-'));
    const kimiHome = path.join(tempDir, 'kimi-home');
    const binDir = path.join(tempDir, 'bin');
    const workDir = path.join(tempDir, 'workspace');
    const keyLogPath = path.join(tempDir, 'keys.jsonl');
    const launchLogPath = path.join(tempDir, 'launches.jsonl');
    const kimiSessionId = 'session_mock-kimi-bound-e2e';
    const responseText = 'Kimi /t bound response';
    const thinkText = 'mock kimi bound thinking';
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(kimiHome, { recursive: true });

    process.env.KIMI_CODE_HOME = kimiHome;
    const wirePath = writeKimiWireFixture({
      homeDir: kimiHome,
      cwd: workDir,
      sessionId: kimiSessionId,
      timestamp: '2026-06-27T10:15:00.000Z',
      text: 'existing Kimi /t prompt',
      assistantText: 'existing Kimi /t answer',
      title: 'Existing Kimi /t session',
    });
    process.env.KIMI_CODE_EXECUTABLE = writeResumeOnlyFakeKimiExecutable(binDir, {
      sessionId: kimiSessionId,
      wirePath,
      keyLogPath,
      launchLogPath,
      responseText,
      thinkText,
    });
    delete process.env.CODELARK_KIMI_EXECUTABLE;
    delete process.env.CODELARK_DEBUG;
    process.env.CODELARK_KIMI_TMUX_POLL_INTERVAL_MS = '50';
    process.env.CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS = '5000';
    process.env.CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS = '5000';
    process.env.CODELARK_KIMI_TMUX_PROMPT_DELAY_MS = '50';

    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: new CodexRoutingProvider(),
    });
    const adapter = new StreamingRecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-kimi-tmux-bound' } as const;

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${kimiSessionId}`, 'incoming-kimi-bound-thread'));
      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      const session = store.getSession(binding.bridgeSessionId);
      assert.equal(session?.runtime?.activeRuntime, 'kimi');
      assert.equal(session?.runtime?.kimi?.provider, 'tmux');
      assert.equal(session?.runtime?.kimi?.sessionId, kimiSessionId);
      assert.equal(session?.runtime?.kimi?.cwd, workDir);
      assert.match(adapter.sent.at(-1)?.text || '', /已切换到本地 Kimi Code 会话/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'continue bound kimi', 'incoming-kimi-bound-plain'));

      await waitForMirrorCondition(() => adapter.streamEvents.some((event) => (
        event.kind === 'end'
        && event.streamKey?.startsWith('mirror:')
        && event.status === 'completed'
        && new RegExp(responseText).test(event.text || '')
      )), 12_000).catch((error) => {
        assert.fail([
          error instanceof Error ? error.message : String(error),
          `streamEvents=${JSON.stringify(adapter.streamEvents)}`,
          `sent=${JSON.stringify(adapter.sent.map((message) => ({ text: message.text, richCard: message.richCard?.title })))}`,
          `launchLog=${fs.existsSync(launchLogPath) ? fs.readFileSync(launchLogPath, 'utf-8') : '<missing>'}`,
          `keyLog=${fs.existsSync(keyLogPath) ? fs.readFileSync(keyLogPath, 'utf-8') : '<missing>'}`,
          `wire=${fs.readFileSync(wirePath, 'utf-8')}`,
        ].join('\n'));
      });

      const updatedSession = store.getSession(binding.bridgeSessionId);
      assert.equal(updatedSession?.runtime?.activeRuntime, 'kimi');
      assert.equal(updatedSession?.runtime?.kimi?.sessionId, kimiSessionId);
      assert.equal(updatedSession?.runtime?.kimi?.cwd, workDir);
      assert.equal(updatedSession?.mirror_status, 'watching');
      await _testOnly.reconcileMirrorSubscriptions();
      assert.equal(bridgeState.kimiMirrorSubscriptions.get(binding.id)?.pendingTurn, null);
      assert.deepEqual(
        adapter.streamEvents.filter((event) => event.kind === 'mirror_start').map((event) => event.streamKey).sort(),
        adapter.streamEvents.filter((event) => event.kind === 'end' && event.streamKey?.startsWith('mirror:')).map((event) => event.streamKey).sort(),
      );

      const launches = fs.readFileSync(launchLogPath, 'utf-8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { argv: string[]; resumed: boolean; cwd: string });
      assert.equal(launches.length, 1);
      assert.deepEqual(launches[0]?.argv.slice(0, 2), ['-r', kimiSessionId]);
      assert.equal(launches[0]?.resumed, true);
      assert.equal(launches[0]?.cwd, workDir);

      const keyLog = fs.readFileSync(keyLogPath, 'utf-8');
      assert.match(keyLog, /continue bound kimi/);
      assert.match(keyLog, /"hex":"0d"/, 'a newly resumed idle Kimi session should submit with Enter');
      assert.match(keyLog, /"hex":"13"/, 'a newly resumed Kimi session should immediately steer with Ctrl-S');
      assert.ok(adapter.streamEvents.some((event) => (
        event.kind === 'status'
        && event.streamKey?.startsWith('mirror:')
        && /当前思考：mock kimi bound thinking/.test(event.text || '')
      )));
      assert.equal(adapter.streamEvents.some((event) => (
        event.kind === 'end'
        && event.streamKey?.startsWith('im:')
        && new RegExp(responseText).test(event.text || '')
      )), false);
      assert.equal(adapter.streamEvents.some((event) => (
        event.kind === 'end'
        && /mock kimi bound thinking/.test(event.text || '')
      )), false);
      assert.match(fs.readFileSync(wirePath, 'utf-8'), new RegExp(responseText));
    } finally {
      const activeBinding = store.getChannelChat(address.channelType, address.chatId);
      if (activeBinding) {
        await execFileAsync('tmux', ['kill-session', '-t', `clk-kimi-${activeBinding.bridgeSessionId}`]).catch(() => {});
      }
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('delivers Kimi mirror clk-ask output as a Feishu question form after /t binding', { timeout: 30_000 }, async (t: TestContext) => {
    if (!(await tmuxAvailable())) {
      t.skip('tmux is not available');
      return;
    }

    const previousEnv = {
      KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
      KIMI_CODE_EXECUTABLE: process.env.KIMI_CODE_EXECUTABLE,
      CODELARK_KIMI_EXECUTABLE: process.env.CODELARK_KIMI_EXECUTABLE,
      CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: process.env.CODELARK_KIMI_TMUX_POLL_INTERVAL_MS,
      CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS: process.env.CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS,
      CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: process.env.CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS,
      CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: process.env.CODELARK_KIMI_TMUX_PROMPT_DELAY_MS,
      CODELARK_DEBUG: process.env.CODELARK_DEBUG,
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-kimi-question-form-'));
    const kimiHome = path.join(tempDir, 'kimi-home');
    const binDir = path.join(tempDir, 'bin');
    const workDir = path.join(tempDir, 'workspace');
    const keyLogPath = path.join(tempDir, 'keys.jsonl');
    const launchLogPath = path.join(tempDir, 'launches.jsonl');
    const kimiSessionId = 'session_mock-kimi-question-form-e2e';
    const askBlock = '<clk-ask>{"question":"请选择 Kimi 发布策略","options":["灰度","全量"],"input":{"label":"补充说明","placeholder":"可留空"},"submitText":"确认提交","allowTextReply":true}</clk-ask>';
    const responseText = `Kimi asks for confirmation.\n\n${askBlock}`;
    const thinkText = 'mock kimi question form thinking';
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(kimiHome, { recursive: true });

    process.env.KIMI_CODE_HOME = kimiHome;
    const wirePath = writeKimiWireFixture({
      homeDir: kimiHome,
      cwd: workDir,
      sessionId: kimiSessionId,
      timestamp: '2026-06-27T10:25:00.000Z',
      text: 'existing Kimi question prompt',
      assistantText: 'existing Kimi question answer',
      title: 'Existing Kimi question session',
    });
    process.env.KIMI_CODE_EXECUTABLE = writeResumeOnlyFakeKimiExecutable(binDir, {
      sessionId: kimiSessionId,
      wirePath,
      keyLogPath,
      launchLogPath,
      responseText,
      thinkText,
    });
    delete process.env.CODELARK_KIMI_EXECUTABLE;
    delete process.env.CODELARK_DEBUG;
    process.env.CODELARK_KIMI_TMUX_POLL_INTERVAL_MS = '50';
    process.env.CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS = '5000';
    process.env.CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS = '5000';
    process.env.CODELARK_KIMI_TMUX_PROMPT_DELAY_MS = '50';

    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: new CodexRoutingProvider(),
    });
    const adapter = new StreamingRecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-kimi-question-form' } as const;

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${kimiSessionId}`, 'incoming-kimi-question-thread'));
      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.activeRuntime, 'kimi');

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'ask user from kimi', 'incoming-kimi-question-plain'));

      await waitForMirrorCondition(() => adapter.sent.some((message) => (
        message.richCard?.form?.submitCallbackData.startsWith('clk-agent-question:') === true
      )), 12_000).catch((error) => {
        assert.fail([
          error instanceof Error ? error.message : String(error),
          `streamEvents=${JSON.stringify(adapter.streamEvents)}`,
          `sent=${JSON.stringify(adapter.sent.map((message) => ({ text: message.text, richCard: message.richCard })))}`,
          `launchLog=${fs.existsSync(launchLogPath) ? fs.readFileSync(launchLogPath, 'utf-8') : '<missing>'}`,
          `keyLog=${fs.existsSync(keyLogPath) ? fs.readFileSync(keyLogPath, 'utf-8') : '<missing>'}`,
          `wire=${fs.readFileSync(wirePath, 'utf-8')}`,
        ].join('\n'));
      });

      const finalMirrorEnd = adapter.streamEvents.find((event) => (
        event.kind === 'end'
        && event.streamKey?.startsWith('mirror:')
        && event.status === 'completed'
        && /Kimi asks for confirmation\./.test(event.text || '')
      ));
      assert.ok(finalMirrorEnd);
      assert.doesNotMatch(finalMirrorEnd.text || '', /<clk-ask>|请选择 Kimi 发布策略/);
      assert.ok(adapter.streamEvents.some((event) => (
        event.kind === 'status'
        && event.streamKey?.startsWith('mirror:')
        && /当前思考：mock kimi question form thinking/.test(event.text || '')
      )));

      const questionMessage = adapter.sent.find((message) => (
        message.richCard?.form?.submitCallbackData.startsWith('clk-agent-question:') === true
      ));
      assert.ok(questionMessage);
      assert.equal(questionMessage.text, '请选择 Kimi 发布策略');
      assert.equal(questionMessage.richCard?.title, '需要确认');
      assert.equal(questionMessage.richCard?.form?.optionElementId, 'clk_choice');
      assert.equal(questionMessage.richCard?.form?.inputElementId, 'clk_input');
      assert.equal(questionMessage.richCard?.form?.inputLabel, '补充说明');
      assert.equal(questionMessage.richCard?.form?.inputPlaceholder, '可留空');
      assert.equal(questionMessage.richCard?.form?.submitText, '确认提交');
      assert.match(questionMessage.richCard?.form?.submitCallbackData || '', /^clk-agent-question:/);
      assert.deepEqual(
        questionMessage.richCard?.form?.options.map((option) => option.text),
        ['灰度', '全量'],
      );

      const keyLog = fs.readFileSync(keyLogPath, 'utf-8');
      assert.match(keyLog, /ask user from kimi/);
      assert.match(keyLog, /"hex":"0d"/, 'the idle Kimi question turn should submit with Enter');
      assert.match(keyLog, /"hex":"13"/, 'the Kimi question turn should immediately steer with Ctrl-S');
      assert.match(fs.readFileSync(wirePath, 'utf-8'), /<clk-ask>/);

      await _testOnly.handleMessage(adapter, {
        ...inboundMessage(address, '', 'incoming-kimi-question-card-submit'),
        callbackData: questionMessage.richCard?.form?.submitCallbackData,
        callbackMessageId: 'kimi-question-card-message',
        raw: {
          event: {
            action: {
              form_value: {
                clk_choice: '灰度',
                clk_input: '先观察十分钟',
              },
            },
          },
        },
      });
      await waitForMirrorCondition(() => adapter.streamEvents.some((event) => (
        event.kind === 'end'
        && event.streamKey?.startsWith('mirror:')
        && event.status === 'completed'
        && /Kimi accepted card answer/.test(event.text || '')
      )), 12_000).catch((error) => {
        assert.fail([
          error instanceof Error ? error.message : String(error),
          `streamEvents=${JSON.stringify(adapter.streamEvents)}`,
          `keyLog=${fs.readFileSync(keyLogPath, 'utf-8')}`,
          `wire=${fs.readFileSync(wirePath, 'utf-8')}`,
        ].join('\n'));
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, '卡片回答之后继续聊', 'incoming-kimi-after-question-follow-up'));
      await waitForMirrorCondition(() => adapter.streamEvents.some((event) => (
        event.kind === 'end'
        && event.streamKey?.startsWith('mirror:')
        && event.status === 'completed'
        && /Kimi continued after follow-up/.test(event.text || '')
      )), 12_000);

      await _testOnly.reconcileMirrorSubscriptions();
      assert.equal(bridgeState.kimiMirrorSubscriptions.get(binding.id)?.pendingTurn, null);
      assert.deepEqual(
        adapter.streamEvents.filter((event) => event.kind === 'mirror_start').map((event) => event.streamKey).sort(),
        adapter.streamEvents.filter((event) => event.kind === 'end' && event.streamKey?.startsWith('mirror:')).map((event) => event.streamKey).sort(),
      );

      const continuedKeyLog = fs.readFileSync(keyLogPath, 'utf-8');
      assert.match(continuedKeyLog, /用户回答了问题卡片/);
      assert.match(continuedKeyLog, /选择：灰度/);
      assert.match(continuedKeyLog, /卡片回答之后继续聊/);
      const launches = fs.readFileSync(launchLogPath, 'utf-8').trim().split(/\r?\n/);
      assert.equal(launches.length, 1, 'card submit and the next message must reuse the same Kimi tmux process');
    } finally {
      const activeBinding = store.getChannelChat(address.channelType, address.chatId);
      if (activeBinding) {
        await execFileAsync('tmux', ['kill-session', '-t', `clk-kimi-${activeBinding.bridgeSessionId}`]).catch(() => {});
      }
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('starts Claude tmux mirror after a plain auto-forwarded message discovers the JSONL session', async () => {
    const calls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: createRecordingLlm(calls),
    });
    const fakeTmux = installFakeTmux();
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-tmux-mirror-home-'));
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    const oldClaudeHome = process.env.CODELARK_CLAUDE_HOME;
    const oldDiscoveryTimeout = process.env.CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;
    process.env.CODELARK_CLAUDE_HOME = claudeHome;
    process.env.CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS = '1000';

    const adapter = new StreamingRecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-claude-tmux-mirror-forward' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-tmux-mirror-forward-'));
    const tmuxSessionName = 'claude_bridge_session';
    const claudeSessionId = 'claude-tmux-jsonl-session';
    let transcriptPath = '';

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-claude-tmux-mirror',
      });
      fs.writeFileSync(fakeTmux.statePath, `${tmuxSessionName}\n`, 'utf-8');
      store.updateSession(binding.bridgeSessionId, {
        runtime: {
          activeRuntime: 'claude',
          general: { tmuxSessionName },
        },
      });
      setSessionClaudeProviderToml(binding.bridgeSessionId, 'tmux');

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'hello claude tmux mirror', 'incoming-claude-tmux-mirror-plain'));
      transcriptPath = appendClaudeMirrorTurn({
        homeDir: claudeHome,
        cwd: workDir,
        sessionId: claudeSessionId,
        timestampPrefix: '2026-06-02T05:00',
        userText: 'hello claude tmux mirror',
        assistantText: 'Claude tmux mirror response',
      });

      await waitForMirrorCondition(() => adapter.streamEvents.some((event) => (
        event.kind === 'end'
        && event.streamKey?.startsWith('mirror:')
        && /Claude tmux mirror response/.test(event.text || '')
      )), 3000).catch((error) => {
        const session = store.getSession(binding.bridgeSessionId);
        assert.fail([
          error instanceof Error ? error.message : String(error),
          `claudeSessionId=${session?.runtime?.claude?.sessionId || ''}`,
          `claudeCwd=${session?.runtime?.claude?.cwd || ''}`,
          `mirrorStatus=${session?.mirror_status || ''}`,
          `claudeMirrorSubscriptions=${JSON.stringify(Array.from((bridgeState.claudeMirrorSubscriptions as Map<string, any>)?.values?.() || []).map((subscription) => ({
            bindingId: subscription.bindingId,
            status: subscription.status,
            filePath: subscription.filePath,
            fileOffset: subscription.fileOffset,
            fileSize: subscription.fileSize,
            dirty: subscription.dirty,
            pendingTurn: subscription.pendingTurn,
            pendingDeliveries: subscription.pendingDeliveries,
          })))}`,
          `streamEvents=${JSON.stringify(adapter.streamEvents)}`,
          `sent=${JSON.stringify(adapter.sent.map((message) => ({ text: message.text, richCard: message.richCard?.title })))}`,
          `transcriptExists=${fs.existsSync(transcriptPath)}`,
        ].join('\n'));
      });

      assert.equal(calls.length, 0);
      const session = store.getSession(binding.bridgeSessionId);
      assert.equal(session?.runtime?.claude?.sessionId, claudeSessionId);
      assert.equal(session?.runtime?.claude?.cwd, workDir);
      assert.equal(session?.mirror_status, 'watching');
      const tmuxLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(tmuxLog, new RegExp(`send-keys -t ${tmuxSessionName} -l hello claude tmux mirror`));
      assert.ok(adapter.streamEvents.some((event) => event.kind === 'mirror_start' && event.streamKey?.startsWith('mirror:')));
      assert.ok(adapter.streamEvents.some((event) => (
        event.kind === 'text'
        && event.streamKey?.startsWith('mirror:')
        && /Claude tmux mirror response/.test(event.text || '')
      )));
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      if (oldClaudeHome === undefined) delete process.env.CODELARK_CLAUDE_HOME;
      else process.env.CODELARK_CLAUDE_HOME = oldClaudeHome;
      if (oldDiscoveryTimeout === undefined) delete process.env.CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS;
      else process.env.CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS = oldDiscoveryTimeout;
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      if (transcriptPath) fs.rmSync(transcriptPath, { force: true });
      await cleanupFakeTmux(fakeTmux);
    }
  });





  it('bootstraps a codex thread before starting tmux provider and still allows /new ./sayhi', async () => {
    const bootstrapThreadId = '019e81d3-e5b0-7540-ad14-4f3073b2701d';
    const llmCalls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: {
        streamChat(params: StreamChatParams): ReadableStream<string> {
          llmCalls.push({
            sessionId: params.sessionId,
            codexThreadId: params.codexThreadId || '',
            prompt: params.prompt,
          });
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ session_id: bootstrapThreadId }) })}\n`);
              controller.close();
            },
          });
        },
      },
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-tmux-before-thread-e2e', userId: 'ou-runtime-tmux-before-thread' } as const;

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-runtime-provider-first'));
      const tmuxBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(tmuxBinding);
      const tmuxSession = store.getSession(tmuxBinding.bridgeSessionId);
      const tmuxThreadId = tmuxSession?.runtime?.codex?.threadId || '';
      const tmuxSessionName = `codex_${tmuxThreadId}`;
      assert.equal(tmuxSession?.runtime?.codex?.provider, undefined);
      assert.equal(getSessionCodexProviderToml(tmuxBinding.bridgeSessionId), 'tmux');
      assert.match(tmuxThreadId, CODEX_THREAD_ID_RE);
      assert.equal(tmuxSession?.runtime?.general?.tmuxSessionName, tmuxSessionName);
      assert.equal(tmuxSession?.runtime?.general?.autoEnter, undefined);
      assert.equal(getSessionTmuxAutoEnterToml(tmuxBinding.bridgeSessionId), true);
      assert.equal(llmCalls.length, 0);

      const startLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(startLog, new RegExp(`new-session -d -s ${tmuxSessionName}`));
      assert.match(startLog, new RegExp(`resume ${tmuxThreadId}`));
      assert.match(adapter.sent.at(-1)?.text || '', new RegExp(`codex_thread_id.*${tmuxThreadId}`, 's'));

      const beforeClearLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '//clear', 'incoming-runtime-clear-blocked'));
      const clearLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeClearLog.length);
      assert.equal(clearLog, '');
      assert.match(adapter.sent.at(-1)?.text || '', /不能通过 `?\/\/clear`? 清空上下文/);
      assert.match(adapter.sent.at(-1)?.text || '', /手动创建新会话/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/new sayhi ./sayhi', 'incoming-runtime-new-sayhi'));
      const newAddress = latestCreatedGroupAddress(adapter);
      const newBinding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
      assert.ok(newBinding);
      assert.notEqual(newBinding.id, tmuxBinding.id);
      assert.equal(store.getSession(newBinding.bridgeSessionId)?.runtime?.codex?.threadId, undefined);
      assert.match(adapter.sent.at(-2)?.text || '', /已创建群聊会话/);
      assert.match(adapter.sent.at(-2)?.text || '', /sayhi/);
      assert.match(adapter.sent.at(-1)?.text || '', /当前会话/);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      await cleanupFakeTmux(fakeTmux);
    }
  });





  it('keeps tmux provider auto-enter enabled when /new follows /p tmux', async () => {
    const bootstrapThreadIds = [
      '019e82f0-0000-7000-9000-000000000001',
      '019e82f0-0000-7000-9000-000000000002',
    ];
    let bootstrapIndex = 0;
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: {
        streamChat(): ReadableStream<string> {
          const threadId = bootstrapThreadIds[Math.min(bootstrapIndex, bootstrapThreadIds.length - 1)];
          bootstrapIndex += 1;
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ session_id: threadId }) })}\n`);
              controller.close();
            },
          });
        },
      },
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const address = { channelType: 'feishu', chatId: 'chat-new-after-tmux-e2e', userId: 'ou-new-after-tmux' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-new-after-tmux-'));

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-new-after-tmux-provider'));
      const tmuxBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(tmuxBinding);
      assert.equal(store.getSession(tmuxBinding.bridgeSessionId)?.runtime?.codex?.provider, undefined);
      assert.equal(getSessionCodexProviderToml(tmuxBinding.bridgeSessionId), 'tmux');

      await _testOnly.handleMessage(adapter, inboundMessage(address, `/new tmux-next ${workDir}`, 'incoming-new-after-tmux-new'));
      const newAddress = latestCreatedGroupAddress(adapter);
      const newBinding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
      assert.ok(newBinding);
      assert.notEqual(newBinding.id, tmuxBinding.id);
      const newSession = store.getSession(newBinding.bridgeSessionId);
      assert.equal(newSession?.runtime?.codex?.provider, undefined);
      assert.equal(getSessionCodexProviderToml(newBinding.bridgeSessionId), 'tmux');
      assert.equal(newSession?.runtime?.general?.autoEnter, undefined);
      assert.equal(getSessionTmuxAutoEnterToml(newBinding.bridgeSessionId), true);
      assert.equal(newSession?.runtime?.codex?.threadId, undefined);
      assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux/s);

      const beforeFirstMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '新线程第一条', 'incoming-new-after-tmux-first'));
      const firstMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeFirstMessageLog.length);
      const newThreadId = store.getSession(newBinding.bridgeSessionId)?.runtime?.codex?.threadId || '';
      const newTmuxSession = `codex_${newThreadId}`;
      assert.match(newThreadId, CODEX_THREAD_ID_RE);
      assert.match(firstMessageLog, new RegExp(`new-session -d -s ${newTmuxSession}`));
      assert.match(firstMessageLog, new RegExp(`paste-buffer -d -p -b clk-paste-[^ ]+ -t ${newTmuxSession}`));
      assert.match(firstMessageLog, new RegExp(`send-keys -t ${newTmuxSession} Enter`));
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      await cleanupFakeTmux(fakeTmux);
    }
  });


  it('initializes a default tmux provider conversation on first text after /set defaultProvider tmux and /new', async () => {
    const bootstrapThreadId = '019e824e-10ef-7430-985d-4349ce6a15f9';
    const llmCalls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      llm: {
        streamChat(params: StreamChatParams): ReadableStream<string> {
          llmCalls.push({
            sessionId: params.sessionId,
            codexThreadId: params.codexThreadId || '',
            prompt: params.prompt,
          });
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ session_id: bootstrapThreadId }) })}\n`);
              controller.close();
            },
          });
        },
      },
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new StreamingRecordingAdapter();
    const streamingAdapter = adapter as StreamingRecordingAdapter;
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-tmux-default-recover-e2e', userId: 'ou-runtime-tmux-default-recover' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-tmux-default-recover-'));

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/set defaultProvider tmux', 'incoming-tmux-default-set-provider'));
      assert.match(adapter.sent.at(-1)?.text || '', /runtime\.codex\.provider.*tmux/s);
      assert.equal(createConfigService({ migrate: false, env: {} }).get('runtime.codex.provider'), 'tmux');

      await _testOnly.handleMessage(adapter, inboundMessage(address, `/new tmux-default ${workDir}`, 'incoming-tmux-default-new'));
      const newAddress = latestCreatedGroupAddress(adapter);
      const binding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
      assert.ok(binding);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, undefined);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, undefined);
      assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux \(全局默认\)/s);

      const beforeFirstMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      const beforeFirstMessageSentCount = adapter.sent.length;
      const beforeFirstMessageReactionCount = streamingAdapter.reactions.length;
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '第一条', 'incoming-tmux-default-first'));
      const firstMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeFirstMessageLog.length);
      const firstMessageSentText = adapter.sent.slice(beforeFirstMessageSentCount).map((message) => message.text).join('\n\n');
      assert.equal(llmCalls.length, 0);
      const actualThreadId = store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId || '';
      const tmuxSession = `codex_${actualThreadId}`;
      const actualSessionPath = findSessionFileByThreadId(actualThreadId) || '';
      assert.match(actualThreadId, CODEX_THREAD_ID_RE);
      assert.equal(actualSessionPath ? fs.existsSync(actualSessionPath) : false, true);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.general?.tmuxSessionName, tmuxSession);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.general?.autoEnter, undefined);
      assert.equal(getSessionTmuxAutoEnterToml(binding.bridgeSessionId), true);
      assert.match(firstMessageLog, new RegExp(`has-session -t ${tmuxSession}`));
      assert.match(firstMessageLog, new RegExp(`new-session -d -s ${tmuxSession}`));
      assert.match(firstMessageLog, new RegExp(`resume ${actualThreadId}`));
      assert.match(firstMessageLog, new RegExp(`paste-buffer -d -p -b clk-paste-[^ ]+ -t ${tmuxSession}`));
      assert.match(firstMessageLog, new RegExp(`send-keys -t ${tmuxSession} Enter`));
      assert.doesNotMatch(firstMessageSentText, /tmux Provider 缺少 codex_thread_id|正在后台重新启动 Codex TUI/);
      assert.deepEqual(streamingAdapter.streamEvents.filter((event) => /^provider-tmux:/.test(event.streamKey || '')), []);
      assert.deepEqual(
        streamingAdapter.reactions.slice(beforeFirstMessageReactionCount).map((reaction) => reaction.action),
        ['add'],
      );
      assert.equal(streamingAdapter.reactions.at(-1)?.emojiType, 'Get');
      const reactionsAfterFirstTmuxSubmit = streamingAdapter.reactions.length;
      appendCodexMirrorTurn(actualSessionPath, {
        timestampPrefix: '2026-05-28T00:01',
        turnId: 'turn-tmux-default-first',
        userText: '第一条',
        assistantText: '第一条响应',
      });
      await _testOnly.reconcileMirrorSubscriptions();
      assert.equal(streamingAdapter.reactions.length, reactionsAfterFirstTmuxSubmit);
      assert.ok(streamingAdapter.streamEvents.some((event) => event.kind === 'text' && /^mirror:/.test(event.streamKey || '') && /第一条响应/.test(event.text || '')));

      const beforeReusableMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      const beforeReusableReactionCount = streamingAdapter.reactions.length;
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '复用中的第二条', 'incoming-tmux-default-reuse-second'));
      const reusableMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeReusableMessageLog.length);
      assert.match(reusableMessageLog, new RegExp(`has-session -t ${tmuxSession}`));
      assert.match(reusableMessageLog, new RegExp(`paste-buffer -d -p -b clk-paste-[^ ]+ -t ${tmuxSession}`));
      assert.doesNotMatch(reusableMessageLog, /new-session|\bresume\b/, 'a running follow-up must reuse the established Codex tmux');
      assert.deepEqual(
        streamingAdapter.reactions.slice(beforeReusableReactionCount).map((reaction) => reaction.action),
        ['add'],
      );
      assert.equal(streamingAdapter.reactions.at(-1)?.emojiType, 'Get');
      const reactionsAfterReusableTmuxSubmit = streamingAdapter.reactions.length;
      appendCodexMirrorTurn(actualSessionPath, {
        timestampPrefix: '2026-05-28T00:01:30',
        turnId: 'turn-tmux-default-reuse-second',
        userText: '复用中的第二条',
        assistantText: '复用中的第二条响应',
      });
      await _testOnly.reconcileMirrorSubscriptions();
      assert.equal(streamingAdapter.reactions.length, reactionsAfterReusableTmuxSubmit);
      assert.ok(streamingAdapter.streamEvents.some((event) => event.kind === 'text'
        && /^mirror:/.test(event.streamKey || '')
        && /复用中的第二条响应/.test(event.text || '')));

      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '/tmux manual after start', 'incoming-tmux-default-manual'));
      assert.doesNotMatch(adapter.sent.at(-1)?.text || '', /tmux session 不存在/);

      fs.writeFileSync(fakeTmux.statePath, '', 'utf-8');
      const beforeManualMissingLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '/tmux manual missing', 'incoming-tmux-default-manual-missing'));
      const manualMissingLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeManualMissingLog.length);
      assert.doesNotMatch(adapter.sent.at(-1)?.text || '', /tmux session 不存在|tmux Provider 缺少 codex_thread_id/);
      assert.match(manualMissingLog, new RegExp(`has-session -t ${tmuxSession}`));
      assert.match(manualMissingLog, new RegExp(`new-session -d -s ${tmuxSession}`));
      assert.match(manualMissingLog, new RegExp(`resume ${actualThreadId}`));
      assert.match(manualMissingLog, new RegExp(`send-keys -t ${tmuxSession} -l manual missing`));
      assert.match(manualMissingLog, new RegExp(`send-keys -t ${tmuxSession} Enter`));

      fs.writeFileSync(fakeTmux.statePath, '', 'utf-8');
      const beforeScreenMissingLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '/tmux-screen 20', 'incoming-tmux-default-screen-missing'));
      const screenMissingLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeScreenMissingLog.length);
      assert.match(adapter.sent.at(-1)?.text || '', new RegExp(`tmux session 不存在：${tmuxSession}`));
      assert.match(adapter.sent.at(-1)?.text || '', /请先发送 `\/provider tmux` 重新启动 Codex TUI。/);
      assert.match(screenMissingLog, new RegExp(`has-session -t ${tmuxSession}`));
      assert.doesNotMatch(screenMissingLog, new RegExp(`new-session -d -s ${tmuxSession}`));
      assert.doesNotMatch(screenMissingLog, new RegExp(`resume ${actualThreadId}`));
      assert.doesNotMatch(screenMissingLog, new RegExp(`capture-pane -t ${tmuxSession} -p -S -20`));

      fs.writeFileSync(fakeTmux.statePath, '', 'utf-8');
      const beforeRecoveredMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      const beforeSecondReactionCount = streamingAdapter.reactions.length;
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '第二条', 'incoming-tmux-default-second'));
      const recoveredMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeRecoveredMessageLog.length);
      assert.match(recoveredMessageLog, new RegExp(`has-session -t ${tmuxSession}`));
      assert.match(recoveredMessageLog, new RegExp(`new-session -d -s ${tmuxSession}`));
      assert.match(recoveredMessageLog, new RegExp(`resume ${actualThreadId}`));
      assert.match(recoveredMessageLog, new RegExp(`paste-buffer -d -p -b clk-paste-[^ ]+ -t ${tmuxSession}`));
      assert.match(recoveredMessageLog, new RegExp(`send-keys -t ${tmuxSession} Enter`));
      assert.deepEqual(streamingAdapter.reactions.slice(beforeSecondReactionCount).map((reaction) => reaction.action), ['add']);
      assert.equal(streamingAdapter.reactions.at(-1)?.emojiType, 'Get');
      const reactionsAfterRecoveredTmuxSubmit = streamingAdapter.reactions.length;
      appendCodexMirrorTurn(actualSessionPath, {
        timestampPrefix: '2026-05-28T00:02',
        turnId: 'turn-tmux-default-second',
        userText: '第二条',
        assistantText: '第二条响应',
      });
      await _testOnly.reconcileMirrorSubscriptions();
      assert.equal(streamingAdapter.reactions.length, reactionsAfterRecoveredTmuxSubmit);
      assert.ok(streamingAdapter.streamEvents.some((event) => event.kind === 'text' && /^mirror:/.test(event.streamKey || '') && /第二条响应/.test(event.text || '')));
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      await cleanupFakeTmux(fakeTmux);
    }
  });

  it('notifies the chat when a tmux provider session exits right after auto-forwarded input', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    const oldExitAfterSend = process.env.TMUX_FAKE_EXIT_AFTER_SEND;
    const oldExitProbeDelay = process.env.CODELARK_TMUX_PROVIDER_EXIT_PROBE_DELAY_MS;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;
    process.env.TMUX_FAKE_EXIT_AFTER_SEND = '1';
    process.env.CODELARK_TMUX_PROVIDER_EXIT_PROBE_DELAY_MS = '0';

    const adapter = new StreamingRecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-tmux-exit-notice-e2e', userId: 'ou-runtime-tmux-exit-notice' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-tmux-exit-notice-'));

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/set defaultProvider tmux', 'incoming-tmux-exit-set-provider'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/new tmux-exit ${workDir}`, 'incoming-tmux-exit-new'));
      const newAddress = latestCreatedGroupAddress(adapter);
      const binding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
      assert.ok(binding);

      const beforeSentCount = adapter.sent.length;
      const beforePromptReactionCount = adapter.reactions.length;
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '会退出的一条', 'incoming-tmux-exit-first'));
      await waitForCondition(() => adapter.sent.slice(beforeSentCount).some((message) => /tmux Provider 会话已退出/.test(message.text || '')));
      const noticeText = adapter.sent.slice(beforeSentCount).map((message) => message.text || '').join('\n\n');
      const exitedTmuxSession = noticeText.match(/Codex tmux Provider 会话已退出：`(codex_[^`]+)`/)?.[1] || '';
      assert.match(exitedTmuxSession, /^codex_/);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.general?.tmuxSessionName, undefined);
      assert.match(noticeText, /\/p tmux/);
      assert.doesNotMatch(noticeText, /\/tmux-screen/);
      assert.doesNotMatch(noticeText, /诊断命令/);
      assert.deepEqual(adapter.reactions.slice(beforePromptReactionCount).map((reaction) => reaction.action), ['add']);
      assert.equal(adapter.reactions.at(-1)?.emojiType, 'Get');
      assert.equal(store.getSession(binding.bridgeSessionId)?.health_status, 'failed');
      assert.match(store.getSession(binding.bridgeSessionId)?.health_reason || '', /disappeared .* after auto-forward input/);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      if (oldExitAfterSend === undefined) delete process.env.TMUX_FAKE_EXIT_AFTER_SEND;
      else process.env.TMUX_FAKE_EXIT_AFTER_SEND = oldExitAfterSend;
      if (oldExitProbeDelay === undefined) delete process.env.CODELARK_TMUX_PROVIDER_EXIT_PROBE_DELAY_MS;
      else process.env.CODELARK_TMUX_PROVIDER_EXIT_PROBE_DELAY_MS = oldExitProbeDelay;
      fs.rmSync(workDir, { recursive: true, force: true });
      await cleanupFakeTmux(fakeTmux);
    }
  });

  it('does not wait for a slow Get reaction after tmux provider auto-forward input', { timeout: 30000 }, async () => {
    const bootstrapThreadId = '019e824e-10ef-7430-985d-4349ce6a15f9';
    const store = initBridgeTestContext({
      dynamicSettings: true,
      llm: {
        streamChat(): ReadableStream<string> {
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ session_id: bootstrapThreadId }) })}\n`);
              controller.close();
            },
          });
        },
      },
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    class SlowReactionAdapter extends StreamingRecordingAdapter {
      addStarted = false;
      tmuxLogAtAddStart = '';
      requestedEmojiType = '';
      private releaseAddReactionPromise: (() => void) | undefined;
      private readonly addReactionPromise = new Promise<void>((resolve) => {
        this.releaseAddReactionPromise = resolve;
      });
      releaseAddReaction(): void {
        this.releaseAddReactionPromise?.();
      }

      override async addMessageReaction(messageId: string, emojiType: string): Promise<string | null> {
        if (messageId !== 'incoming-tmux-slow-reaction-first') {
          return super.addMessageReaction(messageId, emojiType);
        }
        this.addStarted = true;
        this.tmuxLogAtAddStart = fs.readFileSync(fakeTmux.logPath, 'utf-8');
        this.requestedEmojiType = emojiType;
        await this.addReactionPromise;
        return super.addMessageReaction(messageId, emojiType);
      }

    }

    const adapter = new SlowReactionAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-tmux-slow-reaction-e2e', userId: 'ou-runtime-tmux-slow-reaction' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-tmux-slow-reaction-'));
    let handlePromise: Promise<void> | undefined;
    let releasedReaction = false;

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/set defaultProvider tmux', 'incoming-tmux-slow-reaction-set-provider'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/new tmux-slow-reaction ${workDir}`, 'incoming-tmux-slow-reaction-new'));
      const newAddress = latestCreatedGroupAddress(adapter);
      const binding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
      assert.ok(binding);

      const beforeMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      const beforePromptReactionCount = adapter.reactions.length;
      handlePromise = _testOnly.handleMessage(adapter, inboundMessage(newAddress, '慢表情不该挡住发送', 'incoming-tmux-slow-reaction-first'));
      await waitForCondition(() => adapter.addStarted, 15_000);
      assert.match(adapter.tmuxLogAtAddStart.slice(beforeMessageLog.length), /paste-buffer -d -p -b clk-paste-.* -t /);
      assert.match(adapter.tmuxLogAtAddStart.slice(beforeMessageLog.length), /send-keys -t .* Enter/);
      assert.equal(adapter.requestedEmojiType, 'Get');
      const messageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeMessageLog.length);
      assert.match(messageLog, /paste-buffer -d -p -b clk-paste-.* -t /);
      assert.match(messageLog, /send-keys -t .* Enter/);
      assert.equal(adapter.reactions.length, beforePromptReactionCount);
      await handlePromise;
    } finally {
      if (!releasedReaction) {
        releasedReaction = true;
        adapter.releaseAddReaction();
      }
      if (handlePromise) {
        await handlePromise.catch(() => {});
      }
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      await cleanupFakeTmux(fakeTmux);
    }
  });

  it('keeps a locally bootstrapped tmux provider thread after the Codex session file appears', async () => {
    const llmCalls: RecordedLlmCall[] = [];
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-tmux-bootstrap-visible-'));
    const store = initBridgeTestContext({
      dynamicSettings: true,
      llm: createRecordingLlm(llmCalls),
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-tmux-bootstrap-visible-e2e', userId: 'ou-runtime-tmux-bootstrap-visible' } as const;

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/set defaultProvider tmux', 'incoming-tmux-bootstrap-visible-provider'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/new tmux-visible ${workDir}`, 'incoming-tmux-bootstrap-visible-new'));
      const newAddress = latestCreatedGroupAddress(adapter);
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, 'hi', 'incoming-tmux-bootstrap-visible-first'));

      const binding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
      assert.ok(binding);
      const actualThreadId = store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId || '';
      const sessionPath = findSessionFileByThreadId(actualThreadId) || '';
      assert.match(actualThreadId, CODEX_THREAD_ID_RE);
      assert.equal(sessionPath ? fs.existsSync(sessionPath) : false, true);
      assert.equal(llmCalls.length, 0);

      await _testOnly.reconcileMirrorSubscriptions();
      await _testOnly.reconcileMirrorSubscriptions();
      await _testOnly.reconcileMirrorSubscriptions();

      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, actualThreadId);
      assert.equal(bridgeState.mirrorSubscriptions.get(binding.id)?.filePath, sessionPath);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      await cleanupFakeTmux(fakeTmux);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('surfaces the local bootstrap error when /p tmux cannot create a codex thread', async () => {
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-tmux-bootstrap-error-e2e' } as const;
    const originalError = console.error;
    const oldCodexCliPath = process.env.CODELARK_CODEX_CLI_PATH;
    const fakeCodex = installFailingCodexCli();
    const commandErrors: unknown[][] = [];

    try {
      process.env.CODELARK_CODEX_CLI_PATH = fakeCodex.executable;
      console.error = (...args: unknown[]) => {
        if (args[0] === '[bridge-manager] Command failed: /provider') {
          commandErrors.push(args);
          return;
        }
        originalError(...args);
      };
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-runtime-provider-error'));
    } finally {
      console.error = originalError;
      if (oldCodexCliPath === undefined) delete process.env.CODELARK_CODEX_CLI_PATH;
      else process.env.CODELARK_CODEX_CLI_PATH = oldCodexCliPath;
      fs.rmSync(fakeCodex.binDir, { recursive: true, force: true });
    }

    const response = adapter.sent.at(-1)?.text || '';
    assert.equal(commandErrors.length, 1);
    assert.match(response, /\/provider 执行失败：本地 Codex thread bootstrap 失败/);
    assert.match(response, /fake local bootstrap failed/);
    assert.doesNotMatch(response, /请稍后重试/);
    const binding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(binding);
    assert.notEqual(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, 'tmux');
  });

  it('renders the effective default provider in command echoes through the bridge entrypoint', async () => {
    writeHomeConfigToml(`
schema_version = 2

[runtime.codex]
provider = "tmux"
`);
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-default-provider-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-default-provider-'));

    createExistingChannelChat(store, address, { workDir, name: 'default-provider' });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/p', 'incoming-default-provider-p'));
    assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux \(全局默认\)/s);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/m', 'incoming-default-provider-m'));
    assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux \(全局默认\)/s);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/', 'incoming-default-provider-current'));
    assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux \(全局默认\)/s);
  });

  it('falls back to bridge cached messages for /his and supports temporary raw limits', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-raw-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-history-raw-e2e-'));

    const { binding } = createExistingChannelChat(store, address, {
      workDir,
      name: 'history-raw',
    });

    store.addMessage(binding.bridgeSessionId, 'user', 'Bridge 缓存用户消息');
    store.addMessage(binding.bridgeSessionId, 'assistant', 'Bridge 缓存助手回复');
    store.addMessage(binding.bridgeSessionId, 'user', 'Bridge 缓存最后一条');

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his', 'incoming-history-default-msg'));

    const lastText = adapter.sent.at(-1)?.text || '';
    assert.match(lastText, /最近对话（msg）/);
    assert.match(lastText, /来源.*Bridge 缓存/s);
    assert.match(lastText, /Bridge 缓存用户消息/);
    assert.match(lastText, /Bridge 缓存助手回复/);
    assert.equal(adapter.sent.at(-1)?.richCard?.title, '最近对话');

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his raw 1', 'incoming-history-raw-once'));

    const rawText = adapter.sent.at(-1)?.text || '';
    assert.match(rawText, /最近对话（解析文本）/);
    assert.match(rawText, /返回条数.*1 \/ 本次 1（配置 8）/s);
    assert.doesNotMatch(rawText, /Bridge 缓存用户消息/);
    assert.doesNotMatch(rawText, /Bridge 缓存助手回复/);
    assert.match(rawText, /Bridge 缓存最后一条/);
  });

  it('truncates long /his history entries in text and rich-card views', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-long-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-history-long-e2e-'));
    const head = 'CODELARK_LONG_HISTORY_HEAD_LOCAL';
    const tail = 'CODELARK_LONG_HISTORY_TAIL_LOCAL';
    const longContent = `${head} ${'historypad '.repeat(220)}${tail}`;

    const { binding } = createExistingChannelChat(store, address, {
      workDir,
      name: 'history-long',
    });
    store.addMessage(binding.bridgeSessionId, 'assistant', longContent);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his raw 1', 'incoming-history-long-raw'));

    const rawText = adapter.sent.at(-1)?.text || '';
    assert.match(rawText, /最近对话（解析文本）/);
    assert.match(rawText, new RegExp(head));
    assert.match(rawText, /\.\.\./);
    assert.doesNotMatch(rawText, new RegExp(tail));

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his msg 1', 'incoming-history-long-msg'));

    const msgText = adapter.sent.at(-1)?.text || '';
    const cardMarkdown = adapter.sent.at(-1)?.richCard?.sections.at(1)?.markdown || '';
    assert.match(msgText, /最近对话（msg）/);
    assert.match(msgText, new RegExp(head));
    assert.match(msgText, /\.\.\./);
    assert.doesNotMatch(msgText, new RegExp(tail));
    assert.match(cardMarkdown, new RegExp(head));
    assert.match(cardMarkdown, /\.\.\./);
    assert.doesNotMatch(cardMarkdown, new RegExp(tail));
  });

  it('prefers Codex JSONL messages over bridge cached messages for /his msg after /t binding', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-codex-msg-e2e' } as const;
    const threadId = '11111111-1111-4111-8111-111111111111';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-msg-e2e-'));
    writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: workDir,
            originator: 'Codex CLI',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Codex JSONL 用户消息' },
        },
        {
          timestamp: '2026-05-28T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Codex JSONL 助手回复' },
        },
        {
          timestamp: '2026-05-28T00:00:02.001Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Codex JSONL 助手回复' }],
          },
        },
      ],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${threadId}`, 'incoming-thread-msg'));
    const binding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(binding);
    store.addMessage(binding.bridgeSessionId, 'assistant', 'Bridge 缓存不应优先展示');

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his msg', 'incoming-history-codex-msg'));

    const lastText = adapter.sent.at(-1)?.text || '';
    assert.match(lastText, /最近对话（msg）/);
    assert.match(lastText, /来源.*Codex session JSONL/s);
    assert.match(lastText, /Codex JSONL 用户消息/);
    assert.match(lastText, /Codex JSONL 助手回复/);
    assert.equal((lastText.match(/Codex JSONL 助手回复/g) || []).length, 1);
    assert.doesNotMatch(lastText, /Bridge 缓存不应优先展示/);
  });

  it('renders task_complete-only final answers from Codex JSONL through /his msg', async () => {
    initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-task-complete-e2e' } as const;
    const threadId = '22222222-2222-4222-8222-222222222222';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-task-complete-e2e-'));
    writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: workDir,
            originator: 'Codex CLI',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '请给最终答案' },
        },
        {
          timestamp: '2026-05-28T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: '只有 task_complete 里的最终答案',
          },
        },
      ],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${threadId}`, 'incoming-thread-task-complete'));
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his msg', 'incoming-history-task-complete'));

    const lastText = adapter.sent.at(-1)?.text || '';
    assert.match(lastText, /最近对话（msg）/);
    assert.match(lastText, /请给最终答案/);
    assert.match(lastText, /只有 task_complete 里的最终答案/);
  });

  it('sends the original Codex session JSONL file through /his json after /t binding', async () => {
    initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-json-e2e' } as const;
    const threadId = '0123456789abcdef0123456789abcdef';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-e2e-'));
    const { sessionPath, rawJsonl } = writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: workDir,
            originator: 'Codex CLI',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '原始 JSONL 端到端内容' },
        },
      ],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${threadId}`, 'incoming-thread'));
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his json', 'incoming-history-json'));

    const attachmentMessage = adapter.sent.find((message) =>
      Array.isArray(message.attachments) && message.attachments.length === 1);
    assert.ok(attachmentMessage);
    assert.equal(attachmentMessage.attachments?.[0]?.path, sessionPath);
    assert.equal(fs.readFileSync(attachmentMessage.attachments![0].path, 'utf-8'), rawJsonl);
  });

  it('reads Kimi wire history and sends wire JSONL through /his after /t binding', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-kimi-e2e' } as const;
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-history-e2e-'));
    const previousKimiHome = process.env.KIMI_CODE_HOME;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-history-cwd-e2e-'));
    const kimiSessionId = 'session_kimi_history_e2e';

    process.env.KIMI_CODE_HOME = kimiHome;
    const wirePath = writeKimiWireFixture({
      homeDir: kimiHome,
      cwd,
      sessionId: kimiSessionId,
      timestamp: '2026-06-02T00:00:00.000Z',
      text: 'Kimi wire 用户消息不应展示',
      thinkText: 'Kimi wire 思考不应进入历史正文',
      assistantText: 'Kimi wire 助手回复应展示',
      title: 'Kimi wire history e2e',
    });

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${kimiSessionId}`, 'incoming-kimi-history-thread'));
      const binding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(binding);
      store.addMessage(binding.bridgeSessionId, 'assistant', 'Bridge 缓存不应优先展示 Kimi');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/his', 'incoming-history-kimi-default'));

      const defaultText = adapter.sent.at(-1)?.text || '';
      assert.match(defaultText, /最近对话（msg）/);
      assert.match(defaultText, /来源.*Kimi Code wire JSONL/s);
      assert.match(defaultText, /Kimi Code/);
      assert.match(defaultText, /Kimi wire 助手回复应展示/);
      assert.doesNotMatch(defaultText, /Kimi wire 用户消息不应展示/);
      assert.doesNotMatch(defaultText, /Kimi wire 思考不应进入历史正文/);
      assert.doesNotMatch(defaultText, /Bridge 缓存不应优先展示 Kimi/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/his msg 1', 'incoming-history-kimi-msg'));

      const lastText = adapter.sent.at(-1)?.text || '';
      assert.match(lastText, /最近对话（msg）/);
      assert.match(lastText, /来源.*Kimi Code wire JSONL/s);
      assert.match(lastText, /Kimi Code/);
      assert.match(lastText, /Kimi wire 助手回复应展示/);
      assert.doesNotMatch(lastText, /Kimi wire 用户消息不应展示/);
      assert.doesNotMatch(lastText, /Kimi wire 思考不应进入历史正文/);
      assert.doesNotMatch(lastText, /Bridge 缓存不应优先展示 Kimi/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/his raw 1', 'incoming-history-kimi-raw'));

      const rawText = adapter.sent.at(-1)?.text || '';
      assert.match(rawText, /最近对话（解析文本）/);
      assert.match(rawText, /来源.*Kimi Code wire JSONL/s);
      assert.match(rawText, /返回条数.*1 \/ 本次 1（配置 8）/s);
      assert.match(rawText, /Kimi wire 助手回复应展示/);
      assert.doesNotMatch(rawText, /Kimi wire 用户消息不应展示/);
      assert.doesNotMatch(rawText, /Kimi wire 思考不应进入历史正文/);
      assert.doesNotMatch(rawText, /Bridge 缓存不应优先展示 Kimi/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/his json', 'incoming-history-kimi-json'));

      const attachmentMessage = adapter.sent.find((message) =>
        Array.isArray(message.attachments)
        && message.attachments.some((attachment) => attachment.path === wirePath));
      assert.ok(attachmentMessage);
      assert.equal(attachmentMessage.attachments?.[0]?.path, wirePath);
      assert.equal(attachmentMessage.attachments?.[0]?.name, 'wire.jsonl');
      assert.match(fs.readFileSync(attachmentMessage.attachments![0].path, 'utf-8'), /Kimi wire 助手回复应展示/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/his file', 'incoming-history-kimi-file'));

      const fileAttachmentMessage = adapter.sent.at(-1);
      assert.ok(fileAttachmentMessage);
      assert.equal(fileAttachmentMessage.attachments?.[0]?.path, wirePath);
      assert.equal(fileAttachmentMessage.attachments?.[0]?.name, 'wire.jsonl');
      assert.match(fs.readFileSync(fileAttachmentMessage.attachments![0].path, 'utf-8'), /Kimi wire 助手回复应展示/);
    } finally {
      if (previousKimiHome === undefined) {
        delete process.env.KIMI_CODE_HOME;
      } else {
        process.env.KIMI_CODE_HOME = previousKimiHome;
      }
      fs.rmSync(kimiHome, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
