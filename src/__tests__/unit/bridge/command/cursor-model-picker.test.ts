import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRichCardContent } from '../../../../channels/feishu/markdown.js';
import {
  attachCursorModelPickerControls,
  buildCursorModelPickerCard,
  CURSOR_MODEL_PICKER_PAGE_SIZE,
  parseCursorModelPickerArgs,
} from '../../../../bridge/command/cursor-model-picker.js';
import { parseCommandCallbackData } from '../../../../bridge/command/callbacks.js';
import { handleModelCommand, handleModelCommandRequest, handleReasoningCommand } from '../../../../bridge/command/runtime-settings.js';
import { createConfigService } from '../../../../configuration/service.js';
import { resolveCursorCapabilities } from '../../../../bridge/session/cursor-provider-identity.js';
import { resolveCursorInvocationModel, resolveCursorRuntimeConfig } from '../../../../bridge/session/support.js';
import type { CursorAvailableModel } from '../../../../runtime/cursor/models.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { makeBridgeSettings, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

function model(index: number, options: Partial<CursorAvailableModel> = {}): CursorAvailableModel {
  return {
    slug: `model-${index}`,
    name: `Model ${index}`,
    current: false,
    default: false,
    ...options,
  };
}

describe('Cursor model picker', () => {
  beforeEach(() => resetBridgeTestState());

  it('opens on bare /model and reserves pagination for internal card callbacks', () => {
    assert.deepEqual(parseCursorModelPickerArgs(''), { requested: true, invalid: false });
    assert.deepEqual(parseCursorModelPickerArgs('--cursor-model-page=3'), { requested: true, page: 3, invalid: false });
    assert.deepEqual(parseCursorModelPickerArgs('--cursor-model-page 4'), { requested: true, page: 4, invalid: false });
    assert.deepEqual(parseCursorModelPickerArgs('--cursor-model-page=nope'), { requested: true, invalid: true });
    assert.deepEqual(parseCursorModelPickerArgs('list'), { requested: false, invalid: false });
    assert.deepEqual(parseCursorModelPickerArgs('gpt-5.3'), { requested: false, invalid: false });
    assert.deepEqual(parseCursorModelPickerArgs('gpt-5.3 --cursor-model-page=2'), { requested: false, invalid: true });
  });

  it('selects the configured model page regardless of CLI current and renders bounded Feishu options', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Cursor', 'default', undefined, '/tmp/cursor');
    store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'tmux' } } });
    const models = Array.from({ length: 121 }, (_, index) => model(index));
    models[0] = model(0, { slug: 'auto', name: 'Auto', default: true });
    models[1] = model(1, { slug: 'unrelated-cli-current', current: true });
    models[90] = model(90, { slug: 'configured-model', name: 'Configured Model' });
    createConfigService({ migrate: false }).set({ kind: 'session', sessionId: session.id }, {
      runtime: { cursor: { model: 'configured-model' } },
    });

    const picker = buildCursorModelPickerCard({
      session: store.getSession(session.id)!,
      address: { channelType: 'feishu', chatId: 'chat-cursor-models' },
      models,
    });

    assert.equal(picker.page, 3);
    assert.equal(picker.pageCount, 4);
    assert.equal(picker.selectedSlug, 'configured-model');
    assert.equal(picker.card.selects?.[0]?.options.length, CURSOR_MODEL_PICKER_PAGE_SIZE);
    const selected = parseCommandCallbackData(picker.card.selects?.[0]?.selectedCallbackData || '');
    assert.equal(selected?.commandText, '/model configured-model');
    assert.equal(selected?.scopeSessionId, session.id);

    const payload = JSON.parse(buildRichCardContent(picker.card, 'chat-cursor-models')) as any;
    const select = payload.body.elements.find((element: any) => element.tag === 'select_static');
    assert.equal(select.options.length, CURSOR_MODEL_PICKER_PAGE_SIZE);
    assert.equal(select.initial_option, picker.card.selects?.[0]?.selectedCallbackData);
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') < 18_000);
    assert.doesNotMatch(JSON.stringify(payload), /Cursor current|\(current\)/u);
  });

  it('never falls back to CLI current/default for unset or unlisted configuration', () => {
    const models = Array.from({ length: 121 }, (_, index) => model(index));
    models[0] = model(0, { slug: 'auto', default: true });
    models[90] = model(90, { current: true });
    for (const target of ['session', 'global'] as const) {
      for (const selectedSlug of [undefined, 'custom-unlisted']) {
        const picker = attachCursorModelPickerControls({
          card: { title: '模型', sections: [] }, models, target, selectedSlug,
          pageCommand: (page) => `/model --cursor-model-page=${page}`,
          configuredLabel: '已保存配置', controlIdPrefix: 'model',
        });
        assert.equal(picker.page, 1);
        assert.equal(picker.selectedSlug, undefined);
        assert.equal(picker.card.selects?.[0]?.selectedCallbackData, undefined);
        assert.doesNotMatch(JSON.stringify(picker.card), /Cursor current|\(current\)|\(default\)/u);
      }
    }
  });

  it('rejects Desktop model and effort changes without saving or querying the unrelated CLI', async () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Desktop', 'default', undefined, '/tmp/cursor-desktop');
    store.updateSession(session.id, {
      runtime: { activeRuntime: 'cursor', cursor: { sessionId: 'desktop-thread', provider: 'desktop' } },
    });
    const binding = store.upsertChannelChat({ channelType: 'feishu', chatId: 'desktop-models', bridgeSessionId: session.id });
    const service = createConfigService({ migrate: false });
    const scope = { kind: 'session' as const, sessionId: session.id };
    service.set(scope, { runtime: { cursor: { model: 'previous-unapplied', reasoningEffort: 'high' } } });
    const before = service.snapshot(scope).config;
    for (const args of ['', 'new-model', 'default']) {
      const options = {
        msg: { address: { channelType: 'feishu', chatId: binding.chatId }, text: '/model', messageId: `desktop-${args}`, timestamp: Date.now() },
        args, currentBinding: binding, store, markdown: true,
      };
      const result = await handleModelCommandRequest({ ...options, listCursorModels: async () => { throw new Error('must not query CLI'); } });
      assert.match(result.response, /Desktop Bridge 接口尚未接入/u);
      assert.equal(result.richCard?.selects, undefined);
      assert.match(handleModelCommand(options), /Desktop Bridge 接口尚未接入/u);
      assert.match(handleReasoningCommand({ args, binding, store, markdown: true }), /Desktop Bridge 接口尚未接入/u);
      assert.deepEqual(service.snapshot(scope).config, before);
    }
  });

  it('keeps model commands, catalog and launch parameters aligned when a Desktop thread explicitly uses CLI', async () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Desktop with CLI override', 'default', undefined, '/tmp/cursor-override');
    store.updateSession(session.id, {
      runtime: { activeRuntime: 'cursor', cursor: { sessionId: 'desktop-cli-thread', provider: 'desktop' } },
    });
    const binding = store.upsertChannelChat({ channelType: 'feishu', chatId: 'cursor-override', bridgeSessionId: session.id });
    const service = createConfigService({ migrate: false });
    const scope = { kind: 'session' as const, sessionId: session.id };
    const persisted = store.getSession(session.id)!;
    const options = {
      msg: { address: { channelType: 'feishu', chatId: binding.chatId }, text: '/model', messageId: 'override-model', timestamp: Date.now() },
      currentBinding: binding, store, markdown: true,
    };
    assert.match(handleModelCommand({ ...options, args: 'chosen-model' }), /Desktop Bridge 接口尚未接入/u);
    service.set(scope, { runtime: { cursor: { provider: 'tmux' } } });
    assert.equal(persisted.runtime?.cursor?.provider, 'desktop', 'source identity stays Desktop');
    assert.equal(resolveCursorCapabilities(persisted).modelConfiguration, 'process-launch');
    assert.match(handleModelCommand({ ...options, args: 'chosen-model' }), /后续 Cursor tmux 启动/u);
    handleReasoningCommand({ args: 'high', binding, store, markdown: true });
    assert.equal(resolveCursorInvocationModel(binding, persisted, { resuming: true }), 'chosen-model');
    assert.equal(resolveCursorRuntimeConfig(persisted, binding).reasoningEffort, 'high');
    let catalogReads = 0;
    const listCursorModels = async () => { catalogReads += 1; return [model(0, { slug: 'chosen-model' })]; };
    const cliResult = await handleModelCommandRequest({ ...options, args: '', listCursorModels });
    assert.equal(catalogReads, 1);
    assert.equal(parseCommandCallbackData(cliResult.richCard?.selects?.[0]?.selectedCallbackData || '')?.commandText, '/model chosen-model');

    service.unset(scope, 'runtime.cursor.provider');
    const desktopResult = await handleModelCommandRequest({ ...options, args: '', listCursorModels });
    assert.equal(catalogReads, 1, 'returning to Desktop must not read the CLI catalog');
    assert.match(desktopResult.response, /Desktop Bridge 接口尚未接入/u);
    assert.equal(resolveCursorInvocationModel(binding, persisted, { resuming: true }), undefined);
    assert.equal(resolveCursorRuntimeConfig(persisted, binding).reasoningEffort, undefined);
    assert.equal(service.get('runtime.cursor.model', scope), 'chosen-model', 'stored intent is not a Desktop applied model');
  });

  it('uses the existing scoped /model command callbacks from bare /model', async () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Cursor', 'default', undefined, '/tmp/cursor');
    store.updateSession(session.id, {
      runtime: { activeRuntime: 'cursor', cursor: { sessionId: 'cursor-1', cwd: '/tmp/cursor', provider: 'tmux' } },
    });
    const binding = store.upsertChannelChat({
      channelType: 'feishu',
      chatId: 'chat-cursor-models',
      bridgeSessionId: session.id,
    });
    const models = [
      model(0, { slug: 'auto', name: 'Auto', default: true }),
      model(1, { slug: 'gpt-current', name: 'GPT Current', current: true }),
    ];

    const result = await handleModelCommandRequest({
      msg: { address: { channelType: 'feishu', chatId: binding.chatId }, text: '/model', messageId: 'model-picker', timestamp: Date.now() },
      args: '',
      currentBinding: binding,
      store,
      markdown: true,
      listCursorModels: async () => models,
    });

    assert.ok(result.richCard);
    const callbacks = result.richCard?.selects?.[0]?.options.map((option) => parseCommandCallbackData(option.callbackData));
    assert.deepEqual(callbacks?.map((callback) => callback?.commandText), ['/model default', '/model gpt-current']);
    assert.ok(callbacks?.every((callback) => callback?.scopeSessionId === session.id));
    assert.doesNotMatch(JSON.stringify(store.getSession(session.id)), /"model":/);

    const invalid = await handleModelCommandRequest({
      msg: { address: { channelType: 'feishu', chatId: binding.chatId }, text: '/model --cursor-model-page=nope', messageId: 'model-picker-invalid', timestamp: Date.now() },
      args: '--cursor-model-page=nope',
      currentBinding: binding,
      store,
      markdown: true,
      listCursorModels: async () => models,
    });
    assert.equal(invalid.richCard, undefined);
    assert.match(invalid.response, /参数无效/);
    assert.doesNotMatch(JSON.stringify(store.getSession(session.id)), /"model":/);
  });

  it('reuses the dynamic list for global /set callbacks and removes the duplicate text input', () => {
    const models = [
      model(0, { slug: 'auto', name: 'Auto', default: true }),
      model(1, { slug: 'claude-current', name: 'Claude Current', current: true }),
    ];
    const result = attachCursorModelPickerControls({
      card: {
        title: 'Cursor 全局配置',
        sections: [],
        form: {
          optionElementId: 'cursor-settings-option',
          submitText: '保存',
          submitCallbackData: '/set --group runtime.cursor',
          options: [],
          extraInputs: [{ elementId: 'cursorDefaultModel', label: '模型', placeholder: 'model slug', defaultValue: 'auto' }],
        },
      },
      models,
      target: 'global',
      selectedSlug: 'auto',
      pageCommand: (page) => `/set --group runtime.cursor --cursor-model-page=${page}`,
      configuredLabel: '全局默认配置',
      controlIdPrefix: 'set_cursor',
    });

    assert.deepEqual(result.card.form?.extraInputs, []);
    const callbacks = result.card.selects?.[0]?.options.map((option) => parseCommandCallbackData(option.callbackData));
    assert.deepEqual(callbacks?.map((callback) => callback?.commandText), [
      '/set cursorDefaultModel default',
      '/set cursorDefaultModel claude-current',
    ]);
    assert.equal(callbacks?.every((callback) => callback?.scopeSessionId === null), true);
  });
});
