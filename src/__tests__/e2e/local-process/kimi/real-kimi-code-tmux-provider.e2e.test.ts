import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { findKimiSessionFileById } from '../../../../runtime/kimi/session-index.js';
import { kimiSessionLogFilePath } from '../../../../runtime/kimi/runtime-log.js';
import {
  kimiTmuxSessionName,
  parseKimiSessionIdFromScreen,
  streamKimiTmuxTui,
} from '../../../../runtime/kimi/tmux-provider.js';
import {
  commandAvailable,
  execRuntimeCommand,
  removeRuntimeTestDirectory,
  startLocalResponsesProxy,
  waitForCondition,
} from '../../../helpers/runtime/real-codex-e2e-utils.js';

const execFileAsync = promisify(execFile);

interface ParsedSse {
  type: string;
  data: unknown;
}

async function readSse(stream: ReadableStream<string>): Promise<ParsedSse[]> {
  let raw = '';
  for await (const chunk of stream) raw += chunk;
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; data: string })
    .map((event) => {
      try {
        return { type: event.type, data: JSON.parse(event.data) };
      } catch {
        return { type: event.type, data: event.data };
      }
    });
}

function resultSessionId(events: ParsedSse[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'result' || !event.data || typeof event.data !== 'object') continue;
    const sessionId = (event.data as { session_id?: unknown }).session_id;
    if (typeof sessionId === 'string' && sessionId) return sessionId;
  }
  return undefined;
}

function textEvents(events: ParsedSse[]): string[] {
  return events
    .filter((event) => event.type === 'text' && typeof event.data === 'string')
    .map((event) => event.data as string);
}

function errorEvents(events: ParsedSse[]): string[] {
  return events
    .filter((event) => event.type === 'error')
    .map((event) => typeof event.data === 'string' ? event.data : JSON.stringify(event.data));
}

