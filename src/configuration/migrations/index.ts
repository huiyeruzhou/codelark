import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import type {
  ConfigMigration,
  ConfigMigrationState,
  ConfigMigrationStateEntry,
  MigrationContext,
  MigrationPaths,
  RunConfigMigrationsResult,
} from './types.js';

export type {
  ConfigMigration,
  ConfigMigrationState,
  ConfigMigrationStateEntry,
  MigrationContext,
  MigrationPaths,
  MigrationResult,
  RunConfigMigrationsResult,
} from './types.js';

export interface RunConfigMigrationsOptions {
  codelarkHome: string;
  migrations?: ConfigMigration[];
  now?: () => Date;
}

const EMPTY_STATE: ConfigMigrationState = {
  schemaVersion: 1,
  applied: [],
};

export const configMigrations: ConfigMigration[] = [];

function atomicWriteText(filePath: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content, { mode });
  fs.renameSync(tmpPath, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  atomicWriteText(filePath, JSON.stringify(value, null, 2), 0o600);
}

function normalizeState(value: unknown): ConfigMigrationState {
  if (!value || typeof value !== 'object') return { ...EMPTY_STATE, applied: [] };
  const record = value as Partial<ConfigMigrationState>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.applied)) {
    return { ...EMPTY_STATE, applied: [] };
  }
  return {
    schemaVersion: 1,
    applied: record.applied.filter((entry): entry is ConfigMigrationStateEntry => (
      Boolean(entry)
      && typeof entry === 'object'
      && typeof entry.id === 'string'
      && /^v\d+$/.test(entry.id)
      && typeof entry.appliedAt === 'string'
      && Number.isInteger(entry.fromVersion)
      && Number.isInteger(entry.toVersion)
    )),
  };
}

export function resolveMigrationPaths(codelarkHome: string): MigrationPaths {
  return {
    legacyConfigJson: path.join(codelarkHome, 'config.json'),
    legacyConfigEnv: path.join(codelarkHome, 'config.env'),
    homeToml: path.join(codelarkHome, 'config.toml'),
    dataSessionsJson: path.join(codelarkHome, 'data', 'sessions.json'),
    channelConfigDir: path.join(codelarkHome, 'config', 'channels'),
    sessionConfigDir: path.join(codelarkHome, 'config', 'sessions'),
    migrationState: path.join(codelarkHome, 'runtime', 'config-migrations.json'),
    backupDir: path.join(codelarkHome, 'backups', 'config-migrations'),
  };
}

function backupRelativePath(codelarkHome: string, filePath: string): string {
  const relative = path.relative(codelarkHome, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  return path.basename(filePath);
}

export function createMigrationContext(codelarkHome: string): MigrationContext {
  const paths = resolveMigrationPaths(codelarkHome);
  return {
    codelarkHome,
    paths,
    readToml(filePath: string): unknown {
      return parse(fs.readFileSync(filePath, 'utf-8'));
    },
    writeTomlAtomic(filePath: string, value: unknown): void {
      atomicWriteText(filePath, stringify(value), 0o600);
    },
    readJson,
    writeJsonAtomic,
    backupFile(filePath: string, migrationId: `v${number}`): string | null {
      if (!fs.existsSync(filePath)) return null;
      const backupPath = path.join(paths.backupDir, migrationId, backupRelativePath(codelarkHome, filePath));
      if (!fs.existsSync(backupPath)) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(filePath, backupPath);
      }
      return backupPath;
    },
  };
}

function readMigrationState(filePath: string): ConfigMigrationState {
  return normalizeState(readJson<ConfigMigrationState>(filePath));
}

function writeMigrationState(filePath: string, state: ConfigMigrationState): void {
  writeJsonAtomic(filePath, state);
}

export function runConfigMigrations(options: RunConfigMigrationsOptions): RunConfigMigrationsResult {
  const migrations = options.migrations ?? configMigrations;
  const context = createMigrationContext(options.codelarkHome);
  const state = readMigrationState(context.paths.migrationState);
  const appliedIds = new Set(state.applied.map((entry) => entry.id));
  const applied: ConfigMigrationStateEntry[] = [];
  const skipped: RunConfigMigrationsResult['skipped'] = [];
  const warnings: string[] = [];

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      skipped.push({ id: migration.id, reason: 'already-applied' });
      continue;
    }
    if (!migration.detect(context)) {
      skipped.push({ id: migration.id, reason: 'not-detected' });
      continue;
    }

    const result = migration.apply(context);
    warnings.push(...(result.warnings || []));
    const entry: ConfigMigrationStateEntry = {
      id: migration.id,
      appliedAt: (options.now?.() || new Date()).toISOString(),
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
    };
    state.applied.push(entry);
    appliedIds.add(migration.id);
    applied.push(entry);
    writeMigrationState(context.paths.migrationState, state);
  }

  return {
    changed: applied.length > 0,
    applied,
    skipped,
    warnings,
  };
}
