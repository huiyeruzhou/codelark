import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  coordinateRuntimeTmuxSelection,
  getRuntimeTmuxInputState,
  inspectRuntimeTmuxInput,
  resetRuntimeTmuxInputStatesForTests,
  sendRuntimeTmuxInput,
  transitionRuntimeTmuxInputState,
} from '../../../../bridge/tmux/input-state-machine.js';

describe('runtime tmux input state machine', () => {
  beforeEach(() => resetRuntimeTmuxInputStatesForTests());

  it('requires one readiness pass for a cold existing tmux and skips prompt probing once running', async () => {
    let existenceChecks = 0;
    const hasSession = async () => {
      existenceChecks += 1;
      return { exists: true, command: 'tmux has-session -t codex_thread' };
    };

    const cold = await inspectRuntimeTmuxInput({
      runtime: 'codex',
      sessionName: 'codex_thread',
      hasSession,
    });
    assert.equal(cold.needsReadiness, true);
    assert.equal(cold.state.state, 'checking_session');

    transitionRuntimeTmuxInputState('codex', 'codex_thread', 'running', 'readiness passed');
    const established = await inspectRuntimeTmuxInput({
      runtime: 'codex',
      sessionName: 'codex_thread',
      hasSession,
    });
    assert.equal(established.needsReadiness, false);
    assert.equal(established.state.state, 'running');
    assert.match(established.state.reason, /prompt probe skipped/);
    assert.equal(existenceChecks, 2, 'tmux existence is still checked before every send');
  });

  it('moves a disappeared running tmux back to stopped so the caller can relaunch it', async () => {
    transitionRuntimeTmuxInputState('claude', 'claude_session', 'running', 'ready');
    const inspected = await inspectRuntimeTmuxInput({
      runtime: 'claude',
      sessionName: 'claude_session',
      hasSession: async () => ({ exists: false, command: 'tmux has-session -t claude_session' }),
    });

    assert.equal(inspected.exists, false);
    assert.equal(inspected.needsReadiness, true);
    assert.equal(inspected.state.state, 'stopped');
  });

  it('allows send only from running and returns to running after the input is delivered', async () => {
    await assert.rejects(
      () => sendRuntimeTmuxInput({
        runtime: 'kimi',
        sessionName: 'clk-kimi-session',
        send: async () => undefined,
      }),
      /expected running before send/,
    );

    transitionRuntimeTmuxInputState('kimi', 'clk-kimi-session', 'running', 'wire session ready');
    const phases: string[] = [];
    await sendRuntimeTmuxInput({
      runtime: 'kimi',
      sessionName: 'clk-kimi-session',
      send: async () => {
        phases.push(getRuntimeTmuxInputState('kimi', 'clk-kimi-session').state);
      },
    });

    assert.deepEqual(phases, ['sending']);
    assert.equal(getRuntimeTmuxInputState('kimi', 'clk-kimi-session').state, 'running');
  });

  it('records a send failure and requires recovery before another input', async () => {
    transitionRuntimeTmuxInputState('codex', 'codex_failed', 'running', 'ready');
    await assert.rejects(
      () => sendRuntimeTmuxInput({
        runtime: 'codex',
        sessionName: 'codex_failed',
        send: async () => { throw new Error('pane vanished'); },
      }),
      /pane vanished/,
    );

    const failed = getRuntimeTmuxInputState('codex', 'codex_failed');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, 'pane vanished');
  });

  it('gives one owner to concurrent observers of the same selection lifecycle', async () => {
    let releaseOwner!: () => void;
    const ownerBlocked = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let startupExecutions = 0;
    let mirrorExecutions = 0;

    const startup = coordinateRuntimeTmuxSelection({
      runtime: 'codex',
      sessionName: 'codex_shared_selection',
      fingerprint: 'resume-paused-goal',
      run: async () => {
        startupExecutions += 1;
        await ownerBlocked;
        return { choice: 'option_2', commands: ['Down', 'Enter'] };
      },
    });
    const mirror = coordinateRuntimeTmuxSelection({
      runtime: 'codex',
      sessionName: 'codex_shared_selection',
      fingerprint: 'resume-paused-goal',
      run: async () => {
        mirrorExecutions += 1;
        return { choice: 'option_2', commands: ['Down', 'Enter'] };
      },
    });

    assert.equal(startupExecutions, 1);
    assert.equal(mirrorExecutions, 0);
    releaseOwner();
    const [startupResult, mirrorResult] = await Promise.all([startup, mirror]);
    assert.equal(startupResult.owner, true);
    assert.equal(mirrorResult.owner, false);
    assert.deepEqual(startupResult.result, mirrorResult.result);
    assert.equal(startupExecutions + mirrorExecutions, 1);
  });
});
