import { createConfigService } from '../../configuration/service.js';
import type { BridgeSession, ChannelAddress, OutboundRichCard } from '../../domain/index.js';
import type { CursorAvailableModel } from '../../runtime/cursor/models.js';
import { buildCommandCallbackData } from './callbacks.js';

export const CURSOR_MODEL_PICKER_PAGE_SIZE = 50;

export interface CursorModelPickerPageRequest {
  requested: boolean;
  page?: number;
  invalid: boolean;
}

export function parseCursorModelPickerArgs(args: string): CursorModelPickerPageRequest {
  const trimmed = args.trim();
  if (!trimmed) return { requested: true, invalid: false };
  const match = /^list(?:\s+(\d+))?$/iu.exec(trimmed);
  if (!match) return { requested: false, invalid: trimmed.toLowerCase().startsWith('list') };
  const page = match[1] ? Number(match[1]) : undefined;
  return {
    requested: true,
    ...(page ? { page } : {}),
    invalid: page !== undefined && (!Number.isSafeInteger(page) || page < 1),
  };
}

function sessionCursorModelOverride(sessionId: string): string | undefined {
  const resolved = createConfigService({ migrate: false }).resolve('runtime.cursor.model', {
    kind: 'session',
    sessionId,
  });
  return resolved.source === 'session' && typeof resolved.value === 'string' && resolved.value.trim()
    ? resolved.value.trim()
    : undefined;
}

function modelCallback(model: CursorAvailableModel, sessionId: string): string {
  return buildCommandCallbackData(
    model.default || model.slug === 'auto' ? '/model default' : `/model ${model.slug}`,
    sessionId,
  );
}

function modelOptionText(model: CursorAvailableModel): string {
  const markers = [model.current ? 'current' : '', model.default ? 'default' : ''].filter(Boolean);
  return `${model.name}${markers.length > 0 ? ` (${markers.join(', ')})` : ''} · ${model.slug}`;
}

export function buildCursorModelPickerCard(options: {
  session: BridgeSession;
  address: ChannelAddress;
  models: CursorAvailableModel[];
  requestedPage?: number;
}): { card: OutboundRichCard; page: number; pageCount: number; selectedSlug?: string } {
  const currentModel = options.models.find((model) => model.current);
  const override = sessionCursorModelOverride(options.session.id);
  const selected = (override && options.models.find((model) => model.slug === override)) || currentModel;
  const pageCount = Math.max(1, Math.ceil(options.models.length / CURSOR_MODEL_PICKER_PAGE_SIZE));
  const automaticPage = selected
    ? Math.floor(options.models.indexOf(selected) / CURSOR_MODEL_PICKER_PAGE_SIZE) + 1
    : 1;
  const page = Math.min(pageCount, Math.max(1, options.requestedPage || automaticPage));
  const pageModels = options.models.slice(
    (page - 1) * CURSOR_MODEL_PICKER_PAGE_SIZE,
    page * CURSOR_MODEL_PICKER_PAGE_SIZE,
  );
  const selectedCallbackData = selected && pageModels.includes(selected)
    ? modelCallback(selected, options.session.id)
    : undefined;
  const navigation = [
    ...(page > 1 ? [{
      text: '上一页',
      callbackData: buildCommandCallbackData(`/model list ${page - 1}`, options.session.id),
    }] : []),
    {
      text: '刷新列表',
      callbackData: buildCommandCallbackData(`/model list ${page}`, options.session.id),
    },
    ...(page < pageCount ? [{
      text: '下一页',
      callbackData: buildCommandCallbackData(`/model list ${page + 1}`, options.session.id),
    }] : []),
  ];
  const fields: Array<[string, string]> = [
    ['Cursor current', currentModel ? `${currentModel.name} · ${currentModel.slug}` : '未标记'],
    ['当前会话配置', override || '跟随 Cursor 默认'],
  ];

  return {
    page,
    pageCount,
    selectedSlug: selected?.slug,
    card: {
      title: 'Cursor 模型选择',
      subtitle: `账号实时列表 · ${options.models.length} 个模型 · 第 ${page}/${pageCount} 页`,
      template: 'blue',
      sections: [{ fields }],
      selects: [{
        id: 'cursor_model',
        placeholder: `选择模型（第 ${page}/${pageCount} 页）`,
        selectedCallbackData,
        options: pageModels.map((model) => ({
          text: modelOptionText(model),
          callbackData: modelCallback(model, options.session.id),
        })),
      }],
      actions: [navigation],
      footer: [
        '选择后仍执行现有 `/model <slug>` 配置命令；`auto` 会执行 `/model default`。',
        '列表中的 current 来自 Cursor Agent，当前会话配置来自 CodeLark session。',
      ],
      updateKey: `cursor-model-picker:${options.address.channelType}:${options.address.chatId}`,
      updateTtlMs: null,
    },
  };
}
