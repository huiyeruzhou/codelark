import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { inspectCursorDesktopHookActivity } from '../../../../runtime/cursor/desktop-diagnostics.js';

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
});
