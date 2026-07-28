import MarkdownIt from 'markdown-it';

import { createConfigService } from '../../configuration/service.js';
import type { ConfigPatch } from '../../configuration/schema.js';
import {
  SessionDisplayQuery,
  buildBridgeSessionDisplaySummary,
  buildCodexThreadDisplaySummary,
  findVisibleBridgeSessionByCodexThread,
  getBridgeSessionCodexThreadId,
  getBridgeSessionDisplayTitle,
  type SessionDisplayListPayload,
  type SessionDisplaySummary,
} from '../../bridge/session/display/session-display-query.js';
import { stripLegacySessionPrefix } from '../../bridge/session/display/session-title.js';
import type { ChannelChat } from '../../domain/channel.js';
import type { BridgeSession, BridgeSessionUpdate, RuntimeAgent } from '../../domain/session.js';
import type { ConfigPath } from '../../configuration/fields.js';
import {
  resolveSessionTranscriptFile,
  type SessionTranscriptHistoryEntry,
} from '../../bridge/session/transcript-source.js';
import {
  getSessionActiveRuntime,
  getSessionCodexTitle,
  getSessionSystemPrompt,
  getSessionWorkingDirectory,
  mergeSessionRuntimeUpdates,
  setSessionSystemPromptUpdate,
} from '../../domain/session-runtime.js';
import type { JsonFileStore } from '../../storage/json-store.js';
import {
  createUiSessionRegistry,
  createUiSessionRuntimeSource,
  defaultUiSessionCodexSource,
  defaultUiSessionClaudeSource,
  defaultUiSessionKimiSource,
  defaultUiSessionCursorSource,
  type UiSessionCodexSource,
  type UiSessionClaudeSource,
  type UiSessionKimiSource,
  type UiSessionCursorSource,
  type UiSessionRuntimeSource,
} from './session-source.js';

export type UiSessionSummary = SessionDisplaySummary;
export type UiSessionListPayload = SessionDisplayListPayload;

export interface UiSessionIdentity {
  bridgeSessionId?: string;
  codexThreadId?: string;
  claudeSessionId?: string;
  claudeCwd?: string;
  kimiSessionId?: string;
  kimiCwd?: string;
  cursorSessionId?: string;
  cursorCwd?: string;
}

export interface UiSessionHistoryMessage {
  role: string;
  kind: string;
  content: string;
  renderedContent: string;
  timestamp: string;
  rawJsonl: string;
}

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

function renderHistoryMarkdown(content: string): string {
  return markdownRenderer.render(content || '');
}

function uiHistoryMessage(
  role: string,
  kind: string,
  content: string,
  timestamp: string,
  rawJsonl?: string,
): UiSessionHistoryMessage {
  const raw = typeof rawJsonl === 'string' && rawJsonl.length > 0
    ? rawJsonl
    : JSON.stringify({ role, kind, content, timestamp });
  return {
    role,
    kind,
    content,
    renderedContent: renderHistoryMarkdown(content),
    timestamp,
    rawJsonl: raw,
  };
}

function uiRuntimeHistoryMessages(runtimeSource: UiSessionRuntimeSource, runtime: RuntimeAgent, threadId: string, cwd?: string): UiSessionHistoryMessage[] {
  const entries = runtimeSource.readJsonlHistory(runtime, threadId, cwd);
  return entries.map((entry) => uiHistoryMessage(entry.role, entry.kind, entry.content, entry.timestamp, entry.rawJsonl));
}

function uiTranscriptHistoryMessages(entries: SessionTranscriptHistoryEntry[]): UiSessionHistoryMessage[] {
  return entries.map((entry) => uiHistoryMessage(entry.role, entry.kind, entry.content, entry.timestamp, entry.rawJsonl));
}

function filterUiMessagesForRuntime(
  messages: UiSessionHistoryMessage[],
  runtime: RuntimeAgent | undefined,
): UiSessionHistoryMessage[] {
  if (runtime !== 'claude' && runtime !== 'kimi' && runtime !== 'cursor') return messages;
  return messages.filter((message) => message.role !== 'user');
}

function getBridgeSessionTitle(session: BridgeSession): string {
  return getBridgeSessionDisplayTitle(session);
}

