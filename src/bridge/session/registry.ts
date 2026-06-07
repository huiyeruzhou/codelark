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
  type ChannelDefaultTargetSummary,
  removeBinding,
  removeChannelDefaultTarget,
  updateChannelDefaultCodexThread,
  updateBindingTarget,
  updateChannelDefaultTarget,
} from './registry/bindings.js';
import { setSessionCodexTitleUpdate } from '../../domain/session-runtime.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeCwd,
  getSessionClaudeSessionId,
} from '../../domain/session-runtime.js';

export {
  type BindingSummary,
  type BindingTargetOption,
  type ChannelDefaultTargetSummary,
  listBindingSummaries,
  listBindingsForChat,
  listBindingTargetOptions,
  listChannelDefaultTargetSummaries,
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

export interface SessionRegistryOptions {
  codexThreads?: CodexThreadRegistryPort;
  claudeThreads?: ClaudeThreadRegistryPort;
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

export class SessionRegistryService {
  constructor(
    private readonly store: BridgeStore,
    private readonly options: SessionRegistryOptions = {},
  ) {}

  bindChatToBridgeSession(
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

  setChannelDefaultBridgeSession(channelType: string, bridgeSessionId: string): ChannelDefaultTargetSummary {
    return updateChannelDefaultTarget(this.store, channelType, bridgeSessionId);
  }

  setChannelDefaultCodexThread(channelType: string, codexThreadId: string): ChannelDefaultTargetSummary {
    return updateChannelDefaultCodexThread(this.store, channelType, codexThreadId);
  }

  setChannelDefaultClaudeThread(channelType: string, claudeSessionId: string, cwd: string): ChannelDefaultTargetSummary {
    const session = this.materializeClaudeThread(claudeSessionId, cwd);
    return updateChannelDefaultTarget(this.store, channelType, session.id);
  }

  removeChannelDefaultTarget(channelType: string): void {
    removeChannelDefaultTarget(this.store, channelType);
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

}
