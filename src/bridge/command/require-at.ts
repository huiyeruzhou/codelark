import { createConfigService } from '../../configuration/service.js';
import { getBridgeContext } from '../host/context.js';
import * as router from '../session/channel-router.js';
import { sessionRequiresMention } from '../session/require-mention.js';
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

  const store = getBridgeContext().store;
  const binding = store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId)
    || router.resolve(options.msg.address);
  const session = store.getSession(binding.bridgeSessionId);
  if (!session) return '当前会话不存在，无法修改群聊 @bot 设置。';
  const currentValue = sessionRequiresMention(store, options.msg.address);
  if (parsed !== 'show') {
    createConfigService({ migrate: false }).set({ kind: 'session', sessionId: session.id }, {
      session: { requireMention: parsed },
    });
  }
  return buildCommandFields(
    parsed === 'show' ? '当前会话群聊 @bot 设置' : '已更新当前会话群聊 @bot 设置',
    [
      ['会话', session.name || session.id],
      ['当前值', formatRequireAtMode(parsed === 'show' ? currentValue : parsed)],
    ],
    [
      '只作用于当前绑定的会话；后续入站消息立即按此设置过滤，无需重启通道。私聊不受影响。',
      '`/clear` 和 `/new` 继承此设置；切换到已有会话时使用目标会话自己的设置。',
      ...REQUIRE_AT_NOTES,
    ],
    options.markdown,
  );
}
