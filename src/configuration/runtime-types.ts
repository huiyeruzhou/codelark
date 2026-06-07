import type {
  RuntimeReasoningEffort,
  RuntimeSandboxMode,
} from './runtime-options.js';

export type CodexSandboxMode = RuntimeSandboxMode;
export type CodexReasoningEffort = RuntimeReasoningEffort;
export type RuntimeProvider = 'codex' | 'claude';
export type CodexProviderChoice = 'sdk' | 'tmux' | 'pty';
export type ClaudeProviderChoice = 'pty' | 'sdk';
export type ClaudeExecutable = 'claude' | 'ccr';
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export function normalizeRuntimeProvider(value: unknown): RuntimeProvider {
  return typeof value === 'string' && value.trim().toLowerCase() === 'claude' ? 'claude' : 'codex';
}

export function normalizeCodexProviderChoice(value: unknown): CodexProviderChoice | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'sdk' || normalized === 'tmux' || normalized === 'pty') return normalized;
  return 'tmux';
}

export function normalizeClaudeProviderChoice(value: unknown): ClaudeProviderChoice | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'sdk' || normalized === 'pty') return normalized;
  return 'sdk';
}

export function normalizeClaudePermissionMode(value: unknown): ClaudePermissionMode | undefined {
  if (value === 'default' || value === 'acceptEdits' || value === 'bypassPermissions' || value === 'plan') {
    return value;
  }
  return undefined;
}

export function normalizeClaudeExecutable(value: unknown): ClaudeExecutable | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'ccr') return normalized;
  return undefined;
}