function getStoredCodexThreadId(session: BridgeSession): string {
  return getBridgeSessionCodexThreadId(session);
}

function bridgeSessionToSummary(session: BridgeSession): UiSessionSummary {
  return buildBridgeSessionDisplaySummary(session);
}

function getSessionConfigTomlOverride<T>(session: BridgeSession, path: ConfigPath): T | undefined {
  try {
    const resolved = createConfigService({ migrate: false }).resolve(path, {
      kind: 'session',
      sessionId: session.id,
    });
    return resolved.source === 'session' ? resolved.value as T : undefined;
  } catch {
    return undefined;
  }
}

function setOrUnsetSessionConfig(
  sessionId: string,
  path: ConfigPath,
  value: unknown,
  patchForValue: (value: never) => ConfigPatch,
): void {
  const service = createConfigService({ migrate: false });
  if (value === undefined || value === '') {
    service.unset({ kind: 'session', sessionId }, path);
    return;
  }
  service.set({ kind: 'session', sessionId }, patchForValue(value as never));
}

function applySessionConfigToml(bridgeSessionId: string, payload: Record<string, unknown>): void {
  const activeRuntime = payload.activeRuntime === 'claude'
    ? 'claude'
    : payload.activeRuntime === 'kimi'
      ? 'kimi'
      : payload.activeRuntime === 'cursor'
        ? 'cursor'
        : 'codex';
  if (typeof payload.workingDirectory === 'string') {
    const workspace = payload.workingDirectory.trim() || process.cwd();
    createConfigService({ migrate: false }).set(
      { kind: 'session', sessionId: bridgeSessionId },
      { session: { workspace } },
    );
  }

  if (activeRuntime === 'claude') {
    if (typeof payload.claudeModel === 'string') {
      setOrUnsetSessionConfig(
        bridgeSessionId,
        'runtime.claude.model',
        payload.claudeModel.trim(),
        (model) => ({ runtime: { claude: { model } } }),
      );
    }
    if (
      payload.claudeReasoningEffort === 'low'
      || payload.claudeReasoningEffort === 'medium'
      || payload.claudeReasoningEffort === 'high'
      || payload.claudeReasoningEffort === 'xhigh'
      || payload.claudeReasoningEffort === 'max'
      || payload.claudeReasoningEffort === ''
    ) {
      setOrUnsetSessionConfig(
        bridgeSessionId,
        'runtime.claude.reasoningEffort',
        payload.claudeReasoningEffort,
        (reasoningEffort) => ({ runtime: { claude: { reasoningEffort } } }),
      );
    }
    return;
  }

  if (activeRuntime === 'kimi') {
    if (typeof payload.kimiModel === 'string') {
      setOrUnsetSessionConfig(
        bridgeSessionId,
        'runtime.kimi.model',
        payload.kimiModel.trim(),
        (model) => ({ runtime: { kimi: { model } } }),
      );
    }
    if (payload.kimiProvider === 'tmux' || payload.kimiProvider === '') {
      setOrUnsetSessionConfig(
        bridgeSessionId,
        'runtime.kimi.provider',
        payload.kimiProvider,
        (provider) => ({ runtime: { kimi: { provider } } }),
      );
    }
    return;
  }

  if (activeRuntime === 'cursor') {
    if (typeof payload.cursorModel === 'string') {
      setOrUnsetSessionConfig(
        bridgeSessionId,
        'runtime.cursor.model',
        payload.cursorModel.trim(),
        (model) => ({ runtime: { cursor: { model } } }),
      );
    }
    if (payload.cursorProvider === 'tmux' || payload.cursorProvider === '') {
      setOrUnsetSessionConfig(
        bridgeSessionId,
        'runtime.cursor.provider',
        payload.cursorProvider,
        (provider) => ({ runtime: { cursor: { provider } } }),
      );
    }
    if (typeof payload.cursorForce === 'boolean' || payload.cursorForce === '') {
      setOrUnsetSessionConfig(bridgeSessionId, 'runtime.cursor.force', payload.cursorForce, (force) => ({
        runtime: { cursor: { force } },
      }));
    }
    return;
  }

  if (typeof payload.model === 'string') {
    setOrUnsetSessionConfig(
      bridgeSessionId,
      'runtime.codex.model',
      payload.model.trim(),
      (model) => ({ runtime: { codex: { model } } }),
    );
  }
  if (payload.preferredMode === 'yolo' || payload.preferredMode === 'normal' || payload.preferredMode === 'code') {
    setOrUnsetSessionConfig(
      bridgeSessionId,
      'runtime.codex.yoloMode',
      payload.preferredMode === 'yolo' ? 'on' : 'off',
      (yoloMode) => ({ runtime: { codex: { yoloMode } } }),
    );
  }
  if (payload.codexProvider === 'sdk' || payload.codexProvider === 'tmux' || payload.codexProvider === 'pty' || payload.codexProvider === '') {
    setOrUnsetSessionConfig(
      bridgeSessionId,
      'runtime.codex.provider',
      payload.codexProvider,
      (provider) => ({ runtime: { codex: { provider } } }),
    );
  }
  if (
    payload.reasoningEffort === 'minimal'
    || payload.reasoningEffort === 'low'
    || payload.reasoningEffort === 'medium'
    || payload.reasoningEffort === 'high'
    || payload.reasoningEffort === 'xhigh'
    || payload.reasoningEffort === ''
  ) {
    setOrUnsetSessionConfig(
      bridgeSessionId,
      'runtime.codex.reasoningEffort',
      payload.reasoningEffort,
      (reasoningEffort) => ({ runtime: { codex: { reasoningEffort } } }),
    );
  }
  if (
    payload.codexSandboxMode === 'read-only'
    || payload.codexSandboxMode === 'workspace-write'
    || payload.codexSandboxMode === 'danger-full-access'
    || payload.codexSandboxMode === ''
  ) {
    setOrUnsetSessionConfig(
      bridgeSessionId,
      'runtime.codex.sandboxMode',
      payload.codexSandboxMode,
      (sandboxMode) => ({ runtime: { codex: { sandboxMode } } }),
    );
  }
  if (payload.codexNetworkAccess === true || payload.codexNetworkAccess === false || payload.codexNetworkAccess === '') {
    setOrUnsetSessionConfig(bridgeSessionId, 'runtime.codex.networkAccess', payload.codexNetworkAccess, (networkAccess) => ({
      runtime: { codex: { networkAccess } },
    }));
  }
}

