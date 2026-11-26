import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  DoubaoAcpProvider,
  closeAllDoubaoAcpSessions,
  closeDoubaoAcpSession,
  interruptDoubaoAcpSession,
} from '../../../../runtime/doubao/acp-provider.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';
import { processMessage } from '../../../../bridge/turn/interactive/sdk-conversation-engine.js';
import { consumeSseEvents } from '../../../../runtime/sse-stream-decoder.js';
import { normalizeReasoningEffort, normalizeSandboxMode } from '../../../../runtime/options.js';
import { initBridgeTestContext, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';
import { createConfigService } from '../../../../configuration/service.js';

function createFakeDoubaoCliScript(dir: string): string {
  const scriptPath = path.join(dir, 'fake-doubao.mjs');
  const script = `#!/usr/bin/env node
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args[0] !== 'acp' || args[1] !== 'serve') {
  process.stderr.write('unexpected args: ' + args.join(' ') + '\\n');
  process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let modeId = 'default';
let modelId = 'doubao-seed-2.0-code';
let effort = 'medium';
let nativeSessionId = 'e2e-doubao-session-1';
let activePromptTimer = null;
let activePromptId = null;
let pendingPermissionId = null;
let pendingPermissionPromptId = null;

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
}

function update(u) {
  send({ method: 'session/update', params: { sessionId: nativeSessionId, update: u } });
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  // Response to server->client request (permission)
  if (msg.id !== undefined && !msg.method) {
    if (msg.id === pendingPermissionId && pendingPermissionPromptId !== null) {
      const outcome = msg.result?.outcome?.optionId || 'unknown';
      const promptId = pendingPermissionPromptId;
      pendingPermissionId = null;
      pendingPermissionPromptId = null;
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'e2e-tool-1', status: 'completed', rawOutput: 'perm=' + outcome });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '审批结果:' + outcome } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
    }
    return;
  }

  if (msg.method === 'initialize') {
    send({
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    send({
      id: msg.id,
      result: {
        sessionId: nativeSessionId,
        modes: { currentModeId: modeId, availableModes: [{ id: 'default' }, { id: 'plan' }, { id: 'bypass_permissions' }] },
        configOptions: [
          { id: 'model', currentValue: modelId, options: [{ value: 'doubao-seed-2.0-code' }, { value: 'doubao-seed-2.0-pro' }] },
          { id: 'effort', currentValue: effort, options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
        ],
      },
    });
    return;
  }

  if (msg.method === 'session/load') {
    nativeSessionId = msg.params.sessionId;
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE REPLAY MUST BE DROPPED' } });
    send({
      id: msg.id,
      result: {
        modes: { currentModeId: modeId },
        configOptions: [
          { id: 'model', currentValue: modelId, options: [{ value: 'doubao-seed-2.0-code' }, { value: 'doubao-seed-2.0-pro' }] },
          { id: 'effort', currentValue: effort, options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
        ],
      },
    });
    return;
  }

  if (msg.method === 'session/set_mode') {
    modeId = msg.params.modeId;
    send({ id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    if (msg.params.configId === 'model') modelId = msg.params.value;
    if (msg.params.configId === 'effort') effort = msg.params.value;
    send({
      id: msg.id,
      result: {
        configOptions: [
          { id: 'model', currentValue: modelId, options: [{ value: 'doubao-seed-2.0-code' }, { value: 'doubao-seed-2.0-pro' }] },
          { id: 'effort', currentValue: effort, options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
        ],
      },
    });
    return;
  }

  if (msg.method === 'session/cancel') {
    if (activePromptTimer) {
      clearTimeout(activePromptTimer);
      activePromptTimer = null;
    }
    if (activePromptId !== null) {
      const id = activePromptId;
      activePromptId = null;
      send({ id, result: { stopReason: 'cancelled' } });
    }
    return;
  }

  if (msg.method === 'session/prompt') {
    const promptText = msg.params?.prompt?.[0]?.text || '';
    if (promptText === 'SLOW_CANCEL') {
      activePromptId = msg.id;
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial-before-cancel' } });
      activePromptTimer = setTimeout(() => {
        activePromptTimer = null;
        activePromptId = null;
        send({ id: msg.id, result: { stopReason: 'end_turn' } });
      }, 10_000);
      return;
    }

    if (promptText === 'NEED_PERM') {
      pendingPermissionId = 5001;
      pendingPermissionPromptId = msg.id;
      update({ sessionUpdate: 'tool_call', toolCallId: 'e2e-tool-1', title: 'Run check', kind: 'execute', rawInput: { command: 'echo ok' } });
      send({
        id: pendingPermissionId,
        method: 'session/request_permission',
        params: {
          sessionId: nativeSessionId,
          toolCall: { toolCallId: 'e2e-tool-1', title: 'Run check', kind: 'execute' },
          options: [
            { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
      return;
    }

    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'reply:' + promptText + '|mode=' + modeId + '|model=' + modelId + '|effort=' + effort },
    });
    send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

afterEach(async () => {
  await closeAllDoubaoAcpSessions();
  resetBridgeTestState();
});

describe('Doubao ACP local-process E2E', () => {
  it('runs multi-turn conversation, hot-updates mode/model/effort, handles permission approval, cancels cleanly, and resumes across processes without replay', { timeout: 20_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-doubao-e2e-'));
    const scriptPath = createFakeDoubaoCliScript(tmpDir);
    try {
      const permissions = new PendingPermissions();
      const provider = new DoubaoAcpProvider(permissions, {
        executable: scriptPath,
        cancelTimeoutMs: 1_000,
      });

      const store = initBridgeTestContext({ llm: provider });
      const session = store.createSession('Doubao E2E', 'default', undefined, tmpDir);
      store.updateSession(session.id, { runtime: { activeRuntime: 'doubao' } });
      const binding = store.upsertChannelChat({
        channelType: 'feishu',
        chatId: `doubao-e2e-${randomUUID()}`,
        bridgeSessionId: session.id,
      });

      const cfg = createConfigService({ migrate: false });
      cfg.set({ kind: 'session', sessionId: session.id }, {
        runtime: { doubao: { mode: 'plan', model: 'doubao-seed-2.0-pro', reasoningEffort: 'high' } },
      });

      const port = {
        store,
        llm: provider,
        normalizeReasoningEffort,
        normalizeSandboxMode,
        consumeSseEvents,
      };

      // Turn 1: 新会话 + 热设置 mode/model/effort
      const r1 = await processMessage(
        binding,
        'hello-1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { isCurrentTask: () => true },
        port,
      );
      assert.equal(r1.outcome, 'completed');
      assert.equal(r1.responseText, 'reply:hello-1|mode=plan|model=doubao-seed-2.0-pro|effort=high');
      const after1 = store.getSession(session.id)!;
      assert.equal(after1.runtime?.doubao?.sessionId, 'e2e-doubao-session-1');

      // Turn 2: 权限请求审批
      let sawPermission = false;
      const r2 = await processMessage(
        binding,
        'NEED_PERM',
        async (perm) => {
          sawPermission = true;
          permissions.resolve(perm.permissionRequestId, { behavior: 'allow' });
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { isCurrentTask: () => true },
        port,
      );
      assert.equal(sawPermission, true);
      assert.equal(r2.outcome, 'completed');
      assert.equal(r2.responseText, '审批结果:allow-once');

      // Turn 3: 中途打断
      const abort = new AbortController();
      const r3Promise = processMessage(
        binding,
        'SLOW_CANCEL',
        undefined,
        abort.signal,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { isCurrentTask: () => true },
        port,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      abort.abort();
      const interrupted = await interruptDoubaoAcpSession(session.id);
      assert.equal(interrupted, true);
      const r3 = await r3Promise;
      assert.equal(r3.outcome, 'aborted');

      // Turn 4: 关闭进程后跨进程 session/load，验证跳过历史 replay 且保留会话
      await closeDoubaoAcpSession(session.id);
      cfg.set({ kind: 'session', sessionId: session.id }, {
        runtime: { doubao: { mode: 'yolo' } },
      });
      const r4 = await processMessage(
        binding,
        'after-restart',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { isCurrentTask: () => true },
        port,
      );
      assert.equal(r4.outcome, 'completed');
      assert.equal(r4.responseText, 'reply:after-restart|mode=bypass_permissions|model=doubao-seed-2.0-pro|effort=high');
      assert.ok(!r4.responseText.includes('STALE REPLAY'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
