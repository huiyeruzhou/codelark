import type { ToolCallDetail } from '../../../domain/progress.js';
import type { BridgeMirrorRecord } from '../../contracts.js';
import {
  toolCallEventFromSdk,
  type ToolCallEvent,
} from '../../../shared/progress/tool-events.js';
import {
  buildToolCallDetailFromInput,
  buildToolCallDetailFromOutput,
  mergeToolCallDetail,
} from '../../../shared/progress/tool-call-details.js';
import {
  extractNormalizedFreeText,
  extractToolOutputText,
  formatCodexToolName,
  getDynamicToolCallId,
  summarizePatchChanges,
  summarizeToolSearchOutput,
  type SessionEventLine,
  type SessionMessageLine,
} from './jsonl-types.js';
import {
  buildToolCallDetailFromNormalizedCodexCall,
  normalizeCodexToolCall,
} from './tool-call-normalizer.js';

export interface CodexSessionToolEvent {
  recordType: Extract<BridgeMirrorRecord['type'], 'tool_started' | 'tool_finished'>;
  event: ToolCallEvent;
  content: string;
  turnId?: string;
  toolInput?: unknown;
  isError?: boolean;
}

function mergeToolDetails(...details: Array<ToolCallDetail | null | undefined>): ToolCallDetail | null {
  return details.reduce<ToolCallDetail | null>((merged, detail) => mergeToolCallDetail(merged, detail), null);
}

function eventDetail(event: ToolCallEvent): ToolCallDetail | undefined {
  return event.type === 'tool' && event.detail ? event.detail : undefined;
}

function commandInputFromPayload(payload: SessionEventLine['payload']): unknown {
  if (Array.isArray(payload?.command)) return payload.command.join(' ');
  return payload?.command;
}

export function bridgeMirrorRecordFromSessionToolEvent(
  parsed: CodexSessionToolEvent,
  base: Pick<BridgeMirrorRecord, 'signature' | 'timestamp'>,
): BridgeMirrorRecord {
  return {
    ...base,
    type: parsed.recordType,
    content: parsed.content,
    ...(parsed.turnId ? { turnId: parsed.turnId } : {}),
    toolId: parsed.event.toolId,
    toolName: parsed.event.toolName,
    ...(typeof parsed.toolInput !== 'undefined' ? { toolInput: parsed.toolInput } : {}),
    ...(eventDetail(parsed.event) ? { toolDetail: eventDetail(parsed.event) } : {}),
    ...(typeof parsed.isError === 'boolean' ? { isError: parsed.isError } : {}),
  };
}

export function codexSessionToolEventFromResponseItem(
  payload: SessionMessageLine['payload'],
  signature: string,
  activeTurnId: string | null,
): CodexSessionToolEvent | null {
  if (!payload) return null;

  if (payload.type === 'tool_search_call') {
    const toolId = extractNormalizedFreeText(payload.call_id) || signature;
    const event = toolCallEventFromSdk(toolId, 'tool_search', 'running', {
      input: payload.arguments,
      structured: buildToolCallDetailFromInput('tool_search', payload.arguments),
    });
    return {
      recordType: 'tool_started',
      event,
      content: '',
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      toolInput: payload.arguments,
    };
  }

  if (payload.type === 'tool_search_output') {
    const toolId = extractNormalizedFreeText(payload.call_id) || signature;
    const status = extractNormalizedFreeText(payload.status).toLowerCase();
    const output = { tools: payload.tools };
    const event = toolCallEventFromSdk(toolId, 'tool_search', status === 'failed' ? 'error' : 'complete', {
      output: summarizeToolSearchOutput(payload.tools),
      structured: buildToolCallDetailFromOutput('tool_search', output),
    });
    return {
      recordType: 'tool_finished',
      event,
      content: summarizeToolSearchOutput(payload.tools),
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      isError: status === 'failed',
    };
  }

  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const rawToolName = formatCodexToolName(payload.namespace, payload.name);
    const toolId = extractNormalizedFreeText(payload.call_id) || signature;
    if (!rawToolName) return null;
    const normalized = normalizeCodexToolCall(
      rawToolName,
      payload.type === 'function_call' ? payload.arguments : payload.input,
    );
    const toolName = normalized.name;
    const input = normalized.input;
    const event = toolCallEventFromSdk(toolId, toolName, 'running', {
      input,
      structured: buildToolCallDetailFromNormalizedCodexCall(normalized),
    });
    return {
      recordType: 'tool_started',
      event,
      content: '',
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      toolInput: input,
    };
  }

  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const toolId = extractNormalizedFreeText(payload.call_id) || signature;
    const output = extractToolOutputText(payload.output);
    const event = toolCallEventFromSdk(toolId, '', payload.is_error === true ? 'error' : 'complete', {
      output,
    });
    return {
      recordType: 'tool_finished',
      event,
      content: output,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      isError: payload.is_error === true,
    };
  }

  return null;
}

