import type { ToolCallDetail, ToolCallInfo } from '../../domain/progress.js';

const TITLE_PRIMARY_CHAR_LIMIT = 110;
const TITLE_SECONDARY_CHAR_LIMIT = 120;

const COMPLETED_ACTION_ICONS: Record<string, string> = {
  读取: '📖',
  浏览: '📂',
  搜索: '🔎',
  修改: '🛠️',
  写入: '📝',
  运行: '💻',
  等待: '⏳',
  输入: '⌨️',
  读取网页: '🌐',
  搜索网页: '🌐',
  委派: '🤖',
  继续子任务: '🤖',
  更新计划: '☑️',
  查找工具: '🧰',
  编排: '🧩',
  调用: '🔧',
};

export interface ToolPresentation {
  icon: string;
  action: string;
  target: string;
  primary: string;
  secondary: string;
  title: string;
}

function truncateInline(value: string, maxChars: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) return normalized;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('').trimEnd()}…`;
}

function inlineCode(value: string): string {
  return `\`${truncateInline(value, 88).replace(/`/g, '′')}\``;
}

function formatDuration(ms: number | undefined): string {
  if (!Number.isFinite(ms)) return '';
  const safeMs = Math.max(0, Math.round(ms || 0));
  if (safeMs < 1000) return `${safeMs}ms`;
  const seconds = safeMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
}

function outputLineCount(detail: ToolCallDetail | null | undefined): number | null {
  const output = detail && 'output' in detail ? detail.output : undefined;
  if (typeof output !== 'string' || !output) return null;
  const normalized = output.replace(/(?:\r?\n)+$/u, '');
  return normalized ? normalized.split(/\r?\n/).length : null;
}

function shellToken(value: string): { value: string; sourceLength: number } {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(?:'([^']*)'|"([^"]*)"|([^\s;&|]+))/);
  return quoted
    ? { value: quoted[1] ?? quoted[2] ?? quoted[3] ?? '', sourceLength: quoted[0].length }
    : { value: '', sourceLength: 0 };
}

