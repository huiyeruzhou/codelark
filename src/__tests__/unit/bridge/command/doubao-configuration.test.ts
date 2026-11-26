import '../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  handleModeCommand,
  handleModelCommand,
  handleModelCommandRequest,
  handleReasoningCommand,
  handleRuntimeCommand,
  handleYoloCommand,
} from '../../../../bridge/command/runtime-settings.js';
import { handleProviderCommand } from '../../../../bridge/command/provider-settings.js';
import { handleSetCommand } from '../../../../bridge/command/global-settings.js';
import { buildCurrentCommandRichCard, handleCurrentCommand } from '../../../../bridge/command/diagnostics.js';
import { handleLocalRuntimeSessionsCommand } from '../../../../bridge/session/command-use-cases/local-runtime-list.js';
import { CommandThreadDisplay } from '../../../../bridge/command/thread-display.js';
import {
  resolveDoubaoRuntimeConfig,
  resolveEffectiveRuntimeMode,
  resolveEffectiveRuntimeProvider,
} from '../../../../bridge/session/support.js';
import { getSessionActiveRuntime, setSessionDoubaoIdentityUpdate } from '../../../../domain/session-runtime.js';
import { createConfigService } from '../../../../configuration/service.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { configV2ToPayload, mergeConfigV2HomePatch } from '../../../../operator-ui/application/config.js';
import { UiSessionApplication } from '../../../../operator-ui/application/session.js';
import {
  clearDoubaoSessionListCacheForTests,
  seedDoubaoSessionListCacheForTests,
} from '../../../../runtime/doubao/session-index.js';
import { recommendRuntime, runtimeChoiceToConfig } from '../../../../entrypoints/setup-wizard.js';
import { initBridgeTestContext, makeBridgeSettings, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

describe('Doubao runtime configuration, commands, operator UI, and setup wizard', () => {
  beforeEach(() => {
    resetBridgeTestState();
    clearDoubaoSessionListCacheForTests();
  });

  afterEach(() => {
    clearDoubaoSessionListCacheForTests();
  });

  it('switches to doubao via /runtime and supports /mode, /yolo, /model, /reasoning, /p, /current', async () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const baseSession = store.createSession('Codex Session', 'default', undefined, '/tmp/doubao-cmd');
    const initialBinding = store.upsertChannelChat({
      channelType: 'feishu',
      chatId: 'doubao-cmd-chat',
      bridgeSessionId: baseSession.id,
    });
    const msg = (text: string) => ({
      address: { channelType: 'feishu' as const, chatId: initialBinding.chatId },
      messageId: `msg-${text}`,
      text,
      timestamp: Date.now(),
    });

    const switched = await handleRuntimeCommand({
      msg: msg('/runtime doubao'),
      args: 'doubao',
      currentBinding: initialBinding,
      store,
      deps: {},
      markdown: true,
    });
    assert.match(switched, /Doubao/);

    const binding = store.getChannelChat('feishu', initialBinding.chatId)!;
    assert.notEqual(binding.bridgeSessionId, baseSession.id);
    assert.equal(binding.runtimeBridgeSessionIds?.doubao, binding.bridgeSessionId);
    const session = store.getSession(binding.bridgeSessionId)!;
    assert.equal(getSessionActiveRuntime(session), 'doubao');
    assert.equal(resolveEffectiveRuntimeProvider(session, binding).identity, 'doubao:acp');
    assert.equal(resolveDoubaoRuntimeConfig(session, binding).mode, 'normal');

    const modePlan = handleModeCommand({ msg: msg('/mode plan'), args: 'plan', currentBinding: binding, store, markdown: true });
    assert.match(modePlan, /已更新 Doubao 模式/);
    assert.equal(resolveDoubaoRuntimeConfig(store.getSession(session.id), binding).mode, 'plan');
    assert.equal(resolveEffectiveRuntimeMode(binding, store.getSession(session.id)), 'normal');

    const yoloOn = handleYoloCommand({ msg: msg('/yolo on'), args: 'on', currentBinding: binding, store, markdown: true });
    assert.match(yoloOn, /yolo/);
    assert.equal(resolveDoubaoRuntimeConfig(store.getSession(session.id), binding).mode, 'yolo');
    assert.equal(resolveEffectiveRuntimeMode(binding, store.getSession(session.id)), 'yolo');

    const modelReply = handleModelCommand({ msg: msg('/model doubao-seed-2.0-pro'), args: 'doubao-seed-2.0-pro', currentBinding: binding, store, markdown: true });
    assert.match(modelReply, /已更新 Doubao 模型/);
    assert.equal(resolveDoubaoRuntimeConfig(store.getSession(session.id), binding).model, 'doubao-seed-2.0-pro');

    const modelReset = handleModelCommand({ msg: msg('/model default'), args: 'default', currentBinding: binding, store, markdown: true });
    assert.match(modelReset, /已恢复默认 Doubao 模型/);
    assert.equal(resolveDoubaoRuntimeConfig(store.getSession(session.id), binding).model, undefined);

    const reasoningReply = handleReasoningCommand({ args: 'high', binding, store, markdown: true });
    assert.match(reasoningReply, /已更新 Doubao 思考级别/);
    assert.equal(resolveDoubaoRuntimeConfig(store.getSession(session.id), binding).reasoningEffort, 'high');

    const reasoningReset = handleReasoningCommand({ args: 'default', binding, store, markdown: true });
    assert.match(reasoningReset, /已恢复默认 Doubao 思考级别/);
    assert.equal(resolveDoubaoRuntimeConfig(store.getSession(session.id), binding).reasoningEffort, undefined);

    const providerStatus = await handleProviderCommand({
      msg: msg('/p'),
      args: '',
      currentBinding: binding,
      store,
      deps: {},
      markdown: true,
    });
    assert.match(providerStatus.response, /Doubao Provider/);
    assert.match(providerStatus.response, /acp/);

    const providerAlias = await handleProviderCommand({
      msg: msg('/p tmux'),
      args: 'tmux',
      currentBinding: binding,
      store,
      deps: {},
      markdown: true,
    });
    assert.match(providerAlias.response, /已将 `\/p tmux` 解释为 `\/p acp`/);
    assert.match(providerAlias.response, /acp/);

    const providerReject = await handleProviderCommand({
      msg: msg('/p invalid'),
      args: 'invalid',
      currentBinding: binding,
      store,
      deps: {},
      markdown: true,
    });
    assert.match(providerReject.response, /只支持 `acp`/);

    store.updateSession(session.id, setSessionDoubaoIdentityUpdate('native-db-001', '/tmp/doubao-cmd', 'acp'));
    const threadDisplay = new CommandThreadDisplay(store);
    const currentText = handleCurrentCommand({
      msg: msg('/current'),
      binding,
      store,
      threadDisplay,
      markdown: true,
    });
    assert.match(currentText, /Doubao/);
    assert.match(currentText, /doubao_session_id/);
    assert.match(currentText, /native-db-001/);

    const currentCard = buildCurrentCommandRichCard({
      msg: msg('/current'),
      binding,
      store,
      threadDisplay,
      configSection: 'doubao',
    });
    assert.ok(currentCard);
    assert.ok(currentCard.selects?.[0]?.options.some((option) => option.text === 'Doubao'));
  });

  it('supports /set doubao settings, operator UI config roundtrip, and /t doubao listing', async () => {
    const store = initBridgeTestContext();
    const configService = createConfigService({ migrate: false });

    assert.match(handleSetCommand({ args: 'runtime doubao', markdown: true }), /doubao/);
    assert.match(handleSetCommand({ args: 'doubaoDefaultModel doubao-seed-2.0-code', markdown: true }), /doubao-seed-2\.0-code/);
    assert.match(handleSetCommand({ args: 'doubaoMode plan', markdown: true }), /plan/);
    assert.match(handleSetCommand({ args: 'doubaoReasoningEffort high', markdown: true }), /high/);

    const snap = configService.snapshot().config;
    assert.equal(snap.runtime.agent, 'doubao');
    assert.equal(snap.runtime.doubao.model, 'doubao-seed-2.0-code');
    assert.equal(snap.runtime.doubao.mode, 'plan');
    assert.equal(snap.runtime.doubao.reasoningEffort, 'high');

    const uiPayload = configV2ToPayload(snap);
    assert.equal(uiPayload.doubaoDefaultModel, 'doubao-seed-2.0-code');
    assert.equal(uiPayload.doubaoProvider, 'acp');
    assert.equal(uiPayload.doubaoMode, 'plan');
    assert.equal(uiPayload.doubaoReasoningEffort, 'high');

    const patched = mergeConfigV2HomePatch(snap, {
      doubaoDefaultModel: 'doubao-seed-2.0-pro',
      doubaoMode: 'yolo',
      doubaoReasoningEffort: 'low',
    });
    assert.equal(patched.runtime?.doubao?.model, 'doubao-seed-2.0-pro');
    assert.equal(patched.runtime?.doubao?.mode, 'yolo');
    assert.equal(patched.runtime?.doubao?.reasoningEffort, 'low');

    // Operator UI session config roundtrip
    const session = store.createSession('Doubao UI', 'default', undefined, '/tmp/doubao-ui');
    store.updateSession(session.id, { runtime: { activeRuntime: 'doubao' } });
    const uiApp = new UiSessionApplication(store);
    const updatedCfg = uiApp.updateConfig(session.id, {
      activeRuntime: 'doubao',
      doubaoModel: 'doubao-seed-2.0-pro',
      doubaoMode: 'plan',
      doubaoReasoningEffort: 'xhigh',
    });
    assert.equal(updatedCfg.doubaoModel, 'doubao-seed-2.0-pro');
    assert.equal(updatedCfg.doubaoMode, 'plan');
    assert.equal(updatedCfg.doubaoReasoningEffort, 'xhigh');

    // /t doubao lists seeded sessions
    seedDoubaoSessionListCacheForTests([
      {
        sessionId: 'db-list-1',
        cwd: '/tmp/doubao-ui',
        title: 'Doubao 云端测试会话',
        firstSeenAt: '2026-11-26T08:00:00.000Z',
        lastEventAt: '2026-11-26T09:00:00.000Z',
        source: 'doubao',
        originator: 'Doubao CLI',
        activeEstimate: false,
      },
    ]);
    const listResult = await handleLocalRuntimeSessionsCommand({
      msg: {
        address: { channelType: 'feishu', chatId: 'doubao-list-chat' },
        messageId: 'msg-t-doubao',
        text: '/t doubao',
        timestamp: Date.now(),
      },
      args: 'doubao',
      threadDisplay: new CommandThreadDisplay(store),
      markdown: true,
    });
    assert.match(listResult.response, /Doubao 云端测试会话/);
  });

  it('renders an interactive /model picker card for Doubao and resolves model choices by name or ID', async () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Doubao Model Session', 'default', undefined, '/tmp/doubao-model-picker');
    store.updateSession(session.id, { runtime: { activeRuntime: 'doubao', doubao: { provider: 'acp' } } });
    const binding = store.upsertChannelChat({
      channelType: 'feishu',
      chatId: 'doubao-model-picker-chat',
      bridgeSessionId: session.id,
    });
    const fakeModels = [
      { id: '9', name: 'Auto', isDefault: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: '5262373378', name: 'GPT 6.1 Sol', isDefault: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
    ];
    let forceRefreshSeen = false;
    const listDoubaoModels = async (opts?: { forceRefresh?: boolean }) => {
      if (opts?.forceRefresh) forceRefreshSeen = true;
      return fakeModels;
    };
    const msg = (text: string) => ({
      address: { channelType: 'feishu' as const, chatId: binding.chatId },
      messageId: `msg-${text}`,
      text,
      timestamp: Date.now(),
    });

    const pickerResult = await handleModelCommandRequest({
      msg: msg('/model'),
      args: '',
      currentBinding: binding,
      store,
      markdown: true,
      listDoubaoModels,
    });
    assert.ok(pickerResult.richCard, 'expected interactive picker richCard for Doubao /model');
    assert.equal(pickerResult.richCard?.title, 'Doubao 模型选择');
    const select = pickerResult.richCard?.selects?.[0];
    assert.ok(select);
    assert.equal(select.options.length, 3);
    assert.match(select.options[0]!.text, /跟随默认/);
    assert.match(select.options[2]!.text, /GPT 6\.1 Sol · 5262373378/);

    const selected = await handleModelCommandRequest({
      msg: msg('/model GPT 6.1 Sol'),
      args: 'GPT 6.1 Sol',
      currentBinding: binding,
      store,
      markdown: true,
      listDoubaoModels,
    });
    assert.match(selected.response, /GPT 6\.1 Sol \(5262373378\)/);
    assert.equal(resolveDoubaoRuntimeConfig(store.getSession(session.id), binding).model, '5262373378');

    const refreshed = await handleModelCommandRequest({
      msg: msg('/model --refresh'),
      args: '--refresh',
      currentBinding: binding,
      store,
      markdown: true,
      listDoubaoModels,
    });
    assert.equal(forceRefreshSeen, true);
    assert.equal(refreshed.richCard?.selects?.[0]?.selectedCallbackData, refreshed.richCard?.selects?.[0]?.options[2]?.callbackData);
  });

  it('detects ~/.doubao in setup-wizard and maps doubao runtime choice', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-doubao-wizard-'));
    try {
      fs.mkdirSync(path.join(tmpHome, '.doubao'));
      const rec = recommendRuntime(tmpHome);
      assert.equal(rec.runtime, 'doubao');
      assert.deepEqual(runtimeChoiceToConfig('doubao'), {
        agent: 'doubao',
        doubao: { provider: 'acp' },
      });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
