import type { ToolCallInfo } from '../../domain/progress.js';
import { buildFencedCodeBlock } from '../markdown/fence.js';
import { renderCodexToolDetailMarkdown } from './tool-call-details.js';

export type FinalCardTerminalStatus = 'completed' | 'interrupted' | 'error';

export interface ToolProgressRenderOptions {
  terminalStatus?: FinalCardTerminalStatus | null;
  maxItems?: number | null;
}

export interface ToolProgressBlock {
  tool: ToolCallInfo;
  icon: string;
  statusLabel: string;
  header: string;
  detail: string;
  titleMeta: string[];
}

export const LONG_TOOL_OUTPUT_COLLAPSE_THRESHOLD = 4_000;

function normalizeToolStatusForRender(
  status: ToolCallInfo['status'],
  options: ToolProgressRenderOptions,
): ToolCallInfo['status'] {
  if (status !== 'running' || !options.terminalStatus) return status;
  return options.terminalStatus === 'completed' ? 'complete' : 'error';
}

function buildFallbackToolDetailMarkdown(tool: ToolCallInfo): string {
  const details: string[] = [];
  const isEditTool = /^edit$/i.test(tool.name || '');
  const isBashTool = /^(bash|shell_command|exec_command)$/i.test(tool.name || '');
  const isPatchTool = /^(apply_patch|edit)$/i.test(tool.name || '');
  const structured = renderCodexToolDetailMarkdown(tool);
  if (structured) {
    details.push(structured);
  } else {
    if (!isEditTool && tool.input && tool.input.trim()) {
      const language = isBashTool ? 'bash' : isPatchTool ? 'diff' : 'json';
      details.push(`输入：\n${buildFencedCodeBlock(tool.input.trim(), language)}`);
    }
    if (tool.output && tool.output.trim()) {
      details.push(`输出：\n${buildFencedCodeBlock(tool.output.trim(), 'text')}`);
    }
  }
  return details.join('\n\n');
}

function formatToolTitleDuration(ms: number | undefined): string {
  if (!Number.isFinite(ms)) return '';
  const safeMs = Math.max(0, Math.round(ms || 0));
  if (safeMs < 1000) return `${safeMs}ms`;
  const seconds = safeMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function getToolTitleMeta(tool: ToolCallInfo): string[] {
  const detail = tool.detail;
  if (!detail) return [];
  const duration = 'durationMs' in detail ? formatToolTitleDuration(detail.durationMs) : '';
  const exitCode = detail.kind === 'exec_command' && typeof detail.exitCode === 'number'
    && detail.exitCode !== 0
    ? `exit ${detail.exitCode}`
    : '';
  return [duration, exitCode].filter(Boolean);
}

function hasNonZeroExecExit(tool: ToolCallInfo): boolean {
  return tool.detail?.kind === 'exec_command'
    && typeof tool.detail.exitCode === 'number'
    && tool.detail.exitCode !== 0;
}

export function buildToolProgressBlocks(
  tools: ToolCallInfo[],
  options: ToolProgressRenderOptions = {},
): ToolProgressBlock[] {
  if (tools.length === 0) return [];

  const normalized = tools.map((tool) => ({
    ...tool,
    status: normalizeToolStatusForRender(tool.status, options),
  }));

  const maxItems = options.maxItems === null ? normalized.length : options.maxItems ?? 5;
  const slice = normalized.length > maxItems ? normalized.slice(-maxItems) : normalized;
  const hiddenCount = normalized.length - slice.length;

  const rendered: ToolProgressBlock[] = [];
  if (hiddenCount > 0) {
    rendered.push({
      tool: { id: 'hidden', name: 'tools', status: 'complete' },
      icon: '📦',
      statusLabel: '已折叠',
      header: `📦 还有 ${hiddenCount} 个工具调用已折叠`,
      detail: '',
      titleMeta: [],
    });
  }

  for (const tool of slice) {
    const statusLabel = tool.status === 'running' ? '运行中' : tool.status === 'error' ? '异常' : '完成';
    const icon = hasNonZeroExecExit(tool) ? '⚠️' : tool.status === 'running' ? '🔄' : tool.status === 'error' ? '❌' : '✅';
    const titleMeta = getToolTitleMeta(tool);
    const titleParts = [statusLabel, ...titleMeta];
    const header = `#### ${icon} \`${tool.name || 'tool'}\`（${titleParts.join(' · ')}）`;
    rendered.push({
      tool,
      icon,
      statusLabel,
      header,
      detail: buildFallbackToolDetailMarkdown(tool),
      titleMeta,
    });
  }

  return rendered;
}

export function buildToolProgressMarkdown(
  tools: ToolCallInfo[],
  options: ToolProgressRenderOptions = {},
): string {
  const blocks = buildToolProgressBlocks(tools, options);
  return blocks.map((block) => block.detail ? `${block.header}\n\n${block.detail}` : block.header).join('\n\n');
}

export function getLongExecOutput(tool: ToolCallInfo): string {
  return tool.detail?.kind === 'exec_command'
    && typeof tool.detail.output === 'string'
    && tool.detail.output.length > LONG_TOOL_OUTPUT_COLLAPSE_THRESHOLD
    ? tool.detail.output
    : '';
}

export function buildToolDetailWithoutLongOutput(block: ToolProgressBlock): string {
  const output = getLongExecOutput(block.tool);
  if (!output || block.tool.detail?.kind !== 'exec_command') return block.detail;
  return buildFallbackToolDetailMarkdown({
    ...block.tool,
    detail: {
      ...block.tool.detail,
      output: undefined,
    },
  });
}
