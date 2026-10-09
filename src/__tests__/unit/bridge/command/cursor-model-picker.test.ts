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
import { resolveCursorCapabilities } from '../../../../bridge/session/cursor-transport.js';
import { resolveCursorInvocationModel, resolveCursorRuntimeConfig } from '../../../../bridge/session/support.js';
import type { CursorAvailableModel } from '../../../../runtime/cursor/models.js';
import { CursorDesktopModelControlUnavailable } from '../../../../runtime/cursor/desktop-bridge-client.js';
const unavailableDesktopModels = { get: async () => { throw new CursorDesktopModelControlUnavailable('可选增强未启用'); }, set: async () => { throw new CursorDesktopModelControlUnavailable('可选增强未启用'); } };
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
      const result = await handleModelCommandRequest({ ...options, desktopModels: unavailableDesktopModels, listCursorModels: async () => { throw new Error('must not query CLI'); } });
      assert.match(result.response, /标准接口不支持/u);
      assert.equal(result.richCard?.selects, undefined);
      assert.match(handleModelCommand(options), /标准接口不支持/u);
      assert.match(handleReasoningCommand({ args, binding, store, markdown: true }), /标准接口不支持/u);
      assert.deepEqual(service.snapshot(scope).config, before);
    }
  });

  it('keeps Desktop model control external even with an explicit tmux provider setting', async () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Desktop', 'default', undefined, '/tmp/cursor-desktop');
    store.updateSession(session.id, { runtime: {
      activeRuntime: 'cursor', cursor: { sessionId: 'desktop-thread', provider: 'tmux', transport: 'desktop' },
    } });
    const binding = store.upsertChannelChat({ channelType: 'feishu', chatId: 'cursor-tmux-setting', bridgeSessionId: session.id });
    const service = createConfigService({ migrate: false });
    const scope = { kind: 'session' as const, sessionId: session.id };
    service.set(scope, { runtime: { cursor: { provider: 'tmux', model: 'stored-cli-model', reasoningEffort: 'high' } } });
    const persisted = store.getSession(session.id)!;
    assert.equal(resolveCursorCapabilities(persisted).provider, 'tmux');
    assert.equal(resolveCursorCapabilities(persisted).transport, 'desktop');
    const result = await handleModelCommandRequest({
      msg: { address: { channelType: 'feishu', chatId: binding.chatId }, text: '/model', messageId: 'model', timestamp: Date.now() },
      args: '', currentBinding: binding, store, markdown: true, desktopModels: unavailableDesktopModels,
      listCursorModels: async () => { throw new Error('must not query CLI'); },
    });
    assert.match(result.response, /标准接口不支持/u);
    assert.equal(resolveCursorInvocationModel(binding, persisted, { resuming: true }), undefined);
    assert.equal(resolveCursorRuntimeConfig(persisted, binding).reasoningEffort, undefined);
    assert.equal(service.get('runtime.cursor.model', scope), 'stored-cli-model');
  });

  it('uses native Desktop selection and confirms the reply without saving a second model authority', async () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Desktop', 'default', undefined, '/tmp/cursor-desktop');
    store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'tmux', transport: 'desktop', sessionId: 'target' } } });
    const binding = store.upsertChannelChat({ channelType: 'feishu', chatId: 'native-model', bridgeSessionId: session.id });
    const config = createConfigService({ migrate: false });
    const scope = { kind: 'session' as const, sessionId: session.id };
    config.set(scope, { runtime: { cursor: { model: 'stale-cli-model' } } });
    const before = config.snapshot(scope).config;
    let selected = 'native', fail = false;
    const state = () => ({ threadId: 'target', models: [{ id: 'native', name: 'Native' }, { id: 'auto', name: 'Auto' }], selectedModels: [selected], running: true });
    const desktopModels = {
      get: async (id: string) => { assert.equal(id, 'target'); return state(); },
      set: async (id: string, model: string, guard?: () => boolean) => {
        assert.equal(id, 'target'); assert.equal(guard?.(), true);
        if (fail) throw new Error('administrator disabled this model');
        selected = model; return state();
      },
    };
    const options = { msg: { address: { channelType: 'feishu', chatId: binding.chatId }, text: '/model', messageId: 'model', timestamp: Date.now() },
      currentBinding: binding, store, markdown: true, desktopModels, listCursorModels: async () => { throw new Error('must not query CLI'); } };
    const listed = await handleModelCommandRequest({ ...options, args: '' });
    assert.match(listed.response, /Desktop 当前选择：native/);
    assert.equal(parseCommandCallbackData(listed.richCard!.selects![0]!.selectedCallbackData!)?.commandText, '/model native');
    assert.equal(parseCommandCallbackData(listed.richCard!.selects![0]!.options[1]!.callbackData)?.commandText, '/model auto');
    assert.doesNotMatch(JSON.stringify(listed.richCard), /stale-cli-model|当前会话配置/);
    assert.match((await handleModelCommandRequest({ ...options, args: 'auto' })).response, /已确认模型选择：auto/);
    fail = true;
    assert.match((await handleModelCommandRequest({ ...options, args: 'fable' })).response, /未获确认.*administrator/);
    assert.deepEqual(config.snapshot(scope).config, before);
    assert.equal(store.getSession(session.id)!.runtime!.cursor!.provider, 'tmux');
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
