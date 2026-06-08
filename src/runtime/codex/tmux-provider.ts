import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, StreamChatParams } from '../contracts.js';
import type { CodexReasoningEffort, CodexSandboxMode } from '../options.js';
import type { PendingPermissions } from '../permission-gateway.js';
import {
  getCodexSessionsRoot,
  readCodexSessionMirrorRecordDeltaByFilePath,
} from './session-index.js';
import type { BridgeMirrorRecord } from '../contracts.js';
import { sseEvent } from '../sse.js';
import {
  normalizeSandboxMode,
  parseReasoningEffort,
} from '../options.js';
import {
  buildShellSnapshotLaunchCommand,
  ensureShellSnapshot,
} from './shell-snapshot.js';
import { resolveCodexCliExecutable } from './cli-executable.js';
import { tmuxCore, type TmuxCore, type TmuxSendAction } from '../../bridge/tmux/core.js';

const DEFAULT_TMUX_PROMPT_DELAY_MS = 1_200;
const DEFAULT_TMUX_AFTER_TRUST_DELAY_MS = 1_000;
const DEFAULT_TMUX_POLL_INTERVAL_MS = 500;
const DEFAULT_TMUX_SESSION_FILE_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_TUI_UPDATE_TIMEOUT_MS = 300_000;
const CODEX_TUI_SELECTION_PROMPT_STABLE_CAPTURES = 2;
const CODEX_TUI_SELECTION_PROMPT_STABLE_DURATION_MS = 500;
const CODEX_TUI_SELECTION_PROMPT_POST_ACTION_GRACE_MS = 2_000;
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

interface SessionFileSnapshotEntry {
  size: number;
  mtimeMs: number;
}

export type SessionFileSnapshot = Map<string, SessionFileSnapshotEntry>;

export interface CodexTuiRunContext {
  sessionName: string;
  targetPane: string;
  bridgeSessionId: string;
  threadId?: string;
  sessionFilePath?: string;
  nextOffset: number;
  trailingText: string;
  nextTurnId: string | null;
  nextSpecialCallIds: string[];
  emittedToolStarts: Set<string>;
  emittedRecordSignatures: Set<string>;
  lastAssistantText: string;
  terminalSeen: boolean;
  hasError: boolean;
}

export type CodexTuiSelectionPromptKind = 'update' | 'permission' | 'goal' | 'generic';
export type CodexTuiSelectionPromptChoice =
  | 'update_now'
  | 'skip'
  | 'skip_until_next_version'
  | 'replace_current_goal'
  | 'cancel'
  | 'yes_proceed'
  | 'yes_always'
  | 'no'
  | 'not_selection'
  | `option_${number}`;

export type CodexTuiUpdatePromptChoice = Extract<
  CodexTuiSelectionPromptChoice,
  'update_now' | 'skip' | 'skip_until_next_version'
>;

export interface CodexTuiUpdatePromptOption {
  index: number;
  choice: CodexTuiSelectionPromptChoice;
  label: string;
  selected: boolean;
}

export interface CodexTuiSelectionPrompt {
  kind: CodexTuiSelectionPromptKind;
  options: CodexTuiUpdatePromptOption[];
  selectedIndex: number;
  fingerprint: string;
  summary: string;
}

export type CodexTuiUpdatePrompt = CodexTuiSelectionPrompt;

export interface CodexTuiSelectionPromptMonitor {
  stableCaptures: number;
  pending: boolean;
  firstSeenAtMs: number;
  lastTriggeredAtMs: number;
  postActionGraceUntilMs: number;
}

export type CodexTuiUpdatePromptMonitor = CodexTuiSelectionPromptMonitor;

interface SessionMetaPreview {
  threadId: string;
  cwd: string;
  originator: string;
  source: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parsePositiveIntEnv(name: string, fallback: number, minValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= minValue) return Math.floor(parsed);
  return fallback;
}

