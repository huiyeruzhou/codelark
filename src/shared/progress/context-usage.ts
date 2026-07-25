export interface ContextTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface ContextUsageInfo {
  modelContextWindow?: number;
  lastTokenUsage?: ContextTokenUsage;
  totalTokenUsage?: ContextTokenUsage;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTokenUsage(value: unknown): ContextTokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const parsed: ContextTokenUsage = {
    inputTokens: readFiniteNumber(usage.input_tokens),
    cachedInputTokens: readFiniteNumber(usage.cached_input_tokens ?? usage.cache_read_input_tokens),
    outputTokens: readFiniteNumber(usage.output_tokens),
    reasoningOutputTokens: readFiniteNumber(usage.reasoning_output_tokens),
    totalTokens: readFiniteNumber(usage.total_tokens),
  };
  return Object.values(parsed).some((entry) => typeof entry === 'number') ? parsed : undefined;
}

export function parseContextUsageInfo(value: unknown): ContextUsageInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const parsed: ContextUsageInfo = {
    modelContextWindow: readFiniteNumber(raw.model_context_window),
    lastTokenUsage: readTokenUsage(raw.last_token_usage),
    totalTokenUsage: readTokenUsage(raw.total_token_usage),
  };
  return parsed.modelContextWindow != null || parsed.lastTokenUsage || parsed.totalTokenUsage
    ? parsed
    : undefined;
}

function formatWholeK(value: number): string {
  return `${Math.round(Math.max(0, value) / 1000)}k`;
}

function formatDecimalK(value: number): string {
  const normalized = Math.max(0, value) / 1000;
  if (normalized < 10 && normalized % 1 !== 0) return `${normalized.toFixed(1)}k`;
  return `${Math.round(normalized)}k`;
}

export function formatContextUsageCompactParts(info?: ContextUsageInfo | null): {
  context: string;
  lastIo: string;
} {
  if (!info) return { context: '', lastIo: '' };
  let context = '';
  const inputTokens = info.lastTokenUsage?.inputTokens ?? info.totalTokenUsage?.inputTokens;
  if (typeof inputTokens === 'number' && typeof info.modelContextWindow === 'number' && info.modelContextWindow > 0) {
    const pct = Math.round((inputTokens / info.modelContextWindow) * 100);
    context = `Context ${formatWholeK(inputTokens)}(${pct}%)`;
  }

  const turnInput = info.lastTokenUsage?.inputTokens;
  const turnOutput = info.lastTokenUsage?.outputTokens;
  const ioParts: string[] = [];
  if (typeof turnInput === 'number') ioParts.push(`↑${formatDecimalK(turnInput)}`);
  if (typeof turnOutput === 'number') ioParts.push(`↓${formatDecimalK(turnOutput)}`);
  return { context, lastIo: ioParts.join(' ') };
}

export function formatContextUsageCompact(info?: ContextUsageInfo | null): string {
  const { context, lastIo } = formatContextUsageCompactParts(info);
  return [context.replace(/^Context\s+/u, ''), lastIo].filter(Boolean).join(' · ');
}

export function appendContextUsageCompactText(text: string, info?: ContextUsageInfo | null): string {
  const contextText = formatContextUsageCompact(info);
  if (!contextText) return text;
  const line = `Context: ${contextText}`;
  const trimmed = text.trim();
  if (!trimmed) return line;
  if (trimmed.includes(contextText)) return text;
  return `${trimmed}\n\n${line}`;
}

function formatDetailedUsage(label: string, usage?: ContextTokenUsage): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens != null) {
    parts.push(`input ${usage.inputTokens.toLocaleString()}${usage.cachedInputTokens != null ? ` (cached ${usage.cachedInputTokens.toLocaleString()})` : ''}`);
  }
  if (usage.outputTokens != null) {
    parts.push(`output ${usage.outputTokens.toLocaleString()}${usage.reasoningOutputTokens != null ? ` (reasoning ${usage.reasoningOutputTokens.toLocaleString()})` : ''}`);
  }
  if (usage.totalTokens != null) parts.push(`total ${usage.totalTokens.toLocaleString()}`);
  return parts.length > 0 ? `${label}: ${parts.join(', ')}` : null;
}

export function formatContextUsageSummary(info?: ContextUsageInfo | null): string {
  if (!info) return '';
  const lines: string[] = [];
  if (info.modelContextWindow != null) {
    let line = `Context window: ${info.modelContextWindow.toLocaleString()}`;
    if (info.lastTokenUsage?.inputTokens != null && info.modelContextWindow > 0) {
      line += ` (last input: ${Math.round((info.lastTokenUsage.inputTokens / info.modelContextWindow) * 100)}%)`;
    }
    lines.push(line);
  }
  const last = formatDetailedUsage('Last', info.lastTokenUsage);
  if (last) lines.push(last);
  const total = formatDetailedUsage('Total', info.totalTokenUsage);
  if (total) lines.push(total);
  return lines.join('\n');
}
