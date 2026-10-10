import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { _testOnlyCursorDesktopStatus } from '../../../../bridge/command/tmux.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { makeBridgeSettings, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

const THREAD_ID = '22222222-2222-4222-8222-222222222222';

describe('Cursor Desktop /tmux-screen status', () => {
  let root = '';
  let server: http.Server | undefined;
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    resetBridgeTestState();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-cursor-status-'));
    for (const name of ['CURSOR_DESKTOP_BRIDGE_DIR', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'CURSOR_LOGS_DIR']) {
      previousEnv.set(name, process.env[name]);
      process.env[name] = path.join(root, name.toLowerCase());
    }
    const bridgeDir = process.env.CURSOR_DESKTOP_BRIDGE_DIR!;
    const socketPath = process.platform === 'win32'
      ? String.raw`\\.\pipe\codelark-cursor-${randomUUID()}`
      : path.join(root, 'bridge.sock');
    fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(bridgeDir, 0o700);
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        assert.equal(request.headers.authorization, `Bearer ${'b'.repeat(64)}`);
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { type?: string };
        assert.equal(payload.type, 'listThreads');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ threads: [{
          id: THREAD_ID.toUpperCase(),
          title: 'Visible Desktop thread',
          source: 'local',
          status: 'running',
          lastUpdatedAt: Date.now(),
          windowId: 7,
        }] }));
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
      token: 'b'.repeat(64),
      appName: 'Cursor',
      appVersion: 'test',
      userDataDir: root,
      createdAt: Date.now(),
    }), { mode: 0o600 });
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    previousEnv.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shows the authoritative running state without requiring a tmux session', async () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Cursor Desktop', 'default', undefined, '/tmp/cursor-desktop-status');
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'cursor',
        cursor: { sessionId: THREAD_ID, provider: 'desktop', cwd: '/tmp/cursor-desktop-status' },
      },
    });
    const binding = store.upsertChannelChat({
      channelType: 'feishu',
      chatId: 'chat-cursor-desktop-status',
      bridgeSessionId: session.id,
    });

    const result = await _testOnlyCursorDesktopStatus.build(store.getSession(session.id)!, binding, true, 5);

    assert.match(result.text, /Cursor Desktop 后端状态/);
    assert.match(result.text, /Provider[\s\S]*tmux/);
    assert.doesNotMatch(result.text, /Provider[^\n]*desktop/);
    assert.match(result.text, /后端状态[\s\S]*running/);
    assert.match(result.text, /Visible Desktop thread/);
    assert.match(result.text, /running 来自 Cursor 客户端内部 agent\/composer store/);
    assert.match(result.text, /定时刷新[\s\S]*5s/);
    assert.match(result.statusText, /Cursor Desktop · running/);
  });
});
