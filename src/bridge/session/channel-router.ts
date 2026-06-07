/**
 * Channel Router — resolves IM addresses to BridgeSessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelChat (and underlying chat_session).
 */

import type { ChannelAddress, ChannelChat, ChannelType } from '../../domain/index.js';
import { getBridgeContext } from '../context.js';
import { SessionRegistryService } from '../session/registry.js';
import { getOrCreateDraftSession } from '../session/internal-sessions.js';
import { recordBindingChange } from '../session/binding-audit.js';
import { createConfigService, type ConfigScope } from '../../configuration/service.js';
import { expandHomePath } from '../../configuration/paths.js';
import type { ConfigV2 } from '../../configuration/schema.js';

interface ChannelSessionDefaults {
  activeRuntime: 'codex' | 'claude';
  codexModel: string;
  codexMode: 'normal' | 'yolo';
  workspace: string;
}

function channelScopeForAddress(address: Pick<ChannelAddress, 'channelType' | 'channelProvider'>): ConfigScope | undefined {
  return address.channelProvider === undefined || address.channelProvider === 'feishu'
    ? { kind: 'channel', channelId: address.channelType, provider: 'feishu' }
    : undefined;
}

function codexModeFromConfig(config: ConfigV2): 'normal' | 'yolo' {
  return config.runtime.codex.yoloMode === 'on' || config.runtime.codex.yoloMode === 'yolo' ? 'yolo' : 'normal';
}

function resolveChannelSessionDefaults(address: ChannelAddress): ChannelSessionDefaults {
  const effective = createConfigService({ migrate: false }).snapshot(channelScopeForAddress(address));
  const config = effective.config;
  const workspaceSource = effective.provenance.get('session.workspace')?.source;
  const workspaceValue = workspaceSource && workspaceSource !== 'defaults'
    ? config.session.workspace
    : config.bridge.defaultWorkspace;
  const workspace = expandHomePath(workspaceValue || config.bridge.defaultWorkspace) || process.cwd();
  return {
    activeRuntime: config.runtime.agent === 'claude' ? 'claude' : 'codex',
    codexModel: config.runtime.codex.model || '',
    codexMode: codexModeFromConfig(config),
    workspace,
  };
}

/**
 * Resolve an inbound address to a ChannelChat.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelChat {
  const { store } = getBridgeContext();
  const registry = new SessionRegistryService(store);
  const existing = store.getChannelChat(address.channelType, address.chatId);
  if (existing) {
    // Verify the linked session still exists; if not, create a new one
    const session = store.getSession(existing.bridgeSessionId);
    if (session) {
      const updates: Partial<ChannelChat> = {};
      if (address.chatKind && address.chatKind !== existing.chatKind) {
        updates.chatKind = address.chatKind;
      }
      if (address.userId && address.userId !== existing.chatUserId) {
        updates.chatUserId = address.userId;
      }
      if (Object.keys(updates).length > 0) {
        store.updateChannelChat(existing.id, updates);
        return store.getChannelChat(address.channelType, address.chatId) || { ...existing, ...updates };
      }
      return existing;
    }
    // Session was deleted — recreate
    const created = createBinding(address);
    recordBindingChange(store, {
      action: 'auto_recreate_missing_session',
      address,
      fromBinding: existing,
      toBinding: created,
      reason: 'bound session was missing',
    });
    return created;
  }
  const channelDefaultTarget = store.getChannelDefaultTarget(address.channelType);
  if (channelDefaultTarget) {
    try {
      const created = registry.bindChatToBridgeSession(address, channelDefaultTarget.bridgeSessionId);
      if (!created) {
        throw new Error('Session not found.');
      }
      store.deleteChannelDefaultTarget(address.channelType);
      recordBindingChange(store, {
        action: 'auto_create_prebound',
        address,
        fromBinding: null,
        toBinding: created,
        reason: `channel default bridge session ${channelDefaultTarget.bridgeSessionId}`,
      });
      return created;
    } catch (error) {
      store.deleteChannelDefaultTarget(address.channelType);
      console.warn(
        `[channel-router] Failed to apply channel default target for ${address.channelType}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const created = createBinding(address);
  recordBindingChange(store, {
    action: 'auto_create_draft',
    address,
    fromBinding: null,
    toBinding: created,
    reason: channelDefaultTarget
      ? `channel default bridge session ${channelDefaultTarget.bridgeSessionId} was unavailable`
      : 'no existing binding',
  });
  return created;
}

/**
 * Create a new binding.
 * Without a working directory it starts in a hidden temporary BridgeSession (/t 0).
 * With a working directory it creates a regular visible code session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
  sessionName?: string,
): ChannelChat {
  const { store } = getBridgeContext();
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';
  const defaults = resolveChannelSessionDefaults(address);
  const visibleSessionName = sessionName?.trim() || address.displayName?.trim() || `Bridge: ${address.chatId}`;
  const session = workingDirectory
    ? store.createSession(
        visibleSessionName,
        defaults.codexModel,
        undefined,
        workingDirectory,
        defaults.codexMode,
        { activeRuntime: defaults.activeRuntime },
      )
    : getOrCreateDraftSession(store, address, {
        activeRuntime: defaults.activeRuntime,
        codexModel: defaults.codexModel,
        codexMode: defaults.codexMode,
        workingDirectory: defaults.workspace,
      });

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  return store.upsertChannelChat({
    channelType: address.channelType,
    chatId: address.chatId,
    chatKind: address.chatKind,
    chatUserId: address.userId,
    bridgeSessionId: session.id,
  });
}

/**
 * Bind an IM chat to an existing BridgeSession.
 */
export function bindToSession(
  address: ChannelAddress,
  bridgeSessionId: string,
): ChannelChat | null {
  return new SessionRegistryService(getBridgeContext().store)
    .bindChatToBridgeSession(address, bridgeSessionId);
}

/**
 * Bind an IM chat to an existing Codex thread, importing it into the bridge store on demand.
 */
export function bindToCodexThread(
  address: ChannelAddress,
  codexThreadId: string,
  opts?: { workingDirectory?: string; model?: string; displayName?: string; name?: string; codexTitle?: string },
): ChannelChat {
  return new SessionRegistryService(getBridgeContext().store)
    .importCodexThreadForChat(address, codexThreadId, opts);
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelChat, 'chatUserId' | 'bridgeSessionId'>>,
): void {
  getBridgeContext().store.updateChannelChat(id, updates);
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelChat[] {
  return getBridgeContext().store.listChannelChats(channelType);
}
