import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../configuration/paths.js';
import type { AuditLogInput } from '../../domain/audit.js';
import type { ChannelChat } from '../../domain/channel.js';
import type { BridgeMessage } from '../../domain/message.js';
import type { BridgeSession } from '../../domain/session.js';
import { getClaudeSessionJsonlById } from '../../runtime/claude/session-jsonl.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
  getSessionCodexThreadId,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';

interface StoredAuditLogEntry extends AuditLogInput {
  id?: string;
  createdAt?: string;
}

export interface RealE2eDumpInput {
  codelarkHome?: string;
  claudeHome?: string;
  channelType?: string;
  chatId?: string;
  bridgeSessionId?: string;
  runId?: string;
  messageId?: string;
  logTailBytes?: number;
  messageLimit?: number;
  auditLimit?: number;
}

export interface RealE2eDumpCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RealE2eStreamCardCheckpoint {
  kind: 'create' | 'refresh' | 'final' | string;
  streamKey: string;
  chatId?: string;
  cardId?: string;
  elementId?: string;
  status?: string;
  sequence?: number;
  preview?: string;
  elementIds?: string[];
  names?: string[];
  markdownTexts?: string[];
  markdownPreviews?: Array<{ elementId?: string; preview: string }>;
}

export interface BasicDialogueStreamCardCheckpointPhase {
  providerKey: string;
  marker: string;
}

export interface RealE2eDumpReport {
  runId?: string;
  channelType?: string;
  chatId?: string;
  bridgeSessionId?: string;
  binding?: ChannelChat;
  session?: BridgeSession;
  runtime?: 'codex' | 'claude';
  runtimeThreadId?: string;
  workingDirectory?: string;
  claudeSessionId?: string;
  claudeJsonlPath?: string;
  messages: BridgeMessage[];
  audit: StoredAuditLogEntry[];
  streamKeys: string[];
  responseMessageIds: string[];
  streamCardCheckpoints: RealE2eStreamCardCheckpoint[];
  logWindow: {
    path: string;
    fromOffset: number;
    toOffset: number;
    text: string;
  } | null;
  checks: RealE2eDumpCheck[];
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function readJsonlFile<T>(filePath: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const rows: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // Ignore malformed partial lines in diagnostic dumps.
    }
  }
  return rows;
}

function asRecord<T>(value: unknown): Record<string, T> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, T>
    : {};
}

function includesNeedle(value: unknown, needle: string | undefined): boolean {
  if (!needle) return false;
  try {
    return JSON.stringify(value).includes(needle);
  } catch {
    return false;
  }
}

