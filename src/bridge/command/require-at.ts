import { getConfiguredChannelInstance } from '../../configuration/channel-instances.js';
import { createConfigService } from '../../configuration/service.js';
import type { InboundMessage } from '../../domain/index.js';
import { buildCommandFields } from './presentation.js';

function parseRequireAtArg(raw: string): boolean | 'show' | null {
  const token = raw.trim().toLowerCase();
  if (!token || token === 'status' || token === 'show') return 'show';
  if (['on', 'true', '1', 'yes', 'enable', 'enabled', 'require'].includes(token)) return true;
  if (['off', 'false', '0', 'no', 'disable', 'disabled', 'optional'].includes(token)) return false;
  return null;
}

function formatRequireAtMode(requireMention: boolean): string {
  return requireMention ? 'on（群聊必须 @bot）' : 'off（群聊不需要 @bot）';
}

const REQUIRE_AT_NOTES = [
  '用法：`/require-at on` 要求群聊 @bot；`/require-at off` 允许群聊不 @bot。',
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
      ['用法：`/require-at` 查看当前设置，`/require-at on` 要求群聊 @bot，`/require-at off` 允许群聊不 @bot。'],
      options.markdown,
    );
  }

  const service = createConfigService({ migrate: false });
  const channel = getConfiguredChannelInstance(options.msg.address.channelType, service);
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

  const currentValue = channel.config.requireMention === true;
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

  service.set({ kind: 'home' }, {
    channels: [{
      id: channel.id,
      config: {
        requireMention: parsed,
      },
    }],
  });
  const savedChannel = getConfiguredChannelInstance(channel.id, service);
  const savedValue = savedChannel?.config.requireMention === true;

  return buildCommandFields(
    '已更新群聊 @bot 设置',
    [
      ['通道', channel.alias || channel.id],
      ['当前值', formatRequireAtMode(savedValue)],
    ],
    [
      '配置已保存到 `~/.codelark/config.toml`；运行中的 Bridge 会在下一次通道配置同步时重载该通道。',
      '如果关闭 @ 后群消息仍没有触发 Bridge，请检查飞书应用权限和事件订阅，尤其是“读取群组中所有消息”及 `im.message.receive_v1`。权限变更后可能需要重新发布/生效应用配置。',
    ],
    options.markdown,
  );
}
