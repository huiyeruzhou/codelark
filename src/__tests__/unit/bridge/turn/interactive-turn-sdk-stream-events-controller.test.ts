import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInteractiveSdkStreamEventsController,
} from '../../../../bridge/turn/interactive/sdk-stream-events-controller.js';
import type {
  InteractiveStreamFeedback,
  InteractiveStreamUiController,
} from '../../../../bridge/turn/interactive/stream-ui-controller.js';
import { createStreamState } from '../../../../bridge/turn/stream-state.js';
import { initBridgeTestContext } from '../../../helpers/bridge/test-bridge-utils.js';

function makeHarness(options: {
  current?: boolean;
  hasStreamingCards?: boolean;
} = {}) {
  initBridgeTestContext();
  let now = 1000;
  const streamTexts: string[] = [];
  const toolEvents: unknown[] = [];
  const historySnapshots: unknown[] = [];
  const previewTexts: string[] = [];
  const healthProgress: Array<{ type: string; detail?: string }> = [];
  const healthTools: Array<{ toolId: string; toolName: string; status: string }> = [];
  let touchCount = 0;
  let statusPushCount = 0;
  let snapshotSyncCount = 0;

  const streamFeedback = {
    target: {
      adapter: {} as never,
      channelType: 'feishu',
      chatId: 'chat-1',
      streamKey: 'stream-1',
    },
    pushText(text: string) {
      streamTexts.push(text);
    },
    pushHistory(items) {
      historySnapshots.push(structuredClone(items));
    },
    pushTools(tools: unknown[]) {
      toolEvents.push(tools);
    },
    pushTasks() {},
    pushStatus() { return true; },
    pushMetadata() { return true; },
    pushActions() { return true; },
    async finalize() { return true; },
  } satisfies InteractiveStreamFeedback;
  const streamUi = {
    target: streamFeedback.target,
    feedback: streamFeedback,
    hasStreamingCards: options.hasStreamingCards ?? true,
    supportsStructuredStreamUi: true,
    pushMetadata() {},
    pushRunningStatus() {
      statusPushCount += 1;
    },
    syncSnapshot() {
      snapshotSyncCount += 1;
    },
    startStatusHeartbeat() {},
    stopStatusUpdates() {},
    recordInactiveOnce() {},
    async finalizeOnce() {
      return true;
    },
    shouldSkipTextDelivery() {
      return false;
    },
  } satisfies InteractiveStreamUiController;
  const taskState = {
    lastActivityAt: 0,
    lastResponseAt: null,
    lastContentResponseAt: null,
  };
  const controller = createInteractiveSdkStreamEventsController({
    sessionId: 'session-1',
    taskId: 'task-1',
    streamState: createStreamState(now),
    taskState,
    streamUi,
    streamFeedback,
    nowMs: () => {
      now += 10;
      return now;
    },
    isCurrentTask: () => options.current ?? true,
    touchTask() {
      touchCount += 1;
    },
    recordHealthProgress(_sessionId, type, detail) {
      healthProgress.push({ type, detail });
    },
    recordHealthTool(_sessionId, toolId, toolName, status) {
      healthTools.push({ toolId, toolName, status });
    },
    previewOnPartialText(text) {
      previewTexts.push(text);
    },
  });

  return {
    controller,
    taskState,
    streamTexts,
    toolEvents,
    historySnapshots,
    previewTexts,
    healthProgress,
    healthTools,
    get touchCount() { return touchCount; },
    get statusPushCount() { return statusPushCount; },
    get snapshotSyncCount() { return snapshotSyncCount; },
  };
}

