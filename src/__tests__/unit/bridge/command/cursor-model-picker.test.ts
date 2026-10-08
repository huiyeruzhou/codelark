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
import { handleModelCommandRequest } from '../../../../bridge/command/runtime-settings.js';
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

  it('opens the current model page, preselects current, and renders bounded Feishu options', () => {
    const store = new JsonFileStore(makeBridgeSettings());
    const session = store.createSession('Cursor', 'default', undefined, '/tmp/cursor');
    store.updateSession(session.id, { runtime: { activeRuntime: 'cursor', cursor: { provider: 'tmux' } } });
    const models = Array.from({ length: 121 }, (_, index) => model(index));
    models[0] = model(0, { slug: 'auto', name: 'Auto', default: true });
    models[90] = model(90, { slug: 'current-model', name: 'Current Model', current: true });

    const picker = buildCursorModelPickerCard({
      session: store.getSession(session.id)!,
      address: { channelType: 'feishu', chatId: 'chat-cursor-models' },
      models,
    });

    assert.equal(picker.page, 3);
    assert.equal(picker.pageCount, 4);
    assert.equal(picker.selectedSlug, 'current-model');
    assert.equal(picker.card.selects?.[0]?.options.length, CURSOR_MODEL_PICKER_PAGE_SIZE);
    const selected = parseCommandCallbackData(picker.card.selects?.[0]?.selectedCallbackData || '');
    assert.equal(selected?.commandText, '/model current-model');
    assert.equal(selected?.scopeSessionId, session.id);

    const payload = JSON.parse(buildRichCardContent(picker.card, 'chat-cursor-models')) as any;
    const select = payload.body.elements.find((element: any) => element.tag === 'select_static');
    assert.equal(select.options.length, CURSOR_MODEL_PICKER_PAGE_SIZE);
    assert.equal(select.initial_option, picker.card.selects?.[0]?.selectedCallbackData);
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') < 18_000);
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