export function isTruthyEnv(value: string | undefined): boolean {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function shouldUseCodexTmuxTui(): boolean {
  return isTruthyEnv(process.env.CODELARK_CODEX_USE_TMUX_TUI)
    || isTruthyEnv(process.env.CODELARK_CODEX_TMUX_TUI)
    || isTruthyEnv(process.env.CODELARK_CODEX_TUI);
}

function isDebugTmuxKeepAlive(): boolean {
  return isTruthyEnv(process.env.CODELARK_DEBUG);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandPreview(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

export function hasCodexTuiTrustPrompt(screenText: string): boolean {
  const tail = screenText.slice(-20_000);
  return /Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+directory\?/i.test(tail)
    || /Press\s+enter\s+to\s+continue/i.test(tail);
}

export function hasCodexTuiSelectionPrompt(screenText: string): boolean {
  return Boolean(parseCodexTuiSelectionPrompt(screenText));
}

export function hasCodexTuiUpdatePrompt(screenText: string): boolean {
  return parseCodexTuiSelectionPrompt(screenText)?.kind === 'update';
}

function stripTerminalControl(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function normalizeSelectionChoice(label: string): CodexTuiSelectionPromptChoice | null {
  const normalized = label.trim().toLowerCase();
  if (/^update\s+now\b/.test(normalized)) return 'update_now';
  if (/^skip\s+until\s+next\s+version\b/.test(normalized)) return 'skip_until_next_version';
  if (/^skip\b/.test(normalized)) return 'skip';
  if (/^replace\s+current\s+goal\b/.test(normalized)) return 'replace_current_goal';
  if (/^cancel\b/.test(normalized)) return 'cancel';
  if (/^yes,?\s*(?:and\s+)?(?:don['’]t\s+ask\s+again|always)\b/.test(normalized)) return 'yes_always';
  if (/^yes,?\s*proceed\b/.test(normalized) || /^yes\b/.test(normalized)) return 'yes_proceed';
  if (/^no,\s*and\s+tell\s+codex\b/.test(normalized) || /^no\b/.test(normalized)) return 'no';
  return null;
}

function genericSelectionChoice(index: number): CodexTuiSelectionPromptChoice {
  return `option_${Math.max(1, index + 1)}`;
}

function isCodexTuiSelectionPromptChoice(value: string | undefined): value is CodexTuiSelectionPromptChoice {
  return value === 'update_now'
    || value === 'skip'
    || value === 'skip_until_next_version'
    || value === 'replace_current_goal'
    || value === 'cancel'
    || value === 'yes_proceed'
    || value === 'yes_always'
    || value === 'no'
    || value === 'not_selection'
    || Boolean(value && /^option_\d+$/.test(value));
}

function inferSelectionPromptKind(
  tail: string,
  options: CodexTuiUpdatePromptOption[],
): CodexTuiSelectionPromptKind | null {
  const hasChoice = (choice: CodexTuiSelectionPromptChoice) => options.some((option) => option.choice === choice);
  const hasUpdateHeader = /(?:New\s+version|Update)\s+available!?/i.test(tail);
  if (
    hasUpdateHeader
    && hasChoice('update_now')
    && hasChoice('skip')
    && hasChoice('skip_until_next_version')
  ) {
    return 'update';
  }
  if (hasChoice('yes_proceed') && hasChoice('no')) {
    return 'permission';
  }
  if (hasChoice('replace_current_goal') && hasChoice('cancel')) {
    return 'goal';
  }
  if (options.some((option) => option.selected && option.index === 0 && option.choice === 'option_1')) {
    return 'generic';
  }
  return null;
}

function hasCodexTuiSelectionPromptCursor(tail: string): boolean {
  return tail
    .split('\n')
    .some((line) => /^\s*[›>▸➜→]\s*1\.\s+/u.test(line));
}

function hasCodexTuiSelectionPromptFooter(tail: string): boolean {
  return tail
    .split('\n')
    .some((line) => /Press\s+enter\s+to\s+confirm/i.test(line) && /\besc\b/i.test(line));
}

type ParsedSelectionLine = {
  rawLine: string;
  marker: string | null;
  number: number | null;
  label: string;
};

type ParsedSelectionBlock = {
  lines: ParsedSelectionLine[];
  startIndex: number;
};

function parseSelectionLine(rawLine: string): ParsedSelectionLine | null {
  const match = rawLine.match(/^\s*([›>▸➜→*•])?\s*(?:(\d+)[.)]\s*)?(.+?)\s*$/u);
  if (!match) return null;
  const label = match[3].trim();
  if (!label) return null;
  return {
    rawLine,
    marker: match[1] || null,
    number: match[2] ? Number(match[2]) : null,
    label,
  };
}

function isSelectedSelectionLine(line: ParsedSelectionLine): boolean {
  return line.marker === '›'
    || line.marker === '>'
    || line.marker === '▸'
    || line.marker === '➜'
    || line.marker === '→';
}

function extractCurrentSelectionBlock(lines: string[]): ParsedSelectionBlock {
  const parsed = lines.map(parseSelectionLine);
  const selectedLineIndex = parsed.findLastIndex((line) => Boolean(line && isSelectedSelectionLine(line)));
  if (selectedLineIndex < 0) return { lines: [], startIndex: -1 };
  const selected = parsed[selectedLineIndex];
  if (!selected) return { lines: [], startIndex: -1 };

  let start = selectedLineIndex;
  if (selected.number !== null) {
    let expectedNumber = selected.number - 1;
    for (let index = selectedLineIndex - 1; index >= 0; index -= 1) {
      const candidate = parsed[index];
      if (!candidate || candidate.number !== expectedNumber) break;
      start = index;
      expectedNumber -= 1;
    }
  } else {
    for (let index = selectedLineIndex - 1; index >= 0; index -= 1) {
      const candidate = parsed[index];
      if (!candidate || candidate.number !== null || !normalizeSelectionChoice(candidate.label)) break;
      start = index;
    }
  }

  const result: ParsedSelectionLine[] = [];
  let expectedNumber = selected.number !== null
    ? (parsed[start]?.number ?? selected.number)
    : null;
  for (let index = start; index < parsed.length; index += 1) {
    const candidate = parsed[index];
    if (!candidate) break;
    if (expectedNumber !== null) {
      if (candidate.number !== expectedNumber) break;
      expectedNumber += 1;
    } else if (candidate.number !== null || !normalizeSelectionChoice(candidate.label)) {
      break;
    }
    result.push(candidate);
  }
  return { lines: result, startIndex: result.length > 0 ? start : -1 };
}

function trimBlankSummaryEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

export function parseCodexTuiSelectionPrompt(screenText: string): CodexTuiSelectionPrompt | null {
  const tail = stripTerminalControl(screenText).slice(-20_000);
  if (!hasCodexTuiSelectionPromptCursor(tail) || !hasCodexTuiSelectionPromptFooter(tail)) {
    return null;
  }
  const options: CodexTuiUpdatePromptOption[] = [];
  const lines = tail.split('\n');
  const selectionBlock = extractCurrentSelectionBlock(lines);
  const selectionLines = selectionBlock.lines;
  const hasGenericSelectionAnchor = selectionLines.some((line) => line.marker === '›' && line.number === 1);
  const hasGoalSelectionAnchor = selectionLines.some((line) => normalizeSelectionChoice(line.label) === 'replace_current_goal');
  for (const selectionLine of selectionLines) {
    const label = selectionLine.label;
    const index = selectionLine.number !== null ? selectionLine.number - 1 : options.length;
    const rawNormalizedChoice = normalizeSelectionChoice(label);
    const normalizedChoice = rawNormalizedChoice === 'cancel' && !hasGoalSelectionAnchor
      ? null
      : rawNormalizedChoice;
    const selected = isSelectedSelectionLine(selectionLine);
    const choice = normalizedChoice || (
      selectionLine.number !== null && hasGenericSelectionAnchor
        ? genericSelectionChoice(index)
        : null
    );
    if (!choice) continue;
    options.push({
      index,
      choice,
      label,
      selected,
    });
  }
  const kind = inferSelectionPromptKind(tail, options);
  if (!kind) return null;
  const selectedOption = options.find((option) => option.selected) || options[0];
  const summaryContextLines = selectionBlock.startIndex > 0
    ? lines
      .slice(Math.max(0, selectionBlock.startIndex - 3), selectionBlock.startIndex)
      .map((line) => line.trimEnd())
    : [];
  const summaryLines = selectionLines
    .map((line) => line.rawLine.trimEnd())
    .filter((line) => (
      /Update available|Release notes|^\s*(?:Allow|Do you want|Would you like|Codex wants)/i.test(line)
      || Boolean(line.match(/^\s*[›>▸➜→*•]?\s*(?:\d+[.)]\s*)?(?:Update now|Skip|Replace current goal|Cancel|Yes|No)\b/i))
      || (kind === 'generic' && Boolean(line.match(/^\s*[›>▸➜→*•]?\s*\d+[.)]\s+/u)))
    ))
    .slice(-8);
  const summary = trimBlankSummaryEdges([...summaryContextLines, ...summaryLines]).join('\n')
    || options.map((option) => option.label).join('\n');
  const fingerprint = options
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((option) => `${kind}:${option.index}:${option.choice}:${option.selected ? 'selected' : 'plain'}:${option.label}`)
    .join('|');
  return {
    kind,
    options,
    selectedIndex: selectedOption.index,
    fingerprint,
    summary,
  };
}

export function parseCodexTuiUpdatePrompt(screenText: string): CodexTuiUpdatePrompt | null {
  const prompt = parseCodexTuiSelectionPrompt(screenText);
  return prompt?.kind === 'update' ? prompt : null;
}

export function createCodexTuiSelectionPromptMonitor(): CodexTuiSelectionPromptMonitor {
  return {
    stableCaptures: 0,
    pending: false,
    firstSeenAtMs: -1,
    lastTriggeredAtMs: 0,
    postActionGraceUntilMs: 0,
  };
}

export function createCodexTuiUpdatePromptMonitor(): CodexTuiUpdatePromptMonitor {
  return createCodexTuiSelectionPromptMonitor();
}

export function observeStableCodexTuiSelectionPrompt(
  screenText: string,
  monitor: CodexTuiSelectionPromptMonitor,
  threshold = CODEX_TUI_SELECTION_PROMPT_STABLE_CAPTURES,
  nowMs = Date.now(),
): CodexTuiSelectionPrompt | null {
  const prompt = parseCodexTuiSelectionPrompt(screenText);
  if (!prompt) {
    monitor.stableCaptures = 0;
    monitor.firstSeenAtMs = -1;
    return null;
  }
  if (monitor.firstSeenAtMs < 0) {
    monitor.stableCaptures = 1;
    monitor.firstSeenAtMs = nowMs;
  } else {
    monitor.stableCaptures += 1;
  }
  if (monitor.pending || monitor.stableCaptures < threshold) return null;
  if (nowMs < monitor.postActionGraceUntilMs) return null;

  const stableElapsed = monitor.firstSeenAtMs >= 0 ? nowMs - monitor.firstSeenAtMs : 0;
  if (stableElapsed < CODEX_TUI_SELECTION_PROMPT_STABLE_DURATION_MS) return null;
  monitor.lastTriggeredAtMs = nowMs;
  return prompt;
}

export function markCodexTuiSelectionPromptActionSent(
  monitor: CodexTuiSelectionPromptMonitor,
  nowMs = Date.now(),
): void {
  monitor.pending = false;
  monitor.postActionGraceUntilMs = nowMs + CODEX_TUI_SELECTION_PROMPT_POST_ACTION_GRACE_MS;
}

export function observeStableCodexTuiUpdatePrompt(
  screenText: string,
  monitor: CodexTuiUpdatePromptMonitor,
  threshold = CODEX_TUI_SELECTION_PROMPT_STABLE_CAPTURES,
): CodexTuiUpdatePrompt | null {
  const prompt = observeStableCodexTuiSelectionPrompt(screenText, monitor, threshold);
  return prompt?.kind === 'update' ? prompt : null;
}

export function buildCodexTuiSelectionChoiceActions(
  prompt: CodexTuiSelectionPrompt,
  choice: CodexTuiSelectionPromptChoice,
): TmuxSendAction[] {
  if (choice === 'not_selection') return [];
  const ordered = prompt.options.slice().sort((left, right) => left.index - right.index);
  const currentPosition = Math.max(0, ordered.findIndex((option) => option.index === prompt.selectedIndex));
  const targetPosition = ordered.findIndex((option) => option.choice === choice);
  if (targetPosition < 0) {
    return [{ type: 'key', key: 'Enter' }];
  }
  const downSteps = (targetPosition - currentPosition + ordered.length) % ordered.length;
  return [
    ...Array.from({ length: downSteps }, () => ({ type: 'key' as const, key: 'Down' })),
    { type: 'key', key: 'Enter' },
  ];
}

export function buildCodexTuiUpdateChoiceActions(
  prompt: CodexTuiUpdatePrompt,
  choice: CodexTuiUpdatePromptChoice,
): TmuxSendAction[] {
  return buildCodexTuiSelectionChoiceActions(prompt, choice);
}

export async function requestCodexTuiUpdateConfirmation(params: {
  controller: ReadableStreamDefaultController<string>;
  pendingPerms?: PendingPermissions;
  provider: 'tmux' | 'pty';
  bridgeSessionId: string;
  screenCommand: string;
  prompt?: CodexTuiUpdatePrompt;
}): Promise<CodexTuiUpdatePromptChoice> {
  const choice = await requestCodexTuiSelectionConfirmation({
    ...params,
    prompt: params.prompt,
    defaultChoice: 'skip',
  });
  return choice === 'update_now' || choice === 'skip_until_next_version' ? choice : 'skip';
}

export async function requestCodexTuiSelectionConfirmation(params: {
  controller: ReadableStreamDefaultController<string>;
  pendingPerms?: PendingPermissions;
  provider: 'tmux' | 'pty';
  bridgeSessionId: string;
  screenCommand: string;
  prompt?: CodexTuiSelectionPrompt;
  defaultChoice?: CodexTuiSelectionPromptChoice;
}): Promise<CodexTuiSelectionPromptChoice> {
  const kind = params.prompt?.kind || 'permission';
  const defaultChoice = params.defaultChoice || (kind === 'update'
    ? 'skip'
    : kind === 'goal'
      ? 'cancel'
      : kind === 'generic'
        ? 'not_selection'
        : 'yes_proceed');
  const permissionRequestId = `codex-selection:${kind}:${params.provider}:${params.bridgeSessionId}:${Date.now()}`;
  params.controller.enqueue(sseEvent('permission_request', {
    permissionRequestId,
    toolName: 'Codex TUI Selection Prompt',
    toolInput: {
      provider: params.provider,
      reason: kind === 'update'
        ? 'Codex TUI is waiting at a CLI update selection prompt.'
        : kind === 'goal'
          ? 'Codex TUI is waiting at a goal replacement selection prompt.'
          : kind === 'generic'
            ? 'Codex TUI may be waiting at an unrecognized numbered selection prompt.'
            : 'Codex TUI is waiting at an interactive selection prompt.',
      inspect: params.screenCommand,
      promptKind: kind,
      defaultChoice,
      choices: params.prompt
        ? [
          ...params.prompt.options.map((option) => ({
            choice: option.choice,
            label: option.label,
            selected: option.selected,
          })),
          ...(kind === 'generic' ? [{ choice: 'not_selection' as const, label: '这不是TUI选择' }] : []),
        ]
        : undefined,
      ...(params.prompt ? { prompt: params.prompt.summary } : {}),
    },
    suggestions: [],
  }));
  if (!params.pendingPerms) {
    params.controller.enqueue(sseEvent('status', {
      reasoning: `Codex TUI 检测到选择界面，但当前没有权限确认通道，已默认选择 ${defaultChoice}。`,
    }));
    return defaultChoice;
  }
  const resolution = await params.pendingPerms.waitFor(permissionRequestId);
  if (resolution.behavior !== 'allow') return defaultChoice;
  const message = resolution.message;
  if (isCodexTuiSelectionPromptChoice(message)) {
    return message;
  }
  return defaultChoice;
}

export function compactCodexTuiUpdateProgress(screenText: string): string {
  const lines = screenText
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-6).join('\n');
}

export async function requestCodexTuiTrustConfirmation(params: {
  controller: ReadableStreamDefaultController<string>;
  pendingPerms?: PendingPermissions;
  provider: 'tmux' | 'pty';
  bridgeSessionId: string;
  workingDirectory?: string;
  screenCommand: string;
}): Promise<void> {
  const cwd = params.workingDirectory || process.cwd();
  const permissionRequestId = `codex-trust:${params.provider}:${params.bridgeSessionId}:${Date.now()}`;
  const toolInput = {
    provider: params.provider,
    workingDirectory: cwd,
    reason: 'Codex TUI is asking whether this working directory should be trusted.',
    inspect: params.screenCommand,
  };
  params.controller.enqueue(sseEvent('permission_request', {
    permissionRequestId,
    toolName: 'Codex Trust Directory',
    toolInput,
    suggestions: [],
  }));
  if (!params.pendingPerms) {
    throw new Error([
      'Codex TUI 需要用户确认是否信任当前目录，但当前运行时没有可用的权限确认通道。',
      `目录：${cwd}`,
      `请先用 ${params.screenCommand} 查看屏幕并在本地 TUI 中确认，或切回 /provider sdk。`,
    ].join('\n'));
  }

  const resolution = await params.pendingPerms.waitFor(permissionRequestId);
  if (resolution.behavior !== 'allow') {
    throw new Error(resolution.message || '用户拒绝信任当前 Codex 工作目录。');
  }
}

function tmuxSessionName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80) || 'session';
  return `clk-${process.pid}-${Date.now()}-${safe}`;
}

export function buildCodexTuiEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (env.CODELARK_CODEX_API_KEY && !env.CODEX_API_KEY) {
    env.CODEX_API_KEY = env.CODELARK_CODEX_API_KEY;
  }
  if ((env.CODEX_API_KEY || env.CODELARK_CODEX_API_KEY) && !env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = env.CODEX_API_KEY || env.CODELARK_CODEX_API_KEY;
  }
  return env;
}

