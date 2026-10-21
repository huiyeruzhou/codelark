import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { initBridgeTestContext, resetBridgeTestState, RecordingAdapter, inboundMessage } from '../../../helpers/bridge/test-bridge-utils.js';
import * as router from '../../../../bridge/session/channel-router.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import { handleBridgeCommand } from '../../../../bridge/command/dispatch.js';
import { parseCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import { getSessionActiveRuntime, getSessionWorkingDirectory } from '../../../../domain/session-runtime.js';
import { createConfigService } from '../../../../configuration/service.js';

function fixture(t: TestContext) {
  resetBridgeTestState();
  const store = initBridgeTestContext();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-current-save-'));
  t.after(() => { resetBridgeTestState(); fs.rmSync(root, { recursive: true, force: true }); });
  const address = { channelType: 'feishu', chatId: 'current-save', userId: 'user' };
  const binding = router.createBinding(address, root);
  const adapter = new RecordingAdapter();
  let active = false;
  const deps = { diagnoseSessionHealth: async () => null, diagnoseAllActiveSessions: async () => [], getActiveTask: () => active ? { abortController: new AbortController() } : undefined };
  const send = async (command: string, form?: Record<string, unknown>) => { await handleBridgeCommand(adapter, {
    ...inboundMessage(address, command), raw: form ? { event: { action: { form_value: form } } } : undefined,
  }, command, deps); await _testOnlyWaitForDeliveryQueuesForTests(adapter); };
  const button = (index: number) => parseCommandCallbackData(adapter.sent.at(-1)!.richCard!.actions![0]![index]!.callbackData!)!.commandText;
  return { store, root, address, binding, adapter, send, button, setActive: () => { active = true; },
    current: () => store.getSession(store.getChannelChat(address.channelType, address.chatId)!.bridgeSessionId)!,
  };
}

test('/cd asks before creating missing parents, then changes directory exactly once', async (t) => {
  const f = fixture(t); const directory = path.join(f.root, 'new', 'nested');
  await f.send('/cd new/nested');
  assert.equal(fs.existsSync(directory), false);
  assert.equal(getSessionWorkingDirectory(f.current()), f.root);
  const confirm = f.button(0); assert.match(confirm, /^\/mkdir-confirm /);
  await f.send(confirm);
  assert(fs.statSync(directory).isDirectory());
  assert.equal(getSessionWorkingDirectory(f.current()), directory);
  await f.send(confirm); assert.match(f.adapter.sent.at(-1)!.text, /已失效/);
});

test('/current preserves the whole form until directory confirmation', async (t) => {
  const f = fixture(t); const directory = path.join(f.root, 'new'); const oldName = f.current().name;
  await f.send('/current-config common', { clk_cwd: directory, clk_name: 'Saved together', tmuxCaptureLines: '99' });
  assert.equal(f.current().name, oldName); assert.equal(fs.existsSync(directory), false);
  await f.send(f.button(0));
  assert.equal(f.current().name, 'Saved together'); assert.equal(getSessionWorkingDirectory(f.current()), directory);
  assert.equal(createConfigService({ migrate: false }).get('session.tmuxCaptureLines', { kind: 'session', sessionId: f.current().id }), 99);
});

test('directory cancellation and stale binding do not create or change anything', async (t) => {
  const f = fixture(t); const directory = path.join(f.root, 'new');
  await f.send(`/cd ${directory}`); await f.send(f.button(1));
  assert.equal(fs.existsSync(directory), false); assert.equal(getSessionWorkingDirectory(f.current()), f.root);
  await f.send(`/cd ${directory}`); const confirm = f.button(0);
  router.createBinding(f.address, f.root);
  await f.send(confirm); assert.equal(fs.existsSync(directory), false);
  assert.match(f.adapter.sent.at(-1)!.text, /已失效/);
});

test('/current save switches to the selected runtime and writes its own session', async (t) => {
  const f = fixture(t);
  await f.send('/current-runtime claude'); assert.equal(getSessionActiveRuntime(f.current()), 'codex');
  await f.send('/current-config claude', { claudeDefaultModel: 'selected-model' });
  assert.equal(getSessionActiveRuntime(f.current()), 'claude');
  assert.notEqual(f.current().id, f.binding.bridgeSessionId);
  const config = createConfigService({ migrate: false });
  assert.equal(config.get('runtime.claude.model', { kind: 'session', sessionId: f.current().id }), 'selected-model');
  assert.notEqual(config.get('runtime.claude.model', { kind: 'session', sessionId: f.binding.bridgeSessionId }), 'selected-model');
  const claudeId = f.current().id;
  await f.send('/runtime codex');
  await f.send('/current-config claude', { claudeDefaultModel: 'updated-model' });
  assert.equal(f.current().id, claudeId);
  assert.equal(config.get('runtime.claude.model', { kind: 'session', sessionId: claudeId }), 'updated-model');
});

test('/current runtime switch uses exactly the /runtime running warning without saving', async (t) => {
  const f = fixture(t); f.setActive();
  await f.send('/runtime claude'); const warning = f.adapter.sent.at(-1)!.text;
  await f.send('/current-config claude', { claudeDefaultModel: 'must-not-save' });
  assert.equal(f.adapter.sent.at(-1)!.text, warning);
  assert.equal(getSessionActiveRuntime(f.current()), 'codex');
  assert.notEqual(createConfigService({ migrate: false }).get('runtime.claude.model', { kind: 'session', sessionId: f.current().id }), 'must-not-save');
});

test('invalid runtime form does not switch and an existing file does not become a directory', async (t) => {
  const f = fixture(t);
  await f.send('/current-config claude', { claudeProvider: 'invalid-provider' });
  assert.equal(getSessionActiveRuntime(f.current()), 'codex');
  const file = path.join(f.root, 'plain-file'); fs.writeFileSync(file, 'data');
  await f.send(`/cd ${file}`); assert.match(f.adapter.sent.at(-1)!.text, /目标不是目录/);
  assert.equal(getSessionWorkingDirectory(f.current()), f.root);
});


test('/current respects the remembered Cursor Desktop session when previewing and saving', async (t) => {
  const f = fixture(t);
  await f.send('/runtime cursor');
  const cursorId = f.current().id;
  f.store.updateSession(cursorId, { runtime: { cursor: { sessionId: 'remembered-desktop', provider: 'tmux', transport: 'desktop' } } });
  await f.send('/runtime codex');
  const codexId = f.current().id;
  await f.send('/current-runtime cursor');
  assert.match(JSON.stringify(f.adapter.sent.at(-1)!.richCard), /由 Cursor Desktop 对话管理/);
  assert.doesNotMatch(JSON.stringify(f.adapter.sent.at(-1)!.richCard), /cursorDefaultModel|cursorReasoningEffort/);
  await f.send('/current-config cursor', { cursorDefaultModel: 'unsupported-change' });
  assert.match(f.adapter.sent.at(-1)!.text, /配置未保存.*标准接口不支持/);
  assert.equal(f.current().id, codexId);
});

test('/current inherit selection stays inherited when creating another runtime session', async (t) => {
  const f = fixture(t);
  await f.send('/current-config claude', { claudeDefaultModel: '' });
  assert.equal(getSessionActiveRuntime(f.current()), 'claude');
  assert.notEqual(createConfigService({ migrate: false }).resolve('runtime.claude.model', { kind: 'session', sessionId: f.current().id }).source, 'session');
});
