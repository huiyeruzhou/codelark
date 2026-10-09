import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  inspectCursorDesktopHookActivity,
  subscribeCursorDesktopHookActivities,
  type CursorDesktopHookActivity,
  type CursorDesktopHookSubscription,
} from '../../../../runtime/cursor/desktop-diagnostics.js';

function hookBlock(timestamp: string, step: string, input: Record<string, unknown>): string {
  return [
    `[${timestamp}] Hook step requested: ${step}`,
    'INPUT:',
    JSON.stringify(input, null, 2),
    '',
  ].join('\n');
}

async function collectActivities(
  subscription: CursorDesktopHookSubscription,
  count: number,
): Promise<CursorDesktopHookActivity[]> {
  const result: CursorDesktopHookActivity[] = [];
  const deadline = Date.now() + 2_000;
  while (result.length < count && Date.now() < deadline) {
    await subscription.waitForActivity(100);
    result.push(...subscription.drain());
  }
  return result;
}

describe('Cursor Desktop hook diagnostics', () => {
  let root = '';
  let previousLogsDir: string | undefined;
  let previousReconcileInterval: string | undefined;
  let previousDisableWatch: string | undefined;

  beforeEach(() => {
    previousLogsDir = process.env.CURSOR_LOGS_DIR;
    previousReconcileInterval = process.env.CODELARK_CURSOR_DESKTOP_HOOK_RECONCILE_INTERVAL_MS;
    previousDisableWatch = process.env.CODELARK_CURSOR_DESKTOP_HOOK_DISABLE_WATCH;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-cursor-hooks-'));
    process.env.CURSOR_LOGS_DIR = root;
    process.env.CODELARK_CURSOR_DESKTOP_HOOK_RECONCILE_INTERVAL_MS = '50';
    delete process.env.CODELARK_CURSOR_DESKTOP_HOOK_DISABLE_WATCH;
  });

  afterEach(() => {
    if (previousLogsDir === undefined) delete process.env.CURSOR_LOGS_DIR;
    else process.env.CURSOR_LOGS_DIR = previousLogsDir;
    if (previousReconcileInterval === undefined) delete process.env.CODELARK_CURSOR_DESKTOP_HOOK_RECONCILE_INTERVAL_MS;
    else process.env.CODELARK_CURSOR_DESKTOP_HOOK_RECONCILE_INTERVAL_MS = previousReconcileInterval;
    if (previousDisableWatch === undefined) delete process.env.CODELARK_CURSOR_DESKTOP_HOOK_DISABLE_WATCH;
    else process.env.CODELARK_CURSOR_DESKTOP_HOOK_DISABLE_WATCH = previousDisableWatch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the latest event for one conversation without leaking fields from the next event', async () => {
    const logDir = path.join(root, '20261009T000000', 'window1', 'output');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'cursor.hooks.workspace.log');
    fs.writeFileSync(logPath, [
      hookBlock('2026-10-09T00:00:00.000Z', 'preToolUse', {
        conversation_id: 'target-conversation',
        generation_id: 'target-generation',
        model: 'target-model-high',
        model_id: 'target-model',
        tool_name: 'Shell',
        command: 'npm test',
      }),
      hookBlock('2026-10-09T00:00:01.000Z', 'afterAgentThought', {
        conversation_id: 'other-conversation',
        generation_id: 'other-generation',
        model: 'other-model',
      }),
    ].join(''));

    const activity = await inspectCursorDesktopHookActivity('target-conversation');

    assert.equal(activity?.step, 'preToolUse');
    assert.equal(activity?.generationId, 'target-generation');
    assert.equal(activity?.model, 'target-model-high');
    assert.equal(activity?.modelId, 'target-model');
    assert.equal(activity?.toolName, 'Shell');
    assert.equal(activity?.command, 'npm test');
    assert.equal(activity?.logPath, logPath);
  });

  it('shares an async watcher, skips baseline history, and retains a partial final JSON object', async () => {
    const logDir = path.join(root, '20261009T010000', 'window1', 'output');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'cursor.hooks.workspace.log');
    fs.writeFileSync(logPath, hookBlock('2026-10-09T01:00:00.000Z', 'afterAgentThought', {
      conversation_id: 'target-conversation',
      generation_id: 'old-generation',
      text: 'old thought',
    }));
    const target = await subscribeCursorDesktopHookActivities('target-conversation');
    const other = await subscribeCursorDesktopHookActivities('other-conversation');
    try {
      const appended = [
        hookBlock('2026-10-09T01:00:01.000Z', 'afterAgentThought', {
          conversation_id: 'target-conversation',
          generation_id: 'new-generation',
          model: 'claude-test-high',
          text: 'new thought',
        }),
        hookBlock('2026-10-09T01:00:02.000Z', 'preToolUse', {
          conversation_id: 'target-conversation',
          generation_id: 'new-generation',
          tool_name: 'Shell',
          tool_use_id: 'tool-1',
          tool_input: { command: 'pwd' },
        }),
        hookBlock('2026-10-09T01:00:03.000Z', 'postToolUse', {
          conversation_id: 'target-conversation',
          generation_id: 'new-generation',
          tool_name: 'Shell',
          tool_use_id: 'tool-1',
          tool_output: JSON.stringify({ output: '/workspace' }),
        }),
        hookBlock('2026-10-09T01:00:04.000Z', 'afterAgentThought', {
          conversation_id: 'other-conversation',
          text: 'other thought',
        }),
      ].join('');
      const split = appended.lastIndexOf('"tool_output"') + 20;
      fs.appendFileSync(logPath, appended.slice(0, split));

      const first = await collectActivities(target, 2);
      assert.deepEqual(first.map((activity) => activity.step), ['afterAgentThought', 'preToolUse']);
      assert.equal(first[0]?.text, 'new thought');
      assert.deepEqual(first[1]?.toolInput, { command: 'pwd' });

      fs.appendFileSync(logPath, appended.slice(split));
      const second = await collectActivities(target, 1);
      const otherActivities = await collectActivities(other, 1);
      assert.deepEqual(second.map((activity) => activity.step), ['postToolUse']);
      assert.equal(second[0]?.toolUseId, 'tool-1');
      assert.equal(second[0]?.toolOutput, JSON.stringify({ output: '/workspace' }));
      assert.deepEqual(otherActivities.map((activity) => activity.text), ['other thought']);
      assert.doesNotMatch(JSON.stringify([...first, ...second]), /old thought/);
    } finally {
      target.close();
      other.close();
    }
  });

  it('falls back to low-frequency async reconciliation when fs.watch is unavailable', async () => {
    process.env.CODELARK_CURSOR_DESKTOP_HOOK_DISABLE_WATCH = '1';
    const logDir = path.join(root, '20261009T020000', 'window1', 'output');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'cursor.hooks.workspace.log');
    fs.writeFileSync(logPath, '');
    const subscription = await subscribeCursorDesktopHookActivities('target-conversation');
    try {
      fs.appendFileSync(logPath, hookBlock('2026-10-09T02:00:01.000Z', 'afterAgentThought', {
        conversation_id: 'target-conversation', text: 'fallback thought',
      }));
      const activities = await collectActivities(subscription, 1);
      assert.deepEqual(activities.map((activity) => activity.text), ['fallback thought']);
    } finally {
      subscription.close();
    }
  });

  it('retains partial headers and UTF-8 characters across separate reads without replaying completed hooks', async () => {
    const logDir = path.join(root, '20261009T030000', 'window1', 'output');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'cursor.hooks.workspace.log');
    fs.writeFileSync(logPath, '');
    const subscription = await subscribeCursorDesktopHookActivities('target-conversation');
    try {
      const first = hookBlock('2026-10-09T03:00:01.000Z', 'afterAgentThought', {
        conversation_id: 'target-conversation', text: 'first thought',
      });
      const second = Buffer.from(hookBlock('2026-10-09T03:00:02.000Z', 'afterAgentThought', {
        conversation_id: 'target-conversation', text: '中文思考🧠完整尾标',
      }));
      const headerSplit = 13;
      fs.appendFileSync(logPath, first + second.subarray(0, headerSplit).toString());
      assert.deepEqual((await collectActivities(subscription, 1)).map((item) => item.text), ['first thought']);

      const unicodeSplit = second.indexOf(Buffer.from('中')) + 1;
      fs.appendFileSync(logPath, second.subarray(headerSplit, unicodeSplit));
      // No complete event is available; allow the watcher/fallback to consume
      // this byte range before appending the remaining UTF-8 continuation bytes.
      await subscription.waitForActivity(150);
      assert.deepEqual(subscription.drain(), []);
      fs.appendFileSync(logPath, second.subarray(unicodeSplit));
      assert.deepEqual((await collectActivities(subscription, 1)).map((item) => item.text), ['中文思考🧠完整尾标']);

      const third = hookBlock('2026-10-09T03:00:03.000Z', 'afterAgentThought', {
        conversation_id: 'target-conversation', text: 'standalone partial header',
      });
      fs.appendFileSync(logPath, third.slice(0, headerSplit));
      await subscription.waitForActivity(150);
      assert.deepEqual(subscription.drain(), []);
      fs.appendFileSync(logPath, third.slice(headerSplit));
      assert.deepEqual((await collectActivities(subscription, 1)).map((item) => item.text), ['standalone partial header']);
    } finally {
      subscription.close();
    }
  });

  it('reads large thoughts completely in bounded chunks and resets the decoder after rotation', async () => {
    const logDir = path.join(root, '20261009T040000', 'window1', 'output');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'cursor.hooks.workspace.log');
    fs.writeFileSync(logPath, '');
    const subscription = await subscribeCursorDesktopHookActivities('target-conversation');
    try {
      const thought = '完整思考🧠'.repeat(30_000) + 'END-THOUGHT';
      fs.appendFileSync(logPath, hookBlock('2026-10-09T04:00:01.000Z', 'afterAgentThought', {
        conversation_id: 'target-conversation', text: thought,
      }));
      assert.deepEqual((await collectActivities(subscription, 1)).map((item) => item.text), [thought]);
      fs.appendFileSync(logPath, Buffer.from('[partial header 中').subarray(0, -1));
      await subscription.waitForActivity(150);
      fs.renameSync(logPath, `${logPath}.old`);
      fs.writeFileSync(logPath, hookBlock('2026-10-09T04:00:02.000Z', 'afterAgentThought', {
        conversation_id: 'target-conversation', text: 'rotated thought',
      }));
      assert.deepEqual((await collectActivities(subscription, 1)).map((item) => item.text), ['rotated thought']);
    } finally {
      subscription.close();
    }
  });
});
