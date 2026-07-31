import type { BridgeStore } from '../../domain/audit.js';
import type { ChannelAddress, ChannelChat } from '../../domain/channel.js';
import type { BridgeSession, BridgeSessionUpdate } from '../../domain/session.js';
import {
  getBridgeSessionCodexThreadId,
  isVisibleBridgeSession,
} from './display/session-display-query.js';
import {
  bindStoreToCodexThread,
  bindStoreToSession,
  type BindingSummary,
  removeBinding,
  updateBindingTarget,
} from './registry/bindings.js';
import { setSessionCodexTitleUpdate } from '../../domain/session-runtime.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
  getSessionKimiCwd,
  getSessionKimiSessionId,
  getSessionCursorCwd,
  getSessionCursorSessionId,
} from '../../domain/session-runtime.js';

export {
  type BindingSummary,
  type BindingTargetOption,
  listBindingSummaries,
  listBindingsForChat,
  listBindingTargetOptions,
  setActiveBindingForChat,
} from './registry/bindings.js';

export interface ImportCodexThreadOptions {
  workingDirectory?: string;
  model?: string;
  displayName?: string;
}

export interface CodexThreadRecord {
  codexThreadId: string;
  title: string;
  cwd: string;
}

export interface CodexThreadRegistryPort {
  getThread(codexThreadId: string): CodexThreadRecord | null;
  archiveThread?(codexThreadId: string): boolean;
}

export interface ClaudeThreadRecord {
  claudeSessionId: string;
  title: string;
  cwd: string;
}

export interface ClaudeThreadRegistryPort {
  getThread(claudeSessionId: string, cwd: string): ClaudeThreadRecord | null;
  archiveThread?(claudeSessionId: string, cwd: string): boolean;
}

export interface KimiThreadRecord {
  kimiSessionId: string;
  title: string;
  cwd: string;
}

export interface KimiThreadRegistryPort {
  getThread(kimiSessionId: string, cwd: string): KimiThreadRecord | null;
  archiveThread?(kimiSessionId: string, cwd: string): boolean;
}

export interface CursorThreadRegistryPort {
  getThread(cursorSessionId: string, cwd: string): { cursorSessionId: string; title: string; cwd: string } | null;
  archiveThread?(cursorSessionId: string, cwd: string): boolean;
}

export interface SessionRegistryOptions {
  codexThreads?: CodexThreadRegistryPort;
  claudeThreads?: ClaudeThreadRegistryPort;
  kimiThreads?: KimiThreadRegistryPort;
  cursorThreads?: CursorThreadRegistryPort;
  readDefaultModel?: () => string | null | undefined;
  defaultWorkingDirectory?: () => string;
}

export interface DeleteBridgeSessionResult {
  deleted: BridgeSession;
  deletedBridgeSessionIds: string[];
}

export interface ArchiveCodexThreadResult {
  codexThreadId: string;
  deletedBridgeSessions: BridgeSession[];
  deletedBridgeSessionIds: string[];
}

export interface ArchiveClaudeThreadResult {
  claudeSessionId: string;
  cwd: string;
  deletedBridgeSessions: BridgeSession[];
  deletedBridgeSessionIds: string[];
}

export interface ArchiveKimiThreadResult {
  kimiSessionId: string;
  cwd: string;
  deletedBridgeSessions: BridgeSession[];
  deletedBridgeSessionIds: string[];
}

export interface ArchiveCursorThreadResult {
  cursorSessionId: string;
  cwd: string;
  deletedBridgeSessions: BridgeSession[];
  deletedBridgeSessionIds: string[];
}

export class SessionRegistryService {
  constructor(
    private readonly store: BridgeStore,
    private readonly options: SessionRegistryOptions = {},
  ) {}

  attachChatToBridgeSession(
    address: ChannelAddress,
    bridgeSessionId: string,
  ): ChannelChat | null {
    return bindStoreToSession(
      this.store,
      address.channelType,
      address.chatId,
      bridgeSessionId,
      {
        chatKind: address.chatKind,
        chatUserId: address.userId,
        chatDisplayName: address.displayName,
      },
    );
  }