function installedKimiCodeExecutable(): string {
  const hostHome = process.env.CODELARK_TEST_ORIGINAL_HOME || os.homedir();
  return process.env.CODELARK_REAL_KIMI_E2E_EXECUTABLE
    || path.join(hostHome, '.kimi-code', 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi');
}

describe('real Kimi Code tmux provider e2e', () => {
  it('creates, steers, resumes, and reports a provider error from the real Kimi executable', { timeout: 120_000 }, async (t: TestContext) => {
    if (!(await commandAvailable('tmux', ['-V']))) {
      t.skip('tmux is not available');
      return;
    }
    const executable = installedKimiCodeExecutable();
    if (!(await commandAvailable(executable, ['--version']))) {
      t.skip(`real Kimi Code executable is not available at ${executable}`);
      return;
    }

    const previousEnv = new Map<string, string | undefined>();
    const env = {
      KIMI_CODE_HOME: '',
      CODELARK_KIMI_EXECUTABLE: executable,
      KIMI_CODE_EXECUTABLE: undefined,
      KIMI_MODEL_NAME: 'codelark-real-kimi-e2e',
      KIMI_MODEL_API_KEY: 'codelark-local-mock-key',
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: '',
      KIMI_MODEL_MAX_CONTEXT_SIZE: '32768',
      KIMI_MODEL_CAPABILITIES: '',
      KIMI_DISABLE_TELEMETRY: '1',
      CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: '50',
      CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS: '10000',
      CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: '10000',
      CODELARK_KIMI_TMUX_OUTPUT_IDLE_TIMEOUT_MS: '20000',
      CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: '0',
      CODELARK_DEBUG: '1',
    } satisfies Record<string, string | undefined>;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-kimi-code-tmux-'));
    const kimiHome = path.join(tempDir, 'kimi-home');
    const workDir = path.join(tempDir, 'workspace');
    const bridgeSessionId = `real-kimi-code-${process.pid}-${Date.now()}`;
    const tmuxSessionName = kimiTmuxSessionName(bridgeSessionId);
    const responseText = `CODELARK_REAL_KIMI_CODE_${process.pid}_${Date.now()}`;
    const fatalMarker = `CODELARK_REAL_KIMI_FATAL_${process.pid}_${Date.now()}`;
    const proxy = await startLocalResponsesProxy({
      responseText,
      responseDelayMs: 2_500,
      errorWhenBodyIncludes: fatalMarker,
      errorStatus: 402,
      errorBody: {
        error: {
          type: 'membership_inactive',
          code: 'membership_inactive',
          message: fatalMarker,
        },
      },
    });
    env.KIMI_CODE_HOME = kimiHome;
    env.KIMI_MODEL_BASE_URL = proxy.baseUrl;
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(kimiHome, 'config.toml'), [
      'default_model = "codelark-real-kimi-e2e"',
      '',
      '[providers.codelark-local]',
      'type = "openai"',
      `base_url = ${JSON.stringify(proxy.baseUrl)}`,
      'api_key = "codelark-local-mock-key"',
      '',
      '[models.codelark-real-kimi-e2e]',
      'provider = "codelark-local"',
      'model = "codelark-real-kimi-e2e"',
      'max_context_size = 32768',
      '',
    ].join('\n'), 'utf-8');
    for (const [key, value] of Object.entries(env)) {
      previousEnv.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => {});

    try {
      const version = (await execRuntimeCommand(executable, ['--version'])).stdout.trim();
      assert.match(version, /^\d+\.\d+\.\d+/, 'the gate must execute a real versioned Kimi Code binary');

      const firstPromise = readSse(streamKimiTmuxTui({
        sessionId: bridgeSessionId,
        runtime: 'kimi',
        prompt: `Reply with exactly: ${responseText}`,
        workingDirectory: workDir,
      }));
      assert.equal(
        await waitForCondition(
          () => proxy.requests.some((request) => request.url.includes('/chat/completions')),
          15_000,
          50,
        ),
        true,
        'the first real Kimi turn must reach the slow mock model',
      );
      const runningScreen = (await execFileAsync(
        'tmux',
        ['capture-pane', '-p', '-t', `${tmuxSessionName}:0.0`, '-S', '-120'],
      )).stdout;
      const kimiSessionId = parseKimiSessionIdFromScreen(runningScreen);
      assert.match(kimiSessionId || '', /^session_[0-9a-f-]+$/i);
      const sessionFile = findKimiSessionFileById(kimiSessionId!, workDir);
      assert.ok(sessionFile?.filePath);

      const steerText = `STEER_${process.pid}_${Date.now()}`;
      const steeredPromise = readSse(streamKimiTmuxTui({
        sessionId: bridgeSessionId,
        runtime: 'kimi',
        kimiSessionId: kimiSessionId!,
        prompt: steerText,
        workingDirectory: workDir,
      }));
      assert.equal(
        await waitForCondition(() => {
          const wire = fs.readFileSync(sessionFile.filePath, 'utf-8');
          return wire.includes('"type":"turn.steer"') && wire.includes(steerText);
        }, 5_000, 50),
        true,
        'the second input must become turn.steer while the first model request is still running',
      );
      const steeredScreen = (await execFileAsync(
        'tmux',
        ['capture-pane', '-p', '-t', `${tmuxSessionName}:0.0`, '-S', '-120'],
      )).stdout;
      assert.match(steeredScreen, new RegExp(steerText));

      const [first, steered] = await Promise.all([firstPromise, steeredPromise]);
      const firstErrors = errorEvents(first);
      if (firstErrors.length > 0) {
        const capture = await execFileAsync('tmux', ['capture-pane', '-p', '-t', `${tmuxSessionName}:0.0`, '-S', '-120'])
          .then((result) => result.stdout)
          .catch((error) => `capture failed: ${String(error)}`);
        assert.fail(`real Kimi first turn failed: ${firstErrors.join(' | ')}\n--- tmux ---\n${capture}`);
      }
      assert.ok(textEvents(first).some((text) => text.includes(responseText)));
      assert.deepEqual(errorEvents(steered), []);
      assert.equal(resultSessionId(first), kimiSessionId);
      assert.equal(resultSessionId(steered), kimiSessionId);
      assert.match(kimiSessionId || '', /^session_[0-9a-f-]+$/i);
      assert.notEqual(kimiSessionId, `session_${bridgeSessionId}`, 'Kimi Code owns fresh session ids');
      assert.equal(findKimiSessionFileById(kimiSessionId!, workDir)?.sessionId, kimiSessionId);

      await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]);
      const resumed = await readSse(streamKimiTmuxTui({
        sessionId: bridgeSessionId,
        runtime: 'kimi',
        kimiSessionId: kimiSessionId!,
        prompt: `Reply with exactly: ${responseText}`,
        workingDirectory: workDir,
      }));
      assert.deepEqual(errorEvents(resumed), []);
      assert.equal(resultSessionId(resumed), kimiSessionId);
      assert.ok(proxy.requests.filter((request) => request.url.includes('/chat/completions')).length >= 2);

      const failed = await readSse(streamKimiTmuxTui({
        sessionId: bridgeSessionId,
        runtime: 'kimi',
        kimiSessionId: kimiSessionId!,
        prompt: `Trigger the deterministic provider failure: ${fatalMarker}`,
        workingDirectory: workDir,
      }));
      const failedErrors = errorEvents(failed);
      assert.equal(failedErrors.length, 1);
      assert.match(failedErrors[0] || '', /Kimi Code request failed/);
      assert.match(failedErrors[0] || '', new RegExp(fatalMarker));
      assert.equal(failed.some((event) => event.type === 'result'), false);
      assert.equal(
        proxy.requests.some((request) => request.url.includes('/chat/completions') && request.rawBody.includes(fatalMarker)),
        true,
      );
      const runtimeLog = fs.readFileSync(kimiSessionLogFilePath(sessionFile.filePath), 'utf8');
      assert.match(runtimeLog, /ERROR\s+turn failed/);
      assert.match(runtimeLog, new RegExp(fatalMarker));
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => {});
      await proxy.close().catch(() => undefined);
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeRuntimeTestDirectory(tempDir);
    }
  });
});
