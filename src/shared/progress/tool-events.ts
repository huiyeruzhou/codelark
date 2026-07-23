import type { ToolCallDetail, ToolCallInfo } from '../../domain/progress.js';
import type { BridgeMirrorRecord } from '../../runtime/contracts.js';
import {
  buildToolCallDetailFromInput,
  buildToolCallDetailFromOutput,
  mergeToolCallDetail,
  summarizeToolDetailValue,
} from './tool-call-details.js';

export type ToolCallEvent = {
  type: 'tool';
  toolId: string;
  toolName?: string;
  status: ToolCallInfo['status'];
  input?: unknown;
  output?: unknown;
  detail?: ToolCallDetail | null;
};

export function applyToolCallEventToTools(
  tools: Map<string, ToolCallInfo>,
  event: ToolCallEvent,
): string | null {
  let resolvedToolId = event.toolId;
  let existing = tools.get(resolvedToolId);
  if (!existing && event.status !== 'running' && event.toolName) {
    const normalizedName = event.toolName.trim().toLowerCase();
    const running = Array.from(tools.values()).filter((tool) => tool.status === 'running');
    const exact = running.filter((tool) => tool.name.trim().toLowerCase() === normalizedName);
    if (exact.length === 1) {
      existing = exact[0];
      resolvedToolId = existing!.id;
    } else {
      const parentOrchestrations = running.filter((tool) => (
        tool.detail?.kind === 'orchestration'
        && tool.detail.calls.some((call) => call.name.trim().toLowerCase() === normalizedName)
      ));
      if (parentOrchestrations.length === 1) return parentOrchestrations[0]!.id;
    }
  }

  const toolName = event.toolName || existing?.name || 'tool';
  const next: ToolCallInfo = {
    id: resolvedToolId,
    name: toolName,
    status: event.status,
    input: existing?.input ?? null,
    output: existing?.output ?? null,
    detail: existing?.detail ?? null,
  };

  if (event.detail) next.detail = mergeToolCallDetail(next.detail, event.detail);
  if (typeof event.input !== 'undefined') {
    next.detail = mergeToolCallDetail(next.detail, buildToolCallDetailFromInput(toolName, event.input));
    next.input = summarizeToolDetailValue(event.input, 32_000);
  }
  if (typeof event.output !== 'undefined') {
    next.detail = mergeToolCallDetail(
      next.detail,
      buildToolCallDetailFromOutput(toolName, event.output, next.detail),
    );
    const output = summarizeToolDetailValue(event.output, 32_000);
    next.output = output.trim() ? output : existing?.output ?? null;
  }

  tools.set(resolvedToolId, next);
  return resolvedToolId;
}

export function toolCallEventFromSdk(
  toolId: string,
  toolName: string,
  status: ToolCallInfo['status'],
  detail?: { input?: unknown; output?: string; structured?: ToolCallDetail | null },
): ToolCallEvent {
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

export function toolCallEventFromMirrorRecord(record: BridgeMirrorRecord): ToolCallEvent | null {
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
