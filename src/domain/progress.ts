/** Runtime progress DTOs shared by mirror parsers, stream cards, and UI. */

export type CodexToolDetail =
  | {
      kind: 'exec_command';
      command?: string;
      workdir?: string;
      shell?: string;
      tty?: boolean;
      durationMs?: number;
      exitCode?: number;
      runningSessionId?: string;
      timedOut?: boolean;
      output?: string;
      rawOutput?: string;
    }
  | {
      kind: 'terminal_stdin';
      sessionId?: string;
      chars?: string;
      isPoll?: boolean;
      waitMs?: number;
      durationMs?: number;
      exitCode?: number;
      runningSessionId?: string;
      output?: string;
      rawOutput?: string;
    }
  | {
      kind: 'patch_apply';
      patchText?: string;
      files?: Array<{ path: string; action: string; toPath?: string }>;
      output?: string;
      rawOutput?: string;
    }
  | {
      kind: 'tool_search';
      query?: string;
      foundCount?: number;
      namespaces?: string[];
      toolNames?: string[];
      output?: string;
    }
  | {
      kind: 'web_search';
      query?: string;
    }
  | {
      kind: 'mcp';
      server?: string;
      tool?: string;
      input?: unknown;
      output?: string;
      errorText?: string;
    }
  | {
      kind: 'dynamic';
      tool?: string;
      input?: unknown;
      output?: string;
      errorText?: string;
    }
  | {
      kind: 'generic';
      input?: unknown;
      output?: string;
    };

export interface ToolCallInfo {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
  input?: string | null;
  output?: string | null;
  detail?: CodexToolDetail | null;
}

export type StreamingHistoryTextRole = 'assistant' | 'system' | 'user' | 'thinking';

export type StreamingHistoryItem =
  | {
      type: 'markdown';
      role: StreamingHistoryTextRole;
      content: string;
      elementId?: string;
    }
  | {
      type: 'tool_panel';
      tools: ToolCallInfo[];
    };

export type TaskProgressStatus = 'in_progress' | 'pending' | 'completed';

export interface TaskProgressInfo {
  text: string;
  status: TaskProgressStatus;
}

export interface ContextTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface ContextUsageInfo {
  modelContextWindow?: number;
  lastTokenUsage?: ContextTokenUsage;
  totalTokenUsage?: ContextTokenUsage;
}
