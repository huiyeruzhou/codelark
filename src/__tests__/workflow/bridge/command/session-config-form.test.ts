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
      restartCursorTmuxSession: async () => assert.fail('Desktop commands must never start a CLI TUI'),
    });
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
    assert.equal(abortController.signal.aborted, false);
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, session.id);
    assert.equal(service.get('runtime.agent', scope), 'codex');
    return adapter.sent.at(-1)!;
  };
  return { store, service, session, scope, command };
}

it('previewing another runtime keeps the active task, and saving uses the runtime switch warning', async () => {
  const f = fixture();
  const card = (await f.command('/current-runtime claude')).richCard!;
  assert.equal(parseCommandCallbackData(card.form!.submitCallbackData)?.scopeSessionId, f.session.id);
  const before = f.service.snapshot(f.scope).config;
  const warning = (await f.command('/runtime claude')).text;
  assert.match(warning, /请先停止当前对话/);
  assert.equal((await f.command('/current-config claude', { claudeDefaultModel: 'after', cld_idle_min: '15' })).text, warning);
  assert.deepEqual(f.service.snapshot(f.scope).config, before, 'a rejected switch must not save any part of the form');
});

it('a missing directory asks for confirmation before saving any form values', async () => {
  const f = fixture();
  const result = await f.command('/current-config common', { clk_name: 'new name', clk_cwd: `/missing-${f.session.id}`, tmuxCaptureLines: '123' });
  assert.match(result.text, /目录不存在/);
  assert.equal(result.richCard?.title, '创建工作目录');
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
    assert.match((await f.command('/current-config cursor', form)).text, /配置未保存.*标准接口不支持/u);
    assert.deepEqual(f.service.snapshot(f.scope).config, before, 'reject the entire stale form before saving any field');
  }
});

it('Desktop /p tmux keeps the active conversation and public provider without a restart confirmation', async () => {
  const f = fixture();
  f.store.updateSession(f.session.id, {
    runtime: { activeRuntime: 'cursor', cursor: { sessionId: 'desktop-p-thread', provider: 'tmux', transport: 'desktop' } },
  });
  const before = f.store.getSession(f.session.id)?.runtime;
  for (const command of ['/provider', '/p tmux', '/p default']) {
    const result = await f.command(command);
    assert.match(result.text, /Provider[\s\S]*tmux/u);
    assert.match(result.text, /当前会话由 Cursor Desktop 管理/u);
    assert.doesNotMatch(result.text, /改用|重新启动|确认重启/u);
    assert.equal(result.richCard, undefined);
    assert.deepEqual(f.store.getSession(f.session.id)?.runtime, before);
  }
});
