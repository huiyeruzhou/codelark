import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createMigrationContext,
  resolveMigrationPaths,
  runConfigMigrations,
  type ConfigMigration,
} from '../../../configuration/migrations/index.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-migrations-'));
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

describe('config migration runner', () => {
  it('applies a detected migration once and records migration state', () => {
    const home = tempHome();
    try {
      const marker = path.join(home, 'legacy.txt');
      writeFile(marker, 'legacy');
      let applyCount = 0;
      const migration: ConfigMigration = {
        id: 'v1',
        description: 'test migration',
        fromVersion: 1,
        toVersion: 2,
        detect: () => fs.existsSync(marker),
        apply: (context) => {
          applyCount += 1;
          context.writeJsonAtomic(path.join(home, 'result.json'), { ok: true });
          return { changed: true, writtenFiles: [path.join(home, 'result.json')] };
        },
      };

      const first = runConfigMigrations({
        codelarkHome: home,
        migrations: [migration],
        now: () => new Date('2026-06-06T13:00:00.000Z'),
      });
      const second = runConfigMigrations({
        codelarkHome: home,
        migrations: [migration],
        now: () => new Date('2026-06-06T13:01:00.000Z'),
      });

      assert.equal(applyCount, 1);
      assert.equal(first.changed, true);
      assert.deepEqual(first.applied, [{
        id: 'v1',
        appliedAt: '2026-06-06T13:00:00.000Z',
        fromVersion: 1,
        toVersion: 2,
      }]);
      assert.equal(second.changed, false);
      assert.deepEqual(second.skipped, [{ id: 'v1', reason: 'already-applied' }]);

      const state = JSON.parse(fs.readFileSync(resolveMigrationPaths(home).migrationState, 'utf-8')) as unknown;
      assert.deepEqual(state, {
        schemaVersion: 1,
        applied: [{
          id: 'v1',
          appliedAt: '2026-06-06T13:00:00.000Z',
          fromVersion: 1,
          toVersion: 2,
        }],
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips migrations whose detect hook returns false', () => {
    const home = tempHome();
    try {
      const migration: ConfigMigration = {
        id: 'v1',
        description: 'not detected',
        fromVersion: 1,
        toVersion: 2,
        detect: () => false,
        apply: () => {
          throw new Error('must not run');
        },
      };

      const result = runConfigMigrations({ codelarkHome: home, migrations: [migration] });

      assert.equal(result.changed, false);
      assert.deepEqual(result.applied, []);
      assert.deepEqual(result.skipped, [{ id: 'v1', reason: 'not-detected' }]);
      assert.equal(fs.existsSync(resolveMigrationPaths(home).migrationState), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not mark failed migrations as applied', () => {
    const home = tempHome();
    try {
      const migration: ConfigMigration = {
        id: 'v1',
        description: 'fails',
        fromVersion: 1,
        toVersion: 2,
        detect: () => true,
        apply: () => {
          throw new Error('boom');
        },
      };

      assert.throws(
        () => runConfigMigrations({ codelarkHome: home, migrations: [migration] }),
        /boom/,
      );
      assert.equal(fs.existsSync(resolveMigrationPaths(home).migrationState), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('provides atomic JSON/TOML writes and idempotent per-migration backups', () => {
    const home = tempHome();
    try {
      const source = path.join(home, 'config.json');
      writeFile(source, '{"runtime":{"provider":"codex"}}');
      const context = createMigrationContext(home);

      const backup1 = context.backupFile(source, 'v1');
      writeFile(source, '{"runtime":{"provider":"claude"}}');
      const backup2 = context.backupFile(source, 'v1');
      context.writeJsonAtomic(path.join(home, 'runtime', 'written.json'), { ok: true });
      context.writeTomlAtomic(path.join(home, 'config', 'sessions', 's1.toml'), {
        runtime: { provider: 'codex' },
      });

      assert.equal(backup1, backup2);
      assert.equal(fs.readFileSync(backup1!, 'utf-8'), '{"runtime":{"provider":"codex"}}');
      assert.deepEqual(
        context.readJson(path.join(home, 'runtime', 'written.json')),
        { ok: true },
      );
      assert.match(
        fs.readFileSync(path.join(home, 'config', 'sessions', 's1.toml'), 'utf-8'),
        /\[runtime\]\nprovider = "codex"/,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not apply v1 migration when legacy Claude permissionMode needs product confirmation', () => {
    const home = tempHome();
    try {
      const paths = resolveMigrationPaths(home);
      writeFile(paths.legacyConfigJson, JSON.stringify({
        schemaVersion: 1,
        runtime: {
          provider: 'claude',
          claude: {
            permissionMode: 'plan',
          },
        },
        channels: [],
      }));

      assert.throws(
        () => runConfigMigrations({ codelarkHome: home }),
        /Cannot migrate legacy Claude permissionMode=plan/,
      );
      assert.equal(fs.existsSync(paths.homeToml), false);
      assert.equal(fs.existsSync(paths.migrationState), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not apply v1 session migration when legacy session Claude permissionMode needs product confirmation', () => {
    const home = tempHome();
    try {
      const paths = resolveMigrationPaths(home);
      writeFile(paths.dataSessionsJson, JSON.stringify({
        'session-needs-confirmation': {
          id: 'session-needs-confirmation',
          runtime: {
            activeRuntime: 'claude',
            claude: {
              sessionId: 'claude-session',
              permissionMode: 'plan',
            },
          },
        },
      }));

      assert.throws(
        () => runConfigMigrations({ codelarkHome: home }),
        /Cannot migrate legacy Claude permissionMode=plan/,
      );
      assert.equal(fs.existsSync(path.join(paths.sessionConfigDir, 'session-needs-confirmation.toml')), false);
      assert.equal(fs.existsSync(paths.migrationState), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
