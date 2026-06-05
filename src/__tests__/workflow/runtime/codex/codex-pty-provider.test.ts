import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  _testOnlyPtyScreens,
  capturePtyScreen,
  injectPromptIntoPty,
  prepareCodexPtyForPrompt,
  prepareCodexPtyUpdatePrompt,
  shouldUseCodexPtyTui,
} from '../../../../runtime/codex/pty-provider.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';

describe('codex-pty-provider', () => {
  it('captures sanitized pty screen tails by bridge session id', () => {
    _testOnlyPtyScreens.clear();
    _testOnlyPtyScreens.register({
      sessionId: 'bridge-session-pty',
      threadId: 'thread-pty',
      cwd: '/tmp/pty',
    });
    _testOnlyPtyScreens.append('bridge-session-pty', '\x1b[31mred\x1b[0m\r\nline2\nline3');

    const capture = capturePtyScreen('bridge-session-pty', 2);
    assert.ok(capture);
    assert.equal(capture.threadId, 'thread-pty');
    assert.equal(capture.screen, 'line2\nline3');
    _testOnlyPtyScreens.clear();
  });

  it('enables the pty TUI provider path from supported env aliases', () => {
    const oldUsePty = process.env.CODELARK_CODEX_USE_PTY_TUI;
    const oldPtyTui = process.env.CODELARK_CODEX_PTY_TUI;
    try {
      delete process.env.CODELARK_CODEX_USE_PTY_TUI;
      delete process.env.CODELARK_CODEX_PTY_TUI;
      assert.equal(shouldUseCodexPtyTui(), false);

      process.env.CODELARK_CODEX_USE_PTY_TUI = 'true';
      assert.equal(shouldUseCodexPtyTui(), true);

      delete process.env.CODELARK_CODEX_USE_PTY_TUI;
      process.env.CODELARK_CODEX_PTY_TUI = '1';
      assert.equal(shouldUseCodexPtyTui(), true);
    } finally {
      if (oldUsePty === undefined) delete process.env.CODELARK_CODEX_USE_PTY_TUI;
      else process.env.CODELARK_CODEX_USE_PTY_TUI = oldUsePty;
      if (oldPtyTui === undefined) delete process.env.CODELARK_CODEX_PTY_TUI;
      else process.env.CODELARK_CODEX_PTY_TUI = oldPtyTui;
    }
  });

  it('injects multiline prompts with Codex TUI newline and submit sequences', async () => {
    const writes: string[] = [];
    await injectPromptIntoPty({
      write(data: string) {
        writes.push(data);
      },
      kill() {},
      onData() {},
      onExit() {},
    }, 'hello\nworld');

    assert.deepEqual(writes, ['hello', '\x1b\r', 'world', '\r']);
  });

  it('injects prompts into a registered active pty child', async () => {
    const writes: string[] = [];
    const oldSubmitDelay = process.env.CODELARK_CODEX_PTY_SUBMIT_DELAY_MS;
    try {
      process.env.CODELARK_CODEX_PTY_SUBMIT_DELAY_MS = '0';
      _testOnlyPtyScreens.clear();
      _testOnlyPtyScreens.register({ sessionId: 'bridge-session-active-pty' });
      _testOnlyPtyScreens.attachChild('bridge-session-active-pty', {
        write(data: string) {
          writes.push(data);
        },
        kill() {},
        onData() {},
        onExit() {},
      });

      assert.equal(await _testOnlyPtyScreens.injectPromptIntoActivePty('bridge-session-active-pty', 'append now'), true);
      assert.deepEqual(writes, ['append now', '\r']);

      _testOnlyPtyScreens.exit('bridge-session-active-pty', { exitCode: 0 });
      assert.equal(await _testOnlyPtyScreens.injectPromptIntoActivePty('bridge-session-active-pty', 'ignored'), false);
    } finally {
      if (oldSubmitDelay === undefined) delete process.env.CODELARK_CODEX_PTY_SUBMIT_DELAY_MS;
      else process.env.CODELARK_CODEX_PTY_SUBMIT_DELAY_MS = oldSubmitDelay;
      _testOnlyPtyScreens.clear();
    }
  });

  it('requests user confirmation before accepting the Codex TUI trust prompt', async () => {
    const writes: string[] = [];
    const permissionRequests: string[] = [];
    const oldTimeout = process.env.CODELARK_CODEX_PTY_TRUST_PROMPT_TIMEOUT_MS;
    const oldAfterTrust = process.env.CODELARK_CODEX_PTY_AFTER_TRUST_DELAY_MS;
    try {
      process.env.CODELARK_CODEX_PTY_TRUST_PROMPT_TIMEOUT_MS = '0';
      process.env.CODELARK_CODEX_PTY_AFTER_TRUST_DELAY_MS = '0';
      const permissions = new PendingPermissions();
      _testOnlyPtyScreens.clear();
      _testOnlyPtyScreens.register({ sessionId: 'bridge-session-trust' });
      _testOnlyPtyScreens.append(
        'bridge-session-trust',
        'Do you trust the contents of this directory?\nPress enter to continue',
      );
      setTimeout(() => {
        assert.equal(permissionRequests.length, 1);
        permissions.resolve(permissionRequests[0], { behavior: 'allow' });
      }, 0);

      await prepareCodexPtyForPrompt({
        child: {
          write(data: string) {
            writes.push(data);
          },
          kill() {},
          onData() {},
          onExit() {},
        },
        controller: {
          enqueue(data: string) {
            const outer = JSON.parse(data.match(/data: (.*)\n/)?.[1] || '{}') as { type?: string; data?: string };
            assert.equal(outer.type, 'permission_request');
            const body = JSON.parse(outer.data || '{}') as { permissionRequestId?: string };
            assert.match(body.permissionRequestId || '', /^codex-trust:pty:bridge-session-trust:/);
            permissionRequests.push(body.permissionRequestId || '');
          },
        } as ReadableStreamDefaultController<string>,
        pendingPerms: permissions,
        sessionId: 'bridge-session-trust',
        workingDirectory: '/tmp/trusted',
      });

      assert.deepEqual(writes, ['\r']);
    } finally {
      if (oldTimeout === undefined) delete process.env.CODELARK_CODEX_PTY_TRUST_PROMPT_TIMEOUT_MS;
      else process.env.CODELARK_CODEX_PTY_TRUST_PROMPT_TIMEOUT_MS = oldTimeout;
      if (oldAfterTrust === undefined) delete process.env.CODELARK_CODEX_PTY_AFTER_TRUST_DELAY_MS;
      else process.env.CODELARK_CODEX_PTY_AFTER_TRUST_DELAY_MS = oldAfterTrust;
      _testOnlyPtyScreens.clear();
    }
  });

  it('requests user confirmation before accepting the Codex TUI update prompt', async () => {
    const writes: string[] = [];
    const permissionRequests: string[] = [];
    let exited = false;
    const oldTimeout = process.env.CODELARK_CODEX_PTY_UPDATE_PROMPT_TIMEOUT_MS;
    const oldUpdateTimeout = process.env.CODELARK_CODEX_TUI_UPDATE_TIMEOUT_MS;
    try {
      process.env.CODELARK_CODEX_PTY_UPDATE_PROMPT_TIMEOUT_MS = '0';
      process.env.CODELARK_CODEX_TUI_UPDATE_TIMEOUT_MS = '1000';
      const permissions = new PendingPermissions();
      _testOnlyPtyScreens.clear();
      _testOnlyPtyScreens.register({ sessionId: 'bridge-session-update' });
      _testOnlyPtyScreens.append(
        'bridge-session-update',
        'Update available! 0.135.0 -> 0.136.0\n› 1. Update now\n  2. Skip\n  3. Skip until next version',
      );
      setTimeout(() => {
        assert.equal(permissionRequests.length, 1);
        permissions.resolve(permissionRequests[0], { behavior: 'allow', message: 'update_now' });
      }, 0);

      const restarted = await prepareCodexPtyUpdatePrompt({
        child: {
          write(data: string) {
            writes.push(data);
            if (data === '\r') exited = true;
          },
          kill() {},
          onData() {},
          onExit() {},
        },
        controller: {
          enqueue(data: string) {
            const outer = JSON.parse(data.match(/data: (.*)\n/)?.[1] || '{}') as { type?: string; data?: string };
            if (outer.type !== 'permission_request') return;
            const body = JSON.parse(outer.data || '{}') as { permissionRequestId?: string; toolName?: string };
            assert.equal(body.toolName, 'Codex TUI Selection Prompt');
            assert.match(body.permissionRequestId || '', /^codex-selection:update:pty:bridge-session-update:/);
            permissionRequests.push(body.permissionRequestId || '');
          },
        } as ReadableStreamDefaultController<string>,
        pendingPerms: permissions,
        sessionId: 'bridge-session-update',
        isExited: () => exited,
      });

      assert.equal(restarted, true);
      assert.deepEqual(writes, ['\r']);
    } finally {
      if (oldTimeout === undefined) delete process.env.CODELARK_CODEX_PTY_UPDATE_PROMPT_TIMEOUT_MS;
      else process.env.CODELARK_CODEX_PTY_UPDATE_PROMPT_TIMEOUT_MS = oldTimeout;
      if (oldUpdateTimeout === undefined) delete process.env.CODELARK_CODEX_TUI_UPDATE_TIMEOUT_MS;
      else process.env.CODELARK_CODEX_TUI_UPDATE_TIMEOUT_MS = oldUpdateTimeout;
      _testOnlyPtyScreens.clear();
    }
  });
});
