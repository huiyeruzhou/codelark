import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  compareVersions,
  createDailyVersionChecker,
  createFileVersionCheckStateStore,
  type VersionCheckState,
  type VersionCheckStateStore,
} from '../../../../bridge/update/version-check.js';
import { resolveInstalledCodelarkVersion } from '../../../../bridge/update/installed-version.js';

class MemoryStateStore implements VersionCheckStateStore {
  reads = 0;
  writes: VersionCheckState[] = [];

  constructor(public state: VersionCheckState) {}

  read(): VersionCheckState {
    this.reads += 1;
    return { ...this.state };
  }

  write(state: VersionCheckState): void {
    this.state = { ...state };
    this.writes.push({ ...state });
  }
}

const emptyState = (): VersionCheckState => ({
  latestVersion: null,
  ignoredUntilVersion: null,
  lastCheckedDate: null,
});

describe('daily CodeLark version check', () => {
  it('reads state at startup, then checks once on the first message of a local calendar day', async () => {
    const store = new MemoryStateStore(emptyState());
    let fetches = 0;
    const checker = createDailyVersionChecker({
      currentVersion: '1.2.3',
      stateStore: store,
      fetchLatestVersion: async () => {
        fetches += 1;
        return '1.3.0';
      },
      now: () => new Date(2026, 6, 25, 9, 0, 0),
      disabled: () => false,
    });

    assert.equal(store.reads, 1, 'state I/O belongs to runtime startup, not the first message');
    assert.deepEqual(await checker.checkOnFirstMessage(), {
      currentVersion: '1.2.3',
      latestVersion: '1.3.0',
    });
    assert.equal(await checker.checkOnFirstMessage(), null);
    assert.equal(store.reads, 1);
    assert.equal(fetches, 1);
    assert.deepEqual(store.state, {
      latestVersion: '1.3.0',
      ignoredUntilVersion: null,
      lastCheckedDate: '2026-07-25',
    });
  });

  it('does not repeat registry I/O after a same-day process restart', async () => {
    const store = new MemoryStateStore({
      latestVersion: '1.3.0',
      ignoredUntilVersion: null,
      lastCheckedDate: '2026-07-25',
    });
    let fetches = 0;
    const checker = createDailyVersionChecker({
      currentVersion: '1.2.3',
      stateStore: store,
      fetchLatestVersion: async () => {
        fetches += 1;
        return '1.3.0';
      },
      now: () => new Date(2026, 6, 25, 18, 0, 0),
      disabled: () => false,
    });

    assert.equal(await checker.checkOnFirstMessage(), null);
    assert.equal(await checker.checkOnFirstMessage(), null);
    assert.equal(store.reads, 1);
    assert.equal(fetches, 0);
  });

  it('suppresses an ignored version and prompts again only for a higher version', async () => {
    const store = new MemoryStateStore({
      latestVersion: '1.3.0',
      ignoredUntilVersion: '1.3.0',
      lastCheckedDate: '2026-07-24',
    });
    let day = 25;
    let latest = '1.3.0';
    const checker = createDailyVersionChecker({
      currentVersion: '1.2.3',
      stateStore: store,
      fetchLatestVersion: async () => latest,
      now: () => new Date(2026, 6, day, 9, 0, 0),
      disabled: () => false,
    });

    assert.equal(await checker.checkOnFirstMessage(), null);
    day = 26;
    latest = '1.3.1';
    assert.deepEqual(await checker.checkOnFirstMessage(), {
      currentVersion: '1.2.3',
      latestVersion: '1.3.1',
    });
  });

  it('claims concurrent first messages before awaiting the registry', async () => {
    const store = new MemoryStateStore(emptyState());
    let release: ((version: string) => void) | undefined;
    let fetches = 0;
    const checker = createDailyVersionChecker({
      currentVersion: '1.0.0',
      stateStore: store,
      fetchLatestVersion: () => {
        fetches += 1;
        return new Promise<string>((resolve) => { release = resolve; });
      },
      now: () => new Date(2026, 6, 25, 9, 0, 0),
      disabled: () => false,
    });

    const first = checker.checkOnFirstMessage();
    const second = checker.checkOnFirstMessage();
    assert.equal(await second, null);
    assert.equal(fetches, 1);
    release?.('1.1.0');
    assert.equal((await first)?.latestVersion, '1.1.0');
  });

  it('records a failed daily registry check and does not retry on every message', async () => {
    const store = new MemoryStateStore(emptyState());
    let fetches = 0;
    const checker = createDailyVersionChecker({
      currentVersion: '1.0.0',
      stateStore: store,
      fetchLatestVersion: async () => {
        fetches += 1;
        throw new Error('offline');
      },
      now: () => new Date(2026, 6, 25, 9, 0, 0),
      disabled: () => false,
    });

    assert.equal(await checker.checkOnFirstMessage(), null);
    assert.equal(await checker.checkOnFirstMessage(), null);
    assert.equal(fetches, 1);
    assert.equal(store.state.lastCheckedDate, '2026-07-25');
  });

  it('does not access the registry when the installed version cannot be resolved', async () => {
    let fetches = 0;
    const checker = createDailyVersionChecker({
      currentVersion: null,
      stateStore: new MemoryStateStore(emptyState()),
      fetchLatestVersion: async () => {
        fetches += 1;
        return '1.0.0';
      },
      disabled: () => false,
    });
    assert.equal(await checker.checkOnFirstMessage(), null);
    assert.equal(fetches, 0);
  });

  it('writes the three-field JSON state atomically and normalizes malformed input', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-version-state-'));
    const file = path.join(home, 'version-check.json');
    try {
      fs.writeFileSync(file, '{not-json', 'utf-8');
      const store = createFileVersionCheckStateStore(file);
      assert.deepEqual(store.read(), emptyState());
      store.write({
        latestVersion: '1.2.3',
        ignoredUntilVersion: '1.2.3',
        lastCheckedDate: '2026-07-25',
      });
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), {
        latestVersion: '1.2.3',
        ignoredUntilVersion: '1.2.3',
        lastCheckedDate: '2026-07-25',
      });
      assert.deepEqual(fs.readdirSync(home).filter((name) => name.includes('.tmp-')), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('compares semantic versions and resolves the package version beside an entrypoint', () => {
    assert.ok(compareVersions('1.2.4', '1.2.3') > 0);
    assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
    assert.ok(compareVersions('1.0.0', '1.0.0-beta.2') > 0);
    assert.equal(compareVersions('1.2.3+build.2', '1.2.3+build.1'), 0);
    const packageVersion = (JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { version: string }).version;
    assert.equal(
      resolveInstalledCodelarkVersion({
        entrypoint: path.join(process.cwd(), 'dist', 'daemon.mjs'),
        cwd: '/missing',
      }),
      packageVersion,
    );
  });
});
