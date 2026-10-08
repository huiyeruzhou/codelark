import type { ToolCallDetail } from '../../domain/progress.js';

export interface ParsedMcpToolCall {
  id: string;
  server: string;
  tool: string;
  toolName: string;
  status: string;
  input: unknown;
  output: string;
  errorText: string;
  isError: boolean;
  detail: Extract<ToolCallDetail, { kind: 'mcp' }>;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const record = objectRecord(value);
  if (!record) return '';
  for (const key of ['message', 'text', 'content']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  }
  return '';
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      const record = objectRecord(block);
      return record ? textValue(record.text ?? record.content) : '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function isMcpToolCallItem(value: unknown): value is Record<string, unknown> {
  const item = objectRecord(value);
  if (!item || typeof item.type !== 'string') return false;
  return item.type.replace(/[_-]/gu, '').toLowerCase() === 'mcptoolcall';
}

/** Normalize the camel/Pascal-case app-server MCP item used by live events and rollout JSONL. */
export function parseMcpToolCallItem(value: unknown): ParsedMcpToolCall | null {
  if (!isMcpToolCallItem(value)) return null;
  const item = value;
  const result = objectRecord(item.result);
  const server = textValue(item.server);
  const tool = textValue(item.tool);
  const status = textValue(item.status);
  const explicitError = textValue(item.error);
  const resultText = contentText(result?.content)
    || stringifyValue(result?.structuredContent ?? result?.structured_content);
  const isError = status.toLowerCase() === 'failed'
    || result?.isError === true
    || result?.is_error === true
    || Boolean(explicitError);
  const output = isError ? '' : resultText;
  const errorText = explicitError || (isError ? resultText : '');
  const input = item.arguments;
  const inputRecord = objectRecord(input);
  const title = textValue(inputRecord?.title);
  const toolName = server && tool ? `mcp__${server}__${tool}` : 'mcp_tool_call';
  return {
    id: textValue(item.id),
    server,
    tool,
    toolName,
    status,
    input,
    output,
    errorText,
    isError,
    detail: {
      kind: 'mcp',
      ...(server ? { server } : {}),
      ...(tool ? { tool } : {}),
      ...(title ? { title } : {}),
      ...(typeof input !== 'undefined' ? { input } : {}),
      ...(output ? { output } : {}),
      ...(errorText ? { errorText } : {}),
    },
  };
}
