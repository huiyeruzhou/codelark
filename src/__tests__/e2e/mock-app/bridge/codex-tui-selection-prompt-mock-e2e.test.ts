import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PendingPermissions } from '../../../../runtime/permission-gateway.js';
import {
  createCodexTuiSelectionPromptMonitor,
  markCodexTuiSelectionPromptActionSent,
  observeStableCodexTuiSelectionPrompt,
  resolveStableCodexTuiSelectionPrompt,
  type CodexTuiSelectionPrompt,
  type CodexTuiSelectionPromptChoice,
} from '../../../../runtime/codex/tmux-provider.js';
import type { TmuxCore, TmuxSendAction } from '../../../../bridge/tmux/core.js';
import { resetRuntimeTmuxInputStatesForTests } from '../../../../bridge/tmux/input-state-machine.js';

const CODEX_TUI_CONFIRM_FOOTER = 'Press enter to confirm or esc to cancel';

const PERMISSION_SCREEN = [
  'Codex wants to edit files.',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for these files (a)",
  '  3. No, and tell Codex what to do differently (esc)',
  CODEX_TUI_CONFIRM_FOOTER,
].join('\n');

const SECOND_PERMISSION_SCREEN = [
  'Codex wants to run a command.',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for this command (a)",
  '  3. No, and tell Codex what to do differently (esc)',
  CODEX_TUI_CONFIRM_FOOTER,
].join('\n');

const CLAUDE_PERMISSION_SCREEN = [
  'Do you want to create STATUS.md?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits in card-refresh-and-ccr-tmux-fix/ during this session',
  '     (shift+tab)',
  '   3. No',
].join('\n');

const NORMAL_SCREEN = [
  'OpenAI Codex',
  '› Explain this codebase',
].join('\n');

function createMockPromptRuntime() {
  const permissions = new PendingPermissions();
  const permissionRequestIds: string[] = [];
  const sentActions: TmuxSendAction[][] = [];
  const core = {
    async sendActions(_target: string, actions: TmuxSendAction[]) {
      sentActions.push(actions);
      return { commands: actions.map((action) => action.type === 'key' ? action.key : action.text) };
    },
  } as TmuxCore;

  function handlePrompt(prompt: CodexTuiSelectionPrompt) {
    return resolveStableCodexTuiSelectionPrompt({
      controller: {
        enqueue(data: string) {
          const outer = JSON.parse(data.match(/data: (.*)\n/)?.[1] || '{}') as { type?: string; data?: string };
          if (outer.type !== 'permission_request') return;
          const body = JSON.parse(outer.data || '{}') as { permissionRequestId?: string; toolName?: string };
          assert.equal(body.toolName, 'Codex TUI Selection Prompt');
          assert.match(body.permissionRequestId || '', new RegExp(`^codex-selection:${prompt.kind}:tmux:bridge-session-mock-e2e:`));
          permissionRequestIds.push(body.permissionRequestId || '');
        },
      } as ReadableStreamDefaultController<string>,
      pendingPerms: permissions,
      provider: 'tmux',
      bridgeSessionId: 'bridge-session-mock-e2e',
      targetPane: 'mock:0.0',
      prompt,
      screenCommand: '/tmux-screen 80',
      core,
    });
  }

  async function reply(index: number, choice: CodexTuiSelectionPromptChoice = 'yes_proceed') {
    permissions.resolve(permissionRequestIds[index], {
      behavior: 'allow',
      message: choice,
    });
  }

  return { handlePrompt, permissionRequestIds, reply, sentActions };
}

