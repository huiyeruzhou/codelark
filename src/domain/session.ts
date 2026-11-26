import type { ChannelChatMode } from './channel.js';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type KimiThinkingMode = 'default' | 'on' | 'off';
export type CursorReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ZcodeMode = 'build' | 'edit' | 'plan' | 'yolo';
export type DoubaoMode = 'normal' | 'plan' | 'yolo';
export type DoubaoReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type RuntimeProviderChoice = 'sdk' | 'pty' | 'tmux';
export type ClaudeProviderChoice = RuntimeProviderChoice;
export type KimiProviderChoice = 'tmux';
export type CursorProviderChoice = 'tmux' | 'acp';
export type CursorTransport = 'cli' | 'desktop';
export type ZcodeProviderChoice = 'tmux';
export type DoubaoProviderChoice = 'acp';
export type RuntimeAgent = 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode' | 'doubao';
export type RuntimeProviderIdentity =
  | `${'codex' | 'claude'}:${RuntimeProviderChoice}`
  | `kimi:${KimiProviderChoice}`
  | `cursor:${CursorProviderChoice}`
  | `zcode:${ZcodeProviderChoice}`
  | `doubao:${DoubaoProviderChoice}`;
export type ClaudeExecutable = 'claude' | 'ccr';

export type BridgeSessionHealthStatus =
  | 'idle'
  | 'running_active'
  | 'waiting_tool'
  | 'waiting_input'
  | 'slow_observed'
  | 'suspected_stall'
  | 'suspected_stream_ui_stall'
  | 'suspected_detached'
  | 'completed'
  | 'failed'
  | 'aborted';

/** Mirror已读取的位置，独立于上一轮最终回复交付时间；不保存消息正文。 */
export interface MirrorReadPosition {
  threadId: string;
  lastEventSignature?: string;
  lastEventTimestamp?: string;
  lastEventType?: BridgeMirrorRecordType;
  lastEventRole?: 'user' | 'assistant' | 'commentary' | 'system';
  lastEventTurnId?: string;
  lastEventCount: number;
  /** Cursor 当前轮已读取的稳定事件签名，防止快照中间插入漏读；不含正文。 */
  seenTurnSignatures?: string[];
  /** 已由直接流负责的原生轮次；身份不会因沉默、steer 或重启而过期。 */
  directTurnIds?: string[];
  /** 未完成的直接轮次在进程恢复时交给 mirror 继续观察。 */
  directActiveTurnId?: string;
  /** 当前原生轮次的已确认平台来源；输出接管不能改变话题。 */
  replyTarget?: { turnId: string; channelType: string; chatId: string; messageId: string };
}

/** A bounded, durable choice about missed mirror output; never the full transcript. */
export interface MirrorHistorySyncState {
  id: string;
  bindingId: string;
  threadId: string;
  channelType: string;
  chatId: string;
  status: 'pending' | 'resolved';
  createdAt: string;
  noticeAttempted: boolean;
  backlog?: { recordCount: number; replyCount: number; earliestAt: string; latestAt: string };
  ignoreBefore?: string;
  selectedCount?: number;
  previews: Array<{ key: string; text: string; timestamp: string }>;
}

type BridgeMirrorRecordType =
  | 'message'
  | 'reasoning'
  | 'plan_update'
  | 'task_started'
  | 'task_complete'
  | 'task_aborted'
  | 'tool_started'
  | 'tool_finished'
  | 'context_usage'
  | 'goal_status';

export interface BridgeSession {
  id: string;
  name?: string;
  provider_id?: string;
  runtime?: BridgeSessionRuntimeState;
  session_type?: 'normal' | 'draft';
  hidden?: boolean;
  parent_session_id?: string;
  expires_at?: string;
  runtime_status?: 'idle' | 'running' | 'queued' | 'unknown';
  queued_count?: number;
  last_runtime_update_at?: string;
  health_status?: BridgeSessionHealthStatus;
  /** 原生问卷仍在等待用户回答；由交互观察器清除。 */
  pending_user_input?: string;
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
  mirror_read_position?: MirrorReadPosition;
  mirror_history_sync?: MirrorHistorySyncState;
  created_at?: string;
  updated_at?: string;
}

export type BridgeSessionRuntimeState =
  | BridgeSessionCodexRuntimeContainer
  | BridgeSessionClaudeRuntimeContainer
  | BridgeSessionKimiRuntimeContainer
  | BridgeSessionCursorRuntimeContainer
  | BridgeSessionZcodeRuntimeContainer
  | BridgeSessionDoubaoRuntimeContainer;

export interface BridgeSessionCodexRuntimeContainer {
  activeRuntime?: 'codex';
  codex?: BridgeSessionCodexRuntimeState;
  claude?: never;
  kimi?: never;
  cursor?: never;
  zcode?: never;
  doubao?: never;
  general?: BridgeSessionGeneralState;
}

export interface BridgeSessionClaudeRuntimeContainer {
  activeRuntime: 'claude';
  codex?: never;
  claude?: BridgeSessionClaudeRuntimeState;
  kimi?: never;
  cursor?: never;
  zcode?: never;
  doubao?: never;
  general?: BridgeSessionGeneralState;
}

export interface BridgeSessionKimiRuntimeContainer {
  activeRuntime: 'kimi';
  codex?: never;
  claude?: never;
  kimi?: BridgeSessionKimiRuntimeState;
  cursor?: never;
  zcode?: never;
  doubao?: never;
  general?: BridgeSessionGeneralState;
}

export interface BridgeSessionCursorRuntimeContainer {
  activeRuntime: 'cursor';
  codex?: never;
  claude?: never;
  kimi?: never;
  cursor?: BridgeSessionCursorRuntimeState;
  zcode?: never;
  doubao?: never;
  general?: BridgeSessionGeneralState;
}

export interface BridgeSessionZcodeRuntimeContainer {
  activeRuntime: 'zcode';
  codex?: never;
  claude?: never;
  kimi?: never;
  cursor?: never;
  zcode?: BridgeSessionZcodeRuntimeState;
  doubao?: never;
  general?: BridgeSessionGeneralState;
}

export interface BridgeSessionDoubaoRuntimeContainer {
  activeRuntime: 'doubao';
  codex?: never;
  claude?: never;
  kimi?: never;
  cursor?: never;
  zcode?: never;
  doubao?: BridgeSessionDoubaoRuntimeState;
  general?: BridgeSessionGeneralState;
}

export interface BridgeSessionCodexRuntimeState {
  threadId?: string;
  /** 固定此线程的共享后端，重连或 CLI 降级时不得切回独立 writer。 */
  appServerEndpoint?: string;
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
  /** 该原生 ID 所属协议；缺失表示历史 tmux / Desktop 会话。 */
  sessionProvider?: CursorProviderChoice;
  /** 切换协议前的原生绑定，仅保存身份，便于回查原历史。 */
  previousSession?: {
    sessionId: string;
    provider: CursorProviderChoice;
    cwd?: string;
    transport?: CursorTransport;
    tmuxSessionName?: string;
  };
  cwd?: string;
  model?: string;
  /** `desktop` is accepted only when reading legacy session state. */
  provider?: CursorProviderChoice | 'desktop';
  transport?: CursorTransport;
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

export interface BridgeSessionDoubaoRuntimeState {
  sessionId?: string;
  cwd?: string;
  model?: string;
  provider?: DoubaoProviderChoice;
  mode?: DoubaoMode;
  reasoningEffort?: DoubaoReasoningEffort;
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
	    doubao?: Partial<BridgeSessionDoubaoRuntimeState>;
	    general?: Partial<BridgeSessionGeneralState>;
	  };
	};
