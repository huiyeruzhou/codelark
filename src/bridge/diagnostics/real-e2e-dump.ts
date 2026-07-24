import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../configuration/paths.js';
import type { AuditLogInput } from '../../domain/audit.js';
import type { ChannelChat } from '../../domain/channel.js';
import type { BridgeMessage } from '../../domain/message.js';
import type { BridgeSession, RuntimeAgent } from '../../domain/session.js';
import { getClaudeSessionJsonlById } from '../../runtime/claude/session-jsonl.js';
import { findKimiSessionFileById, readKimiSessionMessagesByFilePath } from '../../runtime/kimi/session-index.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
  getSessionCodexThreadId,
  getSessionKimiCwd,
  getSessionKimiSessionId,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';

interface StoredAuditLogEntry extends AuditLogInput {
  id?: string;
  createdAt?: string;
}

export interface RealE2eDumpInput {
  codelarkHome?: string;
  claudeHome?: string;
  kimiHome?: string;
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
  toolPanels?: Array<{
    elementId: string;
    title: string;
    detailChars: number;
    detailLines: number;
    nestedPanelCount: number;
    fences: Array<{ language: string; chars: number; lines: number; closed: boolean }>;
    forbiddenEnvelopeTexts: string[];
  }>;
}

export interface BasicDialogueStreamCardCheckpointPhase {
  providerKey: string;
  marker: string;
  requiredTexts?: string[];
}

export interface KimiThinkingStatusOnlyPhase {
  providerKey: string;
  marker: string;
  thinkingText: string;
}

export interface ScriptedKimiResumeAndSteerAuditInput {
  kimiHome: string;
  sessionId: string;
  cwd?: string;
}

export interface ScriptedKimiRuntimeSlotAuditInput {
  report: Pick<RealE2eDumpReport, 'binding' | 'runtimeSlots'>;
  sessionId: string;
  cwd?: string;
}

export interface ScriptedKimiWireTranscriptAuditInput {
  report: Pick<RealE2eDumpReport, 'binding' | 'runtimeSlots'>;
  marker: string;
  thinkingText: string;
}

export interface ScriptedKimiHistoryTranscriptAuditInput {
  report: Pick<RealE2eDumpReport, 'binding' | 'runtimeSlots'>;
  marker: string;
  thinkingText: string;
}

export interface RealE2eRuntimeSlotReport {
  runtime: RuntimeAgent;
  bridgeSessionId: string;
  session?: BridgeSession;
  runtimeThreadId?: string;
  workingDirectory?: string;
  claudeSessionId?: string;
  claudeJsonlPath?: string;
  kimiSessionId?: string;
  kimiCwd?: string;
  kimiWireJsonlPath?: string;
}

