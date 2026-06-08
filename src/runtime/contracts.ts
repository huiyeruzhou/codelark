import type { FileAttachment } from '../domain/message.js';
import type { ContextUsageInfo, CodexToolDetail, TaskProgressInfo } from '../domain/progress.js';
import type {
  BridgeSessionClaudeRuntimeState,
  ClaudeExecutable,
  ClaudeProviderChoice,
  CodexReasoningEffort,
  CodexSandboxMode,
  RuntimeProviderChoice,
} from '../domain/session.js';
import type { ClaudePermissionMode } from './options.js';

export interface SSEEvent {
  type: SSEEventType;
  data: string;
}

export type SSEEventType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'tool_output'
  | 'tool_timeout'
  | 'status'
  | 'context_usage'
  | 'result'
  | 'error'
  | 'permission_request'
  | 'mode_changed'
  | 'task_update'
  | 'keep_alive'
  | 'done';

export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'code'; language: string; code: string };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_output_tokens?: number;
  cost_usd?: number;
}

export interface BridgeApiProvider {
  id: string;
  [key: string]: unknown;
}

export interface StreamChatParams {
  prompt: string;
  sessionId: string;
  runtime?: 'codex' | 'claude';
  codexThreadId?: string;
  claudeSessionId?: string;
  claudeExecutable?: ClaudeExecutable;
  claudeProvider?: ClaudeProviderChoice;
  model?: string;
  forceModel?: boolean;
  sandboxMode?: CodexSandboxMode;
  networkAccessEnabled?: boolean;
  modelReasoningEffort?: CodexReasoningEffort;
  skipGitRepoCheck?: boolean;
  systemPrompt?: string;
  workingDirectory?: string;
  abortController?: AbortController;
  permissionMode?: string;
  claudePermissionMode?: ClaudePermissionMode;
  claudeReasoningEffort?: BridgeSessionClaudeRuntimeState['reasoningEffort'];
  codexMode?: 'normal' | 'yolo';
  codexProvider?: RuntimeProviderChoice;
  provider?: BridgeApiProvider;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  files?: FileAttachment[];
  onRuntimeStatusChange?: (status: string) => void;
}

export interface LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
}

export interface BridgeMirrorRecord {
  signature: string;
  type: 'message' | 'reasoning' | 'plan_update' | 'task_started' | 'task_complete' | 'task_aborted' | 'tool_started' | 'tool_finished' | 'context_usage' | 'goal_status';
  role?: 'user' | 'assistant' | 'commentary' | 'system';
  content: string;
  userPrompt?: string;
  timestamp: string;
  turnId?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolDetail?: CodexToolDetail;
  isError?: boolean;
  tasks?: TaskProgressInfo[];
  contextUsage?: ContextUsageInfo;
  goalStatus?: string;
  goalObjective?: string;
}

export interface BridgeMirrorRecordDelta {
  records: BridgeMirrorRecord[];
  nextOffset: number;
  trailingText: string;
  nextTurnId: string | null;
  nextSpecialCallIds: string[];
  unknownKinds: string[];
}

export interface MirrorJsonlSourceSummary {
  threadId: string;
  filePath: string;
  cwd?: string;
  updatedAt?: string;
}

export interface MirrorJsonlSource {
  readonly runtime: 'codex' | 'claude';
  findByThreadId(threadId: string, cwd?: string): MirrorJsonlSourceSummary | null;
  readDelta(
    filePath: string,
    startOffset: number,
    endOffset: number,
    trailingText: string,
    currentTurnId: string | null,
    currentSpecialCallIds: Iterable<string>,
  ): BridgeMirrorRecordDelta;
}

export interface LifecycleHooks {
  onBridgeStart?(): void;
  onBridgeAdaptersChanged?(channels: string[]): void;
  onBridgeStop?(): void;
}
