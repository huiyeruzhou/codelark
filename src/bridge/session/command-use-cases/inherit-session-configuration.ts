import { configFields } from '../../../configuration/fields.js';
import { getConfigPath, setConfigPath } from '../../../configuration/path-access.js';
import { createConfigService } from '../../../configuration/service.js';
import type { ConfigPatch } from '../../../configuration/schema.js';
import type { BridgeSession, BridgeStore, ChannelChat } from '../../../domain/index.js';
import { getSessionActiveRuntime, getSessionSystemPrompt } from '../../../domain/session-runtime.js';
import { scopedConfigForRuntime } from '../support.js';

/** 新上下文保留配置；线程身份、任务、健康状态和终端句柄由新会话建立。 */
export function inheritSessionConfiguration(options: {
  store: BridgeStore;
  sourceBinding: ChannelChat | null;
  sourceSession: BridgeSession | null;
  newBinding: ChannelChat;
  workDir: string;
  preserveOtherRuntimeBindings?: boolean;
}): ChannelChat {
  const { store, sourceSession, sourceBinding, newBinding, workDir } = options;
  const newSession = store.getSession(newBinding.bridgeSessionId);
  const activeRuntime = getSessionActiveRuntime(sourceSession || newSession) || 'codex';
  if (sourceSession && newSession) {
    const { config } = scopedConfigForRuntime(sourceBinding, sourceSession);
    const patch: ConfigPatch = {};
    for (const field of configFields) {
      if (!field.scopes.some((scope) => scope === 'session')) continue;
      const value = getConfigPath(config, field.path);
      if (value !== undefined) setConfigPath(patch, field.path, value);
    }
    // 用户显式输入的目录（或命令已经解析好的继承目录）优先于旧配置。
    setConfigPath(patch, 'session.workspace', workDir);
    setConfigPath(patch, 'runtime.agent', activeRuntime);
    createConfigService({ migrate: false }).set({ kind: 'session', sessionId: newSession.id }, patch);
    const endpoint = sourceSession.runtime?.codex?.appServerEndpoint;
    store.updateSession(newSession.id, {
      runtime: {
        activeRuntime,
        general: { systemPrompt: getSessionSystemPrompt(sourceSession) },
        ...(activeRuntime === 'codex' && endpoint ? { codex: { appServerEndpoint: endpoint } } : {}),
      },
    }, { touch: false });
    store.updateSessionProviderId(newSession.id, sourceSession.provider_id || '');
  }
  store.updateChannelChat(newBinding.id, {
    runtimeBridgeSessionIds: {
      ...(options.preserveOtherRuntimeBindings ? sourceBinding?.runtimeBridgeSessionIds : {}),
      [activeRuntime]: newBinding.bridgeSessionId,
    },
  });
  return store.getChannelChat(newBinding.channelType, newBinding.chatId) || newBinding;
}
