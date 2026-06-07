import {
  reasoningEffortSchema,
  sandboxModeSchema,
} from '../configuration/schema.js';
import type { z } from 'zod';

export type RuntimeSandboxMode = z.infer<typeof sandboxModeSchema>;
export type RuntimeReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type CodexSandboxMode = RuntimeSandboxMode;
export type CodexReasoningEffort = RuntimeReasoningEffort;
export type RuntimeProvider = 'codex' | 'claude';
export type CodexProviderChoice = 'sdk' | 'tmux' | 'pty';
export type ClaudeProviderChoice = 'pty' | 'sdk' | 'tmux';
export type ClaudeExecutable = 'claude' | 'ccr';
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export function parseSandboxMode(value: string | null | undefined): RuntimeSandboxMode | undefined {
  return sandboxModeSchema.safeParse(value).data;
}

export function normalizeSandboxMode(
  value: string | null | undefined,
  fallback: RuntimeSandboxMode = 'workspace-write',
): RuntimeSandboxMode {
  return parseSandboxMode(value) || fallback;
}

export function parseReasoningEffort(value: string | null | undefined): RuntimeReasoningEffort | undefined {
  return reasoningEffortSchema.safeParse(value).data;
}

export function normalizeReasoningEffort(
  value: string | null | undefined,
  fallback: RuntimeReasoningEffort = 'medium',
): RuntimeReasoningEffort {
  return parseReasoningEffort(value) || fallback;
}

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
  if (normalized === 'sdk' || normalized === 'pty' || normalized === 'tmux') return normalized;
  return 'tmux';
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