describe('interactive-turn sdk-stream-events-controller', () => {
  it('routes partial text through preview, health, task activity, and streaming card text', () => {
    const harness = makeHarness();

    harness.controller.onPartialText([
      '正文',
      '<clk-send>{"type":"file","path":"D:\\\\a.txt"}</clk-send>',
    ].join('\n'));

    assert.deepEqual(harness.previewTexts, [
      '正文\n<clk-send>{"type":"file","path":"D:\\\\a.txt"}</clk-send>',
    ]);
    assert.deepEqual(harness.streamTexts, ['正文']);
    assert.deepEqual(harness.healthProgress, [{ type: 'text', detail: undefined }]);
    assert.equal(harness.taskState.lastResponseAt, 1010);
    assert.equal(harness.taskState.lastContentResponseAt, 1010);
    assert.equal(harness.touchCount, 1);
    assert.equal(harness.statusPushCount, 1);
    assert.equal(harness.snapshotSyncCount, 1);
  });

  it('records permission waits as activity and runtime status updates', () => {
    const harness = makeHarness();

    harness.controller.onPermissionWait('apply_patch');

    assert.deepEqual(harness.healthProgress, [{
      type: 'permission_wait',
      detail: '当前正在等待工具 apply_patch 的权限确认。',
    }]);
    assert.equal(harness.touchCount, 1);
    assert.equal(harness.statusPushCount, 1);
    assert.equal(harness.snapshotSyncCount, 1);
  });

  it('keeps a provider reasoning heading while a later snapshot replaces only the answer', () => {
    const harness = makeHarness();

    harness.controller.onPartialText('最终问候\n\n**简短思考标题**');
    harness.controller.onHistoryItem({
      type: 'markdown',
      role: 'thinking',
      content: '**简短思考标题**',
    });
    harness.controller.onPartialText('最终问候');

    assert.deepEqual(harness.historySnapshots.at(-1), [
      { type: 'markdown', role: 'thinking', content: '**简短思考标题**' },
      { type: 'markdown', role: 'assistant', content: '最终问候' },
    ]);
  });

  it('ignores stale task events before mutating stream state or UI', () => {
    const harness = makeHarness({ current: false });

    harness.controller.onPartialText('正文');
    harness.controller.onToolEvent('tool-1', 'shell', 'running');
    harness.controller.onTaskEvent([{ text: 'step', status: 'in_progress' }]);
    harness.controller.onStatusNote('waiting');
    harness.controller.onContextUsage({
      modelContextWindow: 200_000,
      lastTokenUsage: { inputTokens: 125_000, outputTokens: 4_000 },
    });

    assert.deepEqual(harness.previewTexts, []);
    assert.deepEqual(harness.streamTexts, []);
    assert.deepEqual(harness.toolEvents, []);
    assert.deepEqual(harness.healthProgress, []);
    assert.deepEqual(harness.healthTools, []);
    assert.equal(harness.touchCount, 0);
    assert.equal(harness.statusPushCount, 0);
    assert.equal(harness.snapshotSyncCount, 0);
  });

  it('updates context usage as stream activity and pushes runtime status', () => {
    const harness = makeHarness();

    harness.controller.onContextUsage({
      modelContextWindow: 200_000,
      lastTokenUsage: {
        inputTokens: 125_300,
        outputTokens: 4_600,
      },
    });

    assert.equal(harness.taskState.lastActivityAt, 1010);
    assert.equal(harness.touchCount, 1);
    assert.equal(harness.statusPushCount, 1);
    assert.equal(harness.snapshotSyncCount, 1);
  });

  it('uses the shared tool event reducer and always keeps tool details', () => {
    const harness = makeHarness();
    harness.controller.onToolEvent('tool-1', 'Bash', 'running', { input: { command: 'pwd' } });
    harness.controller.onToolEvent('tool-1', '', 'complete', { output: '/tmp/project' });

    assert.deepEqual(harness.toolEvents.at(-1), [{
      id: 'tool-1',
      name: 'Bash',
      status: 'complete',
      input: 'pwd',
      output: '/tmp/project',
      detail: {
        kind: 'exec_command',
        command: 'pwd',
        output: '/tmp/project',
        rawOutput: '/tmp/project',
      },
    }]);
  });
});
