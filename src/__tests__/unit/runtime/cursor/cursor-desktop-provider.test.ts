import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { sendCursorDesktopMessage } from '../../../../runtime/cursor/desktop-bridge-client.js';
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

  beforeEach(async () => {
    previousBridgeDir = process.env.CURSOR_DESKTOP_BRIDGE_DIR;
    previousDataDir = process.env.CURSOR_DATA_DIR;
    previousConfigDir = process.env.CURSOR_CONFIG_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-cursor-desktop-'));
    bridgeDir = path.join(root, 'desktop-bridge');
    socketPath = path.join(root, 'bridge.sock');
    fs.mkdirSync(bridgeDir, { mode: 0o700 });
    fs.chmodSync(bridgeDir, 0o700);
    process.env.CURSOR_DESKTOP_BRIDGE_DIR = bridgeDir;
    process.env.CURSOR_DATA_DIR = path.join(root, 'cursor-data');
    process.env.CURSOR_CONFIG_DIR = path.join(root, 'cursor-config');
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
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function startBridge(
    onSend?: (payload: Record<string, unknown>) => void,
    sendStatus: 'submitted' | 'queued' = 'submitted',
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
            status: 'completed',
            lastUpdatedAt: Date.now(),
            windowId: 1,
          }] }));
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
      protocolVersion: 1,
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
    await startBridge((payload) => { sent = payload; });

    const result = await sendCursorDesktopMessage(THREAD_ID, 'hello desktop', { force: true });

    assert.equal(result.status, 'submitted');
    assert.deepEqual(sent, {
      type: 'sendMessage',
      threadId: THREAD_ID,
      text: 'hello desktop',
      force: true,
    });
    await assert.rejects(
      () => sendCursorDesktopMessage('22222222-2222-4222-8222-222222222222', 'do not fallback'),
      /不会降级到 tmux/,
    );
  });

  it('ignores a queued old turn and streams only the submitted Desktop turn', async () => {
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const transcript = getCursorTranscriptCandidates(THREAD_ID, cwd)[0]!;
    await startBridge((payload) => {
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
      sessionId: 'bridge-session',
      runtime: 'cursor',
      cursorProvider: 'desktop',
      cursorSessionId: THREAD_ID,
      workingDirectory: cwd,
    })) output += chunk;

    assert.match(output, /NEW_TURN_OUTPUT/);
    assert.doesNotMatch(output, /OLD_TURN_OUTPUT/);
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
      cursorProvider: 'desktop',
      cursorSessionId: THREAD_ID,
      workingDirectory: cwd,
    })) output += chunk;

    assert.match(output, /REPLACED_TRANSCRIPT_OUTPUT/);
    assert.match(output, /"type":"result"/);
  });
});
