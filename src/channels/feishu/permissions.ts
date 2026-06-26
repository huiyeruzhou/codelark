export interface FeishuPermissionRequirement {
  scope: string;
  reason: string;
}

export interface FeishuEventRequirement {
  event: string;
  reason: string;
}

export interface FeishuCallbackRequirement {
  callback: string;
  reason: string;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export const FEISHU_BASE_TENANT_SCOPES: FeishuPermissionRequirement[] = [
  { scope: 'im:message:send_as_bot', reason: 'Send bot text, post, card, file, and permission messages.' },
  { scope: 'im:message:readonly', reason: 'Read message metadata and hydrate quoted messages.' },
  { scope: 'im:message.p2p_msg:readonly', reason: 'Receive direct messages from users.' },
  { scope: 'im:message.group_at_msg:readonly', reason: 'Receive group messages and @bot mentions.' },
  { scope: 'im:message:update', reason: 'Update interactive card messages during streaming.' },
  { scope: 'im:message.reactions:read', reason: 'Read message reaction state when available.' },
  { scope: 'im:message.reactions:write_only', reason: 'Add completion/error reactions to bridge messages.' },
  { scope: 'im:message.pins:write_only', reason: 'Pin and unpin thread table messages.' },
  { scope: 'im:chat', reason: 'Create and manage bridge group chats.' },
  { scope: 'im:chat:read', reason: 'Read group metadata and receive group lifecycle events.' },
  { scope: 'im:chat:create', reason: 'Create group-backed bridge sessions as the bot.' },
  { scope: 'im:chat:create_by_user', reason: 'Allow bot OpenAPI chat creation with a designated user owner when required.' },
  { scope: 'im:chat:update', reason: 'Rename group-backed bridge sessions.' },
  { scope: 'im:resource', reason: 'Upload and send IM image/file resources.' },
  { scope: 'drive:file:upload', reason: 'Upload confirmed large files to Drive with multipart upload.' },
  { scope: 'drive:drive.metadata:readonly', reason: 'Fetch Drive file URLs after confirmed large file uploads.' },
  { scope: 'docs:permission.setting:write_only', reason: 'Set readable link sharing on Drive files uploaded for chats.' },
  { scope: 'docs:permission.member:create', reason: 'Grant chat members view access to Drive files uploaded for group chats.' },
  { scope: 'cardkit:card:write', reason: 'Create and update streaming CardKit cards.' },
  { scope: 'cardkit:card:read', reason: 'Read CardKit card state when updating existing cards.' },
];

export const FEISHU_DOC_TO_CHAT_TENANT_SCOPES: FeishuPermissionRequirement[] = [
  { scope: 'docs:document.comment:read', reason: 'Read cloud document comment content after comment events.' },
  { scope: 'docs:document.comment:create', reason: 'Reply to cloud document comments.' },
  { scope: 'docs:document.comment:write_only', reason: 'Create fallback document comments and Typing reactions.' },
];

export const FEISHU_REAL_E2E_USER_MESSAGE_SCOPES: FeishuPermissionRequirement[] = [
  { scope: 'im:message.send_as_user', reason: 'Send real Feishu E2E setup and steering messages as the test user.' },
  { scope: 'im:message.group_msg:get_as_user', reason: 'Read group chat transcripts during real Feishu E2E assertions.' },
  { scope: 'im:message.p2p_msg:get_as_user', reason: 'Read direct-message transcripts during real Feishu E2E assertions.' },
];

export const FEISHU_DOC_TO_CHAT_USER_AUTH_SCOPES: FeishuPermissionRequirement[] = [
  { scope: 'im:chat', reason: 'Support user-perspective real Feishu E2E chat setup and diagnostics.' },
  { scope: 'im:chat:read', reason: 'Inspect created group state during setup and diagnostics.' },
  { scope: 'im:chat:delete', reason: 'Clean up user-created real Feishu E2E groups.' },
  ...FEISHU_REAL_E2E_USER_MESSAGE_SCOPES,
  { scope: 'docs:document.comment:read', reason: 'Inspect document comments for doc-to-chat diagnostics.' },
  { scope: 'docs:document.comment:create', reason: 'Create document comments in real doc-to-chat E2E flows.' },
  { scope: 'docs:document.comment:write_only', reason: 'Write document comments and reactions where supported.' },
];

export const FEISHU_REQUIRED_EVENTS: FeishuEventRequirement[] = [
  { event: 'im.message.receive_v1', reason: 'Receive IM messages from users and groups.' },
  { event: 'drive.notice.comment_add_v1', reason: 'Receive cloud document comment events for doc-to-chat.' },
  { event: 'im.chat.member.bot.deleted_v1', reason: 'Detect when the bridge bot is removed from a group.' },
  { event: 'im.chat.disbanded_v1', reason: 'Detect when a group-backed bridge chat is disbanded.' },
];

export const FEISHU_REQUIRED_CALLBACKS: FeishuCallbackRequirement[] = [
  { callback: 'card.action.trigger', reason: 'Receive interactive card button and form submissions.' },
];

export function feishuSetupTenantScopes(): string[] {
  return uniqueSorted([
    ...FEISHU_BASE_TENANT_SCOPES.map((item) => item.scope),
    ...FEISHU_DOC_TO_CHAT_TENANT_SCOPES.map((item) => item.scope),
  ]);
}

export function feishuSetupUserAuthScopes(): string[] {
  return uniqueSorted(FEISHU_DOC_TO_CHAT_USER_AUTH_SCOPES.map((item) => item.scope));
}

export function feishuSetupUserAuthScopeArgument(): string {
  return feishuSetupUserAuthScopes().join(' ');
}

export function feishuSetupPermissionSummary(): string {
  return [
    `控制台权限：${feishuSetupTenantScopes().length} 个`,
    `lark-cli 用户授权额外 scope：${feishuSetupUserAuthScopes().length} 个`,
    `事件订阅：${FEISHU_REQUIRED_EVENTS.map((item) => item.event).join(', ')}`,
    `回调订阅：${FEISHU_REQUIRED_CALLBACKS.map((item) => item.callback).join(', ')}`,
  ].join('\n');
}
