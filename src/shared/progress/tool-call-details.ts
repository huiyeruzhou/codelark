import path from 'node:path';

import { maskSecrets } from '../logger.js';
import type { CodexToolDetail, ToolCallInfo } from '../../domain/progress.js';
import { buildFencedCodeBlock } from '../markdown/fence.js';
import { sanitizeInput } from '../security/validators.js';

export const EXEC_COMMAND_RENDER_OUTPUT_CHAR_LIMIT = 1000;

function sanitizeToolText(value: string): string {
  return maskSecrets(value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

function stringifyToolValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function normalizeToolName(name: string | undefined): string {
  return (name || '').trim().toLowerCase();
}

function isExecTool(name: string | undefined): boolean {
  return /^(bash|shell_command|exec_command)$/.test(normalizeToolName(name));
}

function isWriteStdinTool(name: string | undefined): boolean {
  return normalizeToolName(name) === 'write_stdin';
}

function isPatchTool(name: string | undefined): boolean {
  return /^(apply_patch|edit)$/.test(normalizeToolName(name));
}

function numberFromRecord(record: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function unwrapBashCommand(command: string): string {
  const trimmed = command.trim();
  const bashPrefix = '/bin/bash -lc "';
  return trimmed.startsWith(bashPrefix) && trimmed.endsWith('"')
    ? trimmed.slice(bashPrefix.length, -1)
    : trimmed;
}

function commandFromInput(value: unknown): string {
  const parsed = parseJsonMaybe(value);
  if (typeof parsed === 'string') return unwrapBashCommand(parsed);
  if (!parsed || typeof parsed !== 'object') return '';
  const record = parsed as Record<string, unknown>;
  const direct = record.cmd ?? record.command;
  if (typeof direct === 'string') return unwrapBashCommand(direct);
  for (const key of ['args', 'argv']) {
    const args = record[key];
    if (Array.isArray(args)) {
      return args.map((item) => String(item)).join(' ').trim();
    }
  }
  return '';
}

function parseDurationMs(text: string): number | undefined {
  const wallTime = text.match(/\bWall time:\s*([\d.]+)\s*seconds?\b/i);
  if (wallTime) return Math.round(Number(wallTime[1]) * 1000);
  const durationNs = text.match(/\bduration:\s*(\d+)ns\b/i);
  if (durationNs) return Math.round(Number(durationNs[1]) / 1_000_000);
  return undefined;
}

function formatDuration(ms: number | undefined): string {
  if (!Number.isFinite(ms)) return '';
  const safeMs = Math.max(0, Math.round(ms || 0));
  if (safeMs < 1000) return `${safeMs}ms`;
  const seconds = safeMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function parseProcessOutput(raw: string): {
  durationMs?: number;
  exitCode?: number;
  runningSessionId?: string;
  timedOut?: boolean;
  output?: string;
} {
  const text = raw || '';
  const exitMatch = text.match(/\bProcess exited with code\s+(-?\d+)\b/i)
    || text.match(/\bexit_code:\s*(-?\d+)\b/i);
  const runningMatch = text.match(/\bProcess running with session ID\s+([^\s]+)\b/i);
  const outputMarker = text.match(/\nOutput:\n/);
  let output = '';
  if (outputMarker?.index != null) {
    output = text.slice(outputMarker.index + outputMarker[0].length);
  } else {
    output = text
      .split(/\r?\n/)
      .filter((line) => !/^Chunk ID:/i.test(line.trim()))
      .filter((line) => !/^Wall time:/i.test(line.trim()))
      .filter((line) => !/^Process exited with code/i.test(line.trim()))
      .filter((line) => !/^Process running with session ID/i.test(line.trim()))
      .filter((line) => !/^Original token count:/i.test(line.trim()))
      .join('\n');
  }
  return {
    ...(typeof parseDurationMs(text) === 'number' ? { durationMs: parseDurationMs(text) } : {}),
    ...(exitMatch ? { exitCode: Number(exitMatch[1]) } : {}),
    ...(runningMatch ? { runningSessionId: runningMatch[1] } : {}),
    ...(text.includes('timed_out: true') ? { timedOut: true } : {}),
    ...(output.trim() ? { output: sanitizeToolText(output) } : {}),
  };
}

function extractTextRecordValue(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function extractExecStructuredOutput(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const aggregated = extractTextRecordValue(record, ['aggregated_output', 'formatted_output']);
  if (aggregated.trim()) return aggregated;

  const stdout = extractTextRecordValue(record, ['stdout']);
  const stderr = extractTextRecordValue(record, ['stderr']);
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}

function parsePatchFiles(patchText: string, baseDir?: string): Array<{ path: string; action: string; toPath?: string }> {
  const files: Array<{ path: string; action: string; toPath?: string }> = [];
  let last: { path: string; action: string; toPath?: string } | null = null;
  for (const line of patchText.split(/\r?\n/)) {
    const add = line.match(/^\*\*\* Add File:\s+(.+)$/);
    const update = line.match(/^\*\*\* Update File:\s+(.+)$/);
    const del = line.match(/^\*\*\* Delete File:\s+(.+)$/);
    const move = line.match(/^\*\*\* Move to:\s+(.+)$/);
    if (add) {
      last = { path: normalizePatchDisplayPath(add[1], baseDir), action: 'add' };
      files.push(last);
    } else if (update) {
      last = { path: normalizePatchDisplayPath(update[1], baseDir), action: 'update' };
      files.push(last);
    } else if (del) {
      last = { path: normalizePatchDisplayPath(del[1], baseDir), action: 'delete' };
      files.push(last);
    } else if (move && last) {
      last.action = 'move';
      last.toPath = normalizePatchDisplayPath(move[1], baseDir);
    }
  }
  return files;
}

function relativePathFromBase(filePath: string, baseDir: string | undefined): string | null {
  const base = baseDir?.trim();
  if (!base) return null;
  if (path.win32.isAbsolute(filePath) || path.win32.isAbsolute(base)) {
    if (!path.win32.isAbsolute(filePath) || !path.win32.isAbsolute(base)) return null;
    const relative = path.win32.relative(base, filePath).replace(/\\/g, '/');
    return relative && !path.win32.isAbsolute(relative) ? relative : null;
  }
  if (!path.isAbsolute(filePath) || !path.isAbsolute(base)) return null;
  const relative = path.relative(base, filePath);
  return relative && !path.isAbsolute(relative) ? relative : null;
}

function normalizePatchDisplayPath(value: string, baseDir?: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const relative = relativePathFromBase(trimmed, baseDir)
    ?? (!baseDir ? relativePathFromBase(trimmed, process.cwd()) : null);
  if (relative) return relative;
  if (path.isAbsolute(trimmed)) {
    return trimmed.replace(/^[/\\]+/u, '');
  }
  if (path.win32.isAbsolute(trimmed)) {
    return trimmed.replace(/^[A-Za-z]:[\\/]+/u, '').replace(/\\/g, '/');
  }
  return trimmed;
}

function normalizePatchTextPaths(patchText: string, baseDir?: string): string {
  return patchText.split(/\r?\n/u).map((line) => {
    const match = line.match(/^(\*\*\* (?:Add File|Update File|Delete File|Move to):\s+)(.+)$/u);
    return match ? `${match[1]}${normalizePatchDisplayPath(match[2], baseDir)}` : line;
  }).join('\n');
}

function extractPatchText(value: unknown): string {
  const parsed = parseJsonMaybe(value);
  if (typeof parsed === 'string') return parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return stringifyToolValue(parsed);
  }
  const record = parsed as Record<string, unknown>;
  for (const key of ['patch', 'diff', 'input', 'cmd', 'command']) {
    const text = record[key];
    if (typeof text === 'string' && text.includes('*** Begin Patch')) return text;
  }
  return stringifyToolValue(parsed);
}

function extractToolWorkingDirectory(record: Record<string, unknown> | null): string {
  if (!record) return '';
  return extractTextRecordValue(record, ['workdir', 'working_dir', 'cwd']).trim();
}

function summarizeToolSearchTools(value: unknown): Pick<Extract<CodexToolDetail, { kind: 'tool_search' }>, 'foundCount' | 'namespaces' | 'toolNames'> {
  if (!Array.isArray(value)) return {};
  const namespaces: string[] = [];
  const toolNames: string[] = [];
  let foundCount = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { name?: unknown; tools?: unknown };
    if (typeof record.name === 'string' && record.name.trim()) namespaces.push(record.name.trim());
    if (Array.isArray(record.tools)) {
      foundCount += record.tools.length;
      for (const tool of record.tools) {
        if (tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string') {
          toolNames.push(String((tool as { name: string }).name).trim());
        }
      }
    }
  }
  return {
    ...(foundCount > 0 ? { foundCount } : {}),
    ...(namespaces.length > 0 ? { namespaces: namespaces.slice(0, 5) } : {}),
    ...(toolNames.length > 0 ? { toolNames: toolNames.slice(0, 8) } : {}),
  };
}

export function buildCodexToolDetailFromInput(toolName: string | undefined, input: unknown): CodexToolDetail | null {
  const parsed = parseJsonMaybe(input);
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  if (isExecTool(toolName)) {
    const command = commandFromInput(parsed);
    return {
      kind: 'exec_command',
      ...(command ? { command: sanitizeToolText(command) } : {}),
      ...(typeof record?.workdir === 'string' ? { workdir: sanitizeToolText(record.workdir) } : {}),
      ...(typeof record?.shell === 'string' ? { shell: sanitizeToolText(record.shell) } : {}),
      ...(typeof record?.tty === 'boolean' ? { tty: record.tty } : {}),
    };
  }
  if (isWriteStdinTool(toolName)) {
    const waitMs = numberFromRecord(record, ['yield_time_ms', 'yieldTimeMs']);
    return {
      kind: 'terminal_stdin',
      ...(record && typeof record.session_id !== 'undefined' ? { sessionId: String(record.session_id) } : {}),
      ...(record && typeof record.sessionId !== 'undefined' ? { sessionId: String(record.sessionId) } : {}),
      ...(record && typeof record.chars === 'string' ? { chars: sanitizeToolText(record.chars), isPoll: record.chars.length === 0 } : {}),
      ...(typeof waitMs === 'number' ? { waitMs } : {}),
    };
  }
  if (isPatchTool(toolName)) {
    const workdir = sanitizeToolText(extractToolWorkingDirectory(record));
    const patchText = normalizePatchTextPaths(extractPatchText(input), workdir);
    return {
      kind: 'patch_apply',
      ...(patchText.trim() ? { patchText: sanitizeToolText(patchText) } : {}),
      ...(workdir ? { workdir } : {}),
      files: parsePatchFiles(patchText, workdir),
    };
  }
  if (normalizeToolName(toolName) === 'tool_search') {
    const query = typeof record?.query === 'string'
      ? record.query
      : typeof record?.q === 'string'
        ? record.q
        : '';
    return { kind: 'tool_search', ...(query.trim() ? { query: sanitizeToolText(query) } : {}) };
  }
  if (normalizeToolName(toolName) === 'web search') {
    const query = typeof record?.query === 'string' ? record.query : '';
    return { kind: 'web_search', ...(query.trim() ? { query: sanitizeToolText(query) } : {}) };
  }
  if (normalizeToolName(toolName).startsWith('mcp__')) {
    const parts = String(toolName || '').split('__');
    return {
      kind: 'mcp',
      server: parts[1],
      tool: parts.slice(2).join('__'),
      input: parsed,
    };
  }
  return { kind: 'generic', input: parsed };
}

export function buildCodexToolDetailFromOutput(
  toolName: string | undefined,
  output: unknown,
  existing?: CodexToolDetail | null,
): CodexToolDetail | null {
  const raw = typeof output === 'string' ? output : stringifyToolValue(output);
  const parsed = parseJsonMaybe(output);
  if (existing?.kind === 'orchestration') {
    const structuredOutput = extractExecStructuredOutput(parsed);
    const { output: processOutput } = parseProcessOutput(raw);
    const outputText = structuredOutput || processOutput || '';
    return {
      kind: 'orchestration',
      calls: existing.calls,
      ...(outputText.trim() ? { output: sanitizeToolText(outputText) } : {}),
      rawOutput: raw,
    };
  }
  if (existing?.kind === 'exec_command' || isExecTool(toolName)) {
    const structuredOutput = extractExecStructuredOutput(parsed);
    const { output: processOutput, ...processMeta } = parseProcessOutput(raw);
    const parsedIsRecord = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    const outputText = structuredOutput || (parsedIsRecord ? '' : processOutput || '');
    return {
      kind: 'exec_command',
      ...processMeta,
      ...(outputText.trim() ? { output: sanitizeToolText(outputText) } : {}),
      rawOutput: raw,
    };
  }
  if (existing?.kind === 'terminal_stdin' || isWriteStdinTool(toolName)) {
    return {
      kind: 'terminal_stdin',
      ...parseProcessOutput(raw),
      rawOutput: raw,
    };
  }
  if (existing?.kind === 'patch_apply' || isPatchTool(toolName)) {
    return {
      kind: 'patch_apply',
      output: sanitizeToolText(raw),
      rawOutput: raw,
    };
  }
  if (existing?.kind === 'tool_search' || normalizeToolName(toolName) === 'tool_search') {
    const summary = parsed && typeof parsed === 'object'
      ? summarizeToolSearchTools((parsed as { tools?: unknown }).tools ?? parsed)
      : {};
    return {
      kind: 'tool_search',
      ...summary,
      ...(raw.trim() ? { output: sanitizeToolText(raw) } : {}),
    };
  }
  if (existing?.kind === 'web_search' || normalizeToolName(toolName) === 'web search') {
    return { kind: 'web_search', ...(raw.trim() ? { query: sanitizeToolText(raw) } : {}) };
  }
  if (existing?.kind === 'mcp' || normalizeToolName(toolName).startsWith('mcp__')) {
    return { kind: 'mcp', output: sanitizeToolText(raw) };
  }
  return { kind: 'generic', output: sanitizeToolText(raw) };
}

export function mergeCodexToolDetail(
  existing: CodexToolDetail | null | undefined,
  update: CodexToolDetail | null | undefined,
): CodexToolDetail | null {
  if (!existing) return update || null;
  if (!update) return existing;
  if (existing.kind !== update.kind) {
    if (update.kind === 'generic' && typeof update.output === 'string') {
      return { ...existing, output: update.output } as CodexToolDetail;
    }
    return update.kind === 'generic' ? existing : update;
  }
  return { ...existing, ...update } as CodexToolDetail;
}

function renderStatusLine(tool: ToolCallInfo, detail: Extract<CodexToolDetail, { kind: 'exec_command' | 'terminal_stdin' }>): string {
  const duration = formatDuration(detail.durationMs);
  const suffix = [
    typeof detail.exitCode === 'number' && detail.exitCode !== 0 ? `with exit code ${detail.exitCode}` : '',
    duration ? `in ${duration}` : '',
  ].filter(Boolean).join(' ');
  if (detail.runningSessionId) return `Process running with session ${detail.runningSessionId}${duration ? ` after ${duration}` : ''}.`;
  if (tool.status === 'error' || (typeof detail.exitCode === 'number' && detail.exitCode !== 0)) {
    return `⚠️ Fail${suffix ? ` ${suffix}` : ''}.`;
  }
  if (tool.status === 'complete') {
    return `Success${suffix ? ` ${suffix}` : ''}.`;
  }
  return 'Running.';
}

function escapeTextTagContent(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;');
}

function textTag(color: string, value: string): string {
  return `<text_tag color='${color}'>${escapeTextTagContent(value)}</text_tag>`;
}

function truncateExecOutputForRender(value: string): string {
  const sanitized = sanitizeToolText(value);
  if (!sanitized) return '';
  const { text, truncated } = sanitizeInput(sanitized, EXEC_COMMAND_RENDER_OUTPUT_CHAR_LIMIT);
  return truncated ? `${text}\n...(truncated to ${EXEC_COMMAND_RENDER_OUTPUT_CHAR_LIMIT} chars)` : text;
}

export function renderCodexToolDetailMarkdown(tool: ToolCallInfo): string {
  const detail = tool.detail;
  if (!detail) return '';
  const sections: string[] = [];
  if (detail.kind === 'exec_command') {
    const meta = [
      detail.shell ? `shell: \`${detail.shell}\`` : '',
      typeof detail.tty === 'boolean' ? `tty: \`${String(detail.tty)}\`` : '',
    ].filter(Boolean).join('  ');
    if (meta) sections.push(meta);
    if (detail.command) sections.push(buildFencedCodeBlock(detail.command, 'bash'));
    const status = renderStatusLine(tool, detail);
    if (status && !(tool.status === 'complete' && detail.exitCode === 0)) sections.push(status);
    const output = truncateExecOutputForRender(detail.output || '');
    if (output) sections.push(buildFencedCodeBlock(output, 'text'));
    return sections.join('\n\n');
  }
  if (detail.kind === 'terminal_stdin') {
    const tags = [textTag('blue', `session ${detail.sessionId || 'unknown'}`)];
    if (typeof detail.waitMs === 'number') {
      tags.push(textTag('green', `wait ${formatDuration(detail.waitMs)}`));
    }
    if (detail.isPoll) {
      tags.push(textTag('yellow', 'Read'));
    } else if (typeof detail.chars === 'string') {
      tags.push(textTag('red', 'Write'));
    }
    sections.push(tags.join(' '));
    if (!detail.isPoll && typeof detail.chars === 'string') {
      sections.push(buildFencedCodeBlock(detail.chars, 'text'));
    }
    const status = renderStatusLine(tool, detail);
    if (status && tool.status !== 'running') sections.push(status);
    if (detail.output) sections.push(buildFencedCodeBlock(detail.output, 'text'));
    return sections.join('\n\n');
  }
  if (detail.kind === 'patch_apply') {
    if (detail.files && detail.files.length > 0) {
      sections.push(detail.files.map((file) => {
        const target = file.toPath ? `${file.path} -> ${file.toPath}` : file.path;
        return `- ${file.action}: \`${target}\``;
      }).join('\n'));
    }
    if (detail.patchText) sections.push(buildFencedCodeBlock(detail.patchText, 'diff'));
    return sections.join('\n\n');
  }
  if (detail.kind === 'tool_search') {
    if (detail.query) sections.push(`query: \`${detail.query}\``);
    const summary = [
      typeof detail.foundCount === 'number' ? `Found ${detail.foundCount} tools.` : '',
      detail.namespaces?.length ? `namespaces: ${detail.namespaces.map((name) => `\`${name}\``).join(', ')}` : '',
      detail.toolNames?.length ? `tools: ${detail.toolNames.map((name) => `\`${name}\``).join(', ')}` : '',
    ].filter(Boolean).join('\n');
    if (summary) sections.push(summary);
    return sections.join('\n\n');
  }
  if (detail.kind === 'web_search') {
    return '';
  }
  if (detail.kind === 'mcp') {
    const name = [detail.server, detail.tool].filter(Boolean).join('/');
    if (name) sections.push(`mcp: \`${name}\``);
    if (detail.input != null) sections.push(buildFencedCodeBlock(stringifyToolValue(detail.input), 'json'));
    if (detail.output) sections.push(buildFencedCodeBlock(detail.output, 'text'));
    if (detail.errorText) sections.push(buildFencedCodeBlock(detail.errorText, 'text'));
    return sections.join('\n\n');
  }
  if (detail.kind === 'dynamic') {
    if (detail.tool) sections.push(`tool: \`${detail.tool}\``);
    if (detail.input != null) sections.push(buildFencedCodeBlock(stringifyToolValue(detail.input), 'json'));
    if (detail.output) sections.push(buildFencedCodeBlock(detail.output, 'text'));
    if (detail.errorText) sections.push(buildFencedCodeBlock(detail.errorText, 'text'));
    return sections.join('\n\n');
  }
  if (detail.kind === 'orchestration') {
    detail.calls.forEach((call, index) => {
      const child = renderCodexToolDetailMarkdown({
        id: `${tool.id}:${index}`,
        name: call.name,
        status: tool.status,
        input: null,
        output: null,
        detail: call.detail,
      });
      sections.push([
        `##### ${index + 1}. \`${call.name}\``,
        child,
      ].filter(Boolean).join('\n\n'));
    });
    if (detail.output) {
      sections.push(`编排输出：\n${buildFencedCodeBlock(truncateExecOutputForRender(detail.output), 'text')}`);
    }
    return sections.join('\n\n');
  }
  if (detail.kind === 'generic') {
    if (detail.input != null) sections.push(buildFencedCodeBlock(stringifyToolValue(detail.input), 'json'));
    if (detail.output) sections.push(buildFencedCodeBlock(detail.output, 'text'));
    return sections.join('\n\n');
  }
  return '';
}

export function summarizeToolDetailValue(value: unknown, maxChars: number): string {
  if (value == null) return '';
  if (typeof value === 'object' && value) {
    const record = value as Record<string, unknown>;
    const commandValue = record.cmd ?? record.command;
    if (typeof commandValue === 'string' && commandValue.trim()) {
      const trimmedCommand = commandValue.trim();
      const bashPrefix = '/bin/bash -lc "';
      const extracted = trimmedCommand.startsWith(bashPrefix) && trimmedCommand.endsWith('"')
        ? trimmedCommand.slice(bashPrefix.length, -1)
        : trimmedCommand;
      const masked = maskSecrets(extracted);
      const { text, truncated } = sanitizeInput(masked, maxChars);
      return truncated ? `${text}\n...(truncated)` : text;
    }
  }
  const raw = typeof value === 'string'
    ? value
    : (() => {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    })();
  const masked = maskSecrets(raw);
  const { text, truncated } = sanitizeInput(masked, maxChars);
  return truncated ? `${text}\n...(truncated)` : text;
}
