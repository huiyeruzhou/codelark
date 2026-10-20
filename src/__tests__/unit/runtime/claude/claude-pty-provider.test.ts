import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { _testOnlyClaudePty } from '../../../../runtime/claude/pty-provider.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';

const bypassPermissionsWarning = [
  'WARNING: Claude Code running in Bypass Permissions mode',
  '',
  'In Bypass Permissions mode, Claude Code will not ask for your approval',
  'before running potentially dangerous commands.',
  '',
  '❯ 1. No, exit',
  '  2. Yes, I accept',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

describe('Claude PTY startup prompts', () => {
  it('treats the Claude 2.1.278 terminal setup page as onboarding rather than workspace trust', () => {
    const terminalSetup = [
      'Welcome to Claude Code v2.1.278',
      '',
      "Use Claude Code's terminal setup?",
      '',
      'For the optimal coding experience, enable the recommended settings',
      '❯ 1. Yes, use recommended settings',
      '  2. No, maybe later with /terminal-setup',
      '',
      'Enter to confirm · Esc to skip',
    ].join('\n');

    assert.equal(_testOnlyClaudePty.hasClaudePtyOnboardingPrompt(terminalSetup), true);
    assert.equal(_testOnlyClaudePty.hasClaudePtyTrustPrompt(terminalSetup), false);
  });

  it('does not accept the bypass-permissions warning without a user selection channel', async () => {
    const envNames = [
      'CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS',
      'CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS',
      'CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS',
    ];
    const previous = new Map(envNames.map((name) => [name, process.env[name]]));
    for (const name of envNames) process.env[name] = '0';
    const writes: string[] = [];

    try {
      await assert.rejects(() => (_testOnlyClaudePty.prepareClaudePtyForPrompt as (session: unknown) => Promise<void>)({
        child: { write: (value: string) => writes.push(value) },
        buffer: bypassPermissionsWarning,
      }), /requires an explicit user choice/i);
      assert.deepEqual(writes, []);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('accepts the bypass-permissions warning after an explicit user selection', async () => {
    const envNames = [
      'CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS',
      'CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS',
      'CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS',
    ];
    const previous = new Map(envNames.map((name) => [name, process.env[name]]));
    for (const name of envNames) process.env[name] = '0';
    const writes: string[] = [];
    const events: string[] = [];
    const pendingPerms = new PendingPermissions();

    try {
      const preparing = (_testOnlyClaudePty.prepareClaudePtyForPrompt as (
        session: unknown,
        options: unknown,
      ) => Promise<void>)({
        child: { write: (value: string) => writes.push(value) },
        buffer: bypassPermissionsWarning,
      }, {
        controller: { enqueue: (value: string) => events.push(value) },
        pendingPerms,
        bridgeSessionId: 'bridge-claude-pty-choice',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(writes.length, 0);
      const event = JSON.parse(events[0]!.slice('data: '.length).trim()) as {
        data: string;
      };
      const request = JSON.parse(event.data) as { permissionRequestId: string };
      assert.equal(pendingPerms.resolve(request.permissionRequestId, {
        behavior: 'allow',
        message: 'yes_proceed',
      }), true);
      await preparing;
      assert.deepEqual(writes, ['\x1b[B', '\r']);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('does not write a key when the bypass-permissions choice is denied', async () => {
    const envNames = [
      'CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS',
      'CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS',
      'CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS',
    ];
    const previous = new Map(envNames.map((name) => [name, process.env[name]]));
    for (const name of envNames) process.env[name] = '0';
    const writes: string[] = [];
    const events: string[] = [];
    const pendingPerms = new PendingPermissions();

    try {
      const preparing = (_testOnlyClaudePty.prepareClaudePtyForPrompt as (
        session: unknown,
        options: unknown,
      ) => Promise<void>)({
        child: { write: (value: string) => writes.push(value) },
        buffer: bypassPermissionsWarning,
      }, {
        controller: { enqueue: (value: string) => events.push(value) },
        pendingPerms,
        bridgeSessionId: 'bridge-claude-pty-denied',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const event = JSON.parse(events[0]!.slice('data: '.length).trim()) as { data: string };
      const request = JSON.parse(event.data) as { permissionRequestId: string };
      pendingPerms.resolve(request.permissionRequestId, { behavior: 'deny' });

      await assert.rejects(preparing, /Denied by user/);
      assert.deepEqual(writes, []);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('confirms the safe exit choice without injecting a prompt', async () => {
    const envNames = [
      'CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS',
      'CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS',
      'CODELARK_CLAUDE_PTY_AFTER_TRUST_DELAY_MS',
    ];
    const previous = new Map(envNames.map((name) => [name, process.env[name]]));
    for (const name of envNames) process.env[name] = '0';
    const writes: string[] = [];
    const events: string[] = [];
    const pendingPerms = new PendingPermissions();

    try {
      const preparing = (_testOnlyClaudePty.prepareClaudePtyForPrompt as (
        session: unknown,
        options: unknown,
      ) => Promise<void>)({
        child: { write: (value: string) => writes.push(value) },
        buffer: bypassPermissionsWarning,
      }, {
        controller: { enqueue: (value: string) => events.push(value) },
        pendingPerms,
        bridgeSessionId: 'bridge-claude-pty-exit',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const event = JSON.parse(events[0]!.slice('data: '.length).trim()) as { data: string };
      const request = JSON.parse(event.data) as { permissionRequestId: string };
      pendingPerms.resolve(request.permissionRequestId, { behavior: 'allow', message: 'no' });

      await assert.rejects(preparing, /用户选择退出 Claude Code bypass-permissions 模式/);
      assert.deepEqual(writes, ['\r']);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});


describe('Claude input readiness without startup hints', () => {
  const captured = fs.readFileSync(new URL('../../../fixtures/runtime/claude/mature-input-no-hints.txt', import.meta.url), 'utf8');
  const frame = '────────────────────────────────';

  it('recognizes the real mature input after the banner and shortcut hints scroll away', () => {
    assert.doesNotMatch(captured, /Claude Code|for shortcuts|\/effort/u);
    assert.equal(_testOnlyClaudePty.hasClaudePtyInputPrompt(captured), true);
  });

  for (const footer of ['Update installed · restart to apply', '2 background tasks', 'bypass permissions on', '']) {
    it(`accepts a framed empty input with footer ${JSON.stringify(footer)}`, () => {
      const screen = `Finished.\r\n${frame}\r\n\x1b[36m❯\u00a0\x1b[0m\r\n${frame}\r\n${footer}`;
      assert.equal(_testOnlyClaudePty.hasClaudePtyInputPrompt(screen), true);
    });
  }

  for (const [name, screen] of Object.entries({
    'bare chevron in output': 'Example prompt: ❯',
    'unframed empty chevron': 'Command output\n❯ ',
    'shell prompt': `${frame}\n> \n${frame}`,
    'numbered menu': `${frame}\n❯ 1. Continue\n  2. Cancel\n${frame}`,
    'incomplete input frame': `${frame}\n❯ `,
    'later selection after old input': `${frame}\n❯ \n${frame}\nChoose a mode\n❯ 1. Yes\n  2. No`,
    'unrecognized confirmation after old input': `${frame}\n❯ \n${frame}\nEnter to confirm · Esc to cancel`,
    'trust confirmation': `Quick safety check\n❯ 1. Yes, I trust this folder\n  2. No, exit\nEnter to confirm`,
    'bypass warning': bypassPermissionsWarning,
  })) {
    it(`does not mistake ${name} for a ready input`, () => {
      assert.equal(_testOnlyClaudePty.hasClaudePtyInputPrompt(screen), false);
    });
  }
});