  importCodexThreadForChat(
    address: ChannelAddress,
    codexThreadId: string,
    opts: ImportCodexThreadOptions = {},
  ): ChannelChat {
    return bindStoreToCodexThread(this.store, address.channelType, address.chatId, codexThreadId, {
      workingDirectory: opts.workingDirectory,
      model: opts.model,
      displayName: opts.displayName,
      chatKind: address.chatKind,
      chatUserId: address.userId,
      chatDisplayName: address.displayName,
    });
  }

  switchBindingToBridgeSession(bindingId: string, bridgeSessionId: string): BindingSummary {
    return updateBindingTarget(this.store, bindingId, { bridgeSessionId });
  }

  switchBindingToCodexThread(bindingId: string, codexThreadId: string): BindingSummary {
    return updateBindingTarget(this.store, bindingId, { codexThreadId });
  }

  removeBinding(bindingId: string): void {
    removeBinding(this.store, bindingId);
  }

  getVisibleBridgeSession(bridgeSessionId: string): BridgeSession {
    const session = this.store.getSession(bridgeSessionId);
    if (!session || !isVisibleBridgeSession(session)) {
      throw new Error('指定的 Bridge 会话不存在。');
    }
    return session;
  }

  findVisibleBridgeSessionByCodexThread(codexThreadId: string): BridgeSession | null {
    if (!codexThreadId) return null;
    return this.store.listSessions().find((session) => (
      isVisibleBridgeSession(session)
      && getBridgeSessionCodexThreadId(session) === codexThreadId
    )) || null;
  }

  findVisibleBridgeSessionByClaudeThread(claudeSessionId: string, cwd: string): BridgeSession | null {
    if (!claudeSessionId || !cwd) return null;
    return this.store.listSessions().find((session) => (
      isVisibleBridgeSession(session)
      && getSessionActiveRuntime(session) === 'claude'
      && getSessionClaudeSessionId(session) === claudeSessionId
      && getSessionClaudeCwd(session) === cwd
    )) || null;
  }

  findVisibleBridgeSessionByKimiThread(kimiSessionId: string, cwd: string): BridgeSession | null {
    if (!kimiSessionId || !cwd) return null;
    return this.store.listSessions().find((session) => (
      isVisibleBridgeSession(session)
      && getSessionActiveRuntime(session) === 'kimi'
      && getSessionKimiSessionId(session) === kimiSessionId
      && getSessionKimiCwd(session) === cwd
    )) || null;
  }

  findVisibleBridgeSessionByCursorThread(cursorSessionId: string, cwd: string): BridgeSession | null {
    return this.store.listSessions().find((session) => (
      isVisibleBridgeSession(session)
      && getSessionActiveRuntime(session) === 'cursor'
      && getSessionCursorSessionId(session) === cursorSessionId
      && getSessionCursorCwd(session) === cwd
    )) || null;
  }

  materializeCodexThread(codexThreadId: string): BridgeSession {
    const existing = this.findVisibleBridgeSessionByCodexThread(codexThreadId);
    if (existing) return existing;

    const localThread = this.options.codexThreads?.getThread(codexThreadId) || null;
    if (!localThread) {
      throw new Error('指定的 Codex 会话不存在。');
    }

    const session = this.store.createSession(
      '',
      this.options.readDefaultModel?.() || 'default',
      undefined,
      localThread.cwd || this.options.defaultWorkingDirectory?.() || process.cwd(),
      'normal',
    );
    this.store.updateSessionCodexThreadId(session.id, codexThreadId);
    if (localThread.title) {
      this.store.updateSession(session.id, setSessionCodexTitleUpdate(localThread.title), { touch: false });
    }
    return this.store.getSession(session.id) || session;
  }

