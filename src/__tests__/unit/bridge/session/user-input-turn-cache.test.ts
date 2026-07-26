import '../../../setup/test-setup.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UserInputTurnCountCache } from '../../../../bridge/session/command-use-cases/user-input-turn-cache.js';

describe('UserInputTurnCountCache', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function fixture(): { cache: UserInputTurnCountCache; cachePath: string; sessionPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-turn-cache-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'runtime', 'turns.json');
    return {
      cache: new UserInputTurnCountCache(cachePath),
      cachePath,
      sessionPath: path.join(dir, 'session.jsonl'),
    };
  }

  const isUserLine = (line: string): boolean => JSON.parse(line).role === 'user';

  it('returns immediately on a cold miss and fills the exact count in the background', async () => {
    const { cache, sessionPath } = fixture();
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ role: 'user', text: 'one' }),
      JSON.stringify({ role: 'assistant', text: 'answer' }),
      JSON.stringify({ role: 'user', text: 'two' }),
      '',
    ].join('\n'));

    assert.equal(cache.get('codex', sessionPath, isUserLine), undefined);
    await cache.waitForIdle();
    assert.equal(cache.get('codex', sessionPath, isUserLine), 2);
  });

  it('counts an appended suffix without rereading the cached prefix', async () => {
    const { cache, sessionPath } = fixture();
    fs.writeFileSync(sessionPath, `${JSON.stringify({ role: 'user', text: 'one' })}\n`);
    cache.get('codex', sessionPath, isUserLine);
    await cache.waitForIdle();

    fs.appendFileSync(sessionPath, `${JSON.stringify({ role: 'user', text: 'two' })}\n`);
    assert.equal(cache.get('codex', sessionPath, isUserLine), 1);
    await cache.waitForIdle();
    assert.equal(cache.get('codex', sessionPath, isUserLine), 2);
  });

  it('persists the stat-keyed count for a fast bridge restart', async () => {
    const { cache, cachePath, sessionPath } = fixture();
    fs.writeFileSync(sessionPath, `${JSON.stringify({ role: 'user', text: 'one' })}\n`);
    cache.get('codex', sessionPath, isUserLine);
    await cache.waitForIdle();

    const restarted = new UserInputTurnCountCache(cachePath);
    assert.equal(restarted.get('codex', sessionPath, isUserLine), 1);
  });

  it('rescans a grown file when the cached snapshot ended mid-line', async () => {
    const { cache, sessionPath } = fixture();
    fs.writeFileSync(sessionPath, JSON.stringify({ role: 'user', text: 'one' }));
    cache.get('codex', sessionPath, isUserLine);
    await cache.waitForIdle();
    assert.equal(cache.get('codex', sessionPath, isUserLine), 1);

    fs.appendFileSync(sessionPath, `\n${JSON.stringify({ role: 'user', text: 'two' })}`);
    assert.equal(cache.get('codex', sessionPath, isUserLine), 1);
    await cache.waitForIdle();
    assert.equal(cache.get('codex', sessionPath, isUserLine), 2);
  });

  it('rescans a same-size rewrite instead of treating it as an append', async () => {
    const { cache, sessionPath } = fixture();
    const matchesUser = (line: string): boolean => line === 'U';
    fs.writeFileSync(sessionPath, 'U\n');
    cache.get('codex', sessionPath, matchesUser);
    await cache.waitForIdle();
    assert.equal(cache.get('codex', sessionPath, matchesUser), 1);

    fs.writeFileSync(sessionPath, 'A\n');
    const later = new Date(Date.now() + 2_000);
    fs.utimesSync(sessionPath, later, later);
    assert.equal(cache.get('codex', sessionPath, matchesUser), undefined);
    await cache.waitForIdle();
    assert.equal(cache.get('codex', sessionPath, matchesUser), 0);
  });
});
