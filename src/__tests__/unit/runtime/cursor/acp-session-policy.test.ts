import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  assertCursorAcpRestrictiveResume,
  cursorAcpSessionStorePath,
  migrateLegacyCursorCliSessionToAcp,
} from '../../../../runtime/cursor/acp-session-policy.js';

function createLegacyCursorStoreDb(
  storePath: string,
  meta: Record<string, unknown>,
  blobContent = 'hello-legacy-history',
): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const db = new DatabaseSync(storePath);
  try {
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
    const hexMeta = Buffer.from(JSON.stringify(meta), 'utf8').toString('hex');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', hexMeta);
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run('b1', Buffer.from(blobContent, 'utf8'));
  } finally {
    db.close();
  }
}

describe('cursor acp session policy & legacy CLI migration', () => {
  it('losslessly migrates a legacy CLI WAL store.db into acp-sessions without mutating the source', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-cursor-migrate-'));
    try {
      const env: NodeJS.ProcessEnv = { CURSOR_CONFIG_DIR: tmpRoot };
      const cwd = path.join(tmpRoot, 'workspace-exp');
      const sessionId = 'a0fcb6f5-df09-422c-a36c-7ad353def799';
      const cwdHash = crypto.createHash('md5').update(path.resolve(cwd)).digest('hex');
      const legacyStorePath = path.join(tmpRoot, 'chats', cwdHash, sessionId, 'store.db');

      createLegacyCursorStoreDb(legacyStorePath, {
        agentId: sessionId,
        name: 'Exp Legacy Chat',
        isRunEverything: true,
      }, 'preserved-payload-56-turns');

      const result = migrateLegacyCursorCliSessionToAcp(sessionId, cwd, env);
      assert.equal(result.migrated, true);
      assert.equal(result.alreadyPresent, false);
      assert.equal(result.runEverything, true);

      const acpStorePath = cursorAcpSessionStorePath(sessionId, env);
      assert.equal(result.storePath, acpStorePath);
      assert.ok(fs.existsSync(acpStorePath));
      assert.ok(fs.existsSync(legacyStorePath), 'original legacy CLI store.db must remain untouched');

      const metaJson = JSON.parse(fs.readFileSync(path.join(path.dirname(acpStorePath), 'meta.json'), 'utf8'));
      assert.equal(metaJson.schemaVersion, 1);
      assert.equal(metaJson.cwd, path.resolve(cwd));
      assert.equal(metaJson.title, 'Exp Legacy Chat');

      const copiedDb = new DatabaseSync(acpStorePath, { readOnly: true });
      try {
        const blob = copiedDb.prepare('SELECT data FROM blobs WHERE id = ?').get('b1') as { data: Uint8Array } | undefined;
        assert.equal(Buffer.from(blob!.data).toString('utf8'), 'preserved-payload-56-turns');
      } finally {
        copiedDb.close();
      }

      assert.throws(() => assertCursorAcpRestrictiveResume(sessionId, env), /Run Everything/);

      // Second call is idempotent and recognizes existing ACP store
      const second = migrateLegacyCursorCliSessionToAcp(sessionId, cwd, env);
      assert.equal(second.migrated, true);
      assert.equal(second.alreadyPresent, true);
      assert.equal(second.runEverything, true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('finds legacy CLI store via fallback scan when cwd hash does not match', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-cursor-migrate-scan-'));
    try {
      const env: NodeJS.ProcessEnv = { CURSOR_CONFIG_DIR: tmpRoot };
      const sessionId = 'b25d68d8-a5f5-456f-9561-04b27ef330f6';
      const legacyStorePath = path.join(tmpRoot, 'chats', '0e8a1afc7862838f0ac34110b285d010', sessionId, 'store.db');
      createLegacyCursorStoreDb(legacyStorePath, { agentId: sessionId, name: 'Fallback Scan Chat', isRunEverything: false });

      const result = migrateLegacyCursorCliSessionToAcp(sessionId, '/some/other/cwd', env);
      assert.equal(result.migrated, true);
      assert.equal(result.runEverything, false);
      assert.doesNotThrow(() => assertCursorAcpRestrictiveResume(sessionId, env));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns migrated=false when no legacy CLI store exists', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-cursor-migrate-missing-'));
    try {
      const env: NodeJS.ProcessEnv = { CURSOR_CONFIG_DIR: tmpRoot };
      const result = migrateLegacyCursorCliSessionToAcp('missing-session-123', '/tmp/missing', env);
      assert.equal(result.migrated, false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
