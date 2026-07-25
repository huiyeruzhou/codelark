import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../configuration/paths.js';

export const VERSION_CHECK_STATE_PATH = path.join(CODELARK_HOME, 'version-check.json');
export const VERSION_CHECK_DISABLED_ENV = 'CODELARK_DISABLE_DAILY_VERSION_CHECK';
const NPM_LATEST_URL = 'https://registry.npmjs.org/codelark/latest';
const VERSION_CHECK_TIMEOUT_MS = 8_000;

export interface VersionCheckState {
  latestVersion: string | null;
  ignoredUntilVersion: string | null;
  lastCheckedDate: string | null;
}

export interface VersionUpdateNotice {
  currentVersion: string;
  latestVersion: string;
}

export interface VersionCheckStateStore {
  read(): VersionCheckState;
  write(state: VersionCheckState): void;
}

export interface DailyVersionChecker {
  checkOnFirstMessage(): Promise<VersionUpdateNotice | null>;
  ignoreVersion(version: string): VersionCheckState;
  stateSnapshot(): VersionCheckState;
}

export interface DailyVersionCheckerDeps {
  currentVersion: string | null;
  stateStore?: VersionCheckStateStore;
  fetchLatestVersion?: () => Promise<string>;
  now?: () => Date;
  disabled?: () => boolean;
}

const EMPTY_VERSION_CHECK_STATE: VersionCheckState = {
  latestVersion: null,
  ignoredUntilVersion: null,
  lastCheckedDate: null,
};

export function normalizeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^v/iu, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(normalized)
    ? normalized
    : null;
}

function normalizedDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value.trim())
    ? value.trim()
    : null;
}

function normalizeState(value: unknown): VersionCheckState {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    latestVersion: normalizeVersion(record.latestVersion),
    ignoredUntilVersion: normalizeVersion(record.ignoredUntilVersion),
    lastCheckedDate: normalizedDate(record.lastCheckedDate),
  };
}

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parsePrerelease(value: string): Array<string | number> | null {
  const withoutBuild = value.split('+', 1)[0];
  const dash = withoutBuild.indexOf('-');
  if (dash < 0) return null;
  return withoutBuild.slice(dash + 1).split('.').map((part) => /^\d+$/u.test(part) ? Number(part) : part);
}

/** Returns a positive number when left is newer than right. */
export function compareVersions(leftValue: string, rightValue: string): number {
  const left = normalizeVersion(leftValue);
  const right = normalizeVersion(rightValue);
  if (!left || !right) return 0;
  const leftCore = left.split(/[+-]/u, 1)[0].split('.').map(Number);
  const rightCore = right.split(/[+-]/u, 1)[0].split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftCore[index] || 0) - (rightCore[index] || 0);
    if (difference !== 0) return difference;
  }

  const leftPre = parsePrerelease(left);
  const rightPre = parsePrerelease(right);
  if (leftPre === null && rightPre !== null) return 1;
  if (leftPre !== null && rightPre === null) return -1;
  if (leftPre === null || rightPre === null) return 0;
  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftPre[index];
    const b = rightPre[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a.localeCompare(b);
  }
  return 0;
}

export function createFileVersionCheckStateStore(
  filePath = VERSION_CHECK_STATE_PATH,
): VersionCheckStateStore {
  return {
    read() {
      try {
        return normalizeState(JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown);
      } catch {
        return { ...EMPTY_VERSION_CHECK_STATE };
      }
    },
    write(state) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, filePath);
    },
  };
}

export async function fetchLatestCodelarkVersion(): Promise<string> {
  const response = await fetch(NPM_LATEST_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const payload = await response.json() as { version?: unknown };
  const version = normalizeVersion(payload.version);
  if (!version) throw new Error('npm registry returned an invalid codelark version');
  return version;
}

export function createDailyVersionChecker(deps: DailyVersionCheckerDeps): DailyVersionChecker {
  const stateStore = deps.stateStore || createFileVersionCheckStateStore();
  const fetchLatestVersion = deps.fetchLatestVersion || fetchLatestCodelarkVersion;
  const now = deps.now || (() => new Date());
  const disabled = deps.disabled || (() => process.env[VERSION_CHECK_DISABLED_ENV] === '1');
  const currentVersion = normalizeVersion(deps.currentVersion);
  let state = normalizeState(stateStore.read());
  let claimedDate: string | null = null;

  const persist = (next: VersionCheckState): VersionCheckState => {
    state = normalizeState(next);
    stateStore.write(state);
    return { ...state };
  };

  return {
    async checkOnFirstMessage() {
      if (disabled() || !currentVersion) return null;
      const today = localDateKey(now());
      if (claimedDate === today) return null;
      claimedDate = today;
      if (state.lastCheckedDate === today) return null;

      let latestVersion: string;
      try {
        latestVersion = normalizeVersion(await fetchLatestVersion()) || '';
        if (!latestVersion) throw new Error('latest version is invalid');
      } catch (error) {
        persist({ ...state, lastCheckedDate: today });
        console.warn('[version-check] Daily npm registry check failed:', error instanceof Error ? error.message : String(error));
        return null;
      }

      const nextState = persist({ ...state, latestVersion, lastCheckedDate: today });
      if (compareVersions(latestVersion, currentVersion) <= 0) return null;
      if (
        nextState.ignoredUntilVersion
        && compareVersions(latestVersion, nextState.ignoredUntilVersion) <= 0
      ) {
        return null;
      }
      return { currentVersion, latestVersion };
    },

    ignoreVersion(version) {
      const normalized = normalizeVersion(version);
      if (!normalized) throw new Error('invalid version');
      return persist({ ...state, ignoredUntilVersion: normalized });
    },

    stateSnapshot() {
      return { ...state };
    },
  };
}