function runtimeSessionToSummary(runtimeSource: UiSessionRuntimeSource, store: JsonFileStore, runtime: RuntimeAgent, threadId: string, cwd?: string): UiSessionSummary | null {
  const session = runtimeSource.getThread(runtime, threadId, cwd);
  if (!session) return null;
  return new SessionDisplayQuery(store).localRuntimeSession(session);
}

function codexSessionToSummary(runtimeSource: UiSessionRuntimeSource, store: JsonFileStore, threadId: string): UiSessionSummary | null {
  const session = runtimeSource.getThread('codex', threadId);
  if (!session) return null;
  const linked = findVisibleBridgeSessionByCodexThread(store, threadId);
  return buildCodexThreadDisplaySummary({
    threadId: session.threadId,
    filePath: session.filePath,
    cwd: session.cwd,
    originator: session.originator,
    source: session.source,
    cliVersion: session.cliVersion,
    firstSeenAt: session.firstSeenAt,
    lastEventAt: session.lastEventAt,
    title: session.title,
    activeEstimate: session.activeEstimate,
  }, linked);
}

function bindingForSessionHistory(store: JsonFileStore, session: BridgeSession): ChannelChat {
  return store.listChannelChats().find((binding) => binding.bridgeSessionId === session.id) || {
    id: `ui-session-${session.id}`,
    channelType: 'ui',
    chatId: session.id,
    bridgeSessionId: session.id,
    createdAt: session.created_at || '',
    updatedAt: session.updated_at || session.created_at || '',
  };
}

function sanitizeSessionConfig(payload: Record<string, unknown>): BridgeSessionUpdate {
  const updates: BridgeSessionUpdate = {};
  const runtimeUpdates: BridgeSessionUpdate[] = [];
  const activeRuntime = payload.activeRuntime === 'claude'
    ? 'claude'
    : payload.activeRuntime === 'kimi'
      ? 'kimi'
      : payload.activeRuntime === 'cursor'
        ? 'cursor'
        : 'codex';
  if (typeof payload.name === 'string') {
    updates.name = payload.name.trim() || undefined;
  }
  runtimeUpdates.push({ runtime: { activeRuntime } });
  if (typeof payload.systemPrompt === 'string') {
    runtimeUpdates.push(setSessionSystemPromptUpdate(payload.systemPrompt.trim() || undefined));
  }
  return mergeSessionRuntimeUpdates(updates, ...runtimeUpdates);
}

