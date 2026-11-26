import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StructuredStreamingUiMetadata } from '../../../../channels/contracts.js';
import { _testOnly, registerAdapter } from '../../../../bridge/host/manager.js';
import { CodexRoutingProvider } from '../../../../runtime/codex/routing-provider.js';
import { closeAllDoubaoAcpSessions } from '../../../../runtime/doubao/acp-provider.js';
import { resolveDoubaoExecutable } from '../../../../runtime/doubao/models.js';
import { archiveDoubaoSession, listDoubaoSessions } from '../../../../runtime/doubao/session-index.js';
import { getSessionDoubaoSessionId } from '../../../../domain/session-runtime.js';
import {
  inboundMessage,
  initBridgeTestContext,
  makeBridgeSettings,
  RecordingAdapter,
  resetBridgeTestState,
} from '../../../helpers/bridge/test-bridge-utils.js';
import { removeRuntimeTestDirectory, waitForCondition } from '../../../helpers/runtime/real-codex-e2e-utils.js';

function doubaoAvailable(executable: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(executable, ['--version'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    windowsHide: true,
  });
  return result.status === 0;
}

class DoubaoStreamingRecordingAdapter extends RecordingAdapter {
  readonly streamEvents: Array<{
    kind: 'metadata' | 'status' | 'text' | 'end';
    streamKey?: string;
    text?: string;
    status?: string;
  }> = [];
  private readonly activeStreams = new Set<string>();

  onStreamMetadata(_chatId: string, _metadata: StructuredStreamingUiMetadata, streamKey?: string): void {
    this.streamEvents.push({ kind: 'metadata', streamKey });
  }

  onStreamStatus(_chatId: string, text: string, streamKey?: string): void {
    if (streamKey) this.activeStreams.add(streamKey);
    this.streamEvents.push({ kind: 'status', streamKey, text });
  }

  onStreamText(_chatId: string, text: string, streamKey?: string): void {
    if (streamKey) this.activeStreams.add(streamKey);
    this.streamEvents.push({ kind: 'text', streamKey, text });
  }

  async onStreamEnd(
    _chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    text: string,
    streamKey?: string,
  ): Promise<boolean> {
    this.streamEvents.push({ kind: 'end', streamKey, status, text });
    if (streamKey) this.activeStreams.delete(streamKey);
    return true;
  }

  supportsStructuredStreamingUi(): boolean { return true; }

  hasActiveStreamingUi(_chatId: string, streamKey?: string): boolean {
    return Boolean(streamKey && this.activeStreams.has(streamKey));
  }
}

