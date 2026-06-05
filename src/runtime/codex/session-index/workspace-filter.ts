import path from 'node:path';
import fs from 'node:fs';

import {
  getCodexGlobalStatePath,
  getCodexHome,
} from './paths.js';

interface CodexGlobalState {
  'electron-saved-workspace-roots'?: unknown;
}

function normalizeComparablePath(value: string): string {
  if (!value) return '';
  const stripped = value.replace(/^\\\\\?\\/, '');
  return path.resolve(stripped).replace(/[\\/]+$/, '').toLowerCase();
}

export function isInternalSkillWorkspace(cwd: string): boolean {
  const normalizedCwd = normalizeComparablePath(cwd);
  if (!normalizedCwd) return false;

  const skillsRoot = normalizeComparablePath(path.join(getCodexHome(), 'skills'));
  if (!skillsRoot) return false;

  return normalizedCwd === skillsRoot || normalizedCwd.startsWith(`${skillsRoot}\\`) || normalizedCwd.startsWith(`${skillsRoot}/`);
}

export function loadSavedWorkspaceRoots(): string[] | null {
  const statePath = getCodexGlobalStatePath();
  if (!fs.existsSync(statePath)) return null;

  let parsed: CodexGlobalState;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as CodexGlobalState;
  } catch {
    return null;
  }

  const roots = Array.isArray(parsed['electron-saved-workspace-roots'])
    ? parsed['electron-saved-workspace-roots']
        .map((value) => (typeof value === 'string' ? normalizeComparablePath(value) : ''))
        .filter(Boolean)
    : [];

  return roots.length > 0 ? roots : null;
}

export function isWithinSavedWorkspaceRoots(cwd: string, roots: string[] | null): boolean {
  if (!roots || roots.length === 0) return true;
  const normalizedCwd = normalizeComparablePath(cwd);
  if (!normalizedCwd) return false;

  return roots.some((root) =>
    normalizedCwd === root || normalizedCwd.startsWith(`${root}\\`) || normalizedCwd.startsWith(`${root}/`));
}
