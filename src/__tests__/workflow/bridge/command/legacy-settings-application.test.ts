import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { initBridgeTestContext, resetBridgeTestState, RecordingAdapter, inboundMessage } from '../../../helpers/bridge/test-bridge-utils.js';
import { createConfigService } from '../../../../configuration/service.js';
import { handleBridgeCommand } from '../../../../bridge/command/index.js';
import { processMessage } from '../../../../bridge/turn/interactive/sdk-conversation-engine.js';
import { CodexProvider } from '../../../../runtime/codex/provider.js';
import { consumeSseEvents } from '../../../../runtime/sse-stream-decoder.js';
import { normalizeReasoningEffort, normalizeSandboxMode } from '../../../../runtime/options.js';

it('legacy SDK resume uses changed model and permissions only on the next request', async (t) => {
  resetBridgeTestState();
  const store = initBridgeTestContext();
  const session = store.createSession('legacy-settings', '', '', os.tmpdir());
  const threadId = '44444444-4444-4444-8444-444444444444';
  store.updateSession(session.id, { runtime: { codex: { threadId } } });
  const address = { channelType: 'feishu', chatId: `legacy-settings-${session.id}` };
  const binding = store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  const service = createConfigService({ migrate: false, env: {} });
  service.set({ kind: 'home' }, { runtime: { codex: { model: 'gpt-5.4' } } });
  service.set({ kind: 'session', sessionId: session.id }, { runtime: { codex: { provider: 'sdk', model: 'before', yoloMode: 'off', sandboxMode: 'read-only' } } });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  t.after(() => release());
  const calls: Array<{ id: string; options: Record<string, unknown> }> = [];
  const provider = new CodexProvider();
  (provider as any).sdk = {};
  (provider as any).codex = {
    startThread: () => assert.fail('不能丢弃已有thread'),
    resumeThread: (id: string, options: Record<string, unknown>) => {
      calls.push({ id, options });
      const index = calls.length;
      return { runStreamed: () => ({ events: (async function* () {
        if (index === 1) { started(); await held; }
        yield { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'ok' } };
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
      })() }) };
    },
  };
  const runtime = { store, llm: provider, consumeSseEvents, normalizeReasoningEffort, normalizeSandboxMode };
  const run = () => processMessage(binding, 'hello', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);
  const active = run();
  await ready;
  const adapter = new RecordingAdapter();
  const command = (text: string) => handleBridgeCommand(adapter, inboundMessage(address, text, text), text, {
    getActiveTask: () => undefined, diagnoseSessionHealth: async () => null, diagnoseAllActiveSessions: async () => [],
  });
  await command('/model gpt-5.4');
  await command('/yolo');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options.model, 'before');
  assert.equal(calls[0]!.options.sandboxMode, 'read-only');
  release();
  assert.equal((await active).hasError, false);
  assert.equal((await run()).hasError, false);
  assert.equal(calls[1]!.id, threadId);
  assert.equal(calls[1]!.options.model, 'gpt-5.4');
  assert.equal(calls[1]!.options.approvalPolicy, 'never');
  assert.equal(calls[1]!.options.sandboxMode, 'danger-full-access');
  await command('/yolo off');
  await command('/model default');
  assert.equal((await run()).hasError, false);
  assert.equal(calls[2]!.options.model, 'gpt-5.4');
  assert.equal(calls[2]!.options.approvalPolicy, 'on-request');
  assert.equal(calls[2]!.options.sandboxMode, 'read-only');
});
