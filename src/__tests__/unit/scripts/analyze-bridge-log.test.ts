import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('analyze-bridge-log Feishu request schema', () => {
  it('reads canonical fields, keeps legacy compatibility, and excludes request-start records', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-log-analysis-'));
    const logPath = path.join(tempDir, 'bridge.log');
    const outDir = path.join(tempDir, 'out');
    const entries = [
      {
        time: '2026-07-28T00:00:00.000Z',
        event: 'perf.feishu.request',
        status: 'start',
        operation: 'card.create',
        duration_ms: 0,
      },
      {
        time: '2026-07-28T00:00:01.000Z',
        event: 'perf.feishu.request',
        status: 'success',
        operation: 'card.create',
        response_card_id: 'card-new',
        duration_ms: 40,
      },
      {
        time: '2026-07-28T00:00:02.000Z',
        event: 'perf.feishu.request',
        phase: 'success',
        target: 'card.update',
        cardId: 'card-legacy',
        duration_ms: 60,
      },
    ];
    fs.writeFileSync(logPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    try {
      const stdout = execFileSync(process.execPath, [
        path.resolve('scripts/analyze-bridge-log.js'),
        '--log', logPath,
        '--out', outDir,
      ], { encoding: 'utf8' });
      const result = JSON.parse(stdout) as {
        feishuRequests: number;
        topFeishuOperation: { key: string; count: number; total_ms: number };
      };

      assert.equal(result.feishuRequests, 2);
      assert.equal(result.topFeishuOperation.key, 'card.update');
      assert.equal(result.topFeishuOperation.count, 1);
      assert.equal(result.topFeishuOperation.total_ms, 60);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