export interface RealE2eDumpReport {
  runId?: string;
  channelType?: string;
  chatId?: string;
  bridgeSessionId?: string;
  binding?: ChannelChat;
  session?: BridgeSession;
  runtimeSlots: RealE2eRuntimeSlotReport[];
  runtime?: RuntimeAgent;
  runtimeThreadId?: string;
  workingDirectory?: string;
  claudeSessionId?: string;
  claudeJsonlPath?: string;
  kimiSessionId?: string;
  kimiWireJsonlPath?: string;
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

function withTemporaryEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  if (!value) return fn();
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
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
    let message = line;
    try {
      const structured = JSON.parse(line) as { msg?: unknown };
      if (typeof structured.msg === 'string') message = structured.msg;
    } catch {
      // Plain bridge logs are supported alongside structured JSON logs.
    }
    const index = message.indexOf(STREAM_CARD_CHECKPOINT_PREFIX);
    if (index < 0) continue;
    const jsonText = message.slice(index + STREAM_CARD_CHECKPOINT_PREFIX.length).trim();
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
        ...(Array.isArray(parsed.toolPanels)
          ? { toolPanels: parsed.toolPanels as RealE2eStreamCardCheckpoint['toolPanels'] }
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
      ...(phase.requiredTexts || []),
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

export function scriptedKimiToolCardIssues(
  checkpoints: RealE2eStreamCardCheckpoint[],
  phase: { providerKey: string; marker: string },
): string[] {
  const issues: string[] = [];
  const finalCheckpoint = checkpoints.find((checkpoint) => (
    checkpoint.kind === 'final'
    && checkpoint.status === 'completed'
    && (streamCardCheckpointVisibleText(checkpoint).includes(phase.marker)
      || streamCardCheckpointVisibleText(checkpoint).includes(phase.providerKey))
  ));
  if (!finalCheckpoint) return [`${phase.providerKey}: no completed final checkpoint was available for tool-card audit.`];

  const panels = finalCheckpoint.toolPanels || [];
  if (panels.length < 4) issues.push(`${phase.providerKey}: expected at least 4 inner tool panels, got ${panels.length}.`);
  for (const action of ['读取', '搜索', '修改', '运行']) {
    if (!panels.some((panel) => panel.title.includes(action))) {
      issues.push(`${phase.providerKey}: no tool title contained ${JSON.stringify(action)}.`);
    }
  }
  for (const panel of panels) {
    if (panel.title.includes('\n')) {
      issues.push(`${phase.providerKey}: ${panel.elementId} title contains an explicit newline.`);
    }
    if (/\b(?:Success|Completed)\b|完成/u.test(panel.title)) {
      issues.push(`${phase.providerKey}: ${panel.elementId} repeated success state in its title.`);
    }
    if (panel.nestedPanelCount > 0) {
      issues.push(`${phase.providerKey}: ${panel.elementId} contains ${panel.nestedPanelCount} nested collapsible panels.`);
    }
    if (panel.forbiddenEnvelopeTexts.length > 0) {
      issues.push(`${phase.providerKey}: ${panel.elementId} leaked ${panel.forbiddenEnvelopeTexts.join(', ')}.`);
    }
    if ((panel.title.includes('读取') || panel.title.includes('搜索')) && panel.fences.length > 0) {
      issues.push(`${phase.providerKey}: ${panel.elementId} displayed ordinary tool output.`);
    }
    if (panel.title.includes('运行') && panel.fences.some((fence) => fence.language === 'text')) {
      issues.push(`${phase.providerKey}: ${panel.elementId} displayed command output.`);
    }
    for (const fence of panel.fences) {
      if (!fence.closed) issues.push(`${phase.providerKey}: ${panel.elementId} contains an unclosed ${fence.language || 'plain'} fence.`);
      if (fence.chars > 8_000) issues.push(`${phase.providerKey}: ${panel.elementId} fence exceeded 8000 characters.`);
      if (fence.lines > 160) issues.push(`${phase.providerKey}: ${panel.elementId} fence exceeded 160 lines.`);
    }
  }

  const diffFence = panels.flatMap((panel) => panel.fences).find((fence) => fence.language === 'diff');
  if (!diffFence) {
    issues.push(`${phase.providerKey}: no diff fence was present in the final tool card.`);
  } else if (diffFence.lines !== 160) {
    issues.push(`${phase.providerKey}: scripted long patch should exercise the 160-line cap, got ${diffFence.lines} lines.`);
  }
  if (!panels.some((panel) => panel.fences.some((fence) => fence.language === 'bash'))) {
    issues.push(`${phase.providerKey}: no bash command fence was present in the final tool card.`);
  }
  return issues;
}

export function kimiThinkingStatusOnlyIssues(
  checkpoints: RealE2eStreamCardCheckpoint[],
  phase: KimiThinkingStatusOnlyPhase,
): string[] {
  const phaseCheckpoints = checkpoints.filter((checkpoint) => {
    const visibleText = streamCardCheckpointVisibleText(checkpoint);
    return visibleText.includes(phase.marker) || visibleText.includes(phase.providerKey);
  });
  if (phaseCheckpoints.length === 0) {
    return [`${phase.providerKey}: no stream-card checkpoint contained the phase marker or provider key.`];
  }
  const thinkingNeedles = ['当前思考', phase.thinkingText];
  const streamingThinking = phaseCheckpoints.some((checkpoint) => (
    checkpoint.kind !== 'final'
      && checkpoint.status !== 'completed'
      && thinkingNeedles.every((needle) => streamCardCheckpointVisibleText(checkpoint).includes(needle))
  ));
  const issues: string[] = [];
  if (!streamingThinking) {
    issues.push(`${phase.providerKey}: no non-final stream-card checkpoint showed Kimi thinking in the status area.`);
  }
  const finalThinkingLeak = phaseCheckpoints.find((checkpoint) => (
    checkpoint.kind === 'final'
      && checkpoint.status === 'completed'
      && thinkingNeedles.some((needle) => streamCardCheckpointVisibleText(checkpoint).includes(needle))
  ));
  if (finalThinkingLeak) {
    issues.push(`${phase.providerKey}: completed final card leaked Kimi thinking text into the final answer.`);
  }
  return issues;
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function countHexByte(rawHexLines: string, byte: number): number {
  const expected = byte.toString(16).padStart(2, '0');
  let count = 0;
  for (const line of rawHexLines.split(/\r?\n/)) {
    const bytes = line.toLowerCase().match(/[0-9a-f]{2}/g) || [];
    count += bytes.filter((item) => item === expected).length;
  }
  return count;
}

export function scriptedKimiResumeAndSteerIssues(input: ScriptedKimiResumeAndSteerAuditInput): string[] {
  const issues: string[] = [];
  const launchLogPath = path.join(input.kimiHome, 'scripted-kimi-launches.jsonl');
  const keyLogPath = path.join(input.kimiHome, 'scripted-kimi-keys.log');
  const launches = readJsonlFile<{ argv?: unknown; resumed?: unknown; cwd?: unknown }>(launchLogPath);
  if (launches.length === 0) {
    issues.push(`No scripted Kimi launch records found at ${launchLogPath}.`);
  }
  const freshLaunch = launches.find((launch) => launch.resumed === false);
  if (!freshLaunch) {
    issues.push('Scripted Kimi did not record an initial fresh launch before resume.');
  }
  const resumedLaunch = launches.find((launch) => (
    launch.resumed === true
      && Array.isArray(launch.argv)
      && launch.argv[0] === '-r'
      && launch.argv[1] === input.sessionId
  ));
  if (!resumedLaunch) {
    issues.push(`Scripted Kimi did not resume with "kimi -r ${input.sessionId}".`);
  }
  if (input.cwd && launches.length > 0 && !launches.some((launch) => launch.cwd === input.cwd)) {
    issues.push(`Scripted Kimi launch cwd never matched ${input.cwd}.`);
  }

  const keyLog = readTextFile(keyLogPath);
  if (keyLog == null) {
    issues.push(`No scripted Kimi key log found at ${keyLogPath}.`);
    return issues;
  }
  const ctrlCCount = countHexByte(keyLog, 0x03);
  if (ctrlCCount < 2) {
    issues.push(`Scripted Kimi expected at least two Ctrl-C bytes before resume hint; observed ${ctrlCCount}.`);
  }
  const ctrlSCount = countHexByte(keyLog, 0x13);
  if (ctrlSCount < 1) {
    issues.push('Scripted Kimi did not observe Ctrl-S steer after prompt delivery.');
  }
  return issues;
}

export function scriptedKimiRuntimeSlotIssues(input: ScriptedKimiRuntimeSlotAuditInput): string[] {
  const issues: string[] = [];
  const kimiBridgeSessionId = input.report.binding?.runtimeBridgeSessionIds?.kimi;
  if (!kimiBridgeSessionId) {
    issues.push('ChannelChat did not retain a kimi runtimeBridgeSessionIds slot.');
    return issues;
  }
  const slot = input.report.runtimeSlots.find((item) => (
    item.runtime === 'kimi' && item.bridgeSessionId === kimiBridgeSessionId
  ));
  if (!slot) {
    issues.push(`No dump runtime slot was collected for kimi BridgeSession ${kimiBridgeSessionId}.`);
    return issues;
  }
  if (slot.session?.runtime?.activeRuntime !== 'kimi') {
    issues.push(`Kimi runtime slot ${kimiBridgeSessionId} does not point to an active Kimi BridgeSession.`);
  }
  if (slot.kimiSessionId !== input.sessionId) {
    issues.push(`Kimi runtime slot expected session id ${input.sessionId}; observed ${slot.kimiSessionId || 'none'}.`);
  }
  if (input.cwd && slot.kimiCwd !== input.cwd) {
    issues.push(`Kimi runtime slot expected cwd ${input.cwd}; observed ${slot.kimiCwd || 'none'}.`);
  }
  if (!slot.kimiWireJsonlPath) {
    issues.push(`Kimi runtime slot ${kimiBridgeSessionId} did not resolve a Kimi wire.jsonl transcript.`);
  }
  return issues;
}

export function scriptedKimiWireTranscriptIssues(input: ScriptedKimiWireTranscriptAuditInput): string[] {
  const issues: string[] = [];
  const kimiBridgeSessionId = input.report.binding?.runtimeBridgeSessionIds?.kimi;
  const slot = input.report.runtimeSlots.find((item) => (
    item.runtime === 'kimi' && (!kimiBridgeSessionId || item.bridgeSessionId === kimiBridgeSessionId)
  ));
  if (!slot) {
    issues.push(kimiBridgeSessionId
      ? `No dump runtime slot was collected for kimi BridgeSession ${kimiBridgeSessionId}.`
      : 'ChannelChat did not retain a kimi runtimeBridgeSessionIds slot.');
    return issues;
  }
  if (!slot.kimiWireJsonlPath) {
    issues.push(`Kimi runtime slot ${slot.bridgeSessionId} did not resolve a Kimi wire.jsonl transcript.`);
    return issues;
  }
  const rows = readJsonlFile<Record<string, unknown>>(slot.kimiWireJsonlPath);
  if (rows.length === 0) {
    issues.push(`No Kimi wire transcript records found at ${slot.kimiWireJsonlPath}.`);
    return issues;
  }
  const contentParts = rows
    .map((row) => {
      const event = asRecord<unknown>(row.event);
      const part = asRecord<unknown>(event.part);
      return { event, part };
    })
    .filter(({ event }) => event.type === 'content.part');
  const hasThinking = contentParts.some(({ part }) => (
    part.type === 'think'
      && typeof part.think === 'string'
      && part.think.includes(input.thinkingText)
  ));
  if (!hasThinking) {
    issues.push(`Kimi wire transcript did not contain scripted thinking text ${JSON.stringify(input.thinkingText)}.`);
  }
  const hasMarkerText = contentParts.some(({ part }) => (
    part.type === 'text'
      && typeof part.text === 'string'
      && part.text.includes(input.marker)
  ));
  if (!hasMarkerText) {
    issues.push(`Kimi wire transcript did not contain scripted marker text ${JSON.stringify(input.marker)}.`);
  }
  const hasStepEnd = rows.some((row) => asRecord<unknown>(row.event).type === 'step.end');
  if (!hasStepEnd) {
    issues.push('Kimi wire transcript did not contain a step.end event for the scripted turn.');
  }
  return issues;
}

export function scriptedKimiHistoryTranscriptIssues(input: ScriptedKimiHistoryTranscriptAuditInput): string[] {
  const issues: string[] = [];
  const kimiBridgeSessionId = input.report.binding?.runtimeBridgeSessionIds?.kimi;
  const slot = input.report.runtimeSlots.find((item) => (
    item.runtime === 'kimi' && (!kimiBridgeSessionId || item.bridgeSessionId === kimiBridgeSessionId)
  ));
  if (!slot) {
    issues.push(kimiBridgeSessionId
      ? `No dump runtime slot was collected for kimi BridgeSession ${kimiBridgeSessionId}.`
      : 'ChannelChat did not retain a kimi runtimeBridgeSessionIds slot.');
    return issues;
  }
  if (!slot.kimiWireJsonlPath) {
    issues.push(`Kimi runtime slot ${slot.bridgeSessionId} did not resolve a Kimi wire.jsonl transcript.`);
    return issues;
  }
  const messages = readKimiSessionMessagesByFilePath(slot.kimiWireJsonlPath, 20);
  const transcriptText = messages.map((message) => message.content).join('\n');
  if (!transcriptText.includes(input.marker)) {
    issues.push(`Kimi history transcript did not contain scripted marker text ${JSON.stringify(input.marker)}.`);
  }
  const forbiddenThinking = ['当前思考', input.thinkingText].filter(Boolean);
  for (const text of forbiddenThinking) {
    if (transcriptText.includes(text)) {
      issues.push(`Kimi history transcript leaked thinking text ${JSON.stringify(text)}.`);
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
  const runtimeSlots = (['codex', 'claude', 'kimi'] as const)
    .map((slotRuntime): RealE2eRuntimeSlotReport | null => {
      const slotBridgeSessionId = binding?.runtimeBridgeSessionIds?.[slotRuntime];
      if (!slotBridgeSessionId) return null;
      const slotSession = sessions[slotBridgeSessionId];
      const slotActiveRuntime = getSessionActiveRuntime(slotSession);
      const slotRuntimeThreadId = slotRuntime === 'claude'
        ? getSessionClaudeSessionId(slotSession)
        : slotRuntime === 'kimi'
          ? getSessionKimiSessionId(slotSession)
          : getSessionCodexThreadId(slotSession);
      const slotClaudeSessionId = slotRuntime === 'claude' ? getSessionClaudeSessionId(slotSession) : undefined;
      const slotClaudeCwd = slotRuntime === 'claude'
        ? getSessionClaudeCwd(slotSession) || getSessionWorkingDirectory(slotSession)
        : undefined;
      const slotClaudeJsonl = slotClaudeSessionId && slotClaudeCwd
        ? getClaudeSessionJsonlById(slotClaudeSessionId, slotClaudeCwd, input.claudeHome)
        : null;
      const slotKimiSessionId = slotRuntime === 'kimi' ? getSessionKimiSessionId(slotSession) : undefined;
      const slotKimiCwd = slotRuntime === 'kimi'
        ? getSessionKimiCwd(slotSession) || getSessionWorkingDirectory(slotSession)
        : undefined;
      const slotKimiWireJsonl = slotKimiSessionId
        ? withTemporaryEnv('KIMI_CODE_HOME', input.kimiHome, () => findKimiSessionFileById(slotKimiSessionId, slotKimiCwd))
        : null;
      return {
        runtime: slotRuntime,
        bridgeSessionId: slotBridgeSessionId,
        ...(slotSession ? { session: slotSession } : {}),
        ...(slotRuntimeThreadId ? { runtimeThreadId: slotRuntimeThreadId } : {}),
        ...(slotActiveRuntime === slotRuntime && getSessionWorkingDirectory(slotSession)
          ? { workingDirectory: getSessionWorkingDirectory(slotSession) }
          : {}),
        ...(slotClaudeSessionId ? { claudeSessionId: slotClaudeSessionId } : {}),
        ...(slotClaudeJsonl?.filePath ? { claudeJsonlPath: slotClaudeJsonl.filePath } : {}),
        ...(slotKimiSessionId ? { kimiSessionId: slotKimiSessionId } : {}),
        ...(slotKimiCwd ? { kimiCwd: slotKimiCwd } : {}),
        ...(slotKimiWireJsonl?.filePath ? { kimiWireJsonlPath: slotKimiWireJsonl.filePath } : {}),
      };
    })
    .filter((slot): slot is RealE2eRuntimeSlotReport => slot !== null);
  const messages = bridgeSessionId
    ? [
        ...readJsonFile<BridgeMessage[]>(path.join(dataDir, 'messages', `${bridgeSessionId}.json`), []),
        ...readJsonlFile<BridgeMessage>(path.join(dataDir, 'messages', `${bridgeSessionId}.jsonl`)),
      ]
    : [];
  const activeRuntime = getSessionActiveRuntime(session);
  const inferredRuntime = activeRuntime
    || (getSessionKimiSessionId(session) ? 'kimi' : getSessionClaudeSessionId(session) ? 'claude' : getSessionCodexThreadId(session) ? 'codex' : undefined);
  const runtime = inferredRuntime;
  const runtimeThreadId = runtime === 'claude'
    ? getSessionClaudeSessionId(session)
    : runtime === 'kimi'
      ? getSessionKimiSessionId(session)
      : getSessionCodexThreadId(session);
  const claudeSessionId = runtime === 'claude' ? getSessionClaudeSessionId(session) : undefined;
  const claudeCwd = runtime === 'claude'
    ? getSessionClaudeCwd(session) || getSessionWorkingDirectory(session)
    : undefined;
  const claudeJsonl = claudeSessionId && claudeCwd
    ? getClaudeSessionJsonlById(claudeSessionId, claudeCwd, input.claudeHome)
    : null;
  const kimiSessionId = runtime === 'kimi' ? getSessionKimiSessionId(session) : undefined;
  const kimiCwd = runtime === 'kimi'
    ? getSessionKimiCwd(session) || getSessionWorkingDirectory(session)
    : undefined;
  const kimiWireJsonl = kimiSessionId
    ? withTemporaryEnv('KIMI_CODE_HOME', input.kimiHome, () => findKimiSessionFileById(kimiSessionId, kimiCwd))
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
      ok: runtime === 'codex'
        ? Boolean(runtimeThreadId)
        : runtime === 'claude'
          ? Boolean(claudeSessionId)
          : runtime === 'kimi'
            ? Boolean(kimiSessionId)
            : false,
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
  if (runtime === 'kimi') {
    checks.push({
      name: 'kimi_wire_jsonl_found',
      ok: Boolean(kimiWireJsonl?.filePath),
      detail: kimiWireJsonl?.filePath || 'No Kimi wire.jsonl transcript matched the bound session id/cwd.',
    });
  }
  return {
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.channelType || binding?.channelType ? { channelType: input.channelType || binding?.channelType } : {}),
    ...(input.chatId || binding?.chatId ? { chatId: input.chatId || binding?.chatId } : {}),
    ...(bridgeSessionId ? { bridgeSessionId } : {}),
    ...(binding ? { binding } : {}),
    ...(session ? { session } : {}),
    runtimeSlots,
    ...(runtime ? { runtime } : {}),
    ...(runtimeThreadId ? { runtimeThreadId } : {}),
    ...(getSessionWorkingDirectory(session) ? { workingDirectory: getSessionWorkingDirectory(session) } : {}),
    ...(claudeSessionId ? { claudeSessionId } : {}),
    ...(claudeJsonl?.filePath ? { claudeJsonlPath: claudeJsonl.filePath } : {}),
    ...(kimiSessionId ? { kimiSessionId } : {}),
    ...(kimiWireJsonl?.filePath ? { kimiWireJsonlPath: kimiWireJsonl.filePath } : {}),
    messages: messages.slice(-messageLimit),
    audit: relevantAudit.slice(-auditLimit),
    streamKeys,
    responseMessageIds,
    streamCardCheckpoints,
    logWindow,
    checks,
  };
}