function sessionConfigPayload(session: BridgeSession) {
  const activeRuntime = getSessionActiveRuntime(session) || 'codex';
  const codexYoloMode = getSessionConfigTomlOverride<'off' | 'on' | 'yolo'>(session, 'runtime.codex.yoloMode');
  return {
    id: session.id,
    bridgeSessionId: session.id,
    activeRuntime,
    name: session.name ? stripLegacySessionPrefix(session.name) : '',
    codexTitle: getSessionCodexTitle(session) || '',
    title: getBridgeSessionTitle(session),
    workingDirectory: getSessionWorkingDirectory(session) || '',
    model: getSessionConfigTomlOverride<string>(session, 'runtime.codex.model') || '',
    preferredMode: (codexYoloMode === 'on' || codexYoloMode === 'yolo') ? 'yolo' : 'normal',
    codexProvider: getSessionConfigTomlOverride<string>(session, 'runtime.codex.provider') || '',
    systemPrompt: getSessionSystemPrompt(session) || '',
    reasoningEffort: getSessionConfigTomlOverride<string>(session, 'runtime.codex.reasoningEffort') || '',
    codexSandboxMode: getSessionConfigTomlOverride<string>(session, 'runtime.codex.sandboxMode') || '',
    codexNetworkAccess: getSessionConfigTomlOverride<boolean>(session, 'runtime.codex.networkAccess'),
    claudeModel: getSessionConfigTomlOverride<string>(session, 'runtime.claude.model') || '',
    claudeReasoningEffort: getSessionConfigTomlOverride<string>(session, 'runtime.claude.reasoningEffort') || '',
    kimiModel: getSessionConfigTomlOverride<string>(session, 'runtime.kimi.model') || '',
    kimiProvider: getSessionConfigTomlOverride<string>(session, 'runtime.kimi.provider') || '',
    cursorModel: getSessionConfigTomlOverride<string>(session, 'runtime.cursor.model') || '',
    cursorProvider: getSessionConfigTomlOverride<string>(session, 'runtime.cursor.provider') || '',
    cursorForce: getSessionConfigTomlOverride<boolean>(session, 'runtime.cursor.force'),
  };
}

export class UiSessionApplication {
  constructor(
    private readonly store: JsonFileStore,
    private readonly codexSource: UiSessionCodexSource = defaultUiSessionCodexSource,
    private readonly claudeSource: UiSessionClaudeSource = defaultUiSessionClaudeSource,
    private readonly kimiSource: UiSessionKimiSource = defaultUiSessionKimiSource,
    private readonly cursorSource: UiSessionCursorSource = defaultUiSessionCursorSource,
  ) {}

  private createRuntimeSource(): UiSessionRuntimeSource {
    return createUiSessionRuntimeSource(this.codexSource, this.claudeSource, this.kimiSource, this.cursorSource);
  }

  private createSessionRegistry() {
    return createUiSessionRegistry(this.store, this.codexSource, this.claudeSource, this.kimiSource, this.cursorSource);
  }

  listSessions(limit?: number): UiSessionListPayload {
    const runtimeSource = this.createRuntimeSource();
    return new SessionDisplayQuery(this.store).listRuntimeSessions(runtimeSource.listSessions(), {
      root: runtimeSource.getSessionsRoot(),
      limit,
    });
  }