describe('real Doubao CLI bridge e2e', () => {
  afterEach(async () => {
    await closeAllDoubaoAcpSessions();
    _testOnly.resetStateForTests();
    resetBridgeTestState();
  });

  it('runs real Doubao ACP turns through bridge, hot-updates reasoning, resumes across process restart without replay, and cleans up', { timeout: 240_000 }, async (t: TestContext) => {
    if (process.env.CODELARK_REAL_DOUBAO_E2E !== '1') {
      t.skip('set CODELARK_REAL_DOUBAO_E2E=1 to run against the authenticated real Doubao CLI');
      return;
    }

    const executable = resolveDoubaoExecutable();
    const hostHome = process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir();
    if (!doubaoAvailable(executable, { ...process.env, HOME: hostHome })) {
      t.skip(`real doubao executable is not available at ${executable}`);
      return;
    }

    const savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    };

    // Temporarily point HOME/XDG_* to host home so real doubao CLI uses host login credentials
    // while keeping CODELARK_HOME isolated inside the test temp directory.
    process.env.HOME = hostHome;
    process.env.USERPROFILE = hostHome;
    process.env.XDG_DATA_HOME = path.join(hostHome, '.local', 'share');
    process.env.XDG_CONFIG_HOME = path.join(hostHome, '.config');
    process.env.XDG_CACHE_HOME = path.join(hostHome, '.cache');

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-real-doubao-e2e-'));
    const fixtureFile = path.join(workDir, 'probe.txt');
    const token = `DOUBAO_REAL_E2E_${Date.now()}`;
    fs.writeFileSync(fixtureFile, `secret_value=${token}\n`, 'utf-8');

    let createdNativeSessionId: string | undefined;

    try {
      const store = initBridgeTestContext({
        dynamicSettings: true,
        settings: makeBridgeSettings({
          bridge_default_work_dir: workDir,
        }),
        llm: new CodexRoutingProvider(),
      });
      const adapter = new DoubaoStreamingRecordingAdapter();
      registerAdapter(adapter);
      const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
      bridgeState.running = true;
      const address = {
        channelType: 'feishu',
        chatId: `chat-real-doubao-${Date.now()}`,
        userId: 'ou-real-doubao',
      } as const;

      // 1. Switch to doubao runtime, workDir, yolo mode, and low reasoning via real slash commands
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime doubao', 'msg-runtime'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/cd ${workDir}`, 'msg-cd'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/mode yolo', 'msg-mode'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/reasoning low', 'msg-reasoning'));

      // 2. Turn 1: real tool use (read local probe file) + reply exact token
      await _testOnly.handleMessage(
        adapter,
        inboundMessage(
          address,
          `请读取当前工作目录下的 probe.txt 文件，并只在最终回复中精确输出里面的 secret_value（即 ${token} 对应的值），不要多余解释。`,
          'msg-turn-1',
        ),
      );

      assert.equal(
        await waitForCondition(() => adapter.streamEvents.filter((event) => event.kind === 'end').length >= 1, 90_000, 250),
        true,
        `turn 1 should reach terminal; events=${JSON.stringify(adapter.streamEvents)}`,
      );
      const endsAfterTurn1 = adapter.streamEvents.filter((event) => event.kind === 'end');
      assert.equal(endsAfterTurn1[0]!.status, 'completed', `turn 1 terminal=${JSON.stringify(endsAfterTurn1[0])}`);
      assert.match(endsAfterTurn1[0]!.text || '', new RegExp(token));

      const bindingAfterTurn1 = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(bindingAfterTurn1);
      const sessionAfterTurn1 = store.getSession(bindingAfterTurn1.bridgeSessionId);
      assert.equal(sessionAfterTurn1?.runtime?.activeRuntime, 'doubao');
      createdNativeSessionId = getSessionDoubaoSessionId(sessionAfterTurn1);
      assert.ok(createdNativeSessionId && createdNativeSessionId.length >= 8, 'should persist native doubao sessionId');

      // 3. Simulate bridge restart: close live ACP child process, then send Turn 2 to trigger session/load
      await closeAllDoubaoAcpSessions();
      const turn2Marker = `RESUME_OK_${Date.now()}`;
      await _testOnly.handleMessage(
        adapter,
        inboundMessage(
          address,
          `只回复两个词，用空格隔开：你上一轮读到的 secret_value 和 ${turn2Marker}。不要重复上一轮其它内容。`,
          'msg-turn-2',
        ),
      );

      assert.equal(
        await waitForCondition(() => adapter.streamEvents.filter((event) => event.kind === 'end').length >= 2, 90_000, 250),
        true,
        `turn 2 should reach terminal; events=${JSON.stringify(adapter.streamEvents)}`,
      );
      const endsAfterTurn2 = adapter.streamEvents.filter((event) => event.kind === 'end');
      assert.equal(endsAfterTurn2[1]!.status, 'completed', `turn 2 terminal=${JSON.stringify(endsAfterTurn2[1])}`);
      const turn2Text = endsAfterTurn2[1]!.text || '';
      assert.match(turn2Text, new RegExp(token), 'resumed session should remember turn 1 token');
      assert.match(turn2Text, new RegExp(turn2Marker), 'resumed session should include turn 2 marker');

      const sessionAfterTurn2 = store.getSession(bindingAfterTurn1.bridgeSessionId);
      assert.equal(
        getSessionDoubaoSessionId(sessionAfterTurn2),
        createdNativeSessionId,
        'resumed turn should preserve the same native doubao sessionId',
      );

      // 4. Verify session listing via ACP session/list finds the created session and archive deletes it cleanly
      const listed = await listDoubaoSessions({ forceRefresh: true, cwd: workDir });
      assert.ok(
        listed.some((item) => item.sessionId === createdNativeSessionId),
        `expected listDoubaoSessions to include ${createdNativeSessionId}, got ${listed.map((i) => i.sessionId).join(', ')}`,
      );
      const deleted = archiveDoubaoSession(createdNativeSessionId);
      assert.equal(deleted, true, `expected archiveDoubaoSession(${createdNativeSessionId}) to succeed`);
      createdNativeSessionId = undefined;
    } finally {
      await closeAllDoubaoAcpSessions();
      if (createdNativeSessionId) {
        try {
          archiveDoubaoSession(createdNativeSessionId);
        } catch {
          // Best-effort cleanup of cloud session.
        }
      }
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeRuntimeTestDirectory(workDir);
    }
  });
});