export function buildCodexTuiShellCommand(command: string, args: string[], env: Record<string, string>): string {
  const snapshot = ensureShellSnapshot(env);
  return buildShellSnapshotLaunchCommand(command, args, snapshot);
}

function toApprovalPolicy(permissionMode?: string): string {
  switch (permissionMode) {
    case 'never': return 'never';
    case 'acceptEdits': return 'on-request';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

function isYoloMode(params: StreamChatParams): boolean {
  return params.codexMode === 'yolo' || params.permissionMode === 'never';
}

function shouldSkipGitRepoCheck(params: StreamChatParams): boolean {
  return params.skipGitRepoCheck === true || process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK === 'true';
}

export function buildCodexTuiArgs(params: StreamChatParams, imagePaths: string[]): string[] {
  const args: string[] = [];
  const yoloMode = isYoloMode(params);
  const sandboxMode = yoloMode ? 'danger-full-access' : normalizeSandboxMode(params.sandboxMode) as CodexSandboxMode;
  const modelReasoningEffort = parseReasoningEffort(params.modelReasoningEffort) as CodexReasoningEffort | undefined;

  if (params.forceModel && params.model) args.push('--model', params.model);
  if (yoloMode) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (sandboxMode) {
    args.push('--sandbox', sandboxMode);
  }
  if (params.workingDirectory) args.push('--cd', params.workingDirectory);
  if (shouldSkipGitRepoCheck(params)) {
    args.push('--config', 'skip_git_repo_check=true');
  }
  if (!yoloMode) {
    args.push('--ask-for-approval', toApprovalPolicy(params.permissionMode));
  }
  if (modelReasoningEffort) {
    args.push('--config', `model_reasoning_effort="${modelReasoningEffort}"`);
  }
  if (typeof params.networkAccessEnabled === 'boolean') {
    args.push('--config', `sandbox_workspace_write.network_access=${params.networkAccessEnabled}`);
  }
  if (process.env.CODELARK_CODEX_BASE_URL) {
    args.push('--config', `openai_base_url="${process.env.CODELARK_CODEX_BASE_URL}"`);
  }
  if (process.env.CODELARK_CODEX_API_KEY || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) {
    args.push('--config', 'preferred_auth_method="apikey"');
  }
  for (const imagePath of imagePaths) {
    args.push('--image', imagePath);
  }
  if (params.codexThreadId) {
    args.push('resume', params.codexThreadId);
  }
  return args;
}

export async function injectPromptIntoTmuxPane(targetPane: string, prompt: string): Promise<void> {
  const lines = prompt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  console.log('[codex-tmux] Prompt inject start:', {
    target_pane: targetPane,
    prompt_chars: prompt.length,
    lines: lines.length,
    newline_key: 'M-Enter',
    submit_key: 'Enter',
  });
  const result = await tmuxCore.injectPromptIntoPane(targetPane, prompt);
  console.log('[codex-tmux] Prompt inject tmux commands:', {
    target_pane: targetPane,
    commands: result.commands,
  });
  console.log('[codex-tmux] Prompt inject submitted:', {
    target_pane: targetPane,
    prompt_chars: prompt.length,
    lines: lines.length,
  });
}

function walkJsonlFiles(dirPath: string, target: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(entryPath, target);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      target.push(entryPath);
    }
  }
}

