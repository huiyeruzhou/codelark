import path from 'node:path';

import {
  getCodexHome,
} from './paths.js';

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
