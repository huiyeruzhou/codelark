import '../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetBridgeTestState } from '../helpers/bridge/test-bridge-utils.js';

function assertManagedPath(name: string, value: string | undefined): string {
  assert.ok(value, `${name} must be set`);
  const resolved = path.resolve(value);
  const tmpRoot = path.resolve(os.tmpdir());
  assert.ok(
    resolved === tmpRoot || resolved.startsWith(tmpRoot + path.sep),
    `${name} must be under the OS temp directory, got ${resolved}`,
  );
  assert.ok(
    resolved.includes(`${path.sep}codelark-test-`),
    `${name} must be inside the managed codelark-test home, got ${resolved}`,
  );
  assert.notEqual(resolved, path.join(os.homedir(), '.codelark'));
  assert.notEqual(resolved, path.join(os.homedir(), '.codex'));
  assert.notEqual(resolved, path.join(os.homedir(), '.kimi-code'));
  return resolved;
}

function writeFixture(filePath: string, content = 'fixture\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

describe('unit::test-environment::home-isolation', () => {
  it('keeps codelark, Codex, Claude, Kimi, and process HOME under the managed test root', () => {
    const codelarkHome = assertManagedPath('CODELARK_HOME', process.env.CODELARK_HOME);
    assertManagedPath('CODEX_HOME', process.env.CODEX_HOME);
    assertManagedPath('CODELARK_CLAUDE_HOME', process.env.CODELARK_CLAUDE_HOME);
    assertManagedPath('KIMI_CODE_HOME', process.env.KIMI_CODE_HOME);
    assertManagedPath('HOME', process.env.HOME);
    assertManagedPath('USERPROFILE', process.env.USERPROFILE);

    assert.equal(path.dirname(process.env.CODEX_HOME!), codelarkHome);
    assert.equal(path.dirname(process.env.CODELARK_CLAUDE_HOME!), codelarkHome);
    assert.equal(path.dirname(process.env.KIMI_CODE_HOME!), codelarkHome);
    assert.equal(path.dirname(process.env.HOME!), codelarkHome);
  });

  it('cleans Codex, Claude, and Kimi runtime homes through the shared bridge reset path', () => {
    const codexHome = assertManagedPath('CODEX_HOME', process.env.CODEX_HOME);
    const claudeHome = assertManagedPath('CODELARK_CLAUDE_HOME', process.env.CODELARK_CLAUDE_HOME);
    const kimiHome = assertManagedPath('KIMI_CODE_HOME', process.env.KIMI_CODE_HOME);

    const codexSessionsDir = path.join(codexHome, 'sessions');
    const codexArchiveDir = path.join(codexHome, 'archived_sessions');
    const codexIndex = path.join(codexHome, 'session_index.jsonl');
    const codexCache = path.join(codexHome, 'models_cache.json');
    const claudeProjectsDir = path.join(claudeHome, '.claude', 'projects');
    const kimiSessionsDir = path.join(kimiHome, 'sessions');
    const kimiIndex = path.join(kimiHome, 'session_index.jsonl');

    writeFixture(path.join(codexSessionsDir, '2026', '06', 'rollout-test.jsonl'));
    writeFixture(path.join(codexArchiveDir, 'thread-1.json'));
    writeFixture(codexIndex, '{"threadId":"codex"}\n');
    writeFixture(codexCache, '{"models":[]}\n');
    writeFixture(path.join(claudeProjectsDir, '-tmp-project', 'session.jsonl'));
    writeFixture(path.join(kimiSessionsDir, 'workspace', 'session-1', 'agents', 'main', 'wire.jsonl'));
    writeFixture(kimiIndex, '{"sessionId":"kimi"}\n');

    resetBridgeTestState({ cleanRuntimeHomes: true });

    assert.equal(fs.existsSync(codexSessionsDir), false);
    assert.equal(fs.existsSync(codexArchiveDir), false);
    assert.equal(fs.existsSync(codexIndex), false);
    assert.equal(fs.existsSync(codexCache), true);
    assert.equal(fs.existsSync(claudeProjectsDir), false);
    assert.equal(fs.existsSync(kimiSessionsDir), false);
    assert.equal(fs.existsSync(kimiIndex), false);
  });
});
