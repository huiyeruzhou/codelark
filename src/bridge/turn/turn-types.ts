import type { OutboundAttachment, OutboundQuestion } from '../../domain/index.js';

export type BridgeTurnKind =
  | 'im_sdk'
  | 'im_codex_reuse'
  | 'codex_mirror';

export type BridgeTurnOrigin = 'im' | 'codex';
export type BridgeTurnProgressSource = 'sdk_stream' | 'codex_jsonl' | 'claude_jsonl' | 'kimi_jsonl' | 'cursor_jsonl';
export type BridgeTurnFinalSource = 'sdk_result' | 'codex_task_complete' | 'claude_task_complete' | 'kimi_task_complete' | 'cursor_task_complete';
export type BridgeTurnRuntime = 'codex' | 'claude' | 'kimi' | 'cursor';

export interface ActiveBridgeTurn {
  id: string;
  sessionId: string;
  kind: BridgeTurnKind;
  origin: BridgeTurnOrigin;
  progressSource: BridgeTurnProgressSource;
  finalSource: BridgeTurnFinalSource;
  runtime?: BridgeTurnRuntime;
  codexThreadId?: string;
  runtimeThreadId?: string;
  requestMessageId?: string;
  streamKey?: string;
  startedAt: number;
}

export interface BridgeTurnClassification {
  kind: BridgeTurnKind;
  sessionId: string;
  codexThreadId?: string;
  codexThreadAvailable: boolean;
  reason:
    | 'codex_thread'
    | 'codex_thread_missing'
    | 'runtime_claude'
    | 'runtime_kimi'
    | 'runtime_cursor'
    | 'bridge_thread'
    | 'new_bridge_thread';
}

export interface FinalizedBridgeResponse {
  text: string;
  attachments: OutboundAttachment[];
  questions: OutboundQuestion[];
  hasError?: boolean;
  errorMessage?: string;
  source: BridgeTurnFinalSource;
}

export interface BridgeTurnTerminalRecord {
  runtime?: BridgeTurnRuntime;
  turnId?: string;
  sessionId: string;
  threadId?: string;
  codexThreadId: string;
  text: string;
  outcome: 'completed' | 'failed' | 'aborted';
  timestamp: string;
}
