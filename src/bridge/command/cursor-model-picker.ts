import { createConfigService } from '../../configuration/service.js';
import type { BridgeSession, ChannelAddress, OutboundRichCard } from '../../domain/index.js';
import type { CursorAvailableModel } from '../../runtime/cursor/models.js';
import { buildCommandCallbackData } from './callbacks.js';

export const CURSOR_MODEL_PICKER_PAGE_SIZE = 36;
export const CURSOR_MODEL_PAGE_ARG = '--cursor-model-page';

export interface CursorModelPickerPageRequest {
  requested: boolean;
  page?: number;
  invalid: boolean;
}

export function extractCursorModelPageArg(args: string): {
  args: string;
  page?: number;
  invalid: boolean;
} {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  let page: number | undefined;
  let invalid = false;
  const remaining: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const inline = token.match(/^--cursor-model-page=(.*)$/u);
    if (inline) {
      const parsed = Number(inline[1]);
      if (page !== undefined || !Number.isSafeInteger(parsed) || parsed < 1) invalid = true;
      else page = parsed;
      continue;
    }
    if (token === CURSOR_MODEL_PAGE_ARG) {
      const parsed = Number(tokens[index + 1]);
      if (page !== undefined || !Number.isSafeInteger(parsed) || parsed < 1) invalid = true;
      else page = parsed;
      index += 1;
      continue;
    }
    remaining.push(token);
  }
  return { args: remaining.join(' '), ...(page ? { page } : {}), invalid };
}

export function parseCursorModelPickerArgs(args: string): CursorModelPickerPageRequest {
  const parsed = extractCursorModelPageArg(args);
  if (parsed.args) return { requested: false, invalid: parsed.invalid || parsed.page !== undefined };
  return {
    requested: true,
    ...(parsed.page ? { page: parsed.page } : {}),
    invalid: parsed.invalid,
  };
}

export function sessionCursorModelOverride(sessionId: string): string | undefined {
  const resolved = createConfigService({ migrate: false }).resolve('runtime.cursor.model', {
    kind: 'session',
    sessionId,
  });
  return resolved.source === 'session' && typeof resolved.value === 'string' && resolved.value.trim()
    ? resolved.value.trim()
    : undefined;
}

function modelOptionText(model: CursorAvailableModel): string {
  const markers = [model.current ? 'current' : '', model.default ? 'default' : ''].filter(Boolean);
  return `${model.name}${markers.length > 0 ? ` (${markers.join(', ')})` : ''} · ${model.slug}`;
}

function selectionCommand(model: CursorAvailableModel, target: 'session' | 'global'): string {
  const value = model.default || model.slug === 'auto' ? 'default' : model.slug;
  return target === 'global' ? `/set cursorDefaultModel ${value}` : `/model ${value}`;
}

export function attachCursorModelPickerControls(options: {
  card: OutboundRichCard;
  models: CursorAvailableModel[];
  target: 'session' | 'global';
  selectedSlug?: string;
  requestedPage?: number;
  pageCommand: (page: number) => string;
  scopeSessionId?: string;
  configuredLabel: string;
  controlIdPrefix: string;
}): { card: OutboundRichCard; page: number; pageCount: number; selectedSlug?: string } {
  const currentModel = options.models.find((model) => model.current);
  const configuredModel = options.selectedSlug
    ? options.models.find((model) => model.slug === options.selectedSlug)
    : undefined;
  const automaticModel = options.target === 'global'
    ? options.models.find((model) => model.default || model.slug === 'auto') || currentModel
    : configuredModel || currentModel;
  const selected = configuredModel || automaticModel;
  const pageCount = Math.max(1, Math.ceil(options.models.length / CURSOR_MODEL_PICKER_PAGE_SIZE));
  const automaticPage = selected
    ? Math.floor(options.models.indexOf(selected) / CURSOR_MODEL_PICKER_PAGE_SIZE) + 1
    : 1;
  const page = Math.min(pageCount, Math.max(1, options.requestedPage || automaticPage));
  const pageModels = options.models.slice(
    (page - 1) * CURSOR_MODEL_PICKER_PAGE_SIZE,
    page * CURSOR_MODEL_PICKER_PAGE_SIZE,
  );
  const callback = (command: string) => buildCommandCallbackData(command, options.scopeSessionId);
  const selectedCallbackData = selected && pageModels.includes(selected)
    ? callback(selectionCommand(selected, options.target))
    : undefined;
  const modelSelect = {
    id: `${options.controlIdPrefix}_model`,
    placeholder: `Cursor 模型（第 ${page}/${pageCount} 页）`,
    selectedCallbackData,
    options: pageModels.map((model) => ({
      text: modelOptionText(model),
      callbackData: callback(selectionCommand(model, options.target)),
    })),
  };
  const pageSelect = {
    id: `${options.controlIdPrefix}_page`,
    placeholder: `模型页 ${page}/${pageCount}`,
    selectedCallbackData: callback(options.pageCommand(page)),
    options: Array.from({ length: pageCount }, (_, index) => ({
      text: `第 ${index + 1} 页`,
      callbackData: callback(options.pageCommand(index + 1)),
    })),
  };
  const form = options.card.form
    ? {
        ...options.card.form,
        extraInputs: options.card.form.extraInputs?.filter((input) => input.elementId !== 'cursorDefaultModel'),
      }
    : undefined;
  return {
    page,
    pageCount,
    selectedSlug: selected?.slug,
    card: {
      ...options.card,
      subtitle: `${options.card.subtitle || ''} · Cursor 账号实时列表 ${options.models.length} 个 · 第 ${page}/${pageCount} 页`.replace(/^ · /u, ''),
      selects: [...(options.card.selects || []), modelSelect, pageSelect],
      sections: [
        ...options.card.sections,
        { fields: [
          ['Cursor current', currentModel ? `${currentModel.name} · ${currentModel.slug}` : '未标记'],
          [options.configuredLabel, options.selectedSlug || (options.target === 'global' ? '跟随 Cursor 默认' : '跟随当前会话模型')],
        ] },
      ],
      ...(form ? { form } : {}),
      footer: [
        ...(options.card.footer || []),
        '模型列表实时来自 `cursor agent models`；current 是 Cursor 当前值，选择后仍走原有配置命令。',
      ],
    },
  };
}

export function buildCursorModelPickerCard(options: {
  session: BridgeSession;
  address: ChannelAddress;
  models: CursorAvailableModel[];
  requestedPage?: number;
}): { card: OutboundRichCard; page: number; pageCount: number; selectedSlug?: string } {
  const override = sessionCursorModelOverride(options.session.id);
  const base: OutboundRichCard = {
    title: 'Cursor 模型选择',
    template: 'blue',
    sections: [],
    actions: [[{
      text: '刷新列表',
      callbackData: buildCommandCallbackData(
        `/model ${CURSOR_MODEL_PAGE_ARG}=${options.requestedPage || 1}`,
        options.session.id,
      ),
    }]],
    updateKey: `cursor-model-picker:${options.address.channelType}:${options.address.chatId}`,
    updateTtlMs: null,
  };
  return attachCursorModelPickerControls({
    card: base,
    models: options.models,
    target: 'session',
    selectedSlug: override,
    requestedPage: options.requestedPage,
    pageCommand: (page) => `/model ${CURSOR_MODEL_PAGE_ARG}=${page}`,
    scopeSessionId: options.session.id,
    configuredLabel: '当前会话配置',
    controlIdPrefix: 'cursor_model_command',
  });
}
