export type RuntimeSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type RuntimeReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export function parseSandboxMode(value: string | null | undefined): RuntimeSandboxMode | undefined {
  if (
    value === 'read-only'
    || value === 'workspace-write'
    || value === 'danger-full-access'
  ) {
    return value;
  }
  return undefined;
}

export function normalizeSandboxMode(
  value: string | null | undefined,
  fallback: RuntimeSandboxMode = 'workspace-write',
): RuntimeSandboxMode {
  return parseSandboxMode(value) || fallback;
}

export function parseReasoningEffort(value: string | null | undefined): RuntimeReasoningEffort | undefined {
  if (
    value === 'minimal'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
  ) {
    return value;
  }
  return undefined;
}

export function normalizeReasoningEffort(
  value: string | null | undefined,
  fallback: RuntimeReasoningEffort = 'medium',
): RuntimeReasoningEffort {
  return parseReasoningEffort(value) || fallback;
}

export function normalizeChannelId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'channel';
}
