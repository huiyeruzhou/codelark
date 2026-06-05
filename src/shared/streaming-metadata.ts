export function formatStreamContextId(value: string | null | undefined, fallback = ''): string {
  const normalized = value?.trim() || fallback.trim();
  return normalized ? normalized.slice(0, 8) : '';
}

export function buildRuntimeStreamTags(context: {
  reasoningEffort?: string | null;
  model?: string | null;
}): string[] {
  const reasoningEffort = context.reasoningEffort?.trim();
  const model = context.model?.trim();
  return [
    reasoningEffort ? `effort:${reasoningEffort}` : '',
    model ? `model:${model}` : '',
  ].filter(Boolean);
}

export function formatStreamTagLabel(tag: string): string {
  const normalized = tag.trim();
  const separatorIndex = normalized.indexOf(':');
  if (separatorIndex <= 0) return normalized;
  const prefix = normalized.slice(0, separatorIndex).toLowerCase();
  if (prefix !== 'effort' && prefix !== 'reasoning' && prefix !== 'model') return normalized;
  return normalized.slice(separatorIndex + 1) || normalized;
}

export function buildStreamContextTags(context: {
  bindingId?: string | null;
  fallbackId?: string | null;
  bridgeSessionId?: string | null;
  threadId?: string | null;
  executionProvider?: string | null;
  creatorKind?: string | null;
  source?: 'sdk' | 'mirror' | null;
}): string[] {
  const bridgeId = formatStreamContextId(context.bridgeSessionId, context.fallbackId || context.bindingId || '');
  return [
    bridgeId ? `bridge_id:${bridgeId}` : '',
    context.source === 'sdk' ? 'sdk' : '',
    context.source === 'mirror' ? 'mirror' : '',
  ].filter(Boolean);
}
