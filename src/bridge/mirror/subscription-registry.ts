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
    activeRuntime?: 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode';
    codex?: {
      threadId?: string | null;
    };
    claude?: {
      sessionId?: string | null;
      cwd?: string | null;
    };
    kimi?: {
      sessionId?: string | null;
      cwd?: string | null;
    };
    cursor?: {
      sessionId?: string | null;
      cwd?: string | null;
    };
    zcode?: {
      sessionId?: string | null;
      cwd?: string | null;
    };
  };
}

export interface MirrorSubscriptionRegistryPlan<TBinding extends MirrorRegistryBinding> {
  upsertBindings: TBinding[];
  removeBindingIds: string[];
  rejectedDuplicateBindings: Array<{ kept: TBinding; rejected: TBinding }>;
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
  hasSessionMirrorSource: (session: MirrorRegistrySession | null | undefined) => boolean,
  options: MirrorSubscriptionRegistryOptions = {},
): MirrorSubscriptionRegistryPlan<TBinding> {
  const activeChannels = new Set(activeChannelTypes);
  const eligibleBindings = bindings.filter((binding) => {
    if (!activeChannels.has(binding.channelType)) return false;
    if (binding.chatId?.startsWith('doc:')) return false;
    const session = getSession(binding.bridgeSessionId);
    return hasSessionMirrorSource(session);
  });
  const canonicalBindingBySessionId = new Map<string, TBinding>();
  for (const binding of eligibleBindings) {
    const selected = canonicalBindingBySessionId.get(binding.bridgeSessionId);
    if (!selected) {
      canonicalBindingBySessionId.set(binding.bridgeSessionId, binding);
      continue;
    }
    const selectedCreatedAt = Date.parse(selected.createdAt || '');
    const bindingCreatedAt = Date.parse(binding.createdAt || '');
    const bindingIsOlder = Number.isFinite(bindingCreatedAt)
      && (!Number.isFinite(selectedCreatedAt) || bindingCreatedAt < selectedCreatedAt);
    if (bindingIsOlder) {
      canonicalBindingBySessionId.set(binding.bridgeSessionId, binding);
    }
  }
  const upsertBindings = eligibleBindings.filter((binding) => (
    canonicalBindingBySessionId.get(binding.bridgeSessionId)?.id === binding.id
  ));
  const rejectedDuplicateBindings = eligibleBindings
    .filter((binding) => canonicalBindingBySessionId.get(binding.bridgeSessionId)?.id !== binding.id)
    .map((rejected) => ({
      kept: canonicalBindingBySessionId.get(rejected.bridgeSessionId)!,
      rejected,
    }));
  const desiredIds = new Set(upsertBindings.map((binding) => binding.id));
  const removeBindingIds = Array.from(existingBindingIds).filter((bindingId) => !desiredIds.has(bindingId));

  return {
    upsertBindings,
    removeBindingIds,
    rejectedDuplicateBindings,
  };
}
