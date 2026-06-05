import '../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

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
  return resolved;
}

describe('unit::test-environment::home-isolation', () => {
  it('keeps codelark, Codex, Claude, and process HOME under the managed test root', () => {
    const codelarkHome = assertManagedPath('CODELARK_HOME', process.env.CODELARK_HOME);
    assertManagedPath('CODEX_HOME', process.env.CODEX_HOME);
    assertManagedPath('CODELARK_CLAUDE_HOME', process.env.CODELARK_CLAUDE_HOME);
    assertManagedPath('HOME', process.env.HOME);
    assertManagedPath('USERPROFILE', process.env.USERPROFILE);

    assert.equal(path.dirname(process.env.CODEX_HOME!), codelarkHome);
    assert.equal(path.dirname(process.env.CODELARK_CLAUDE_HOME!), codelarkHome);
    assert.equal(path.dirname(process.env.HOME!), codelarkHome);
  });
});
