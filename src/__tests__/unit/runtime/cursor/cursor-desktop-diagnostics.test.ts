import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  captureCursorDesktopHookCursor,
  inspectCursorDesktopHookActivity,
  readCursorDesktopHookActivityDelta,
} from '../../../../runtime/cursor/desktop-diagnostics.js';

function hookBlock(timestamp: string, step: string, input: Record<string, unknown>): string {
  return [
    `[${timestamp}] Hook step requested: ${step}`,
    'INPUT:',
    JSON.stringify(input, null, 2),
    '',
  ].join('\n');
}

describe('Cursor Desktop hook diagnostics', () => {
  let root = '';
  let previousLogsDir: string | undefined;

  beforeEach(() => {
    previousLogsDir = process.env.CURSOR_LOGS_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-cursor-hooks-'));
    process.env.CURSOR_LOGS_DIR = root;
  });

  afterEach(() => {
    if (previousLogsDir === undefined) delete process.env.CURSOR_LOGS_DIR;
    else process.env.CURSOR_LOGS_DIR = previousLogsDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the latest event for one conversation without leaking fields from the next event', () => {
    const logDir = path.join(root, '20261009T000000', 'window1', 'output');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'cursor.hooks.workspace.log');
    fs.writeFileSync(logPath, [
      '[2026-10-09T00:00:00.000Z] Hook step requested: preToolUse',
      'INPUT:',
      JSON.stringify({
        conversation_id: 'target-conversation',
        generation_id: 'target-generation',
        model: 'target-model-high',
        model_id: 'target-model',
        tool_name: 'Shell',
        command: 'npm test',
      }, null, 2),
      '[2026-10-09T00:00:01.000Z] Hook step requested: afterAgentThought',
      'INPUT:',
      JSON.stringify({
        conversation_id: 'other-conversation',
        generation_id: 'other-generation',
        model: 'other-model',
      }, null, 2),
    ].join('\n'));

    const activity = inspectCursorDesktopHookActivity('target-conversation');

    assert.equal(activity?.step, 'preToolUse');
    assert.equal(activity?.generationId, 'target-generation');
    assert.equal(activity?.model, 'target-model-high');
    assert.equal(activity?.modelId, 'target-model');
    assert.equal(activity?.toolName, 'Shell');
    assert.equal(activity?.command, 'npm test');
    assert.equal(activity?.logPath, logPath);
  });

  it('reads every appended hook after a byte baseline and retains a partial final JSON object', () => {
    const logDir = path.join(root, '20261009T010000', 'window1', 'output');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'cursor.hooks.workspace.log');
    fs.writeFileSync(logPath, hookBlock('2026-10-09T01:00:00.000Z', 'afterAgentThought', {
      conversation_id: 'target-conversation',
      generation_id: 'old-generation',
      text: 'old thought',
    }));
    let cursor = captureCursorDesktopHookCursor();
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
    ].join('');
    const split = appended.lastIndexOf('"tool_output"') + 20;
    fs.appendFileSync(logPath, appended.slice(0, split));

    const first = readCursorDesktopHookActivityDelta('target-conversation', cursor);
    cursor = first.cursor;
    assert.deepEqual(first.activities.map((activity) => activity.step), ['afterAgentThought', 'preToolUse']);
    assert.equal(first.activities[0]?.text, 'new thought');
    assert.deepEqual(first.activities[1]?.toolInput, { command: 'pwd' });

    fs.appendFileSync(logPath, appended.slice(split));
    const second = readCursorDesktopHookActivityDelta('target-conversation', cursor);
    assert.deepEqual(second.activities.map((activity) => activity.step), ['postToolUse']);
    assert.equal(second.activities[0]?.toolUseId, 'tool-1');
    assert.equal(second.activities[0]?.toolOutput, JSON.stringify({ output: '/workspace' }));
    assert.doesNotMatch(JSON.stringify([...first.activities, ...second.activities]), /old thought/);
  });

  it('filters interleaved hook records by exact conversation id', () => {
    const logDir = path.join(root, '20261009T020000', 'window1', 'output');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'cursor.hooks.workspace.log');
    fs.writeFileSync(logPath, '');
    const cursor = captureCursorDesktopHookCursor();
    fs.appendFileSync(logPath, [
      hookBlock('2026-10-09T02:00:01.000Z', 'afterAgentThought', {
        conversation_id: 'target-conversation', text: 'target thought',
      }),
      hookBlock('2026-10-09T02:00:02.000Z', 'afterAgentThought', {
        conversation_id: 'other-conversation', text: 'other thought',
      }),
    ].join(''));

    const delta = readCursorDesktopHookActivityDelta('target-conversation', cursor);
    assert.deepEqual(delta.activities.map((activity) => activity.text), ['target thought']);
  });
});
