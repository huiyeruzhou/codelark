import type { ChannelChatMode } from './channel.js';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type KimiThinkingMode = 'default' | 'on' | 'off';
export type CursorReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ZcodeMode = 'build' | 'edit' | 'plan' | 'yolo';
export type RuntimeProviderChoice = 'sdk' | 'pty' | 'tmux';
export type ClaudeProviderChoice = RuntimeProviderChoice;
export type KimiProviderChoice = 'tmux';
export type CursorProviderChoice = 'tmux';
export type ZcodeProviderChoice = 'tmux';
export type RuntimeAgent = 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode';
export type RuntimeProviderIdentity =
  | `${'codex' | 'claude'}:${RuntimeProviderChoice}`
  | `kimi:${KimiProviderChoice}`
  | `cursor:${CursorProviderChoice}`
  | `zcode:${ZcodeProviderChoice}`;
export type ClaudeExecutable = 'claude' | 'ccr';

export type BridgeSessionHealthStatus =
  | 'idle'
  | 'running_active'
  | 'waiting_tool'
  | 'slow_observed'
  | 'suspected_stall'
  | 'suspected_stream_ui_stall'
  | 'suspected_detached'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface BridgeSession {
  id: string;
  name?: string;
  provider_id?: string;
  runtime?: BridgeSessionRuntimeState;
  session_type?: 'normal' | 'draft';
  hidden?: boolean;
  parent_session_id?: string;
  expires_at?: string;
  runtime_status?: 'idle' | 'running' | 'queued';
  queued_count?: number;
  last_runtime_update_at?: string;
  health_status?: BridgeSessionHealthStatus;
  health_reason?: string;
  last_progress_at?: string;
  last_progress_type?: string;
  active_tools_json?: string;
  active_tool_name?: string;
  active_tool_started_at?: string;
  last_tool_finished_at?: string;
  last_stream_ui_attempt_at?: string;
  last_stream_ui_update_at?: string;
  stream_ui_flush_started_at?: string;
  last_stream_ui_error_at?: string;
  last_stream_ui_error?: string;
  stream_ui_consecutive_failures?: number;
  mirror_status?: 'inactive' | 'watching' | 'stale';
  mirror_last_event_at?: string;
  created_at?: string;
  updated_at?: string;
}

export type BridgeSessionRuntimeState =
  | BridgeSessionCodexRuntimeContainer
  | BridgeSessionClaudeRuntimeContainer
  | BridgeSessionKimiRuntimeContainer
  | BridgeSessionCursorRuntimeContainer
  | BridgeSessionZcodeRuntimeContainer;

export interface BridgeSessionCodexRuntimeContainer {
  activeRuntime?: 'codex';
  codex?: BridgeSessionCodexRuntimeState;
  claude?: never;
  kimi?: never;
  cursor?: never;
  zcode?: never;
  general?: BridgeSessionGeneralState;
}

export interface BridgeSessionClaudeRuntimeContainer {
  activeRuntime: 'claude';
  codex?: never;
  claude?: BridgeSessionClaudeRuntimeState;
  kimi?: never;
  cursor?: never;
  zcode?: never;
  general?: BridgeSessionGeneralState;
}

export interface BridgeSessionKimiRuntimeContainer {
  activeRuntime: 'kimi';
  codex?: never;
  claude?: never;
  kimi?: BridgeSessionKimiRuntimeState;
  cursor?: never;
  zcode?: never;
  general?: BridgeSessionGeneralState;
}

export interface BridgeSessionCursorRuntimeContainer {
  activeRuntime: 'cursor';
  codex?: never;
  claude?: never;
  kimi?: never;
  cursor?: BridgeSessionCursorRuntimeState;
  zcode?: never;
  general?: BridgeSessionGeneralState;
}

export interface BridgeSessionZcodeRuntimeContainer {
  activeRuntime: 'zcode';
  codex?: never;
  claude?: never;
  kimi?: never;
  cursor?: never;
  zcode?: BridgeSessionZcodeRuntimeState;
  general?: BridgeSessionGeneralState;
}

export interface BridgeSessionCodexRuntimeState {
  threadId?: string;
  title?: string;
  model?: string;
  provider?: RuntimeProviderChoice;
  mode?: ChannelChatMode;
  sandboxMode?: CodexSandboxMode;
  networkAccess?: boolean;
  reasoningEffort?: CodexReasoningEffort;
}

export interface BridgeSessionClaudeRuntimeState {
  sessionId?: string;
  cwd?: string;
  model?: string;
  provider?: ClaudeProviderChoice;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  idleTimeoutMinutes?: number;
}

export interface BridgeSessionKimiRuntimeState {
  sessionId?: string;
  cwd?: string;
  model?: string;
  provider?: KimiProviderChoice;
  thinkingMode?: KimiThinkingMode;
}

export interface BridgeSessionCursorRuntimeState {
  sessionId?: string;
  cwd?: string;
  model?: string;
  provider?: CursorProviderChoice;
  force?: boolean;
  reasoningEffort?: CursorReasoningEffort;
}

export interface BridgeSessionZcodeRuntimeState {
  sessionId?: string;
  cwd?: string;
  model?: string;
  provider?: ZcodeProviderChoice;
  mode?: ZcodeMode;
}

export interface BridgeSessionGeneralState {
  workingDirectory?: string;
  systemPrompt?: string;
  tmuxSessionName?: string;
  captureLines?: number;
  autoEnter?: boolean;
  echoInput?: boolean;
}

export type BridgeSessionUpdate = Omit<Partial<BridgeSession>, 'runtime'> & {
	runtime?: {
	    activeRuntime?: BridgeSessionRuntimeState['activeRuntime'];
	    codex?: Partial<BridgeSessionCodexRuntimeState>;
	    claude?: Partial<BridgeSessionClaudeRuntimeState>;
	    kimi?: Partial<BridgeSessionKimiRuntimeState>;
	    cursor?: Partial<BridgeSessionCursorRuntimeState>;
	    zcode?: Partial<BridgeSessionZcodeRuntimeState>;
	    general?: Partial<BridgeSessionGeneralState>;
	  };
	};
