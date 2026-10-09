import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { sendCursorDesktopMessage, stopCursorDesktopThread } from '../../../../runtime/cursor/desktop-bridge-client.js';
import { streamCursorDesktop } from '../../../../runtime/cursor/desktop-provider.js';
import {
  cursorWorkspaceHash,
  getCursorTranscriptCandidates,
} from '../../../../runtime/cursor/session-index.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';

describe('Cursor Desktop provider', () => {
  let root = '';
  let bridgeDir = '';
  let socketPath = '';
  let server: http.Server | undefined;
  let previousBridgeDir: string | undefined;
  let previousDataDir: string | undefined;
  let previousConfigDir: string | undefined;
  let previousPollInterval: string | undefined;
  let previousHookReconcileInterval: string | undefined;
  let previousLogsDir: string | undefined;
  let previousOutputIdleTimeout: string | undefined;
  let previousQueuedIdleTimeout: string | undefined;

  beforeEach(async () => {
    previousBridgeDir = process.env.CURSOR_DESKTOP_BRIDGE_DIR;
    previousDataDir = process.env.CURSOR_DATA_DIR;
    previousConfigDir = process.env.CURSOR_CONFIG_DIR;
    previousPollInterval = process.env.CODELARK_CURSOR_DESKTOP_POLL_INTERVAL_MS;
    previousHookReconcileInterval = process.env.CODELARK_CURSOR_DESKTOP_HOOK_RECONCILE_INTERVAL_MS;
    previousLogsDir = process.env.CURSOR_LOGS_DIR;
    previousOutputIdleTimeout = process.env.CODELARK_CURSOR_DESKTOP_OUTPUT_IDLE_TIMEOUT_MS;
    previousQueuedIdleTimeout = process.env.CODELARK_CURSOR_DESKTOP_QUEUED_IDLE_TIMEOUT_MS;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-cursor-desktop-'));
    bridgeDir = path.join(root, 'desktop-bridge');
    socketPath = path.join(root, 'bridge.sock');
    fs.mkdirSync(bridgeDir, { mode: 0o700 });
    fs.chmodSync(bridgeDir, 0o700);
    process.env.CURSOR_DESKTOP_BRIDGE_DIR = bridgeDir;
    process.env.CURSOR_DATA_DIR = path.join(root, 'cursor-data');
    process.env.CURSOR_CONFIG_DIR = path.join(root, 'cursor-config');
    process.env.CURSOR_LOGS_DIR = path.join(root, 'cursor-logs');
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (previousBridgeDir === undefined) delete process.env.CURSOR_DESKTOP_BRIDGE_DIR;
    else process.env.CURSOR_DESKTOP_BRIDGE_DIR = previousBridgeDir;
    if (previousDataDir === undefined) delete process.env.CURSOR_DATA_DIR;
    else process.env.CURSOR_DATA_DIR = previousDataDir;
    if (previousConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR;
    else process.env.CURSOR_CONFIG_DIR = previousConfigDir;
    if (previousPollInterval === undefined) delete process.env.CODELARK_CURSOR_DESKTOP_POLL_INTERVAL_MS;
    else process.env.CODELARK_CURSOR_DESKTOP_POLL_INTERVAL_MS = previousPollInterval;
    if (previousHookReconcileInterval === undefined) delete process.env.CODELARK_CURSOR_DESKTOP_HOOK_RECONCILE_INTERVAL_MS;
    else process.env.CODELARK_CURSOR_DESKTOP_HOOK_RECONCILE_INTERVAL_MS = previousHookReconcileInterval;
    if (previousLogsDir === undefined) delete process.env.CURSOR_LOGS_DIR;
    else process.env.CURSOR_LOGS_DIR = previousLogsDir;
    if (previousOutputIdleTimeout === undefined) delete process.env.CODELARK_CURSOR_DESKTOP_OUTPUT_IDLE_TIMEOUT_MS;
    else process.env.CODELARK_CURSOR_DESKTOP_OUTPUT_IDLE_TIMEOUT_MS = previousOutputIdleTimeout;
    if (previousQueuedIdleTimeout === undefined) delete process.env.CODELARK_CURSOR_DESKTOP_QUEUED_IDLE_TIMEOUT_MS;
    else process.env.CODELARK_CURSOR_DESKTOP_QUEUED_IDLE_TIMEOUT_MS = previousQueuedIdleTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function startBridge(
    onSend?: (payload: Record<string, unknown>) => void,
    sendStatus: 'submitted' | 'queued' | 'steered' | 'interrupt-requested' | 'idle' | 'error' = 'submitted',
    threadStatus: 'idle' | 'running' | 'completed' | 'error' | 'unknown' = 'completed',
    protocolVersion = 3,
    onReadEvents?: (payload: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        assert.equal(request.headers.authorization, `Bearer ${'a'.repeat(64)}`);
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.setHeader('content-type', 'application/json');
        if (payload.type === 'listThreads') {
          response.end(JSON.stringify({ threads: [{
            id: THREAD_ID,
            title: 'Existing Desktop thread',
            source: 'local',
            status: threadStatus,
            lastUpdatedAt: Date.now(),
            windowId: 1,
          }] }));
          return;
        }
        if (payload.type === 'readThreadEvents') {
          response.end(JSON.stringify(onReadEvents?.(payload) || {
            cursor: Number(payload.after) || 0,
            events: [],
          }));
          return;
        }
        onSend?.(payload);
        response.end(JSON.stringify({
          status: sendStatus,
          threadId: THREAD_ID,
          threadTitle: 'Existing Desktop thread',
          windowId: 1,
        }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, () => resolve());
    });
    fs.writeFileSync(path.join(bridgeDir, 'instance.json'), JSON.stringify({
      protocolVersion,
      pid: process.pid,
      socketPath,
      token: 'a'.repeat(64),
      appName: 'Cursor',
      appVersion: 'test',
      userDataDir: root,
      createdAt: Date.now(),
    }), { mode: 0o600 });
  }

  it('sends only to an exact live Desktop thread over the authenticated socket', async () => {
    let sent: Record<string, unknown> | undefined;
    await startBridge((payload) => { sent = payload; }, 'submitted', 'completed', 1);

    const result = await sendCursorDesktopMessage(THREAD_ID, 'hello desktop', { delivery: 'force' });

    assert.equal(result.status, 'submitted');
    assert.deepEqual(sent, {
      type: 'sendMessage',
      threadId: THREAD_ID,
      text: 'hello desktop',
      force: true,
    });
    await assert.rejects(
      () => sendCursorDesktopMessage('22222222-2222-4222-8222-222222222222', 'do not fallback'),
      /不会改用 CLI/,
    );
  });

  it('treats submitted as queued when an older Desktop Bridge reports the thread already running', async () => {
    await startBridge(undefined, 'submitted', 'running', 1);

    const result = await sendCursorDesktopMessage(THREAD_ID, 'queue behind current turn', { delivery: 'queue' });

    assert.equal(result.status, 'queued');
  });

  it('sends explicit steer without force to the bound running thread', async () => {
    const requests: Record<string, unknown>[] = [];
    await startBridge((payload) => { requests.push(payload); }, 'steered', 'running');
    const result = await sendCursorDesktopMessage(THREAD_ID, 'correct course');
    assert.deepEqual(requests, [{ type: 'sendMessage', threadId: THREAD_ID, text: 'correct course', delivery: 'steer' }]);
    assert.equal(result.actualDelivery, 'steer');
    assert.equal(result.status, 'steered');
  });

  it('rejects v1 steer before sending rather than enqueueing behind the active turn', async () => {
    const requests: unknown[] = [];
    await startBridge((payload) => { requests.push(payload); }, 'submitted', 'running', 1);
    await assert.rejects(sendCursorDesktopMessage(THREAD_ID, 'must steer'), /不支持 steer；消息未发送/);
    assert.deepEqual(requests, []);
  });

  it('accepts v2 submitted when the turn finished between discovery and send', async () => {
    await startBridge(undefined, 'submitted', 'running', 2);
    const result = await sendCursorDesktopMessage(THREAD_ID, 'new turn');
    assert.equal(result.status, 'submitted');
    assert.equal(result.actualDelivery, 'submitted');
  });

  it('sends Stop to the exact Desktop thread, independent of a local active task', async () => {
    const requests: unknown[] = [];
    await startBridge((payload) => { requests.push(payload); }, 'interrupt-requested', 'running');
    assert.deepEqual(await stopCursorDesktopThread(THREAD_ID), { status: 'interrupt-requested', threadId: THREAD_ID });
    assert.deepEqual(requests, [{ type: 'stopThread', threadId: THREAD_ID }]);
    await assert.rejects(stopCursorDesktopThread('missing-thread'), /不会改用 CLI/);
    assert.equal(requests.length, 1);
  });

  it('rejects unsupported Stop without sending or claiming the backend stopped', async () => {
    const requests: unknown[] = [];
    await startBridge((payload) => { requests.push(payload); }, 'submitted', 'running', 2);
    await assert.rejects(stopCursorDesktopThread(THREAD_ID), /未停止后端任务/);
    assert.deepEqual(requests, []);
  });

  it('rechecks the binding before sending Stop and propagates failed acknowledgement', async () => {
    const requests: unknown[] = [];
    await startBridge((payload) => { requests.push(payload); }, 'error', 'running');
    await assert.rejects(stopCursorDesktopThread(THREAD_ID, () => false), /绑定已变化/);
    assert.equal(requests.length, 0);
    await assert.rejects(stopCursorDesktopThread(THREAD_ID), /未确认停止请求/);
    assert.equal(requests.length, 1);
  });

  it('ignores a queued old turn and streams only the submitted Desktop turn', async () => {
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const transcript = getCursorTranscriptCandidates(THREAD_ID, cwd)[0]!;
    await startBridge((payload) => {
      assert.equal(payload.delivery, 'steer');
      assert.equal(payload.force, undefined);
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, [
        { role: 'assistant', message: { content: [{ type: 'text', text: 'OLD_TURN_OUTPUT' }] } },
        { type: 'turn_ended', status: 'success' },
        { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${payload.text}\n</user_query>` }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'NEW_TURN_OUTPUT' }] } },
        { type: 'turn_ended', status: 'success' },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    }, 'queued');

    let output = '';
    for await (const chunk of streamCursorDesktop({
      prompt: 'continue in desktop',
      cursorForce: true,
      sessionId: 'bridge-session',
      runtime: 'cursor',
      cursorProvider: 'tmux',
      cursorTransport: 'desktop',
      cursorSessionId: THREAD_ID,
      workingDirectory: cwd,
    })) output += chunk;

    assert.match(output, /NEW_TURN_OUTPUT/);
    assert.doesNotMatch(output, /OLD_TURN_OUTPUT/);
    assert.match(output, /"type":"result"/);
  });

  it('tracks the first new Desktop turn even when Cursor normalizes the submitted user text', async () => {
    const cwd = path.join(root, 'workspace-normalized');
    fs.mkdirSync(cwd, { recursive: true });
    const transcript = getCursorTranscriptCandidates(THREAD_ID, cwd)[0]!;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, [
      { role: 'user', message: { content: [{ type: 'text', text: 'old prompt' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'old answer' }] } },
      { type: 'turn_ended', status: 'success' },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    await startBridge(() => {
      fs.appendFileSync(transcript, [
        { role: 'user', message: { content: [{ type: 'text', text: 'Cursor-normalized follow-up without the original wire prompt' }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'NORMALIZED_PROMPT_OUTPUT' }] } },
        { type: 'turn_ended', status: 'success' },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    });

    let output = '';
    for await (const chunk of streamCursorDesktop({
      prompt: 'wire prompt that is not persisted verbatim',
      sessionId: 'bridge-session-normalized',
      runtime: 'cursor',
      cursorProvider: 'tmux',
      cursorTransport: 'desktop',
      cursorSessionId: THREAD_ID,
      workingDirectory: cwd,
    })) output += chunk;

    assert.match(output, /NORMALIZED_PROMPT_OUTPUT/);
    assert.doesNotMatch(output, /old answer/);
    assert.match(output, /"type":"result"/);
  });

  it('recovers the submitted turn when Cursor atomically replaces an existing transcript', async () => {
    const cwd = path.join(root, 'workspace-replaced');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionDir = path.join(process.env.CURSOR_CONFIG_DIR!, 'chats', cursorWorkspaceHash(cwd), THREAD_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'store.db'), 'placeholder');
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      title: 'Existing Desktop thread',
      createdAtMs: Date.now() - 10_000,
      updatedAtMs: Date.now() - 1_000,
      hasConversation: true,
      isSubagent: false,
      cwd,
    }));
    const transcript = getCursorTranscriptCandidates(THREAD_ID, cwd)[0]!;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'old prompt' }] } })}\n`);
    await startBridge((payload) => {
      const replacement = `${transcript}.next`;
      fs.writeFileSync(replacement, [
        { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${payload.text}\n</user_query>` }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'REPLACED_TRANSCRIPT_OUTPUT' }] } },
        { type: 'turn_ended', status: 'success' },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      fs.renameSync(replacement, transcript);
    });

    let output = '';
    for await (const chunk of streamCursorDesktop({
      prompt: 'atomic replacement prompt',
      sessionId: 'bridge-session-replaced',
      runtime: 'cursor',
      cursorProvider: 'tmux',
      cursorTransport: 'desktop',
      cursorSessionId: THREAD_ID,
      workingDirectory: cwd,
    })) output += chunk;

    assert.match(output, /REPLACED_TRANSCRIPT_OUTPUT/);
    assert.match(output, /"type":"result"/);
  });

  it('recovers when Cursor rewrites and grows the same transcript inode', async () => {
    const cwd = path.join(root, 'workspace-rewritten');
    fs.mkdirSync(cwd, { recursive: true });
    const transcript = getCursorTranscriptCandidates(THREAD_ID, cwd)[0]!;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'X'.repeat(2_000) }] } })}\n`);
    const initialInode = fs.statSync(transcript).ino;
    await startBridge((payload) => {
      fs.writeFileSync(transcript, [
        { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${payload.text}\n</user_query>` }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: `SAME_INODE_OUTPUT${'Y'.repeat(2_500)}` }] } },
        { type: 'turn_ended', status: 'success' },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      assert.equal(fs.statSync(transcript).ino, initialInode);
    });

    let output = '';
    for await (const chunk of streamCursorDesktop({
      prompt: 'same inode rewrite prompt',
      sessionId: 'bridge-session-rewritten',
      runtime: 'cursor',
      cursorProvider: 'tmux',
      cursorTransport: 'desktop',
      cursorSessionId: THREAD_ID,
      workingDirectory: cwd,
    })) output += chunk;

    assert.match(output, /SAME_INODE_OUTPUT/);
    assert.match(output, /"type":"result"/);
  });

  it('keeps waiting past transcript idle timeout while Desktop reports running', async () => {
    const cwd = path.join(root, 'workspace-running');
    fs.mkdirSync(cwd, { recursive: true });
    const transcript = getCursorTranscriptCandidates(THREAD_ID, cwd)[0]!;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    process.env.CODELARK_CURSOR_DESKTOP_POLL_INTERVAL_MS = '50';
    process.env.CODELARK_CURSOR_DESKTOP_OUTPUT_IDLE_TIMEOUT_MS = '1000';
    await startBridge((payload) => {
      setTimeout(() => {
        fs.writeFileSync(transcript, [
          { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${payload.text}\n</user_query>` }] } },
          { role: 'assistant', message: { content: [{ type: 'text', text: 'OUTPUT_AFTER_IDLE_WINDOW' }] } },
          { type: 'turn_ended', status: 'success' },
        ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      }, 1_250);
    }, 'submitted', 'running');

    let output = '';
    for await (const chunk of streamCursorDesktop({
      prompt: 'long running desktop prompt',
      sessionId: 'bridge-session-running',
      runtime: 'cursor',
      cursorProvider: 'tmux',
      cursorTransport: 'desktop',
      cursorSessionId: THREAD_ID,
      cursorForce: true,
      workingDirectory: cwd,
    })) output += chunk;

    assert.match(output, /后端仍为 running/);
    assert.match(output, /OUTPUT_AFTER_IDLE_WINDOW/);
    assert.match(output, /"type":"result"/);
  });

  it('uses protocol v2 realtime events as liveness while collecting the final transcript', async () => {
    const cwd = path.join(root, 'workspace-realtime');
    fs.mkdirSync(cwd, { recursive: true });
    const transcript = getCursorTranscriptCandidates(THREAD_ID, cwd)[0]!;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    process.env.CODELARK_CURSOR_DESKTOP_POLL_INTERVAL_MS = '50';
    let eventsRead = 0;
    await startBridge((payload) => {
      if (payload.type !== 'sendMessage') return;
      setTimeout(() => {
        fs.writeFileSync(transcript, [
          { role: 'user', message: { content: [{ type: 'text', text: 'normalized realtime input' }] } },
          { role: 'assistant', message: { content: [{ type: 'text', text: 'REALTIME_FINAL_OUTPUT' }] } },
          { type: 'turn_ended', status: 'success' },
        ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      }, 350);
    }, 'submitted', 'running', 2, () => {
      eventsRead += 1;
      return eventsRead === 1
        ? {
            cursor: 1,
            events: [{
              sequence: 1,
              type: 'snapshot',
              threadId: THREAD_ID,
              status: 'generating',
              model: 'claude-sonnet-test',
              timestamp: Date.now(),
              snapshot: {},
            }],
          }
        : { cursor: 1, events: [] };
    });

    let output = '';
    for await (const chunk of streamCursorDesktop({
      prompt: 'realtime input',
      sessionId: 'bridge-session-realtime',
      runtime: 'cursor',
      cursorProvider: 'tmux',
      cursorTransport: 'desktop',
      cursorSessionId: THREAD_ID,
      workingDirectory: cwd,
    })) output += chunk;

    assert.match(output, /实时事件已连接/);
    assert.match(output, /claude-sonnet-test/);
    assert.match(output, /REALTIME_FINAL_OUTPUT/);
    assert.match(output, /"type":"result"/);
  });

  it('streams Cursor hook thoughts and tool lifecycle before the final transcript', async () => {
    const cwd = path.join(root, 'workspace-hooks');
    fs.mkdirSync(cwd, { recursive: true });
    const transcript = getCursorTranscriptCandidates(THREAD_ID, cwd)[0]!;
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    const hookDir = path.join(process.env.CURSOR_LOGS_DIR!, '20261009T030000', 'window1', 'output');
    fs.mkdirSync(hookDir, { recursive: true });
    const hookLog = path.join(hookDir, 'cursor.hooks.workspace.log');
    fs.writeFileSync(hookLog, '');
    const longThought = `${'Detailed reasoning that remains available after folding. '.repeat(45)}FULL_END`;
    assert.ok(Array.from(longThought).length > 2_000);
    process.env.CODELARK_CURSOR_DESKTOP_POLL_INTERVAL_MS = '50';
    process.env.CODELARK_CURSOR_DESKTOP_HOOK_RECONCILE_INTERVAL_MS = '50';
    const hookBlock = (timestamp: string, step: string, input: Record<string, unknown>) => [
      `[${timestamp}] Hook step requested: ${step}`,
      'INPUT:',
      JSON.stringify(input, null, 2),
      '',
    ].join('\n');
    await startBridge((payload) => {
      if (payload.type !== 'sendMessage') return;
      setTimeout(() => {
        fs.writeFileSync(transcript, [
          { role: 'user', message: { content: [{ type: 'text', text: String(payload.text) }] } },
          { role: 'assistant', message: { content: [{
            type: 'tool_use',
            name: 'Shell',
            input: { command: 'pwd', description: 'Print working directory' },
          }] } },
        ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      }, 50);
      setTimeout(() => {
        fs.appendFileSync(hookLog, [
          hookBlock('2026-10-09T03:00:01.000Z', 'afterAgentThought', {
            conversation_id: THREAD_ID,
            generation_id: 'generation-live',
            model: 'claude-opus-live-high',
            text: 'I am checking the workspace now.',
          }),
          hookBlock('2026-10-09T03:00:01.500Z', 'afterAgentThought', {
            conversation_id: THREAD_ID,
            generation_id: 'generation-live',
            model: 'claude-opus-live-high',
            text: longThought,
          }),
          hookBlock('2026-10-09T03:00:02.000Z', 'preToolUse', {
            conversation_id: THREAD_ID,
            generation_id: 'generation-live',
            model: 'claude-opus-live-high',
            tool_name: 'Shell',
            tool_use_id: 'tool-live-1',
            tool_input: { command: 'pwd', cwd: '', timeout: 30_000 },
          }),
          hookBlock('2026-10-09T03:00:03.000Z', 'postToolUse', {
            conversation_id: THREAD_ID,
            generation_id: 'generation-live',
            model: 'claude-opus-live-high',
            tool_name: 'Shell',
            tool_use_id: 'tool-live-1',
            tool_output: JSON.stringify({ output: '/workspace-hooks' }),
          }),
        ].join(''));
      }, 100);
      setTimeout(() => {
        fs.appendFileSync(transcript, [
          { role: 'tool', message: { content: [{
            type: 'text',
            text: JSON.stringify({ tool_name: 'Shell', tool_result: '/workspace-hooks-final' }),
          }] } },
          { role: 'assistant', message: { content: [{ type: 'text', text: 'HOOK_FINAL_OUTPUT' }] } },
          { type: 'turn_ended', status: 'success' },
        ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      }, 250);
    }, 'submitted', 'completed');

    let output = '';
    for await (const chunk of streamCursorDesktop({
      prompt: 'show hooks live',
      sessionId: 'bridge-session-hooks',
      runtime: 'cursor',
      cursorProvider: 'tmux',
      cursorTransport: 'desktop',
      cursorSessionId: THREAD_ID,
      workingDirectory: cwd,
    })) output += chunk;

    const events = output.trim().split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; data: string });
    const historyItems = events
      .filter((event) => event.type === 'history_item')
      .map((event) => JSON.parse(event.data) as Record<string, unknown>);
    const statuses = events
      .filter((event) => event.type === 'status')
      .map((event) => JSON.parse(event.data) as Record<string, unknown>);

    assert.deepEqual(historyItems.find((item) => String(item.content).includes('checking the workspace')), {
      type: 'markdown',
      role: 'thinking',
      content: '> I am checking the workspace now.',
    });
    const foldedThought = historyItems.find((item) => item.collapseTitle === '💭 Cursor 思考 · 展开查看');
    assert.equal(String(foldedThought?.content).endsWith('FULL_END'), true);
    assert.equal(String(foldedThought?.content).includes('实时思考已截断'), false);
    assert.equal(statuses.some((status) => 'thinking' in status), false);
    assert.equal(statuses.some((status) => status.reasoning === 'Cursor 正在思考'), true);
    assert.match(output, /claude-opus-live-high/);
    assert.match(output, /"type":"tool_use"/);
    assert.doesNotMatch(output, /tool-live-1/);
    assert.match(output, /"type":"tool_result"/);
    assert.match(output, /\/workspace-hooks/);
    assert.doesNotMatch(output, /Cursor 已完成工具/);
    assert.match(output, /HOOK_FINAL_OUTPUT/);
    assert.equal(output.match(/"type":"tool_use"/g)?.length, 1);
  });
});