  materializeClaudeThread(claudeSessionId: string, cwd: string): BridgeSession {
    const existing = this.findVisibleBridgeSessionByClaudeThread(claudeSessionId, cwd);
    if (existing) return existing;

    const localThread = this.options.claudeThreads?.getThread(claudeSessionId, cwd) || null;
    if (!localThread) {
      throw new Error('指定的 Claude Code 会话不存在。');
    }

    const session = this.store.createSession(
      localThread.title || '',
      this.options.readDefaultModel?.() || 'default',
      undefined,
      localThread.cwd || this.options.defaultWorkingDirectory?.() || process.cwd(),
      'normal',
      { activeRuntime: 'claude' },
    );
    this.store.updateSession(session.id, {
      name: localThread.title || session.name,
      runtime: {
        activeRuntime: 'claude',
        claude: {
          sessionId: localThread.claudeSessionId,
          cwd: localThread.cwd,
        },
        general: {
          workingDirectory: localThread.cwd,
        },
      },
    }, { touch: false });
    return this.store.getSession(session.id) || session;
  }

  materializeKimiThread(kimiSessionId: string, cwd: string): BridgeSession {
    const existing = this.findVisibleBridgeSessionByKimiThread(kimiSessionId, cwd);
    if (existing) return existing;

    const localThread = this.options.kimiThreads?.getThread(kimiSessionId, cwd) || null;
    if (!localThread) {
      throw new Error('指定的 Kimi Code 会话不存在。');
    }

    const session = this.store.createSession(
      localThread.title || '',
      this.options.readDefaultModel?.() || 'default',
      undefined,
      localThread.cwd || this.options.defaultWorkingDirectory?.() || process.cwd(),
      'normal',
      { activeRuntime: 'kimi' },
    );
    this.store.updateSession(session.id, {
      name: localThread.title || session.name,
      runtime: {
        activeRuntime: 'kimi',
        kimi: {
          sessionId: localThread.kimiSessionId,
          cwd: localThread.cwd,
          provider: 'tmux',
        },
        general: {
          workingDirectory: localThread.cwd,
        },
      },
    }, { touch: false });
    return this.store.getSession(session.id) || session;
  }

  materializeCursorThread(cursorSessionId: string, cwd: string): BridgeSession {
    const existing = this.findVisibleBridgeSessionByCursorThread(cursorSessionId, cwd);
    if (existing) return existing;
    const localThread = this.options.cursorThreads?.getThread(cursorSessionId, cwd) || null;
    if (!localThread) throw new Error('指定的 Cursor Agent 会话不存在。');
    const session = this.store.createSession(
      localThread.title || '',
      this.options.readDefaultModel?.() || 'default',
      undefined,
      localThread.cwd || this.options.defaultWorkingDirectory?.() || process.cwd(),
      'normal',
      { activeRuntime: 'cursor' },
    );
    this.store.updateSession(session.id, {
      name: localThread.title || session.name,
      runtime: {
        activeRuntime: 'cursor',
        cursor: { sessionId: localThread.cursorSessionId, cwd: localThread.cwd, provider: 'tmux' },
        general: { workingDirectory: localThread.cwd },
      },
    }, { touch: false });
    return this.store.getSession(session.id) || session;
  }

  renameBridgeSession(bridgeSessionId: string, name: string | undefined): BridgeSession {
    const session = this.getVisibleBridgeSession(bridgeSessionId);
    this.store.updateSession(session.id, { name });
    return this.store.getSession(session.id) || { ...session, name };
  }

  renameCodexThread(codexThreadId: string, name: string | undefined): BridgeSession {
    const session = this.materializeCodexThread(codexThreadId);
    return this.renameBridgeSession(session.id, name);
  }

  renameClaudeThread(claudeSessionId: string, cwd: string, name: string | undefined): BridgeSession {
    const session = this.materializeClaudeThread(claudeSessionId, cwd);
    return this.renameBridgeSession(session.id, name);
  }

  renameKimiThread(kimiSessionId: string, cwd: string, name: string | undefined): BridgeSession {
    const session = this.materializeKimiThread(kimiSessionId, cwd);
    return this.renameBridgeSession(session.id, name);
  }

  renameCursorThread(cursorSessionId: string, cwd: string, name: string | undefined): BridgeSession {
    const session = this.materializeCursorThread(cursorSessionId, cwd);
    return this.renameBridgeSession(session.id, name);
  }

