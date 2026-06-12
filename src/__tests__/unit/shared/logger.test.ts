import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatConsoleLogArgs, formatLogArg, maskSecrets, maskStructuredLogLine } from '../../../shared/logger.js';

describe('maskSecrets', () => {
  it('masks supported secret patterns while preserving non-secret text and suffixes', () => {
    const cases = [
      ['token=secret123456789', 'secret123456789'],
      ['secret=my-secret-value', 'my-secret-value'],
      ['password=hunter2abc', 'hunter2abc'],
      ['api_key=sk-abcdef123456', 'sk-abcdef123456'],
      ['Using bot token bot1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ12345678a', 'bot1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ12345678a'],
      ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.signature', 'Bearer eyJhbGciOiJIUzI1NiJ9.test.signature'],
      ['token="my-secret-token"', 'my-secret-token'],
    ];

    for (const [input, leaked] of cases) {
      const result = maskSecrets(input);
      assert.notEqual(result, input);
      assert.ok(!result.includes(leaked), `${leaked} should be masked`);
    }

    const input = 'Starting bridge on port 8080';
    assert.equal(maskSecrets(input), input);

    const result = maskSecrets('token=abcdefghijklmnop');
    assert.ok(result.includes('mnop'));
  });
});

describe('formatLogArg', () => {
  it('serializes Error objects with their message', () => {
    const formatted = formatLogArg(new Error('boom'));
    assert.match(formatted, /boom/);
    assert.match(formatted, /Error/);
  });

  it('falls back to inspect for circular objects', () => {
    const value: { self?: unknown; ok: boolean } = { ok: true };
    value.self = value;
    const formatted = formatLogArg(value);
    assert.match(formatted, /ok/);
    assert.match(formatted, /Circular/i);
  });
});

describe('formatConsoleLogArgs', () => {
  it('preserves structured fields from prefixed console object logs', () => {
    const payload = formatConsoleLogArgs([
      '[feishu-adapter] Streaming sync plan:',
      {
        event: 'perf.card.sync_plan',
        stream_key: 'stream-1',
        duration_ms: 123,
      },
    ]);

    assert.equal(payload.message, 'Streaming sync plan:');
    assert.deepEqual(payload.fields, {
      source: 'console',
      name: 'feishu-adapter',
      event: 'perf.card.sync_plan',
      stream_key: 'stream-1',
      duration_ms: 123,
    });
  });

  it('formats non-object console logs as a plain source-tagged message', () => {
    const payload = formatConsoleLogArgs(['plain', 'value', 'tail']);

    assert.equal(payload.message, 'plain value tail');
    assert.deepEqual(payload.fields, { source: 'console' });
  });
});

describe('maskStructuredLogLine', () => {
  it('masks secret object fields without breaking JSON structure', () => {
    const line = JSON.stringify({
      level: 'INFO',
      time: '2026-06-05T00:00:00.000Z',
      token: 'abcdefghijklmnop',
      nested: { appSecret: 'my-secret-value' },
      msg: 'started',
    }) + '\n';

    const result = maskStructuredLogLine(line);
    const parsed = JSON.parse(result) as {
      token: string;
      nested: { appSecret: string };
      msg: string;
    };

    assert.equal(parsed.token, '************mnop');
    assert.equal(parsed.nested.appSecret, '***********alue');
    assert.equal(parsed.msg, 'started');
    assert.ok(result.endsWith('\n'));
  });

  it('masks secrets embedded in structured message strings', () => {
    const line = JSON.stringify({
      level: 'INFO',
      msg: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.signature',
    });

    const result = maskStructuredLogLine(line);
    const parsed = JSON.parse(result) as { msg: string };

    assert.doesNotMatch(parsed.msg, /Bearer eyJhbGciOiJIUzI1NiJ9\.test\.signature/);
    assert.match(parsed.msg, /ture$/);
  });
});
