import fs from 'node:fs';

function validTimeZone(candidate: string | null | undefined): string | null {
  const value = (candidate || '').trim().replace(/^:/, '');
  if (!value || value.startsWith('/')) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return value;
  } catch {
    return null;
  }
}

function timeZoneFromLocaltimePath(localtimePath: string): string | null {
  const marker = 'zoneinfo/';
  const index = localtimePath.lastIndexOf(marker);
  return index >= 0 ? validTimeZone(localtimePath.slice(index + marker.length)) : null;
}

function detectSystemTimeZone(): string {
  const shellTimeZone = validTimeZone(process.env.TZ);
  if (shellTimeZone) return shellTimeZone;

  const runtimeTimeZone = validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return runtimeTimeZone || 'UTC';
  }

  try {
    const linuxTimeZone = validTimeZone(fs.readFileSync('/etc/timezone', 'utf8'));
    if (linuxTimeZone) return linuxTimeZone;
  } catch {
    // macOS and some minimal Linux images do not provide /etc/timezone.
  }

  try {
    const linkedTimeZone = timeZoneFromLocaltimePath(fs.realpathSync('/etc/localtime'));
    if (linkedTimeZone) return linkedTimeZone;
  } catch {
    // Fall through to the runtime's platform default.
  }

  return runtimeTimeZone || 'UTC';
}

const SYSTEM_TIME_ZONE = detectSystemTimeZone();

export function resolveSystemTimeZone(): string {
  return SYSTEM_TIME_ZONE;
}

export const _testOnly = {
  timeZoneFromLocaltimePath,
  validTimeZone,
};