function classifyShellCommand(command: string): { action: string; target: string; secondary?: string } {
  const normalized = command.trim();
  const rgFiles = normalized.match(/(?:^|[;&|]\s*)(?:rg\s+--files|find\s+([^\s;&|]+)|ls(?:\s+-[^\s]+)*\s*([^\s;&|]+)?)/);
  if (rgFiles) {
    const target = rgFiles[1] || rgFiles[2] || '.';
    return { action: '浏览', target: inlineCode(target) };
  }

  const read = normalized.match(/(?:^|[;&|]\s*)(cat|head|tail|sed)\b([^;&|]*)/);
  if (read) {
    const tool = read[1];
    const args = read[2] || '';
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const file = [...tokens].reverse().find((token) => !token.startsWith('-') && !/^['"]?\d/.test(token));
    const range = tool === 'sed' ? args.match(/['"]?(\d+),(\d+)p['"]?/) : null;
    return {
      action: '读取',
      target: inlineCode((file || command).replace(/^['"]|['"]$/g, '')),
      ...(range ? { secondary: `第 ${range[1]}–${range[2]} 行` } : {}),
    };
  }

  const search = normalized.match(/(?:^|[;&|]\s*)(?:rg|grep)\b([^;&|]*)/);
  if (search) {
    const args = (search[1] || '').trim();
    const withoutFlags = args.replace(/^(?:(?:-[^\s]+|--[^\s]+)(?:\s+|$))+/u, '');
    const query = shellToken(withoutFlags);
    const rest = withoutFlags.slice(query.sourceLength).trim();
    const searchPath = shellToken(rest);
    return {
      action: '搜索',
      target: query.value ? inlineCode(query.value) : inlineCode(command),
      ...(searchPath.value ? { secondary: `路径 ${inlineCode(searchPath.value)}` } : {}),
    };
  }

  return { action: '运行', target: inlineCode(normalized || 'command') };
}

function presentationFromDetail(tool: ToolCallInfo): { action: string; target: string; meta: string[] } {
  const detail = tool.detail;
  const meta: string[] = [];
  if (!detail) return { action: '调用', target: inlineCode(tool.name || 'tool'), meta };

  if (detail.kind === 'exec_command') {
    const classified = classifyShellCommand(detail.command || tool.name || 'command');
    if (classified.secondary) meta.push(classified.secondary);
    if (typeof detail.exitCode === 'number' && detail.exitCode !== 0) meta.push(`exit ${detail.exitCode}`);
    const duration = formatDuration(detail.durationMs);
    if (duration) meta.push(duration);
    const lines = outputLineCount(detail);
    if (lines) meta.push(`输出 ${lines} 行`);
    if (detail.runningSessionId) meta.push(`后台终端 ${inlineCode(detail.runningSessionId)}`);
    return { action: classified.action, target: classified.target, meta };
  }
  if (detail.kind === 'terminal_stdin') {
    const action = detail.isPoll ? '等待' : '输入';
    const target = detail.sessionId ? `终端 ${inlineCode(detail.sessionId)}` : '后台终端';
    if (typeof detail.waitMs === 'number') meta.push(`等待 ${formatDuration(detail.waitMs)}`);
    if (typeof detail.maxTokens === 'number') {
      meta.push(`≤${Math.round(detail.maxTokens).toLocaleString('en-US')} tokens`);
    }
    const duration = formatDuration(detail.durationMs);
    if (duration) meta.push(duration);
    const lines = outputLineCount(detail);
    if (lines) meta.push(`输出 ${lines} 行`);
    if (detail.runningSessionId) meta.push(`后台终端 ${inlineCode(detail.runningSessionId)}`);
    return { action, target, meta };
  }
  if (detail.kind === 'patch_apply') {
    const files = detail.files || [];
    const target = files.length === 1
      ? inlineCode(files[0]!.toPath || files[0]!.path)
      : `${files.length || 1} 个文件`;
    if (files.length > 1) meta.push(files.slice(0, 4).map((file) => inlineCode(file.toPath || file.path)).join(' · '));
    return { action: '修改', target, meta };
  }
  if (detail.kind === 'file_read') {
    if (typeof detail.lineCount === 'number') {
      const start = detail.lineOffset ?? 0;
      meta.push(`第 ${start + 1}–${start + detail.lineCount} 行`);
    }
    const lines = outputLineCount(detail);
    if (lines) meta.push(`输出 ${lines} 行`);
    return { action: '读取', target: detail.path ? inlineCode(detail.path) : '文件', meta };
  }
  if (detail.kind === 'file_search') {
    if (detail.path) meta.push(`路径 ${inlineCode(detail.path)}`);
    if (typeof detail.matchCount === 'number') meta.push(`${detail.matchCount} 处`);
    return { action: '搜索', target: detail.query ? inlineCode(detail.query) : '文件内容', meta };
  }
  if (detail.kind === 'file_change') {
    return {
      action: detail.operation === 'write' ? '写入' : '修改',
      target: detail.path ? inlineCode(detail.path) : '文件',
      meta,
    };
  }
  if (detail.kind === 'url_fetch') {
    return { action: '读取网页', target: truncateInline(detail.url || 'URL', 88), meta };
  }
  if (detail.kind === 'agent') {
    return {
      action: detail.resume ? '继续子任务' : '委派',
      target: truncateInline(detail.description || detail.subagentType || '子任务', 88),
      meta,
    };
  }
  if (detail.kind === 'todo_list') {
    if (detail.items?.length) meta.push(`${detail.items.length} 项`);
    return { action: '更新计划', target: '', meta };
  }
  if (detail.kind === 'tool_search') {
    if (typeof detail.foundCount === 'number') meta.push(`${detail.foundCount} 个工具`);
    return { action: '查找工具', target: detail.query ? inlineCode(detail.query) : '', meta };
  }
  if (detail.kind === 'web_search') {
    return { action: '搜索网页', target: detail.query ? inlineCode(detail.query) : '', meta };
  }
  if (detail.kind === 'mcp') {
    const name = [detail.server, detail.tool].filter(Boolean).join('/');
    return { action: '调用', target: inlineCode(name || tool.name || 'MCP'), meta };
  }
  if (detail.kind === 'dynamic') {
    return { action: '调用', target: inlineCode(detail.tool || tool.name || 'tool'), meta };
  }
  if (detail.kind === 'orchestration') {
    meta.push(detail.calls.slice(0, 4).map((call) => inlineCode(call.name)).join(' · '));
    return { action: '编排', target: `${detail.calls.length} 个工具`, meta };
  }
  return { action: '调用', target: inlineCode(tool.name || 'tool'), meta };
}

export function getToolPresentation(tool: ToolCallInfo): ToolPresentation {
  const failedExec = tool.detail?.kind === 'exec_command'
    && typeof tool.detail.exitCode === 'number'
    && tool.detail.exitCode !== 0;
  const { action, target, meta } = presentationFromDetail(tool);
  const icon = failedExec
    ? '⚠️'
    : tool.status === 'running'
      ? '🔄'
      : tool.status === 'error'
        ? '❌'
        : COMPLETED_ACTION_ICONS[action] || '🔧';
  const primary = truncateInline([icon, action, target].filter(Boolean).join(' '), TITLE_PRIMARY_CHAR_LIMIT);
  const secondary = truncateInline(meta.filter(Boolean).join(' · '), TITLE_SECONDARY_CHAR_LIMIT);
  return {
    icon,
    action,
    target,
    primary,
    secondary,
    title: [primary, secondary].filter(Boolean).join(' · '),
  };
}
