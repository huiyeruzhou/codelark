import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createExternalTerminalFinalizationController,
} from '../../../../bridge/turn/interactive/terminal-finalization-controller.js';

describe('interactive-turn terminal-finalization-controller', () => {
  it('races external terminal completion against a running process and settles completion later', async () => {
    const abortController = new AbortController();
    const controller = createExternalTerminalFinalizationController({
      abortSignal: abortController.signal,
      hasCodexThread: () => true,
      isCurrentTask: () => true,
      isAborted: () => abortController.signal.aborted,
      abortTask: () => abortController.abort(),
    });
    const processPromise = new Promise<never>(() => {});
    const racedPromise = controller.raceProcess(processPromise);

    const completionPromise = controller.finalize('completed', 'done', 'final text');

    assert.equal(abortController.signal.aborted, true);
    const raced = await racedPromise;
    assert.equal(raced.kind, 'external');
    assert.equal(raced.kind === 'external' ? raced.terminal.finalText : '', 'final text');

    controller.settleCompletion(true);
    assert.equal(await completionPromise, true);
  });

  it('waits briefly for terminal finalization after the process result settles', async () => {
    const abortController = new AbortController();
    let abortCalled = false;
    const controller = createExternalTerminalFinalizationController({
      abortSignal: abortController.signal,
      hasCodexThread: () => true,
      isCurrentTask: () => true,
      isAborted: () => abortController.signal.aborted,
      abortTask: () => {
        abortCalled = true;
        abortController.abort();
      },
      finalizationTimeoutMs: 25,
    });

    controller.expectCodexTerminalFinal();
    const raced = await controller.raceProcess(Promise.resolve('sdk result'));
    assert.equal(raced.kind, 'process');
    controller.markProcessSettled();
    setTimeout(() => {
      void controller.finalize('completed', 'done after process', 'terminal final');
    }, 0);

    const terminal = await controller.waitAfterProcess();
    assert.equal(terminal?.finalText, 'terminal final');
    assert.equal(abortCalled, false);
    controller.settleCompletion(true);
  });

  it('does not wait for a terminal event when no Codex terminal final is expected', async () => {
    const abortController = new AbortController();
    const controller = createExternalTerminalFinalizationController({
      abortSignal: abortController.signal,
      hasCodexThread: () => true,
      isCurrentTask: () => true,
      isAborted: () => abortController.signal.aborted,
      abortTask: () => abortController.abort(),
      finalizationTimeoutMs: 25,
    });

    assert.equal(await controller.waitAfterProcess(), null);
  });
});
