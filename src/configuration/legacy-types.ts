import type {
  ChannelProvider,
  FeishuChannelConfig,
} from './channel-types.js';
import type {
  ClaudeExecutable,
  ClaudePermissionMode,
  ClaudeProviderChoice,
  CodexProviderChoice,
  CodexReasoningEffort,
  CodexSandboxMode,
  RuntimeProvider,
} from '../runtime/options.js';

export interface CodexRuntimeDefaultsConfig {
  defaultModel?: string;
  defaultMode?: string;
  skipGitRepoCheck?: boolean;
  sandboxMode?: CodexSandboxMode;
  networkAccess?: boolean;
  reasoningEffort?: CodexReasoningEffort;
}

export interface ClaudeRuntimeDefaultsConfig {
  provider?: ClaudeProviderChoice;
  executable?: ClaudeExecutable;
  defaultModel?: string;
  permissionMode?: ClaudePermissionMode;
  idleTimeoutMinutes?: number;
}

export interface BridgeControlConfig {
  defaultCodexProvider?: CodexProviderChoice;
}

export interface GlobalBridgeConfig {
  defaultWorkspaceRoot?: string;
  historyMessageLimit?: number;
  streamStatusIdleStartSeconds?: number;
  streamStatusCheckIntervalSeconds?: number;
  uiAllowLan?: boolean;
  uiAccessToken?: string;
}

export interface RuntimeConfig {
  provider: RuntimeProvider;
  codex?: CodexRuntimeDefaultsConfig;
  claude?: ClaudeRuntimeDefaultsConfig;
  bridgeControl?: BridgeControlConfig;
  bridge?: GlobalBridgeConfig;
}

export interface ChannelInstance {
  id: string;
  alias: string;
  provider: ChannelProvider;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  config: FeishuChannelConfig;
}

export interface Config {
  runtime: RuntimeConfig['provider'];
  defaultWorkspaceRoot?: string;
  defaultModel?: string;
  defaultProvider?: CodexProviderChoice;
  defaultMode: string;
  historyMessageLimit?: number;
  streamStatusIdleStartSeconds?: number;
  streamStatusCheckIntervalSeconds?: number;
  codexSkipGitRepoCheck?: boolean;
  codexSandboxMode?: CodexSandboxMode;
  codexNetworkAccess?: boolean;
  codexReasoningEffort?: CodexReasoningEffort;
  claudeDefaultModel?: string;
  claudeProvider?: ClaudeProviderChoice;
  claudeExecutable?: ClaudeExecutable;
  claudePermissionMode?: ClaudePermissionMode;
  claudeIdleTimeoutMinutes?: number;
  uiAllowLan?: boolean;
  uiAccessToken?: string;
  schemaVersion?: number;
  channels?: ChannelInstance[];
  enabledChannels: string[];
}