  updateBridgeSessionConfig(bridgeSessionId: string, updates: BridgeSessionUpdate): BridgeSession {
    const session = this.getVisibleBridgeSession(bridgeSessionId);
    this.store.updateSession(session.id, updates);
    const updated = this.store.getSession(session.id);
    if (!updated) throw new Error('Updated session not found.');
    return updated;
  }

  deleteBridgeSession(bridgeSessionId: string): DeleteBridgeSessionResult {
    const session = this.getVisibleBridgeSession(bridgeSessionId);
    this.store.deleteSession(session.id);
    return {
      deleted: session,
      deletedBridgeSessionIds: [session.id],
    };
  }

  archiveCodexThread(codexThreadId: string): ArchiveCodexThreadResult {
    if (!this.options.codexThreads?.archiveThread) {
      throw new Error('Local Codex archive is not configured.');
    }
    const archived = this.options.codexThreads.archiveThread(codexThreadId);
    if (!archived) {
      throw new Error('指定的 Codex 会话不存在。');
    }

    const linkedSessions = this.store.listSessions()
      .filter((session) => getBridgeSessionCodexThreadId(session) === codexThreadId);
    for (const session of linkedSessions) {
      this.store.deleteSession(session.id);
    }

    return {
      codexThreadId,
      deletedBridgeSessions: linkedSessions,
      deletedBridgeSessionIds: linkedSessions.map((session) => session.id),
    };
  }

  archiveClaudeThread(claudeSessionId: string, cwd: string): ArchiveClaudeThreadResult {
    if (!this.options.claudeThreads?.archiveThread) {
      throw new Error('Local Claude archive is not configured.');
    }
    const archived = this.options.claudeThreads.archiveThread(claudeSessionId, cwd);
    if (!archived) {
      throw new Error('指定的 Claude Code 会话不存在。');
    }

    const linkedSessions = this.store.listSessions()
      .filter((session) => (
        getSessionActiveRuntime(session) === 'claude'
        && getSessionClaudeSessionId(session) === claudeSessionId
        && getSessionClaudeCwd(session) === cwd
      ));
    for (const session of linkedSessions) {
      this.store.deleteSession(session.id);
    }

    return {
      claudeSessionId,
      cwd,
      deletedBridgeSessions: linkedSessions,
      deletedBridgeSessionIds: linkedSessions.map((session) => session.id),
    };
  }

  archiveKimiThread(kimiSessionId: string, cwd: string): ArchiveKimiThreadResult {
    if (!this.options.kimiThreads?.archiveThread) {
      throw new Error('Local Kimi archive is not configured.');
    }
    const archived = this.options.kimiThreads.archiveThread(kimiSessionId, cwd);
    if (!archived) {
      throw new Error('指定的 Kimi Code 会话不存在。');
    }

    const linkedSessions = this.store.listSessions()
      .filter((session) => (
        getSessionActiveRuntime(session) === 'kimi'
        && getSessionKimiSessionId(session) === kimiSessionId
        && getSessionKimiCwd(session) === cwd
      ));
    for (const session of linkedSessions) {
      this.store.deleteSession(session.id);
    }

    return {
      kimiSessionId,
      cwd,
      deletedBridgeSessions: linkedSessions,
      deletedBridgeSessionIds: linkedSessions.map((session) => session.id),
    };
  }

  archiveCursorThread(cursorSessionId: string, cwd: string): ArchiveCursorThreadResult {
    if (!this.options.cursorThreads?.archiveThread) {
      throw new Error('Local Cursor archive is not configured.');
    }
    const archived = this.options.cursorThreads.archiveThread(cursorSessionId, cwd);
    if (!archived) throw new Error('指定的 Cursor Agent 会话不存在。');
    const linkedSessions = this.store.listSessions().filter((session) => (
      getSessionActiveRuntime(session) === 'cursor'
      && getSessionCursorSessionId(session) === cursorSessionId
      && getSessionCursorCwd(session) === cwd
    ));
    for (const session of linkedSessions) this.store.deleteSession(session.id);
    return {
      cursorSessionId,
      cwd,
      deletedBridgeSessions: linkedSessions,
      deletedBridgeSessionIds: linkedSessions.map((session) => session.id),
    };
  }

}
