import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildZcodeArgs,
  buildZcodeTmuxLaunchCommand,
  createZcodeSecretEnvironmentFile,
  extractZcodeScreenResult,
  findZcodeSessionIdInLaunchLogs,
  isZcodeInputReadyScreen,
  resolveZcodeTmuxSessionPlan,
  shouldPreserveZcodeTmuxAfterFailure,
  zcodeEditorText,
  zcodeTmuxSessionName,
} from '../../../../runtime/zcode/tmux-provider.js';

describe('ZCode tmux provider', () => {
  it('builds fresh and resume commands without interpreting native slash commands', () => {
    assert.deepEqual(buildZcodeArgs({
      prompt: '/goal show',
      sessionId: 'bridge-zcode',
      runtime: 'zcode',
      workingDirectory: '/work/repo',
      zcodeMode: 'build',
    }), [
      '--mode', 'build',
      '--cwd', '/work/repo',
    ]);
    assert.deepEqual(buildZcodeArgs({
      prompt: 'continue',
      sessionId: 'bridge-zcode',
      runtime: 'zcode',
      zcodeSessionId: 'sess_123',
    }), ['--resume', 'sess_123']);
    assert.deepEqual(buildZcodeArgs({
      prompt: 'continue',
      sessionId: 'bridge-zcode',
      runtime: 'zcode',
      model: 'zai/glm-5.2',
      zcodeMode: 'plan',
      workingDirectory: '/work/repo',
    }), ['--model', 'zai/glm-5.2', '--mode', 'plan', '--cwd', '/work/repo']);
    assert.equal(zcodeTmuxSessionName('bridge-123'), 'clk-zcode-bridge-123');
  });

  it('reuses a live tmux with a startup identity that is not persisted yet', () => {
    assert.deepEqual(resolveZcodeTmuxSessionPlan({
      exists: true,
      requestedSessionId: 'sess_pending',
    }), {
      launch: false,
      reuseSessionId: 'sess_pending',
    });
    assert.deepEqual(resolveZcodeTmuxSessionPlan({
      exists: false,
      requestedSessionId: 'sess_pending',
    }), {
      launch: true,
    });
    assert.deepEqual(resolveZcodeTmuxSessionPlan({
      exists: false,
      requestedSessionId: 'sess_persisted',
      persistedSessionId: 'sess_persisted',
    }), {
      launch: true,
      resumeSessionId: 'sess_persisted',
    });
    assert.deepEqual(resolveZcodeTmuxSessionPlan({
      exists: true,
      recreate: true,
      requestedSessionId: 'sess_pending',
    }), {
      launch: true,
    });
  });

  it('propagates non-secret ZCode environment without putting the API key in the command', () => {
    const command = buildZcodeTmuxLaunchCommand('zcode', ['--resume', 'sess_123'], {
      platform: 'linux',
      env: {
        ZCODE_LOG_DIR: '/tmp/zcode logs',
        ZCODE_SESSION_DB_PATH: '/tmp/zcode db.sqlite',
        ZCODE_API_KEY: 'secret-key',
      },
    });
    assert.equal(
      command,
      "ZCODE_SESSION_DB_PATH='/tmp/zcode db.sqlite' ZCODE_LOG_DIR='/tmp/zcode logs' zcode --resume sess_123",
    );
    assert.equal(String(command).includes('secret-key'), false);
  });

  it('passes ZCode API keys through a private launch file and discovers identity from isolated logs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-zcode-launch-'));
    const secretFile = createZcodeSecretEnvironmentFile({ ZCODE_API_KEY: "key-with-'quote" }, root);
    assert.ok(secretFile);
    assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(secretFile, 'utf8'), "export ZCODE_API_KEY='key-with-'\\''quote'\n");

    const logDir = path.join(root, 'logs');
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(logDir, 'zcode-2026-08-14.jsonl'), [
      '{"event":"unrelated","sessionId":"sess_wrong"}',
      '{"event":"bootstrap.app.startup.started","sessionId":"sess_expected"}',
      '{"event":',
    ].join('\n'));
    assert.equal(findZcodeSessionIdInLaunchLogs(logDir), 'sess_expected');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('recognizes the real empty editor and distinguishes a pending draft', () => {
    const ready = [
      ' █████ ▄███   ┌── SYSTEM INITIATED',
      '────────────────────────────────────────────────────────',
      '                                                        ',
      '────────────────────────────────────────────────────────',
      ' ◈ default ─ ◉ build ─ ctx 100% left ─ 0 tokens',
    ].join('\n');
    const draft = ready.replace(
      '                                                        ',
      ' CODELARK_ZCODE_DRAFT_MARKER',
    );

    assert.equal(isZcodeInputReadyScreen(ready), true);
    assert.equal(zcodeEditorText(ready), '');
    assert.equal(zcodeEditorText(draft), 'CODELARK_ZCODE_DRAFT_MARKER');
  });

  it('extracts a native slash result generically from the TUI transcript', () => {
    const screen = [
      ' › /goal',
      '',
      ' No goal is set. Use /goal <objective> to set one.',
      '',
      ' [ ✓ 0s ]',
      '────────────────────────────────────────────────────────',
      '',
      '────────────────────────────────────────────────────────',
      ' ◈ default ─ ◉ build ─ ctx 100% left ─ 0 tokens',
    ].join('\n');

    assert.deepEqual(extractZcodeScreenResult(screen, '/goal'), {
      content: 'No goal is set. Use /goal <objective> to set one.',
      failed: false,
    });
    assert.equal(extractZcodeScreenResult(screen, '/status'), null);
  });

  it('preserves the provider-owned tmux when /stop aborts only the active turn', () => {
    const controller = new AbortController();
    controller.abort();

    assert.equal(shouldPreserveZcodeTmuxAfterFailure(new Error('ZCode request was aborted.'), controller.signal), true);
    assert.equal(shouldPreserveZcodeTmuxAfterFailure(new Error('unexpected launch failure')), false);
  });
});