export function snapshotSessionFiles(): SessionFileSnapshot {
  const files: string[] = [];
  walkJsonlFiles(getCodexSessionsRoot(), files);
  const snapshot: SessionFileSnapshot = new Map();
  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      snapshot.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore races with Codex moving or rotating files.
    }
  }
  return snapshot;
}

function readFirstLine(filePath: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(4096);
    let offset = 0;
    while (offset < 1024 * 1024) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) break;
      const slice = Buffer.from(buffer.subarray(0, bytesRead));
      chunks.push(slice);
      offset += bytesRead;
      if (slice.includes(0x0a)) break;
    }
    const combined = Buffer.concat(chunks).toString('utf-8');
    return combined.split(/\r?\n/, 1)[0] || '';
  } catch {
    return '';
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function parseSessionMeta(filePath: string): SessionMetaPreview | null {
  const firstLine = readFirstLine(filePath);
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: {
        id?: unknown;
        cwd?: unknown;
        originator?: unknown;
        source?: unknown;
      };
    };
    if (parsed.type !== 'session_meta' || typeof parsed.payload?.id !== 'string') return null;
    return {
      threadId: parsed.payload.id,
      cwd: typeof parsed.payload.cwd === 'string' ? parsed.payload.cwd : '',
      originator: typeof parsed.payload.originator === 'string' ? parsed.payload.originator : '',
      source: typeof parsed.payload.source === 'string' ? parsed.payload.source : '',
    };
  } catch {
    return null;
  }
}