function readLogTail(filePath: string, maxBytes: number): RealE2eDumpReport['logWindow'] {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const bytes = Math.max(0, Math.min(maxBytes, size));
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const fromOffset = size - bytes;
      fs.readSync(fd, buffer, 0, bytes, fromOffset);
      return {
        path: filePath,
        fromOffset,
        toOffset: size,
        text: buffer.toString('utf-8'),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function findBinding(bindings: ChannelChat[], input: RealE2eDumpInput): ChannelChat | undefined {
  if (input.channelType && input.chatId) {
    const exact = bindings.find((binding) => (
      binding.channelType === input.channelType && binding.chatId === input.chatId
    ));
    if (exact) return exact;
  }
  if (input.chatId) {
    const byChat = bindings.find((binding) => binding.chatId === input.chatId);
    if (byChat) return byChat;
  }
  if (input.bridgeSessionId) {
    const bySession = bindings.find((binding) => binding.bridgeSessionId === input.bridgeSessionId);
    if (bySession) return bySession;
  }
  return undefined;
}

function findSession(
  sessions: Record<string, BridgeSession>,
  binding: ChannelChat | undefined,
  input: RealE2eDumpInput,
): BridgeSession | undefined {
  if (input.bridgeSessionId && sessions[input.bridgeSessionId]) return sessions[input.bridgeSessionId];
  if (binding?.bridgeSessionId && sessions[binding.bridgeSessionId]) return sessions[binding.bridgeSessionId];
  if (input.runId) {
    return Object.values(sessions).find((session) => (
      includesNeedle(session.name, input.runId) || includesNeedle(session, input.runId)
    ));
  }
  return undefined;
}

function extractStreamKeys(text: string): string[] {
  return Array.from(new Set(
    Array.from(text.matchAll(/streamKey\s*[=:]\s*'?([A-Za-z0-9:_-]+)/g)).map((match) => match[1])
      .concat(Array.from(text.matchAll(/streamKey=([A-Za-z0-9:_-]+)/g)).map((match) => match[1])),
  ));
}

function extractResponseMessageIds(text: string): string[] {
  return Array.from(new Set(
    Array.from(text.matchAll(/message_id=([A-Za-z0-9_-]+)/g)).map((match) => match[1])
      .concat(Array.from(text.matchAll(/messageId: '([^']+)'/g)).map((match) => match[1])),
  ));
}

const STREAM_CARD_CHECKPOINT_PREFIX = '[real-feishu-e2e:stream-card-checkpoint] ';

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function extractStreamCardCheckpoints(text: string): RealE2eStreamCardCheckpoint[] {
  const checkpoints: RealE2eStreamCardCheckpoint[] = [];
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(STREAM_CARD_CHECKPOINT_PREFIX);
    if (index < 0) continue;
    const jsonText = line.slice(index + STREAM_CARD_CHECKPOINT_PREFIX.length).trim();
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      if (typeof parsed.streamKey !== 'string' || typeof parsed.kind !== 'string') continue;
      checkpoints.push({
        kind: parsed.kind,
        streamKey: parsed.streamKey,
        ...(typeof parsed.chatId === 'string' ? { chatId: parsed.chatId } : {}),
        ...(typeof parsed.cardId === 'string' ? { cardId: parsed.cardId } : {}),
        ...(typeof parsed.elementId === 'string' ? { elementId: parsed.elementId } : {}),
        ...(typeof parsed.status === 'string' ? { status: parsed.status } : {}),
        ...(typeof parsed.sequence === 'number' ? { sequence: parsed.sequence } : {}),
        ...(typeof parsed.preview === 'string' ? { preview: parsed.preview } : {}),
        ...(asStringArray(parsed.elementIds) ? { elementIds: asStringArray(parsed.elementIds) } : {}),
        ...(asStringArray(parsed.names) ? { names: asStringArray(parsed.names) } : {}),
        ...(asStringArray(parsed.markdownTexts) ? { markdownTexts: asStringArray(parsed.markdownTexts) } : {}),
        ...(Array.isArray(parsed.markdownPreviews)
          ? { markdownPreviews: parsed.markdownPreviews as Array<{ elementId?: string; preview: string }> }
          : {}),
      });
    } catch {
      // Ignore malformed diagnostic lines; the primary dump must stay best-effort.
    }
  }
  return checkpoints;
}

export function streamCardCheckpointVisibleText(checkpoint: Pick<
  RealE2eStreamCardCheckpoint,
  'preview' | 'names' | 'markdownTexts' | 'markdownPreviews'
>): string {
  return [
    checkpoint.preview || '',
    ...(checkpoint.names || []),
    ...(checkpoint.markdownTexts || []),
    ...(checkpoint.markdownPreviews || []).map((item) => item.preview || ''),
  ].join('\n');
}

function streamCardCheckpointIncludes(checkpoints: RealE2eStreamCardCheckpoint[], text: string): boolean {
  return checkpoints.some((checkpoint) => streamCardCheckpointVisibleText(checkpoint).includes(text));
}

export function basicDialogueStreamCardCheckpointIssues(
  checkpoints: RealE2eStreamCardCheckpoint[],
  phases: BasicDialogueStreamCardCheckpointPhase[],
): string[] {
  const issues: string[] = [];
  if (checkpoints.length === 0) {
    return ['No structured stream-card checkpoints were emitted by the isolated bridge.'];
  }
  for (const phase of phases) {
    const phaseCheckpoints = checkpoints.filter((checkpoint) => {
      const visibleText = streamCardCheckpointVisibleText(checkpoint);
      return visibleText.includes(phase.marker) || visibleText.includes(phase.providerKey);
    });
    if (phaseCheckpoints.length === 0) {
      issues.push(`${phase.providerKey}: no stream-card checkpoint contained the phase marker or provider key.`);
      continue;
    }
    const requiredTexts = [
      phase.marker,
      `provider preload complete: ${phase.providerKey}`,
      `${phase.providerKey} partial text`,
      `Goal Active: ${phase.providerKey} provider isolation`,
      `running representative tool: ${phase.providerKey}`,
      'Bash',
      'Context:',
    ];
    for (const text of requiredTexts) {
      if (!streamCardCheckpointIncludes(phaseCheckpoints, text)) {
        issues.push(`${phase.providerKey}: missing stream-card checkpoint text ${JSON.stringify(text)}.`);
      }
    }
    const completed = phaseCheckpoints.some((checkpoint) => (
      checkpoint.kind === 'final'
        && checkpoint.status === 'completed'
        && streamCardCheckpointVisibleText(checkpoint).includes(phase.marker)
    ));
    if (!completed) {
      issues.push(`${phase.providerKey}: no completed final card checkpoint contained ${phase.marker}.`);
    }
  }
  return issues;
}

function logLinesWithNeedles(text: string, needles: string[]): string {
  const relevantNeedles = needles.filter((needle) => needle.trim());
  if (relevantNeedles.length === 0) return text;
  const lines = text.split(/\r?\n/).filter((line) => (
    relevantNeedles.some((needle) => line.includes(needle))
  ));
  return lines.length > 0 ? lines.join('\n') : text;
}

export function collectRealE2eDump(input: RealE2eDumpInput = {}): RealE2eDumpReport {
  const codelarkHome = input.codelarkHome || CODELARK_HOME;
  const dataDir = path.join(codelarkHome, 'data');
  const logsDir = path.join(codelarkHome, 'logs');
  const sessions = asRecord<BridgeSession>(readJsonFile(path.join(dataDir, 'sessions.json'), {}));
  const bindings = Object.values(asRecord<ChannelChat>(readJsonFile(path.join(dataDir, 'channel-chats.json'), {})));
  const audit = [
    ...readJsonFile<StoredAuditLogEntry[]>(path.join(dataDir, 'audit.json'), []),
    ...readJsonlFile<StoredAuditLogEntry>(path.join(dataDir, 'audit.jsonl')),
  ];
  const binding = findBinding(bindings, input);
  const session = findSession(sessions, binding, input);
  const bridgeSessionId = input.bridgeSessionId || binding?.bridgeSessionId || session?.id;
  const messages = bridgeSessionId
    ? [
        ...readJsonFile<BridgeMessage[]>(path.join(dataDir, 'messages', `${bridgeSessionId}.json`), []),
        ...readJsonlFile<BridgeMessage>(path.join(dataDir, 'messages', `${bridgeSessionId}.jsonl`)),
      ]
    : [];
  const activeRuntime = getSessionActiveRuntime(session);
  const inferredRuntime = activeRuntime
    || (getSessionClaudeSessionId(session) ? 'claude' : getSessionCodexThreadId(session) ? 'codex' : undefined);
  const runtime = inferredRuntime;
  const runtimeThreadId = runtime === 'claude'
    ? getSessionClaudeSessionId(session)
    : getSessionCodexThreadId(session);
  const claudeSessionId = runtime === 'claude' ? getSessionClaudeSessionId(session) : undefined;
  const claudeCwd = runtime === 'claude'
    ? getSessionClaudeCwd(session) || getSessionWorkingDirectory(session)
    : undefined;
  const claudeJsonl = claudeSessionId && claudeCwd
    ? getClaudeSessionJsonlById(claudeSessionId, claudeCwd, input.claudeHome)
    : null;
  const auditNeedles = [
    input.runId,
    input.messageId,
    input.chatId,
    bridgeSessionId,
  ].filter((value): value is string => Boolean(value));
  const relevantAudit = auditNeedles.length > 0
    ? audit.filter((entry) => auditNeedles.some((needle) => includesNeedle(entry, needle)))
    : audit;
  const auditLimit = Math.max(1, Math.floor(input.auditLimit || 50));
  const messageLimit = Math.max(1, Math.floor(input.messageLimit || 50));
  const logWindow = readLogTail(path.join(logsDir, 'bridge.log'), Math.max(1, Math.floor(input.logTailBytes || 64_000)));
  const logText = logWindow?.text || '';
  const relevantLogText = logLinesWithNeedles(logText, [
    input.runId,
    input.messageId,
    input.chatId,
    bridgeSessionId,
  ].filter((value): value is string => Boolean(value)));
  const streamKeys = extractStreamKeys(relevantLogText);
  const responseMessageIds = extractResponseMessageIds(relevantLogText);
  const streamCardCheckpoints = extractStreamCardCheckpoints(relevantLogText);
  const checks: RealE2eDumpCheck[] = [
    {
      name: 'binding_found',
      ok: Boolean(binding),
      detail: binding ? binding.id : 'No channel binding matched the dump input.',
    },
    {
      name: 'session_found',
      ok: Boolean(session),
      detail: session ? session.id : 'No BridgeSession matched the dump input.',
    },
    {
      name: 'runtime_identity_bound',
      ok: runtime === 'codex' ? Boolean(runtimeThreadId) : runtime === 'claude' ? Boolean(claudeSessionId) : false,
      detail: runtimeThreadId || 'No local runtime identity is bound.',
    },
    {
      name: 'messages_present',
      ok: messages.length > 0,
      detail: `${messages.length} stored bridge messages`,
    },
    {
      name: 'audit_present',
      ok: relevantAudit.length > 0,
      detail: `${relevantAudit.length} relevant audit entries`,
    },
  ];
  if (runtime === 'claude') {
    checks.push({
      name: 'claude_jsonl_found',
      ok: Boolean(claudeJsonl?.filePath),
      detail: claudeJsonl?.filePath || 'No Claude JSONL transcript matched the bound session id/cwd.',
    });
  }
  return {
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.channelType || binding?.channelType ? { channelType: input.channelType || binding?.channelType } : {}),
    ...(input.chatId || binding?.chatId ? { chatId: input.chatId || binding?.chatId } : {}),
    ...(bridgeSessionId ? { bridgeSessionId } : {}),
    ...(binding ? { binding } : {}),
    ...(session ? { session } : {}),
    ...(runtime ? { runtime } : {}),
    ...(runtimeThreadId ? { runtimeThreadId } : {}),
    ...(getSessionWorkingDirectory(session) ? { workingDirectory: getSessionWorkingDirectory(session) } : {}),
    ...(claudeSessionId ? { claudeSessionId } : {}),
    ...(claudeJsonl?.filePath ? { claudeJsonlPath: claudeJsonl.filePath } : {}),
    messages: messages.slice(-messageLimit),
    audit: relevantAudit.slice(-auditLimit),
    streamKeys,
    responseMessageIds,
    streamCardCheckpoints,
    logWindow,
    checks,
  };
}
