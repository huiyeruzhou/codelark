export interface MirrorRegistryBinding {
  id: string;
  channelType: string;
  chatId?: string;
  bridgeSessionId: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
}

export interface MirrorRegistrySession {
  runtime?: {
    activeRuntime?: 'codex' | 'claude';
    codex?: {
      threadId?: string | null;
      provider?: 'sdk' | 'pty' | 'tmux' | string | null;
    };
  };
}

export interface MirrorSubscriptionRegistryPlan<TBinding extends MirrorRegistryBinding> {
  upsertBindings: TBinding[];
  removeBindingIds: string[];
}

export interface MirrorSubscriptionRegistryOptions {
  activeBindingWindowMs?: number;
  nowMs?: number;
}

function mirrorRegistryBindingActivityTime(binding: MirrorRegistryBinding): number {
  const time = Date.parse(binding.lastActivityAt || binding.updatedAt || binding.createdAt || '');
  return Number.isFinite(time) ? time : 0;
}

export function isMirrorRegistryBindingActive(
  binding: MirrorRegistryBinding,
  options: MirrorSubscriptionRegistryOptions = {},
): boolean {
  const windowMs = Math.max(0, options.activeBindingWindowMs || 0);
  if (windowMs <= 0) return true;
  const activityAt = mirrorRegistryBindingActivityTime(binding);
  if (activityAt <= 0) return false;
  const nowMs = Number.isFinite(options.nowMs || 0) ? options.nowMs! : Date.now();
  return nowMs - activityAt <= windowMs;
}

export function getMirrorRegistryBindingActivityTier(
  binding: MirrorRegistryBinding,
  options: MirrorSubscriptionRegistryOptions = {},
): 'hot' | 'cold' {
  return isMirrorRegistryBindingActive(binding, options) ? 'hot' : 'cold';
}

export function buildMirrorSubscriptionRegistryPlan<TBinding extends MirrorRegistryBinding>(
  bindings: TBinding[],
  activeChannelTypes: Iterable<string>,
  existingBindingIds: Iterable<string>,
  getSession: (sessionId: string) => MirrorRegistrySession | null | undefined,
  hasSessionMirrorSource: (session: MirrorRegistrySession | null | undefined) => boolean = (
    (session) => {
      if (session?.runtime?.activeRuntime === 'claude') return false;
      if (!session?.runtime?.codex?.threadId?.trim()) return false;
      return session.runtime.codex.provider !== 'sdk';
    }
  ),
  options: MirrorSubscriptionRegistryOptions = {},
): MirrorSubscriptionRegistryPlan<TBinding> {
  const activeChannels = new Set(activeChannelTypes);
  const upsertBindings = bindings.filter((binding) => {
    if (!activeChannels.has(binding.channelType)) return false;
    if (binding.chatId?.startsWith('doc:')) return false;
    const session = getSession(binding.bridgeSessionId);
    return hasSessionMirrorSource(session);
  });
  const desiredIds = new Set(upsertBindings.map((binding) => binding.id));
  const removeBindingIds = Array.from(existingBindingIds).filter((bindingId) => !desiredIds.has(bindingId));

  return {
    upsertBindings,
    removeBindingIds,
  };
}