export function findSessionFileByThreadId(threadId: string): string | null {
  const files: string[] = [];
  walkJsonlFiles(getCodexSessionsRoot(), files);
  const candidates = files
    .filter((filePath) => path.basename(filePath).includes(threadId))
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    });
  return candidates[0] || null;
}

function isLikelyTuiSession(meta: SessionMetaPreview, params: StreamChatParams): boolean {
  const originator = meta.originator.toLowerCase();
  const source = meta.source.toLowerCase();
  if (params.workingDirectory && meta.cwd) {
    const expected = path.resolve(params.workingDirectory).replace(/[\\/]+$/, '').toLowerCase();
    const actual = path.resolve(meta.cwd).replace(/[\\/]+$/, '').toLowerCase();
    if (expected !== actual) return false;
  }
  return originator.includes('codex-tui') || source === 'cli' || !originator;
}

function findUpdatedSessionFile(
  before: SessionFileSnapshot,
  params: StreamChatParams,
  startedAtMs: number,
): { filePath: string; threadId: string; startOffset: number } | null {
  if (params.codexThreadId) {
    const resumed = findSessionFileByThreadId(params.codexThreadId);
    if (resumed) {
      return {
        filePath: resumed,
        threadId: params.codexThreadId,
        startOffset: before.get(resumed)?.size || 0,
      };
    }
  }

  const files: string[] = [];
  walkJsonlFiles(getCodexSessionsRoot(), files);
  const candidates = files
    .map((filePath) => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return null;
      }
      const previous = before.get(filePath);
      const changed = !previous || stat.size !== previous.size || stat.mtimeMs !== previous.mtimeMs;
      if (!changed && stat.mtimeMs < startedAtMs - 5_000) return null;
      const meta = parseSessionMeta(filePath);
      if (!meta || !isLikelyTuiSession(meta, params)) return null;
      return {
        filePath,
        threadId: meta.threadId,
        mtimeMs: stat.mtimeMs,
        startOffset: previous ? previous.size : 0,
      };
    })
    .filter((item): item is { filePath: string; threadId: string; mtimeMs: number; startOffset: number } => Boolean(item))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return candidates[0]
    ? {
        filePath: candidates[0].filePath,
        threadId: candidates[0].threadId,
        startOffset: candidates[0].startOffset,
      }
    : null;
}

function recordToolName(record: BridgeMirrorRecord): string {
  return record.toolName || 'tool';
}

