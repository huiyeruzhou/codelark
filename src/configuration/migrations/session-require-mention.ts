import fs from 'node:fs';
import path from 'node:path';
import { tomlToConfigPatch } from '../schema.js';
import { materializeHomeChannelPatch, readDefaultsConfig, resolveConfigPaths, sessionTomlPath } from '../sources.js';
import type { ConfigMigration } from './types.js';

/** 迁移序号 v2；TOML schema 仍为 2。旧 channel 值迁入已绑定 session 后不再参与入站过滤。 */
export const sessionRequireMentionMigration: ConfigMigration = {
  id: 'v2', fromVersion: 2, toVersion: 2,
  description: '将旧通道群聊 @bot 要求迁移到已绑定会话，显式会话值优先，冲突时要求 @bot。',
  // 没有旧绑定也要记录完成，避免以后创建的会话被当成升级前的会话迁移。
  detect: () => true,
  apply(context) {
    const bindingsFile = path.join(context.codelarkHome, 'data', 'channel-chats.json');
    if (!fs.existsSync(context.paths.homeToml) || !fs.existsSync(bindingsFile)) return { changed: false };
    const bindings = context.readJson<Record<string, {
      channelType: string; bridgeSessionId: string; runtimeBridgeSessionIds?: Record<string, string>;
    }>>(bindingsFile);
    if (bindings && Object.keys(bindings).length === 0) return { changed: false };
    const sessions = context.readJson<Record<string, unknown>>(context.paths.dataSessionsJson);
    if (!bindings || !sessions) throw new Error('require-at 迁移无法读取现有会话/绑定，未标记迁移完成。');
    const paths = resolveConfigPaths({ codelarkHome: context.codelarkHome });
    const defaults = readDefaultsConfig(paths.defaultsToml).patch;
    const home = tomlToConfigPatch(context.readToml(context.paths.homeToml));
    // home channels 整组替换 defaults；保留配置顺序，provider 别名应匹配第一项。
    const channels = materializeHomeChannelPatch(defaults, {}, home).channels ?? defaults.channels ?? [];
    const candidates = new Map<string, Map<string, boolean>>();
    for (const binding of Object.values(bindings)) {
      // 与 getConfiguredChannelInstance 一致：精确 id 优先，再按 provider 兼容旧标识。
      const channel = channels.find((item) => item.id === binding.channelType)
        || channels.find((item) => item.provider === binding.channelType);
      if (!channel || channel.provider !== 'feishu') continue;
      for (const id of new Set([binding.bridgeSessionId, ...Object.values(binding.runtimeBridgeSessionIds || {})])) {
        if (!id || !sessions[id]) continue;
        const values = candidates.get(id) || new Map<string, boolean>();
        values.set(channel.id, channel.config?.requireMention === true);
        candidates.set(id, values);
      }
    }
    const backedUpFiles = [context.backupFile(context.paths.homeToml, 'v2'), context.backupFile(bindingsFile, 'v2')]
      .filter((file): file is string => Boolean(file));
    const writtenFiles: string[] = [];
    const warnings: string[] = [];
    for (const [id, values] of candidates) {
      const file = sessionTomlPath(paths, id);
      const raw = fs.existsSync(file) ? context.readToml(file) as Record<string, any> : {};
      // false 也是显式选择，绝不被旧 channel 的 true 覆盖。
      if (typeof raw.session?.require_mention === 'boolean') continue;
      const requireMention = [...values.values()].some(Boolean);
      if (new Set(values.values()).size > 1) {
        warnings.push(`会话 ${id} 的旧 channel require_mention 冲突（${[...values.keys()].sort().join(', ')}），已迁移为 on；可用 /require-at off 修改该会话。`);
      }
      const backup = context.backupFile(file, 'v2');
      if (backup) backedUpFiles.push(backup);
      context.writeTomlAtomic(file, { ...raw, session: { ...raw.session, require_mention: requireMention } });
      writtenFiles.push(file);
    }
    return { changed: writtenFiles.length > 0, writtenFiles, backedUpFiles, warnings };
  },
};
