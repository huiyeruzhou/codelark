import {
  loadConfig,
  parseFeishuRequireMentionMode,
  saveConfig,
  type FeishuChannelConfig,
} from '../../configuration/index.js';
import type { InboundMessage } from '../../domain/index.js';
import { buildCommandFields } from './presentation.js';

type RequireAtMode = boolean | 'context';

function parseRequireAtArg(raw: string): RequireAtMode | 'show' | null {
  const token = raw.trim().toLowerCase();
  if (!token || token === 'status' || token === 'show') return 'show';
  if (['on', 'true', '1', 'yes', 'enable', 'enabled', 'require'].includes(token)) return true;
  if (['off', 'false', '0', 'no', 'disable', 'disabled', 'optional'].includes(token)) return false;
  if (['context', 'ctx', 'listen'].includes(token)) return 'context';
  return null;
}

function formatRequireAtMode(mode: RequireAtMode): string {
  if (mode === 'context') return 'context（非 @ 只进入上下文，不触发回复）';
  return mode ? 'on（群聊必须 @bot）' : 'off（群聊不需要 @bot）';
}

const REQUIRE_AT_NOTES = [
  '用法：`/require-at on` 只处理 @bot；`/require-at off` 所有群消息都会触发回复；`/require-at context` 非 @ 消息只进入上下文，下一次 @bot 时附带。',
  '如果关闭 @ 后群消息仍没有触发 Bridge，请检查飞书应用权限和事件订阅，尤其是“读取群组中所有消息”及 `im.message.receive_v1`。权限变更后可能需要重新发布/生效应用配置。',
];

export function handleRequireAtCommand(options: {
  msg: InboundMessage;
  args: string;
  markdown: boolean;
}): string {
  const parsed = parseRequireAtArg(options.args);
  if (parsed === null) {
    return buildCommandFields(
      '群聊 @bot 设置未更新',
      [['输入', options.args || '-']],
      ['用法：`/require-at` 查看当前设置，`/require-at on|off|context` 切换群聊消息处理模式。'],
      options.markdown,
    );
  }

  const current = loadConfig();
  const channel = (current.channels || []).find((item) => item.id === options.msg.address.channelType);
  if (!channel) {
    return buildCommandFields(
      '群聊 @bot 设置未更新',
      [['通道', options.msg.address.channelType]],
      ['当前通道不在配置文件中，请先在 Web 控制台保存该通道配置。'],
      options.markdown,
    );
  }
  if (channel.provider !== 'feishu') {
    return buildCommandFields(
      '群聊 @bot 设置未更新',
      [['通道', channel.alias || channel.id], ['类型', channel.provider]],
      ['这个命令只适用于飞书通道。'],
      options.markdown,
    );
  }

  const feishuConfig = channel.config as FeishuChannelConfig;
  const currentValue = parseFeishuRequireMentionMode(feishuConfig.requireMention);
  if (parsed === 'show') {
    return buildCommandFields(
      '群聊 @bot 设置',
      [
        ['通道', channel.alias || channel.id],
        ['当前值', formatRequireAtMode(currentValue)],
      ],
      REQUIRE_AT_NOTES,
      options.markdown,
    );
  }

  const now = new Date().toISOString();
  const nextChannels = (current.channels || []).map((item) => {
    if (item.id !== channel.id) return item;
    return {
      ...item,
      updatedAt: now,
      config: {
        ...item.config,
        requireMention: parsed,
      },
    };
  });

  saveConfig({
    ...current,
    channels: nextChannels,
    enabledChannels: Array.from(new Set(nextChannels.filter((item) => item.enabled).map((item) => item.provider))),
  });
  const savedChannel = loadConfig().channels?.find((item) => item.id === channel.id);
  const savedConfig = savedChannel?.config as FeishuChannelConfig | undefined;
  const savedValue = parseFeishuRequireMentionMode(savedConfig?.requireMention);

  return buildCommandFields(
    '已更新群聊 @bot 设置',
    [
      ['通道', channel.alias || channel.id],
      ['当前值', formatRequireAtMode(savedValue)],
    ],
    [
      '配置已保存到 `~/.codelark/config.json` 与 `config.env`；运行中的 Bridge 会在下一次通道配置同步时重载该通道。',
      savedValue === 'context'
        ? '`context` 模式需要飞书应用具备“获取群组中所有消息”权限；非 @ 消息会写入当前群绑定会话的上下文，但不会触发 Codex 回复。'
        : '',
      '如果关闭 @ 后群消息仍没有触发 Bridge，请检查飞书应用权限和事件订阅，尤其是“读取群组中所有消息”及 `im.message.receive_v1`。权限变更后可能需要重新发布/生效应用配置。',
    ].filter(Boolean),
    options.markdown,
  );
}