export function codexSessionToolEventFromEventMessage(
  payload: SessionEventLine['payload'],
  signature: string,
  activeTurnId: string | null,
): CodexSessionToolEvent | null {
  if (!payload) return null;

  if (payload.type === 'web_search_end') {
    const toolId = extractNormalizedFreeText(payload.call_id) || signature;
    const query = extractToolOutputText(payload.query);
    return {
      recordType: 'tool_finished',
      event: toolCallEventFromSdk(toolId, 'Web Search', 'complete', {
        output: query,
        structured: { kind: 'web_search', query },
      }),
      content: query,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    };
  }

  if (payload.type === 'mcp_tool_call_end') {
    const toolId = extractNormalizedFreeText(payload.call_id) || signature;
    const server = extractNormalizedFreeText(payload.invocation?.server);
    const tool = extractNormalizedFreeText(payload.invocation?.tool);
    const toolName = server && tool ? `mcp__${server}__${tool}` : 'mcp_tool_call';
    return {
      recordType: 'tool_finished',
      event: toolCallEventFromSdk(toolId, toolName, 'complete', {
        structured: {
          kind: 'mcp',
          ...(server ? { server } : {}),
          ...(tool ? { tool } : {}),
        },
      }),
      content: '',
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      isError: false,
    };
  }

  if (payload.type === 'exec_command_end') {
    const toolId = extractNormalizedFreeText(payload.call_id) || signature;
    const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : null;
    const status = extractNormalizedFreeText(payload.status).toLowerCase();
    const commandInput = commandInputFromPayload(payload);
    const outputText = extractToolOutputText(
      payload.aggregated_output
        ?? payload.formatted_output
        ?? payload.stdout
        ?? payload.stderr
        ?? payload.command,
    );
    const durationSeconds = typeof (payload as { duration_seconds?: unknown }).duration_seconds === 'number'
      ? (payload as { duration_seconds: number }).duration_seconds
      : null;
    const detail = mergeToolDetails(
      buildToolCallDetailFromInput('Bash', { cmd: commandInput }),
      {
        kind: 'exec_command',
        ...(exitCode != null ? { exitCode } : {}),
        ...(durationSeconds != null ? { durationMs: Math.round(durationSeconds * 1000) } : {}),
        ...(outputText.trim() ? { output: outputText } : {}),
        rawOutput: outputText,
      },
    );
    const isError = status === 'failed' || (exitCode != null && exitCode !== 0);
    return {
      recordType: 'tool_finished',
      event: toolCallEventFromSdk(toolId, 'Bash', isError ? 'error' : 'complete', {
        input: commandInput,
        output: outputText,
        structured: detail,
      }),
      content: outputText,
      ...(payload.turn_id || activeTurnId ? { turnId: payload.turn_id || activeTurnId || undefined } : {}),
      toolInput: commandInput,
      isError,
    };
  }

  if (payload.type === 'patch_apply_end') {
    const toolId = extractNormalizedFreeText(payload.call_id) || signature;
    const status = extractNormalizedFreeText(payload.status).toLowerCase();
    const output = summarizePatchChanges(payload.changes)
      || extractToolOutputText(payload.stdout ?? payload.stderr);
    const isError = payload.success === false || status === 'failed';
    return {
      recordType: 'tool_finished',
      event: toolCallEventFromSdk(toolId, 'apply_patch', isError ? 'error' : 'complete', {
        output,
        structured: {
          kind: 'patch_apply',
          ...(output.trim() ? { output } : {}),
        },
      }),
      content: output,
      ...(payload.turn_id || activeTurnId ? { turnId: payload.turn_id || activeTurnId || undefined } : {}),
      isError,
    };
  }

  if (payload.type === 'dynamic_tool_call_request') {
    const toolId = getDynamicToolCallId(payload) || signature;
    const toolName = extractNormalizedFreeText(payload.tool) || 'tool';
    return {
      recordType: 'tool_started',
      event: toolCallEventFromSdk(toolId, toolName, 'running', {
        input: payload.arguments,
        structured: buildToolCallDetailFromInput(toolName, payload.arguments),
      }),
      content: '',
      ...(payload.turnId || activeTurnId ? { turnId: payload.turnId || activeTurnId || undefined } : {}),
      toolInput: payload.arguments,
    };
  }

  if (payload.type === 'dynamic_tool_call_response') {
    const toolId = getDynamicToolCallId(payload) || signature;
    const toolName = extractNormalizedFreeText(payload.tool) || 'tool';
    const output = extractToolOutputText(payload.content_items ?? payload.error);
    return {
      recordType: 'tool_finished',
      event: toolCallEventFromSdk(toolId, toolName, payload.success === false ? 'error' : 'complete', {
        output,
        structured: {
          kind: 'dynamic',
          tool: toolName,
          ...(payload.success === false ? { errorText: output } : { output }),
        },
      }),
      content: output,
      ...(payload.turn_id || activeTurnId ? { turnId: payload.turn_id || activeTurnId || undefined } : {}),
      isError: payload.success === false,
    };
  }

  return null;
}