export function enqueueCodexTuiRecordAsSse(
  controller: ReadableStreamDefaultController<string>,
  context: CodexTuiRunContext,
  record: BridgeMirrorRecord,
): void {
  if (context.emittedRecordSignatures.has(record.signature)) return;
  context.emittedRecordSignatures.add(record.signature);

  switch (record.type) {
    case 'task_started':
      context.terminalSeen = false;
      break;

    case 'reasoning':
      if (record.content) {
        controller.enqueue(sseEvent('status', { reasoning: record.content }));
      }
      break;

    case 'plan_update':
      controller.enqueue(sseEvent('task_update', {
        session_id: context.bridgeSessionId,
        codex_thread_id: context.threadId,
        tasks: record.tasks || [],
        todos: record.tasks || [],
      }));
      break;

    case 'context_usage':
      if (record.contextUsage) {
        controller.enqueue(sseEvent('context_usage', record.contextUsage));
      }
      break;

    case 'tool_started': {
      const toolId = record.toolId || record.signature;
      if (!context.emittedToolStarts.has(toolId)) {
        context.emittedToolStarts.add(toolId);
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: recordToolName(record),
          input: {},
        }));
      }
      break;
    }

    case 'tool_finished': {
      const toolId = record.toolId || record.signature;
      if (!context.emittedToolStarts.has(toolId)) {
        context.emittedToolStarts.add(toolId);
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: recordToolName(record),
          input: {},
        }));
      }
      controller.enqueue(sseEvent('tool_result', {
        tool_use_id: toolId,
        content: record.content || 'Done',
        is_error: record.isError === true,
      }));
      break;
    }

    case 'message':
      if (record.role === 'assistant' && record.content) {
        context.lastAssistantText = record.content;
        controller.enqueue(sseEvent('text', record.content));
      } else if (record.role === 'commentary' && record.content) {
        controller.enqueue(sseEvent('status', { reasoning: record.content }));
      }
      break;

    case 'task_complete':
      if (record.content && record.content !== context.lastAssistantText) {
        context.lastAssistantText = record.content;
        controller.enqueue(sseEvent('text', record.content));
      }
      context.terminalSeen = true;
      controller.enqueue(sseEvent('result', {
        ...(context.threadId ? { session_id: context.threadId } : {}),
      }));
      break;

    case 'task_aborted':
      context.terminalSeen = true;
      context.hasError = true;
      controller.enqueue(sseEvent('error', record.content || 'Codex task aborted.'));
      break;
  }
}

