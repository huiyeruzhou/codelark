import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCodexSessionByThreadId, listCodexSessions } from '../../../../runtime/codex/session-index.js';

it('bounds history reads by the requested page and keeps activity, filtering and direct lookup fresh', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-discovery-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const dir = path.join(home, 'sessions', '2026', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  const id = (n: number) => `01234567-1234-1234-1234-${String(n).padStart(12, '0')}`;
  const timestamp = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 1000);
  const write = (n: number, payload: object = {}, name = `rollout-${id(n)}.jsonl`) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: id(n), cwd: '/repo', ...payload } }) + '\n');
    fs.utimesSync(file, timestamp(n), timestamp(n));
    return file;
  };
  const old = write(0);
  for (let n = 1; n < 1000; n++) write(n);
  const opens: string[] = [];
  const originalOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).startsWith(dir)) opens.push(String(args[0]));
    return originalOpen(...args);
  });

  assert.deepEqual(listCodexSessions(5).map(s => s.threadId), [999, 998, 997, 996, 995].map(id));
  assert.equal(new Set(opens).size, 5, 'old history bodies must not be opened for a recent page');
  opens.length = 0;
  assert.equal(getCodexSessionByThreadId(id(0))?.filePath, old, 'cold exact lookup also reaches an old session');
  assert.deepEqual([...new Set(opens)], [old]);
  opens.length = 0;
  assert.equal(getCodexSessionByThreadId(id(5000)), null);
  assert.equal(opens.length, 0, 'an unrelated runtime ID must not read any native rollout body');

  fs.appendFileSync(old, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Resumed old work' } }) + '\n');
  fs.utimesSync(old, timestamp(2000), timestamp(2000));
  assert.equal(listCodexSessions(1)[0]?.threadId, id(0), 'sort by current activity, not filename date');
  assert.equal(listCodexSessions(1)[0]?.title, 'Resumed old work');
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: id(0), thread_name: 'Renamed', updated_at: timestamp(2001).toISOString() }) + '\n');
  assert.equal(listCodexSessions(1)[0]?.title, 'Renamed', 'native title changes must be visible immediately');

  fs.mkdirSync(path.join(home, 'archived_sessions'));
  fs.writeFileSync(path.join(home, 'archived_sessions', `rollout-${id(0)}.jsonl`), '');
  assert.equal(getCodexSessionByThreadId(id(0)), null, 'archive invalidates a previous lookup');
  write(3000, { source: { subagent: { parent_thread_id: id(0) } } });
  write(3001, { cwd: path.join(home, 'skills', 'internal') });
  const damaged = write(3002);
  fs.writeFileSync(damaged, '{incomplete');
  fs.utimesSync(damaged, timestamp(3002), timestamp(3002));
  const vanished = write(3003);
  const originalStat = fs.statSync;
  t.mock.method(fs, 'statSync', ((...args: Parameters<typeof fs.statSync>) => {
    const stat = originalStat(...args);
    if (String(args[0]) === vanished && fs.existsSync(vanished)) fs.unlinkSync(vanished);
    return stat;
  }) as typeof fs.statSync);
  assert.deepEqual(listCodexSessions(2).map(s => s.threadId), [id(999), id(998)], 'excluded and disappeared files do not consume page slots');

  const legacy = write(4000, {}, 'imported-history.jsonl');
  assert.equal(getCodexSessionByThreadId(id(4000))?.filePath, legacy, 'nonstandard imported filenames remain discoverable');
  fs.unlinkSync(legacy);
  assert.equal(getCodexSessionByThreadId(id(4000)), null, 'deletion invalidates exact lookup');
});

it('returns each thread once using its most recently active rollout', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-discovery-duplicates-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const dir = path.join(home, 'sessions'); fs.mkdirSync(dir);
  const id = '01234567-1234-1234-1234-123456789abc';
  for (const [prefix, ms] of [['a', 2000], ['z', 1000]] as const) {
    const file = path.join(dir, `${prefix}-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd: `/repo/${prefix}` } }));
    fs.utimesSync(file, new Date(ms), new Date(ms));
  }
  assert.equal(getCodexSessionByThreadId(id)?.cwd, '/repo/a');
  assert.deepEqual(listCodexSessions().map(s => s.cwd), ['/repo/a']);
});
