import '../../../setup/test-setup.js';
import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { initBridgeTestContext, resetBridgeTestState, RecordingAdapter, inboundMessage } from '../../../helpers/bridge/test-bridge-utils.js';
import { createConfigService } from '../../../../configuration/service.js';
import { handleBridgeCommand } from '../../../../bridge/command/index.js';
import { parseCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';

beforeEach(() => resetBridgeTestState());
function fixture() {
  const store = initBridgeTestContext();
  const service = createConfigService({ migrate: false, env: {} });
  const session = store.createSession('form', 'gpt-5.4', '', os.tmpdir());
  const scope = { kind: 'session' as const, sessionId: session.id };
  service.set(scope, { runtime: { agent: 'codex', claude: { model: 'before', provider: 'sdk' } } });
  store.updateSession(session.id, { runtime_status: 'running', health_status: 'running_active' });
  const address = { channelType: 'feishu', chatId: `form-${session.id}` };
  store.upsertChannelChat({ ...address, bridgeSessionId: session.id });
  const adapter = new RecordingAdapter();
  const abortController = new AbortController();
  const command = async (text: string, form?: Record<string, string>) => {
    const msg = inboundMessage(address, text, `form-${adapter.sent.length}`);
    if (form) msg.raw = { action: { form_value: form } };
    await handleBridgeCommand(adapter, msg, text, {
      getActiveTask: () => ({ abortController }),
      diagnoseSessionHealth: async () => null, diagnoseAllActiveSessions: async () => [],
    });
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(abortController.signal.aborted, false);
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, session.id);
    assert.equal(service.get('runtime.agent', scope), 'codex');
    return adapter.sent.at(-1)!;
  };
  return { store, service, session, scope, command };
}

it('editing another runtime is independent of the active task and applies a validated form together', async () => {
  const f = fixture();
  const card = (await f.command('/current-runtime claude')).richCard!;
  assert.equal(parseCommandCallbackData(card.form!.submitCallbackData)?.scopeSessionId, f.session.id);
  const before = f.service.snapshot(f.scope).config;
  assert.match((await f.command('/current-config claude', { claudeDefaultModel: 'after', cld_idle_min: '-1' })).text, /配置未保存/);
  assert.deepEqual(f.service.snapshot(f.scope).config, before, '后面的无效字段不能留下前面模型修改');
  assert.match((await f.command('/current-config claude', { claudeDefaultModel: 'after', cld_idle_min: '15' })).text, /已保存当前会话配置/);
  assert.equal(f.service.get('runtime.claude.model', f.scope), 'after');
  assert.equal(f.service.get('runtime.claude.idleTimeoutMinutes', f.scope), 15);
});

it('invalid directory prevents the name and other form values from being saved', async () => {
  const f = fixture();
  assert.match((await f.command('/current-config common', { clk_name: 'new name', clk_cwd: `/missing-${f.session.id}`, tmuxCaptureLines: '123' })).text, /配置未保存/);
  assert.equal(f.store.getSession(f.session.id)?.name, 'form');
  assert.equal(f.service.get('session.workspace', f.scope), os.tmpdir());
  assert.notEqual(f.service.get('session.tmuxCaptureLines', f.scope), 123);
});

it('Desktop Cursor cards omit unsupported model controls and stale forms cannot save model overrides', async () => {
  const f = fixture();
  f.store.updateSession(f.session.id, {
    runtime: { activeRuntime: 'cursor', cursor: { sessionId: 'desktop-form-thread', provider: 'desktop' } },
  });
  const card = (await f.command('/current-runtime cursor')).richCard!;
  assert.ok(card);
  assert.doesNotMatch(JSON.stringify(card), /Cursor current|current_cursor_model|cursorDefaultModel|cursorReasoningEffort/u);
  assert.match(JSON.stringify(card), /由 Cursor Desktop 对话管理/u);
  const before = f.service.snapshot(f.scope).config;
  const forms: Array<Record<string, string>> = [{ cursor_model: 'new-model', cursor_force: 'true' }, { cursor_reasoning: 'high', cursor_force: 'true' }];
  for (const form of forms) {
    assert.match((await f.command('/current-config cursor', form)).text, /配置未保存.*Desktop Bridge 接口尚未接入/u);
    assert.deepEqual(f.service.snapshot(f.scope).config, before, 'reject the entire stale form before saving any field');
  }
});
