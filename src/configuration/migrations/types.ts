// migration 公共类型：描述迁移输入路径、状态文件和迁移执行结果。
// 具体旧格式解析放在 migrations/legacy/*，避免污染当前配置 schema。

export interface ConfigMigrationStateEntry {
  id: `v${number}`;
  appliedAt: string;
  fromVersion: number;
  toVersion: number;
}

export interface ConfigMigrationState {
  schemaVersion: 1;
  applied: ConfigMigrationStateEntry[];
}

export interface MigrationPaths {
  legacyConfigJson: string;
  legacyConfigEnv: string;
  homeToml: string;
  dataSessionsJson: string;
  channelConfigDir: string;
  sessionConfigDir: string;
  migrationState: string;
  backupDir: string;
}

export interface MigrationContext {
  codelarkHome: string;
  paths: MigrationPaths;
  readToml(path: string): unknown;
  writeTomlAtomic(path: string, value: unknown): void;
  readJson<T>(path: string): T | null;
  writeJsonAtomic(path: string, value: unknown): void;
  backupFile(path: string, migrationId: string): string | null;
}

export interface MigrationResult {
  changed: boolean;
  writtenFiles?: string[];
  backedUpFiles?: string[];
  warnings?: string[];
}

export interface ConfigMigration {
  id: `v${number}`;
  description: string;
  fromVersion: number;
  toVersion: number;
  detect(context: MigrationContext): boolean;
  apply(context: MigrationContext): MigrationResult;
}

export interface RunConfigMigrationsResult {
  changed: boolean;
  applied: ConfigMigrationStateEntry[];
  skipped: Array<{ id: `v${number}`; reason: 'already-applied' | 'not-detected' }>;
  warnings: string[];
}