describe('codex tui selection prompt mock e2e', () => {
  beforeEach(() => resetRuntimeTmuxInputStatesForTests());

  it('only prompts once while the user leaves an ordinary stuck prompt unresolved, then stops after resolution clears the screen', async () => {
    const monitor = createCodexTuiSelectionPromptMonitor();
    const runtime = createMockPromptRuntime();

    assert.equal(observeStableCodexTuiSelectionPrompt(PERMISSION_SCREEN, monitor, 2, 0), null);
    assert.equal(observeStableCodexTuiSelectionPrompt(PERMISSION_SCREEN, monitor, 2, 499), null);
    const prompt = observeStableCodexTuiSelectionPrompt(PERMISSION_SCREEN, monitor, 2, 600);
    assert.ok(prompt);

    monitor.pending = true;
    const handled = runtime.handlePrompt(prompt);
    assert.equal(runtime.permissionRequestIds.length, 1);

    assert.equal(observeStableCodexTuiSelectionPrompt(PERMISSION_SCREEN, monitor, 2, 12_000), null);
    assert.equal(observeStableCodexTuiSelectionPrompt(PERMISSION_SCREEN, monitor, 2, 60_000), null);
    assert.equal(runtime.permissionRequestIds.length, 1);

    await runtime.reply(0);
    const result = await handled;
    markCodexTuiSelectionPromptActionSent(monitor, 60_000);
    assert.equal(result.choice, 'yes_proceed');
    assert.deepEqual(runtime.sentActions, [[{ type: 'key', key: 'Enter' }]]);

    assert.equal(observeStableCodexTuiSelectionPrompt(NORMAL_SCREEN, monitor, 2, 60_500), null);
    assert.equal(runtime.permissionRequestIds.length, 1);
  });

  it('waits two seconds for TUI reaction before prompting again when another prompt appears immediately', async () => {
    const monitor = createCodexTuiSelectionPromptMonitor();
    const runtime = createMockPromptRuntime();

    assert.equal(observeStableCodexTuiSelectionPrompt(PERMISSION_SCREEN, monitor, 2, 0), null);
    const firstPrompt = observeStableCodexTuiSelectionPrompt(PERMISSION_SCREEN, monitor, 2, 600);
    assert.ok(firstPrompt);

    monitor.pending = true;
    const firstHandled = runtime.handlePrompt(firstPrompt);
    await runtime.reply(0);
    await firstHandled;
    markCodexTuiSelectionPromptActionSent(monitor, 600);

    assert.equal(observeStableCodexTuiSelectionPrompt(SECOND_PERMISSION_SCREEN, monitor, 2, 700), null);
    assert.equal(observeStableCodexTuiSelectionPrompt(SECOND_PERMISSION_SCREEN, monitor, 2, 2_599), null);
    const secondPrompt = observeStableCodexTuiSelectionPrompt(SECOND_PERMISSION_SCREEN, monitor, 2, 2_600);
    assert.ok(secondPrompt);

    monitor.pending = true;
    const secondHandled = runtime.handlePrompt(secondPrompt);
    assert.equal(runtime.permissionRequestIds.length, 2);
    await runtime.reply(1, 'yes_always');
    const secondResult = await secondHandled;
    markCodexTuiSelectionPromptActionSent(monitor, 2_600);

    assert.equal(secondResult.choice, 'yes_always');
    assert.deepEqual(runtime.sentActions, [
      [{ type: 'key', key: 'Enter' }],
      [{ type: 'key', key: 'Down' }, { type: 'key', key: 'Enter' }],
    ]);
  });

  it('uses the same stable-capture and post-action grace timing for Claude Code numbered selections', async () => {
    const monitor = createCodexTuiSelectionPromptMonitor();
    const runtime = createMockPromptRuntime();

    assert.equal(observeStableCodexTuiSelectionPrompt(CLAUDE_PERMISSION_SCREEN, monitor, 2, 0), null);
    assert.equal(observeStableCodexTuiSelectionPrompt(CLAUDE_PERMISSION_SCREEN, monitor, 2, 499), null);
    const firstPrompt = observeStableCodexTuiSelectionPrompt(CLAUDE_PERMISSION_SCREEN, monitor, 2, 600);
    assert.ok(firstPrompt);
    assert.equal(firstPrompt.kind, 'generic');
    assert.deepEqual(firstPrompt.options.map((option) => option.choice), [
      'option_1',
      'option_2',
      'option_3',
    ]);

    monitor.pending = true;
    const firstHandled = runtime.handlePrompt(firstPrompt);
    await runtime.reply(0, 'option_2');
    await firstHandled;
    markCodexTuiSelectionPromptActionSent(monitor, 600);

    assert.equal(observeStableCodexTuiSelectionPrompt(CLAUDE_PERMISSION_SCREEN, monitor, 2, 2_599), null);
    const secondPrompt = observeStableCodexTuiSelectionPrompt(CLAUDE_PERMISSION_SCREEN, monitor, 2, 2_600);
    assert.ok(secondPrompt);
    assert.equal(runtime.permissionRequestIds.length, 1);
    assert.deepEqual(runtime.sentActions, [
      [{ type: 'key', key: 'Down' }, { type: 'key', key: 'Enter' }],
    ]);
  });

  it('treats the same fingerprint as a new prompt after the screen changes away and back', async () => {
    const monitor = createCodexTuiSelectionPromptMonitor();

    assert.equal(observeStableCodexTuiSelectionPrompt(PERMISSION_SCREEN, monitor, 2, 0), null);
    const firstPrompt = observeStableCodexTuiSelectionPrompt(PERMISSION_SCREEN, monitor, 2, 600);
    assert.ok(firstPrompt);

    assert.equal(observeStableCodexTuiSelectionPrompt(NORMAL_SCREEN, monitor, 2, 700), null);
    assert.equal(observeStableCodexTuiSelectionPrompt(PERMISSION_SCREEN, monitor, 2, 800), null);

    const revivedPrompt = observeStableCodexTuiSelectionPrompt(PERMISSION_SCREEN, monitor, 2, 1_400);
    assert.ok(revivedPrompt);
    assert.equal(revivedPrompt.fingerprint, firstPrompt.fingerprint);
  });
});
