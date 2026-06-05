import os from 'node:os';
import path from 'node:path';

export function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function getCodexSessionsRoot(): string {
  return path.join(getCodexHome(), 'sessions');
}

export function getArchivedSessionsRoot(): string {
  return path.join(getCodexHome(), 'archived_sessions');
}

export function getSessionIndexPath(): string {
  return path.join(getCodexHome(), 'session_index.jsonl');
}

export function getCodexGlobalStatePath(): string {
  return path.join(getCodexHome(), '.codex-global-state.json');
}
