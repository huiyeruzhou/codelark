import { createConfigService } from '../../configuration/service.js';
import type { BridgeSession, ChannelAddress, OutboundRichCard } from '../../domain/index.js';
import type { DoubaoModelInfo } from '../../runtime/doubao/models.js';
import { buildCommandCallbackData } from './callbacks.js';

export const DOUBAO_MODEL_REFRESH_ARG = '--refresh';

export function sessionDoubaoModelOverride(sessionId: string): string | undefined {
  const resolved = createConfigService({ migrate: false }).resolve('runtime.doubao.model', {
    kind: 'session',
    sessionId,
  });
  return resolved.source === 'session' && typeof resolved.value === 'string' && resolved.value.trim()
    ? resolved.value.trim()
    : undefined;
}

export function formatDoubaoModelDisplay(
  modelId: string | undefined,
  models: readonly DoubaoModelInfo[],
): string {
  const normalized = modelId?.trim();
  if (!normalized) return '未设置覆盖（跟随默认）';
  const matched = models.find((model) => model.id.toLowerCase() === normalized.toLowerCase());
  return matched && matched.name !== matched.id
    ? `${matched.name} (${matched.id})`
    : normalized;
}

function selectionCommand(value: string, target: 'session' | 'global'): string {
  return target === 'global' ? `/set doubaoDefaultModel ${value}` : `/model ${value}`;
}

export function attachDoubaoModelPickerControls(options: {
  card: OutboundRichCard;
  models: readonly DoubaoModelInfo[];
  target: 'session' | 'global';
  selectedModelId?: string;
  scopeSessionId?: string;
  configuredLabel: string;
  controlIdPrefix: string;
}): { card: OutboundRichCard; selectedModelId?: string } {
  const normalizedSelected = options.selectedModelId?.trim() || undefined;
  const matchedSelected = normalizedSelected
    ? options.models.find((model) => model.id.toLowerCase() === normalizedSelected.toLowerCase())
    : undefined;
  const callback = (command: string) => buildCommandCallbackData(command, options.scopeSessionId);
  const defaultCallbackData = callback(selectionCommand('default', options.target));
  const selectedCallbackData = matchedSelected
    ? callback(selectionCommand(matchedSelected.id, options.target))
    : !normalizedSelected
      ? defaultCallbackData
      : undefined;

  const modelSelect = options.models.length > 0
    ? {
        id: `${options.controlIdPrefix}_model`,
        placeholder: `选择 Doubao 模型（共 ${options.models.length} 项）`,
        selectedCallbackData,
        options: [
          {
            text: '跟随默认（清除覆盖） · default',
            callbackData: defaultCallbackData,
          },
          ...options.models.map((model) => ({
            text: `${model.name}${model.isDefault ? '（默认）' : ''} · ${model.id}`,
            callbackData: callback(selectionCommand(model.id, options.target)),
          })),
        ],
      }
    : undefined;

  const form = options.card.form && modelSelect
    ? {
        ...options.card.form,
        extraInputs: options.card.form.extraInputs?.filter((input) => input.elementId !== 'doubaoDefaultModel'),
      }
    : options.card.form;

  return {
    selectedModelId: matchedSelected?.id || normalizedSelected,
    card: {
      ...options.card,
      subtitle: `${options.card.subtitle || ''} · Doubao 模型目录 ${options.models.length} 项`.replace(/^ · /u, ''),
      selects: [...(options.card.selects || []), ...(modelSelect ? [modelSelect] : [])],
      sections: [
        ...options.card.sections,
        {
          fields: [
            [options.configuredLabel, formatDoubaoModelDisplay(normalizedSelected, options.models)],
          ],
        },
      ],
      ...(form ? { form } : {}),
      footer: [
        ...(options.card.footer || []),
        '选择后写入配置；下一轮发消息时 Doubao ACP 会通过 session/set_config_option 自动热切换模型。',
      ],
    },
  };
}

export function buildDoubaoModelPickerCard(options: {
  session: BridgeSession;
  address: ChannelAddress;
  models: readonly DoubaoModelInfo[];
  effectiveModel?: string;
}): { card: OutboundRichCard; selectedModelId?: string } {
  const override = sessionDoubaoModelOverride(options.session.id);
  const effectiveLabel = formatDoubaoModelDisplay(override || options.effectiveModel, options.models);
  const effortLines = options.models.map((model) => {
    const efforts = model.efforts.length > 0
      ? ` · 思考级别：${model.efforts.join('/')}${model.defaultEffort ? `（默认 ${model.defaultEffort}）` : ''}`
      : '';
    return `- **${model.name}**${model.isDefault ? '（默认）' : ''} · \`${model.id}\`${efforts}`;
  });

  const base: OutboundRichCard = {
    title: 'Doubao 模型选择',
    template: 'blue',
    sections: [
      ...(override || !options.effectiveModel
        ? []
        : [{ fields: [['当前生效模型', effectiveLabel] as [string, string]] }]),
      ...(effortLines.length > 0 ? [{ markdown: `**可用模型**\n\n${effortLines.join('\n')}` }] : []),
    ],
    actions: [[{
      text: '刷新列表',
      callbackData: buildCommandCallbackData(`/model ${DOUBAO_MODEL_REFRESH_ARG}`, options.session.id),
    }]],
    updateKey: `doubao-model-picker:${options.address.channelType}:${options.address.chatId}`,
    updateTtlMs: null,
  };

  return attachDoubaoModelPickerControls({
    card: base,
    models: options.models,
    target: 'session',
    selectedModelId: override,
    scopeSessionId: options.session.id,
    configuredLabel: '当前会话配置',
    controlIdPrefix: 'doubao_model_command',
  });
}
