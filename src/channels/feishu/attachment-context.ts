function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function quote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

export function feishuResourceReference(key: string): string {
  return `<feishu_resource_ref key="${encodeURIComponent(key)}" />`;
}

/** Keep the resource and recovery steps beside the message that contains it. */
export function describeDeferredFeishuAttachment(options: {
  messageId: string; fileKey: string; type: string; name?: string; size?: number;
  appId: string; reason: string; merged?: boolean;
}): string {
  const type = options.type === 'image' ? 'image' : 'file';
  const name = options.name || options.fileKey;
  const output = `./${name.replace(/[/\\\x00-\x1f]/g, '_')}`;
  const command = `lark-cli im +messages-resources-download --as user --message-id ${quote(options.messageId)} --file-key ${quote(options.merged ? '替换为原消息中的 file_key' : options.fileKey)} --type ${type} --output ${quote(output)}`;
  return [
    `<feishu_attachment name="${attribute(name)}" message_id="${attribute(options.messageId)}" file_key="${attribute(options.fileKey)}" resource_type="${type}" app_id="${attribute(options.appId)}" status="not_downloaded"${options.size === undefined ? '' : ` size_bytes="${options.size}"`}>`,
    options.reason,
    ...(options.merged ? [
      '合并转发子消息的资源 key 不能直接用于下载。先用有权访问原消息的用户身份读取原消息，取得原始 file_key，再执行下载命令；无法访问原消息时，请在飞书打开合并转发并保存附件，或单独转发该附件。',
      `原消息读取：lark-cli api GET ${quote(`/open-apis/im/v1/messages/${encodeURIComponent(options.messageId)}`)} --as user`,
    ] : []),
    '按需下载（使用已登录且有权读取该消息的 lark-cli 用户身份；多应用时指定对应 --profile）：',
    command,
    '</feishu_attachment>',
  ].join('\n');
}
