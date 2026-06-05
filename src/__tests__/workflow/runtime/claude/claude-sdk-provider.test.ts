import '../../../setup/test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _testOnlyClaudeSdk } from '../../../../runtime/claude/sdk-provider.js';

async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('ClaudeSdkProvider helpers', () => {
  beforeEach(() => {
    delete process.env.CODELARK_CLAUDE_EXECUTABLE;
    delete process.env.CODELARK_CLAUDE_CCR_START_TIMEOUT_MS;
    delete process.env.CODELARK_FAKE_CCR_CALLS_PATH;
    delete process.env.CODELARK_FAKE_CCR_RUNNING_PATH;
  });

  it('builds SDK options with deterministic first-session identity', async () => {
    const options = await withEnvOverride(
      { CODELARK_CLAUDE_EXECUTABLE: undefined },
      () => _testOnlyClaudeSdk.buildClaudeSdkOptions({
        prompt: 'hello',
        sessionId: '11111111-2222-4333-8444-555555555555',
        workingDirectory: '/tmp/claude-sdk',
        model: 'claude-sonnet-test',
        systemPrompt: 'system',
        claudePermissionMode: 'plan',
        claudeReasoningEffort: 'high',
      }),
    );

    assert.equal(options.env?.CODELARK_CLAUDE_EXECUTABLE, undefined);
    assert.equal(options.sessionId, '11111111-2222-4333-8444-555555555555');
    assert.equal(options.cwd, '/tmp/claude-sdk');
    assert.equal(options.model, 'claude-sonnet-test');
    assert.equal(options.permissionMode, 'plan');
    assert.equal(options.effort, 'high');
    assert.equal(options.systemPrompt, 'system');
  });

  it('resumes an existing Claude session instead of assigning a new sessionId', async () => {
    const options = await withEnvOverride(
      { CODELARK_CLAUDE_EXECUTABLE: undefined },
      () => _testOnlyClaudeSdk.buildClaudeSdkOptions({
        prompt: 'hello',
        sessionId: '11111111-2222-4333-8444-555555555555',
        claudeSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      }),
    );

    assert.equal(options.env?.CODELARK_CLAUDE_EXECUTABLE, undefined);
    assert.equal(options.resume, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    assert.equal(options.sessionId, undefined);
  });

  it('prepares Claude Code Router env from the per-turn executable before launching the SDK subprocess', async () => {
    const previousEnv = {
      PATH: process.env.PATH,
      CODELARK_CLAUDE_EXECUTABLE: process.env.CODELARK_CLAUDE_EXECUTABLE,
      CODELARK_CLAUDE_CCR_START_TIMEOUT_MS: process.env.CODELARK_CLAUDE_CCR_START_TIMEOUT_MS,
      CODELARK_FAKE_CCR_CALLS_PATH: process.env.CODELARK_FAKE_CCR_CALLS_PATH,
      CODELARK_FAKE_CCR_RUNNING_PATH: process.env.CODELARK_FAKE_CCR_RUNNING_PATH,
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-sdk-fake-ccr-'));
    const binDir = path.join(tempDir, 'bin');
    const nodeModulesBinDir = path.join(tempDir, 'repo', 'node_modules', '.bin');
    const callsPath = path.join(tempDir, 'calls.jsonl');
    const runningPath = path.join(tempDir, 'router-running');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(nodeModulesBinDir, { recursive: true });

    const scriptPath = path.join(binDir, 'fake-ccr.cjs');
    fs.writeFileSync(scriptPath, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const command = process.argv[2] || '';
const callsPath = process.env.CODELARK_FAKE_CCR_CALLS_PATH;
const runningPath = process.env.CODELARK_FAKE_CCR_RUNNING_PATH;
if (callsPath) {
  fs.appendFileSync(callsPath, JSON.stringify({
    command,
    env: {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CODELARK_FAKE_CCR_BRIDGE_ENV: process.env.CODELARK_FAKE_CCR_BRIDGE_ENV,
    },
    running: runningPath ? fs.existsSync(runningPath) : false,
  }) + '\n');
}
if (command === 'activate') {
  process.stdout.write('export ANTHROPIC_BASE_URL="http://127.0.0.1:4567"\n');
  process.stdout.write("export ANTHROPIC_AUTH_TOKEN='fake-sdk-router-token'\n");
  process.exit(0);
}
if (command === 'status') {
  if (runningPath && fs.existsSync(runningPath)) {
    process.stdout.write('Status: Running\n');
    process.exit(0);
  }
  process.stdout.write('❌ Status: Not Running\n');
  process.exit(0);
}
if (command === 'start') {
  if (runningPath) fs.writeFileSync(runningPath, 'running');
  process.exit(0);
}
process.exit(2);
`, 'utf-8');
    const executablePath = path.join(binDir, process.platform === 'win32' ? 'ccr.cmd' : 'ccr');
    if (process.platform === 'win32') {
      fs.writeFileSync(executablePath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf-8');
    } else {
      fs.writeFileSync(executablePath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf-8');
      fs.chmodSync(executablePath, 0o755);
    }
    const localExecutablePath = path.join(nodeModulesBinDir, process.platform === 'win32' ? 'ccr.cmd' : 'ccr');
    if (process.platform === 'win32') {
      fs.writeFileSync(localExecutablePath, '@echo off\r\nexit /b 99\r\n', 'utf-8');
    } else {
      fs.writeFileSync(localExecutablePath, '#!/usr/bin/env sh\nexit 99\n', 'utf-8');
      fs.chmodSync(localExecutablePath, 0o755);
    }

    process.env.PATH = `${nodeModulesBinDir}${path.delimiter}${binDir}${path.delimiter}${process.env.PATH || ''}`;
    delete process.env.CODELARK_CLAUDE_EXECUTABLE;
    process.env.CODELARK_CLAUDE_CCR_START_TIMEOUT_MS = '3000';
    process.env.CODELARK_FAKE_CCR_CALLS_PATH = callsPath;
    process.env.CODELARK_FAKE_CCR_RUNNING_PATH = runningPath;

    try {
      const options = await _testOnlyClaudeSdk.buildClaudeSdkOptions({
        prompt: 'hello',
        sessionId: '11111111-2222-4333-8444-555555555555',
        claudeExecutable: 'ccr',
      });

      assert.equal(options.env?.CODELARK_CLAUDE_EXECUTABLE, 'ccr');
      assert.equal(options.env?.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4567');
      assert.equal(options.env?.ANTHROPIC_AUTH_TOKEN, 'fake-sdk-router-token');
      assert.ok(fs.existsSync(runningPath), 'expected SDK env preparation to start fake CCR');
      const calls = fs.readFileSync(callsPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { command: string; running: boolean });
      assert.equal(calls[0]?.command, 'activate');
      const startIndex = calls.findIndex((call) => call.command === 'start');
      assert.ok(startIndex > 0, 'expected SDK env preparation to start fake CCR');
      assert.ok(
        calls.slice(0, startIndex).some((call) => call.command === 'status' && !call.running),
        'expected SDK env preparation to observe CCR as stopped before starting it',
      );
      assert.ok(
        calls.slice(startIndex + 1).some((call) => call.command === 'status' && call.running),
        'expected SDK env preparation to verify CCR is running after start',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('extracts assistant text blocks from SDK messages', () => {
    const text = _testOnlyClaudeSdk.textFromAssistant({
      type: 'assistant',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
          { type: 'text', text: 'world' },
        ],
      },
      parent_tool_use_id: null,
      uuid: '11111111-2222-4333-8444-555555555555',
      session_id: '11111111-2222-4333-8444-555555555555',
    } as any);

    assert.equal(text, 'hello world');
  });

  it('emits SDK tool_use and tool_result events from Claude message blocks', async () => {
    const chunks: string[] = [];
    const controller = {
      enqueue(chunk: string) {
        chunks.push(chunk);
      },
    } as ReadableStreamDefaultController<string>;

    _testOnlyClaudeSdk.enqueueAssistantContentBlocks(controller, {
      type: 'assistant',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } },
        ],
      },
      parent_tool_use_id: null,
      uuid: '11111111-2222-4333-8444-555555555555',
      session_id: '11111111-2222-4333-8444-555555555555',
    } as any);
    _testOnlyClaudeSdk.enqueueUserToolResults(controller, {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'workspace' }],
      },
      uuid: '22222222-2222-4222-8222-222222222222',
      session_id: '11111111-2222-4333-8444-555555555555',
    } as any);

    const events = chunks
      .join('')
      .trim()
      .split(/\n/)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
    assert.deepEqual(events.map((event) => event.type), ['text', 'tool_use', 'tool_result']);
    assert.deepEqual(JSON.parse(events[1].data), {
      id: 'toolu_1',
      name: 'Bash',
      input: { command: 'pwd' },
    });
    assert.deepEqual(JSON.parse(events[2].data), {
      tool_use_id: 'toolu_1',
      content: 'workspace',
      is_error: false,
    });
  });
});