export function buildTempImageFiles(params: StreamChatParams, tempFiles: string[]): string[] {
  const imageFiles = params.files?.filter((file) => file.type.startsWith('image/')) || [];
  const imagePaths: string[] = [];
  for (const file of imageFiles) {
    if (file.filePath && fs.existsSync(file.filePath)) {
      imagePaths.push(file.filePath);
      continue;
    }
    const ext = MIME_EXT[file.type] || '.png';
    const tmpPath = path.join(os.tmpdir(), `clk-tui-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
    tempFiles.push(tmpPath);
    imagePaths.push(tmpPath);
  }
  return imagePaths;
}

async function launchTmuxCodexSession(
  sessionName: string,
  params: StreamChatParams,
  imagePaths: string[],
): Promise<void> {
  const env = buildCodexTuiEnv();
  const codexArgs = buildCodexTuiArgs(params, imagePaths);
  const executable = resolveCodexCliExecutable({ env });
  const command = buildCodexTuiShellCommand(executable, codexArgs, env);

  console.log('[codex-tmux] Codex TUI start:', {
    bridge_session_id: params.sessionId,
    tmux_session: sessionName,
    command: commandPreview(executable, codexArgs.map((arg) => imagePaths.includes(arg) ? '<image-path:redacted>' : arg)),
    prompt_chars: params.prompt.length,
    cwd: params.workingDirectory || null,
    resume_thread_id: params.codexThreadId || null,
    debug_keep_tmux: isDebugTmuxKeepAlive(),
  });

  await tmuxCore.ensureDetachedSession({
    name: sessionName,
    cwd: params.workingDirectory,
    command,
    recreate: true,
  });
}

async function waitForTmuxCodexUpdateExit(params: {
  sessionName: string;
  targetPane: string;
  controller: ReadableStreamDefaultController<string>;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  let lastProgress = '';
  while ((await tmuxCore.hasSession(params.sessionName)).exists) {
    const screen = await tmuxCore.capturePane(params.targetPane, 80).catch(() => ({ screen: '', command: '' }));
    const progress = compactCodexTuiUpdateProgress(screen.screen);
    if (progress && progress !== lastProgress) {
      lastProgress = progress;
      params.controller.enqueue(sseEvent('status', { reasoning: `Codex 正在更新：\n${progress}` }));
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for Codex update to finish.');
    }
    await sleep(1_000);
  }
}

async function prepareCodexTmuxUpdatePrompt(params: {
  controller: ReadableStreamDefaultController<string>;
  pendingPerms?: PendingPermissions;
  sessionName: string;
  targetPane: string;
  bridgeSessionId: string;
  screen: string;
}): Promise<boolean> {
  const prompt = parseCodexTuiUpdatePrompt(params.screen);
  if (!prompt) return false;

  console.log('[codex-tmux] Codex TUI update prompt detected; waiting for user confirmation');
  const choice = await requestCodexTuiUpdateConfirmation({
    controller: params.controller,
    pendingPerms: params.pendingPerms,
    provider: 'tmux',
    bridgeSessionId: params.bridgeSessionId,
    screenCommand: '/tmux-screen 80',
    prompt,
  });
  const actions = buildCodexTuiSelectionChoiceActions(prompt, choice);
  const sent = await tmuxCore.sendActions(params.targetPane, actions);
  if (choice !== 'update_now') {
    console.log('[codex-tmux] Codex TUI update prompt skipped:', {
      target_pane: params.targetPane,
      choice,
      commands: sent.commands,
    });
    return false;
  }

  params.controller.enqueue(sseEvent('status', { reasoning: '用户确认更新 Codex CLI，正在等待更新完成。' }));
  console.log('[codex-tmux] Codex TUI update prompt confirmed:', {
    target_pane: params.targetPane,
    commands: sent.commands,
  });
  const timeoutMs = parsePositiveIntEnv(
    'CODELARK_CODEX_TUI_UPDATE_TIMEOUT_MS',
    DEFAULT_CODEX_TUI_UPDATE_TIMEOUT_MS,
    1_000,
  );
  await waitForTmuxCodexUpdateExit({
    sessionName: params.sessionName,
    targetPane: params.targetPane,
    controller: params.controller,
    timeoutMs,
  });
  params.controller.enqueue(sseEvent('status', { reasoning: 'Codex CLI 更新流程已结束，正在重新启动 Codex tmux。' }));
  return true;
}

export async function resolveStableCodexTuiUpdatePrompt(params: {
  controller: ReadableStreamDefaultController<string>;
  pendingPerms?: PendingPermissions;
  provider: 'tmux';
  bridgeSessionId: string;
  targetPane: string;
  prompt: CodexTuiUpdatePrompt;
  screenCommand: string;
  core?: TmuxCore;
}): Promise<{ choice: CodexTuiUpdatePromptChoice; commands: string[] }> {
  const result = await resolveStableCodexTuiSelectionPrompt(params);
  const choice = result.choice === 'update_now' || result.choice === 'skip_until_next_version'
    ? result.choice
    : 'skip';
  return { choice, commands: result.commands };
}

export async function resolveStableCodexTuiSelectionPrompt(params: {
  controller: ReadableStreamDefaultController<string>;
  pendingPerms?: PendingPermissions;
  provider: 'tmux';
  bridgeSessionId: string;
  targetPane: string;
  prompt: CodexTuiSelectionPrompt;
  screenCommand: string;
  core?: TmuxCore;
}): Promise<{ choice: CodexTuiSelectionPromptChoice; commands: string[] }> {
  const core = params.core || tmuxCore;
  const choice = await requestCodexTuiSelectionConfirmation({
    controller: params.controller,
    pendingPerms: params.pendingPerms,
    provider: params.provider,
    bridgeSessionId: params.bridgeSessionId,
    screenCommand: params.screenCommand,
    prompt: params.prompt,
  });
  const actions = buildCodexTuiSelectionChoiceActions(params.prompt, choice);
  if (choice === 'not_selection' || actions.length === 0) {
    params.controller.enqueue(sseEvent('status', {
      reasoning: '已记录：当前屏幕不是 Codex TUI 选择界面，未向 tmux 发送选择按键。',
    }));
    return { choice, commands: [] };
  }
  const result = await core.sendActions(params.targetPane, actions);
  params.controller.enqueue(sseEvent('status', {
    reasoning: `已将 Codex TUI 选择发送到 tmux：${choice}`,
  }));
  return { choice, commands: result.commands };
}

export async function pollCodexTuiSessionFile(
  controller: ReadableStreamDefaultController<string>,
  params: StreamChatParams,
  context: CodexTuiRunContext,
  before: SessionFileSnapshot,
  startedAtMs: number,
  isTerminalAlive: () => Promise<boolean>,
  options: { detectTmuxSelectionPrompt?: boolean; pendingPerms?: PendingPermissions } = {},
): Promise<void> {
  const pollIntervalMs = parsePositiveIntEnv('CODELARK_CODEX_TMUX_POLL_INTERVAL_MS', DEFAULT_TMUX_POLL_INTERVAL_MS, 100);
  const fileTimeoutMs = parsePositiveIntEnv('CODELARK_CODEX_TMUX_SESSION_FILE_TIMEOUT_MS', DEFAULT_TMUX_SESSION_FILE_TIMEOUT_MS, 1_000);
  let sessionFileDeadline = Date.now() + fileTimeoutMs;
  const selectionPromptMonitor = createCodexTuiSelectionPromptMonitor();

  while (!context.terminalSeen) {
    if (params.abortController?.signal.aborted) {
      break;
    }

    if (!context.sessionFilePath) {
      const found = findUpdatedSessionFile(before, params, startedAtMs);
      if (found) {
        context.sessionFilePath = found.filePath;
        context.threadId = found.threadId;
        context.nextOffset = found.startOffset;
        sessionFileDeadline = Date.now() + fileTimeoutMs;
        controller.enqueue(sseEvent('status', { session_id: found.threadId }));
      } else if (Date.now() > sessionFileDeadline) {
        throw new Error('Timed out waiting for Codex TUI session jsonl file.');
      }
    }

    if (context.sessionFilePath) {
      let size = context.nextOffset;
      try {
        size = fs.statSync(context.sessionFilePath).size;
      } catch {
        size = context.nextOffset;
      }
      if (size > context.nextOffset) {
        const delta = readCodexSessionMirrorRecordDeltaByFilePath(
          context.sessionFilePath,
          context.nextOffset,
          size,
          context.trailingText,
          context.nextTurnId,
          context.nextSpecialCallIds,
        );
        context.nextOffset = delta.nextOffset;
        context.trailingText = delta.trailingText;
        context.nextTurnId = delta.nextTurnId;
        context.nextSpecialCallIds = delta.nextSpecialCallIds;
        if (delta.unknownKinds.length > 0) {
          console.warn('[codex-tmux] Unhandled Codex TUI jsonl kinds:', delta.unknownKinds.join(', '));
        }
        for (const record of delta.records) {
          enqueueCodexTuiRecordAsSse(controller, context, record);
        }
      }
    }

    if (context.terminalSeen) break;
    const terminalAlive = await isTerminalAlive();
    if (!terminalAlive) {
      if (!context.hasError) {
        controller.enqueue(sseEvent('result', {
          ...(context.threadId ? { session_id: context.threadId } : {}),
        }));
      }
      break;
    }
    const capture = options.detectTmuxSelectionPrompt
      ? await tmuxCore.capturePane(context.targetPane, 80).catch(() => ({ screen: '', command: '/tmux-screen 80' }))
      : null;
    const stableSelectionPrompt = capture
      ? observeStableCodexTuiSelectionPrompt(capture.screen, selectionPromptMonitor)
      : null;
    if (stableSelectionPrompt) {
      selectionPromptMonitor.pending = true;
      try {
        console.log('[codex-tmux] Stable Codex TUI selection prompt detected during polling; waiting for user selection', {
          prompt_kind: stableSelectionPrompt.kind,
        });
        await resolveStableCodexTuiSelectionPrompt({
          controller,
          pendingPerms: options.pendingPerms,
          provider: 'tmux',
          bridgeSessionId: params.sessionId,
          targetPane: context.targetPane,
          prompt: stableSelectionPrompt,
          screenCommand: '/tmux-screen 80',
        });
      } finally {
        markCodexTuiSelectionPromptActionSent(selectionPromptMonitor);
      }
    }
    await sleep(pollIntervalMs);
  }
}

export function streamCodexTmuxTui(params: StreamChatParams, pendingPerms?: PendingPermissions): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      (async () => {
        const tempFiles: string[] = [];
        const sessionName = tmuxSessionName(params.sessionId);
        const targetPane = `${sessionName}:0.0`;
        const before = snapshotSessionFiles();
        const startedAtMs = Date.now();
        const context: CodexTuiRunContext = {
          sessionName,
          targetPane,
          bridgeSessionId: params.sessionId,
          threadId: params.codexThreadId,
          sessionFilePath: params.codexThreadId ? findSessionFileByThreadId(params.codexThreadId) || undefined : undefined,
          nextOffset: 0,
          trailingText: '',
          nextTurnId: null,
          nextSpecialCallIds: [],
          emittedToolStarts: new Set(),
          emittedRecordSignatures: new Set(),
          lastAssistantText: '',
          terminalSeen: false,
          hasError: false,
        };
        if (context.sessionFilePath) {
          context.nextOffset = before.get(context.sessionFilePath)?.size || 0;
        }

        try {
          const imagePaths = buildTempImageFiles(params, tempFiles);
          let screen = { screen: '', command: '/tmux-screen 80' };
          for (let launchAttempt = 0; launchAttempt < 2; launchAttempt += 1) {
            controller.enqueue(sseEvent('status', { reasoning: params.codexThreadId
              ? '正在启动 Codex tmux，并 resume 当前 Codex thread。'
              : '正在启动 Codex tmux。' }));
            await launchTmuxCodexSession(sessionName, params, imagePaths);
            const promptDelayMs = parsePositiveIntEnv('CODELARK_CODEX_TMUX_PROMPT_DELAY_MS', DEFAULT_TMUX_PROMPT_DELAY_MS, 0);
            if (promptDelayMs > 0) await sleep(promptDelayMs);
            controller.enqueue(sseEvent('status', { reasoning: 'Codex tmux 已启动，正在准备注入本次消息。' }));
            screen = await tmuxCore.capturePane(targetPane, 80).catch(() => ({ screen: '', command: `/tmux-screen 80` }));
            const restartedAfterUpdate = await prepareCodexTmuxUpdatePrompt({
              controller,
              pendingPerms,
              sessionName,
              targetPane,
              bridgeSessionId: params.sessionId,
              screen: screen.screen,
            });
            if (restartedAfterUpdate) {
              if (launchAttempt === 0) continue;
              throw new Error('Codex update finished, but the restarted Codex tmux asked to update again.');
            }
            break;
          }
          if (hasCodexTuiTrustPrompt(screen.screen)) {
            console.log('[codex-tmux] Codex TUI trust prompt detected; waiting for user confirmation before prompt injection');
            await requestCodexTuiTrustConfirmation({
              controller,
              pendingPerms,
              provider: 'tmux',
              bridgeSessionId: params.sessionId,
              workingDirectory: params.workingDirectory,
              screenCommand: '/tmux-screen 80',
            });
            const confirm = await tmuxCore.sendActions(targetPane, [{ type: 'key', key: 'Enter' }]);
            console.log('[codex-tmux] Codex TUI trust prompt confirmed:', { target_pane: targetPane, commands: confirm.commands });
            const afterTrustDelayMs = parsePositiveIntEnv(
              'CODELARK_CODEX_TMUX_AFTER_TRUST_DELAY_MS',
              DEFAULT_TMUX_AFTER_TRUST_DELAY_MS,
              0,
            );
            if (afterTrustDelayMs > 0) await sleep(afterTrustDelayMs);
          }
          controller.enqueue(sseEvent('status', { reasoning: '正在把本次消息发送到 Codex tmux。' }));
          await injectPromptIntoTmuxPane(targetPane, params.prompt);
          await pollCodexTuiSessionFile(
            controller,
            params,
            context,
            before,
            startedAtMs,
            async () => (await tmuxCore.hasSession(context.sessionName)).exists,
            { detectTmuxSelectionPrompt: true, pendingPerms },
          );
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[codex-tmux] Error:', error instanceof Error ? error.stack || error.message : error);
          try {
            controller.enqueue(sseEvent('error', message || 'Codex TUI execution failed.'));
            controller.close();
          } catch {
            // Controller may already be closed.
          }
        } finally {
          for (const tmp of tempFiles) {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          }
          if (!isDebugTmuxKeepAlive()) {
            try { await tmuxCore.killSession(sessionName, { ignoreMissing: true }); } catch { /* best-effort cleanup */ }
          } else {
            console.log(`[codex-tmux] CODELARK_DEBUG is enabled; tmux session kept: ${sessionName}`);
          }
        }
      })();
    },
  });
}

export class CodexTmuxProvider implements LLMProvider {
  constructor(private readonly pendingPerms?: PendingPermissions) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return streamCodexTmuxTui(params, this.pendingPerms);
  }
}
