import type { ToolCallDetail, ToolCallInfo } from '../../domain/progress.js';
import { buildFencedCodeBlock } from '../markdown/fence.js';
import {
  buildToolCallDetailFromInput,
  buildToolCallDetailFromOutput,
  mergeToolCallDetail,
  renderToolCallDetailMarkdown,
} from './tool-call-details.js';
import { getToolPresentation, type ToolPresentation } from './tool-presentation.js';

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
  presentation: ToolPresentation;
}

function normalizeToolStatusForRender(
  status: ToolCallInfo['status'],
  options: ToolProgressRenderOptions,
): ToolCallInfo['status'] {
  if (status !== 'running' || !options.terminalStatus) return status;
  return options.terminalStatus === 'completed' ? 'complete' : 'error';
}

function hydrateToolDetail(tool: ToolCallInfo): ToolCallInfo {
  if (tool.detail) return tool;
  let detail = null;
  if (typeof tool.input === 'string' && tool.input.trim()) {
    detail = mergeToolCallDetail(detail, buildToolCallDetailFromInput(tool.name, tool.input));
  }
  if (typeof tool.output === 'string' && tool.output.trim()) {
    detail = mergeToolCallDetail(detail, buildToolCallDetailFromOutput(tool.name, tool.output, detail));
  }
  return detail ? { ...tool, detail } : tool;
}

function withoutToolOutput(detail: ToolCallDetail): ToolCallDetail {
  if (detail.kind === 'orchestration') {
    return {
      ...detail,
      output: undefined,
      rawOutput: undefined,
      calls: detail.calls.map((call) => ({
        ...call,
        detail: call.detail ? withoutToolOutput(call.detail) : null,
      })),
    };
  }
  if (!('output' in detail)) return detail;
  return { ...detail, output: undefined };
}

function buildFallbackToolDetailMarkdown(tool: ToolCallInfo): string {
  const details: string[] = [];
  const isEditTool = /^edit$/i.test(tool.name || '');
  const isBashTool = /^(bash|shell_command|exec_command)$/i.test(tool.name || '');
  const isPatchTool = /^apply_patch$/i.test(tool.name || '');
  const displayTool = !isPatchTool && tool.detail
    ? { ...tool, detail: withoutToolOutput(tool.detail) }
    : tool;
  const structured = renderToolCallDetailMarkdown(displayTool);
  if (structured) {
    details.push(structured);
  } else {
    if (!isEditTool && tool.input && tool.input.trim()) {
      const language = isBashTool ? 'bash' : isPatchTool ? 'diff' : 'json';
      details.push(`输入：\n${buildFencedCodeBlock(tool.input.trim(), language)}`);
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

export function buildToolProgressBlocks(
  tools: ToolCallInfo[],
  options: ToolProgressRenderOptions = {},
): ToolProgressBlock[] {
  if (tools.length === 0) return [];

  const normalized = tools.map((tool) => hydrateToolDetail({
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
      presentation: {
        icon: '📦',
        action: '省略',
        target: `${hiddenCount} 个更早的工具调用`,
        primary: `📦 省略 ${hiddenCount} 个更早的工具调用`,
        secondary: '',
        title: `📦 省略 ${hiddenCount} 个更早的工具调用`,
      },
    });
  }

  for (const tool of slice) {
    const statusLabel = tool.status === 'running' ? '运行中' : tool.status === 'error' ? '异常' : '完成';
    const titleMeta = getToolTitleMeta(tool);
    const presentation = getToolPresentation(tool);
    const icon = presentation.icon;
    const header = `#### ${presentation.title.replace(/\n/g, ' · ')}`;
    rendered.push({
      tool,
      icon,
      statusLabel,
      header,
      detail: buildFallbackToolDetailMarkdown(tool),
      titleMeta,
      presentation,
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
