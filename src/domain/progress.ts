/** Runtime progress DTOs shared by mirror parsers, stream cards, and UI. */

export type ToolCallDetail =
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
      maxTokens?: number;
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
      workdir?: string;
      output?: string;
      rawOutput?: string;
    }
  | {
      kind: 'file_read';
      path?: string;
      lineOffset?: number;
      lineCount?: number;
      output?: string;
    }
  | {
      kind: 'file_search';
      query?: string;
      path?: string;
      outputMode?: string;
      headLimit?: number;
      matchCount?: number;
      output?: string;
    }
  | {
      kind: 'file_change';
      operation: 'edit' | 'write';
      path?: string;
      mode?: string;
      before?: string;
      after?: string;
      content?: string;
      output?: string;
    }
  | {
      kind: 'url_fetch';
      url?: string;
      output?: string;
    }
  | {
      kind: 'agent';
      description?: string;
      subagentType?: string;
      resume?: string;
      prompt?: string;
      output?: string;
    }
  | {
      kind: 'todo_list';
      items?: unknown[];
      output?: string;
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
      kind: 'orchestration';
      calls: Array<{
        name: string;
        detail: ToolCallDetail | null;
      }>;
      output?: string;
      rawOutput?: string;
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
  detail?: ToolCallDetail | null;
}

/** @deprecated Use ToolCallDetail. */
export type CodexToolDetail = ToolCallDetail;

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
