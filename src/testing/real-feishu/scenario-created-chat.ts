interface ScenarioChatLookupInput {
  bindings: unknown;
  sessions: unknown;
  requestedName: string;
  channelType: string;
  excludedChatIds?: string[];
}

function bindingValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>);
}

function sessionMap(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([id, session]) => (
    session && typeof session === 'object' && !Array.isArray(session)
      ? [[id, session as Record<string, unknown>]]
      : []
  )));
}

export function scenarioChatNameMatchesRequested(displayName: string, requestedName: string): boolean {
  const withoutBotPrefix = displayName.replace(/^\[[^\]]+\]/, '').trim();
  const visibleName = withoutBotPrefix.replace(/(?:\.\.\.|…)+$/, '').trim();
  if (!visibleName) return false;
  if (visibleName === requestedName || visibleName.includes(requestedName)) return true;

  // Feishu truncates long group names. A substantial exact prefix remains
  // deterministic because real-E2E /new names contain the unique run id.
  const minimumPrefixLength = Math.min(24, requestedName.length);
  return visibleName.length >= minimumPrefixLength && requestedName.startsWith(visibleName);
}

function firstCommandArgument(command: string, prefix: string): string {
  const trimmed = command.trim();
  if (!trimmed.startsWith(`${prefix} `)) return '';
  const rest = trimmed.slice(prefix.length).trim();
  const match = rest.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return (match?.[1] || match?.[2] || match?.[3] || '').trim();
}

export function expectedScenarioChatFinalName(input: {
  requestedName: string;
  chatId: string;
  observations: Array<{ chatId: string; sentText: string }>;
}): string {
  let expectedName = input.requestedName;
  for (const observation of input.observations) {
    if (observation.chatId !== input.chatId) continue;
    const clearedName = firstCommandArgument(observation.sentText, '/clear');
    if (clearedName) expectedName = clearedName;
    const renamedName = firstCommandArgument(observation.sentText, '/t rename');
    if (renamedName) expectedName = renamedName;
  }
  return expectedName;
}

export function findScenarioCreatedChatIdsInBindings(input: ScenarioChatLookupInput): string[] {
  const excluded = new Set(input.excludedChatIds || []);
  const sessions = sessionMap(input.sessions);
  const chatIds = new Set<string>();
  for (const value of bindingValues(input.bindings)) {
    if (!value || typeof value !== 'object') continue;
    const binding = value as Record<string, unknown>;
    const chatId = typeof binding.chatId === 'string' ? binding.chatId : '';
    const channelType = typeof binding.channelType === 'string' ? binding.channelType : '';
    const bridgeSessionId = typeof binding.bridgeSessionId === 'string' ? binding.bridgeSessionId : '';
    const session = sessions[bridgeSessionId];
    const sessionName = typeof session?.name === 'string' ? session.name : '';
    if (!chatId.startsWith('oc_') || excluded.has(chatId)) continue;
    if (channelType !== input.channelType) continue;
    if (!scenarioChatNameMatchesRequested(sessionName, input.requestedName)) continue;
    chatIds.add(chatId);
  }
  return [...chatIds];
}