  getHistory(identity: UiSessionIdentity): {
    session: UiSessionSummary;
    source: string;
    messages: UiSessionHistoryMessage[];
  } {
    if (identity.bridgeSessionId) {
      const session = this.store.getSession(identity.bridgeSessionId);
      if (!session || session.hidden === true || session.session_type === 'draft') {
        throw new Error('指定的 Bridge 会话不存在。');
      }

      const codexThreadId = getStoredCodexThreadId(session);
      if (codexThreadId) {
        const runtimeSource = this.createRuntimeSource();
        const codexSummary = codexSessionToSummary(runtimeSource, this.store, codexThreadId);
        return {
          session: codexSummary || bridgeSessionToSummary(session),
          source: 'codex',
          messages: uiRuntimeHistoryMessages(runtimeSource, 'codex', codexThreadId),
        };
      }

      const transcript = resolveSessionTranscriptFile(session, bindingForSessionHistory(this.store, session));
      if (transcript) {
        return {
          session: bridgeSessionToSummary(session),
          source: transcript.transcript.runtime,
          messages: uiTranscriptHistoryMessages(transcript.source.readHistory(transcript.transcript)),
        };
      }

      const { messages } = this.store.getMessages(session.id);
      const activeRuntime = getSessionActiveRuntime(session);
      return {
        session: bridgeSessionToSummary(session),
        source: 'bridge',
        messages: filterUiMessagesForRuntime(
          messages.map((message) => uiHistoryMessage(message.role, 'bridge:message', message.content, message.timestamp || '')),
          activeRuntime,
        ),
      };
    }

    if (identity.codexThreadId) {
      const runtimeSource = this.createRuntimeSource();
      const summary = codexSessionToSummary(runtimeSource, this.store, identity.codexThreadId);
      if (!summary) {
        throw new Error('指定的 Codex 会话不存在。');
      }

      return {
        session: summary,
        source: 'codex',
        messages: uiRuntimeHistoryMessages(runtimeSource, 'codex', identity.codexThreadId),
      };
    }

    if (identity.claudeSessionId && identity.claudeCwd) {
      const runtimeSource = this.createRuntimeSource();
      const summary = runtimeSessionToSummary(runtimeSource, this.store, 'claude', identity.claudeSessionId, identity.claudeCwd);
      if (!summary) {
        throw new Error('指定的 Claude Code 会话不存在。');
      }

      return {
        session: summary,
        source: 'claude',
        messages: uiRuntimeHistoryMessages(runtimeSource, 'claude', identity.claudeSessionId, identity.claudeCwd),
      };
    }

    if (identity.kimiSessionId && identity.kimiCwd) {
      const runtimeSource = this.createRuntimeSource();
      const summary = runtimeSessionToSummary(runtimeSource, this.store, 'kimi', identity.kimiSessionId, identity.kimiCwd);
      if (!summary) {
        throw new Error('指定的 Kimi Code 会话不存在。');
      }

      return {
        session: summary,
        source: 'kimi',
        messages: uiRuntimeHistoryMessages(runtimeSource, 'kimi', identity.kimiSessionId, identity.kimiCwd),
      };
    }

    if (identity.cursorSessionId && identity.cursorCwd) {
      const runtimeSource = this.createRuntimeSource();
      const summary = runtimeSessionToSummary(runtimeSource, this.store, 'cursor', identity.cursorSessionId, identity.cursorCwd);
      if (!summary) throw new Error('指定的 Cursor Agent 会话不存在。');
      return {
        session: summary,
        source: 'cursor',
        messages: uiRuntimeHistoryMessages(runtimeSource, 'cursor', identity.cursorSessionId, identity.cursorCwd),
      };
    }

    throw new Error('不支持的会话目标。');
  }

  getConfig(bridgeSessionId: string) {
    const session = this.createSessionRegistry().getVisibleBridgeSession(bridgeSessionId);
    return sessionConfigPayload(session);
  }

  importCodexThread(codexThreadId: string) {
    const session = this.createSessionRegistry().materializeCodexThread(codexThreadId);
    return {
      bridgeSessionId: session.id,
      session: bridgeSessionToSummary(session),
      config: sessionConfigPayload(session),
    };
  }

  importClaudeThread(claudeSessionId: string, cwd: string) {
    const session = this.createSessionRegistry().materializeClaudeThread(claudeSessionId, cwd);
    return {
      bridgeSessionId: session.id,
      session: bridgeSessionToSummary(session),
      config: sessionConfigPayload(session),
    };
  }

  importKimiThread(kimiSessionId: string, cwd: string) {
    const session = this.createSessionRegistry().materializeKimiThread(kimiSessionId, cwd);
    return {
      bridgeSessionId: session.id,
      session: bridgeSessionToSummary(session),
      config: sessionConfigPayload(session),
    };
  }

