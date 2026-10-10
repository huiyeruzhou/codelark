import type { FeishuChannelConfig } from '../types.js';
import type { ChannelAddress } from '../../domain/channel.js';
import { canControlCustomerService, customerServiceControllers, parseTopicConversationId } from './customer-service.js';

export function isCustomerServiceManagementCommand(text: string): boolean {
  return /^\/(?:whitelist|service-admin|customer)(?:\s|$)/i.test(text.trim());
}

export function editCustomerServiceMode(options: {
  config: FeishuChannelConfig; address: ChannelAddress; args: string; creatorId?: string | null;
}): { text: string; chats?: string[] } {
  const { config, address } = options;
  if (!canControlCustomerService(config, address.userId || '', options.creatorId)) {
    return { text: '只有客服控制白名单用户（留空时为 bot 创始人）可以管理客服模式。' };
  }
  const topic = parseTopicConversationId(address.chatId);
  const chatId = topic?.chatId || address.chatId;
  if (address.chatKind === 'p2p' || (!topic && address.chatKind !== 'group') || !/^oc_[a-zA-Z0-9]+$/.test(chatId)) {
    return { text: '请在需要设置的飞书群或群内话题中使用 /customer。' };
  }
  const action = options.args.trim().toLowerCase();
  const help = '用法：/customer 查看；/customer on 开启当前群；/customer off 关闭当前群。';
  const current = [...new Set(config.customerServiceChats || [])];
  const enabled = current.includes(chatId);
  const scope = '设置作用于整个群；是否需要 @ 沿用群聊 /require-at 设置。白名单用 /whitelist 管理。';
  if (!action || action === 'status') return { text: `当前群客服模式：${enabled ? 'on（已开启）' : 'off（未开启）'}。\n${help}\n${scope}` };
  if (action !== 'on' && action !== 'off') return { text: `参数无效，配置未修改。\n${help}` };
  const next = action === 'on';
  if (next === enabled) return { text: `当前群客服模式已是 ${action}，无需修改。\n${scope}` };
  return { chats: next ? [...current, chatId] : current.filter((id) => id !== chatId),
    text: `${next ? '已开启当前群客服模式，后续问题将在话题中答复' : '已关闭当前群客服模式，后续消息按普通群聊处理'}。\n${scope}` };
}

const USER_ID = /^ou_[a-zA-Z0-9]+$/;
export const WHITELIST_HELP = '用法：/whitelist 查看；/whitelist add @成员 添加；/whitelist remove @成员 移除（可同时 @ 多人）。空名单默认 bot 创始人拥有权限。';

/** Authorization is checked again at mutation time, including calls outside service groups. */
export function editCustomerServiceWhitelist(options: {
  config: FeishuChannelConfig; userId: string; args: string; mentionedUserIds?: string[]; creatorId?: string | null;
}): { text: string; users?: string[] } {
  const { config, userId } = options;
  const isDefault = !(config.customerServiceControlUsers || []).length;
  const current = [...new Set(customerServiceControllers(config, options.creatorId))];
  const parts = options.args.trim().split(/\s+/).filter(Boolean);
  const action = parts.shift()?.toLowerCase() || 'list';
  if (!canControlCustomerService(config, userId, options.creatorId)) {
    return { text: !isDefault
      ? '只有客服控制白名单中的成员可以管理名单。'
      : '白名单为空时，bot 创始人（飞书应用创建者）是默认管理员，可直接使用 /whitelist add @成员。' };
  }
  const scope = '此名单由当前机器人通道的所有客服群共用。';
  if (action === 'init') {
    if (parts.length || options.mentionedUserIds?.length) return { text: WHITELIST_HELP };
    return !isDefault ? { text: `名单已初始化。${WHITELIST_HELP}` }
      : { text: `已保存 bot 创始人为客服管理员；空名单时本就默认拥有权限。${scope}`, users: current };
  }
  if (action === 'list' && !parts.length && !options.mentionedUserIds?.length) {
    return { text: [`客服控制白名单（${current.length} 人${isDefault ? '，默认 bot 创始人' : ''}）`, ...current.map((id) => `- ${id}`), scope, WHITELIST_HELP].join('\n') };
  }
  if (action !== 'add' && action !== 'remove') return { text: WHITELIST_HELP };
  const targets = [...new Set([...parts.map((value) => value === 'me' ? userId : value), ...(options.mentionedUserIds || [])])];
  if (!targets.length || targets.some((id) => !USER_ID.test(id))) {
    return { text: `请使用飞书实际 @ 选择成员，或填写 ou_ 开头的用户 ID；不支持 @所有人、群 ID 或手写 @姓名。\n${WHITELIST_HELP}` };
  }
  const users = action === 'add' ? [...new Set([...current, ...targets])] : current.filter((id) => !targets.includes(id));
  if (!users.length) return { text: '不能移除最后一位客服管理员，请先添加另一位管理员。清空配置名单会恢复 bot 创始人的默认权限。' };
  const changed = action === 'add' ? users.length - current.length : current.length - users.length;
  if (!changed && isDefault && action === 'add') return { text: `已将默认的 bot 创始人保存到白名单，当前 ${users.length} 人。${scope}`, users };
  if (!changed && !(isDefault && action === 'add')) return { text: `名单无需修改，当前 ${current.length} 人。${scope}` };
  return { text: `已${action === 'add' ? '添加' : '移除'} ${changed} 位客服管理员，当前 ${users.length} 人；权限立即生效。\n${scope}`, users };
}
