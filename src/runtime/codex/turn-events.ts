import type { CodexToolDetail, ToolCallInfo } from '../../domain/progress.js';
import type { BridgeMirrorRecord } from '../contracts.js';
import {
  buildCodexToolDetailFromInput,
  buildCodexToolDetailFromOutput,
  mergeCodexToolDetail,
  summarizeToolDetailValue,
} from '../../shared/progress/tool-call-details.js';

export type CodexTurnEvent =
  | {
      type: 'tool';
      toolId: string;
      toolName?: string;
      status: ToolCallInfo['status'];
      input?: unknown;
      output?: unknown;
      detail?: CodexToolDetail | null;
    };

export function applyCodexTurnEventToTools(
  tools: Map<string, ToolCallInfo>,
  event: CodexTurnEvent,
): void {
  if (event.type !== 'tool') return;

  const existing = tools.get(event.toolId);
  const toolName = event.toolName || existing?.name || 'tool';
  const next: ToolCallInfo = {
    id: event.toolId,
    name: toolName,
    status: event.status,
    input: existing?.input ?? null,
    output: existing?.output ?? null,
    detail: existing?.detail ?? null,
  };

  if (event.detail) {
    next.detail = mergeCodexToolDetail(next.detail, event.detail);
  }
  if (typeof event.input !== 'undefined') {
    next.detail = mergeCodexToolDetail(
      next.detail,
      buildCodexToolDetailFromInput(toolName, event.input),
    );
    next.input = summarizeToolDetailValue(event.input, 32_000);
  }
  if (typeof event.output !== 'undefined') {
    const outputDetail = buildCodexToolDetailFromOutput(toolName, event.output, next.detail);
    next.detail = mergeCodexToolDetail(next.detail, outputDetail);
    const output = summarizeToolDetailValue(event.output, 32_000);
    next.output = output.trim() ? output : existing?.output ?? null;
  }

  tools.set(event.toolId, next);
}

export function codexTurnEventFromSdkToolEvent(
  toolId: string,
  toolName: string,
  status: ToolCallInfo['status'],
  detail?: { input?: unknown; output?: string; structured?: CodexToolDetail | null },
): CodexTurnEvent {
  return {
    type: 'tool',
    toolId,
    ...(toolName ? { toolName } : {}),
    status,
    ...(detail?.structured ? { detail: detail.structured } : {}),
    ...(detail && typeof detail.input !== 'undefined' ? { input: detail.input } : {}),
    ...(detail && typeof detail.output === 'string' ? { output: detail.output } : {}),
  };
}

export function codexTurnEventFromMirrorRecord(record: BridgeMirrorRecord): CodexTurnEvent | null {
  if (record.type === 'tool_started') {
    return {
      type: 'tool',
      toolId: record.toolId || record.signature,
      toolName: record.toolName,
      status: 'running',
      ...(record.toolDetail ? { detail: record.toolDetail } : {}),
      ...(typeof record.toolInput !== 'undefined' ? { input: record.toolInput } : {}),
    };
  }
  if (record.type === 'tool_finished') {
    return {
      type: 'tool',
      toolId: record.toolId || record.signature,
      toolName: record.toolName,
      status: record.isError ? 'error' : 'complete',
      ...(record.toolDetail ? { detail: record.toolDetail } : {}),
      ...(typeof record.toolInput !== 'undefined' ? { input: record.toolInput } : {}),
      ...(record.content.trim() ? { output: record.content } : {}),
    };
  }
  return null;
}
