import { configFields } from '../../../configuration/fields.js';
import { getConfigPath, setConfigPath } from '../../../configuration/path-access.js';
import { createConfigService } from '../../../configuration/service.js';
import type { ConfigPatch, ConfigV2 } from '../../../configuration/schema.js';
import type { BridgeSession, BridgeStore, ChannelChat, RuntimeAgent } from '../../../domain/index.js';
import { getSessionActiveRuntime, getSessionSystemPrompt } from '../../../domain/session-runtime.js';
import { scopedConfigForRuntime } from '../support.js';

/** 只投影 session 可写配置；不携带 thread、endpoint、任务或健康状态。 */
export function projectSessionConfiguration(config: ConfigV2, workDir: string, runtime: RuntimeAgent): ConfigPatch {
  const patch: ConfigPatch = {};
  for (const field of configFields) {
    if (!field.scopes.some((scope) => scope === 'session')) continue;
    const value = getConfigPath(config, field.path);
    if (value !== undefined) setConfigPath(patch, field.path, value);
  }
  // 命令解析后的目录和目标 runtime 优先于来源配置。
  setConfigPath(patch, 'session.workspace', workDir);
  setConfigPath(patch, 'runtime.agent', runtime);
  return patch;
}

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
    const patch = projectSessionConfiguration(config, workDir, activeRuntime);
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