  importCursorThread(cursorSessionId: string, cwd: string) {
    const session = this.createSessionRegistry().materializeCursorThread(cursorSessionId, cwd);
    return {
      bridgeSessionId: session.id,
      session: bridgeSessionToSummary(session),
      config: sessionConfigPayload(session),
    };
  }

  renameSession(identity: UiSessionIdentity, name: string | undefined) {
    const registry = this.createSessionRegistry();
    const updated = identity.bridgeSessionId
      ? registry.renameBridgeSession(identity.bridgeSessionId, name)
      : identity.codexThreadId
        ? registry.renameCodexThread(identity.codexThreadId, name)
        : identity.claudeSessionId && identity.claudeCwd
          ? registry.renameClaudeThread(identity.claudeSessionId, identity.claudeCwd, name)
          : identity.kimiSessionId && identity.kimiCwd
            ? registry.renameKimiThread(identity.kimiSessionId, identity.kimiCwd, name)
            : registry.renameCursorThread(identity.cursorSessionId!, identity.cursorCwd!, name);
    return sessionConfigPayload(updated);
  }

  updateConfig(bridgeSessionId: string, payload: Record<string, unknown>) {
    const registry = this.createSessionRegistry();
    const updates = sanitizeSessionConfig(payload);
    const updated = registry.updateBridgeSessionConfig(bridgeSessionId, updates);
    applySessionConfigToml(bridgeSessionId, payload);
    return sessionConfigPayload(updated);
  }

  deleteSession(identity: UiSessionIdentity): { deleted: UiSessionSummary; deletedBridgeSessionIds: string[] } {
    if (identity.bridgeSessionId) {
      const registry = this.createSessionRegistry();
      const session = registry.getVisibleBridgeSession(identity.bridgeSessionId);
      const summary = bridgeSessionToSummary(session);
      registry.deleteBridgeSession(session.id);
      return { deleted: summary, deletedBridgeSessionIds: [session.id] };
    }

    if (identity.codexThreadId) {
      const runtimeSource = this.createRuntimeSource();
      const summary = codexSessionToSummary(runtimeSource, this.store, identity.codexThreadId);
      if (!summary) {
        throw new Error('指定的 Codex 会话不存在。');
      }

      const result = this.createSessionRegistry().archiveCodexThread(identity.codexThreadId);
      return { deleted: summary, deletedBridgeSessionIds: result.deletedBridgeSessionIds };
    }

    if (identity.claudeSessionId && identity.claudeCwd) {
      const runtimeSource = this.createRuntimeSource();
      const summary = runtimeSessionToSummary(runtimeSource, this.store, 'claude', identity.claudeSessionId, identity.claudeCwd);
      if (!summary) {
        throw new Error('指定的 Claude Code 会话不存在。');
      }

      const result = this.createSessionRegistry().archiveClaudeThread(identity.claudeSessionId, identity.claudeCwd);
      return { deleted: summary, deletedBridgeSessionIds: result.deletedBridgeSessionIds };
    }

    if (identity.kimiSessionId && identity.kimiCwd) {
      const runtimeSource = this.createRuntimeSource();
      const summary = runtimeSessionToSummary(runtimeSource, this.store, 'kimi', identity.kimiSessionId, identity.kimiCwd);
      if (!summary) {
        throw new Error('指定的 Kimi Code 会话不存在。');
      }

      const result = this.createSessionRegistry().archiveKimiThread(identity.kimiSessionId, identity.kimiCwd);
      return { deleted: summary, deletedBridgeSessionIds: result.deletedBridgeSessionIds };
    }

    if (identity.cursorSessionId && identity.cursorCwd) {
      const runtimeSource = this.createRuntimeSource();
      const summary = runtimeSessionToSummary(runtimeSource, this.store, 'cursor', identity.cursorSessionId, identity.cursorCwd);
      if (!summary) throw new Error('指定的 Cursor Agent 会话不存在。');
      const result = this.createSessionRegistry().archiveCursorThread(identity.cursorSessionId, identity.cursorCwd);
      return { deleted: summary, deletedBridgeSessionIds: result.deletedBridgeSessionIds };
    }

    throw new Error('不支持的会话目标。');
  }
}
