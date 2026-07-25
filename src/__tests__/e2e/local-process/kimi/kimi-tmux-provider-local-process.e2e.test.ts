import '../../../setup/test-setup.js';
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { findKimiSessionFileById } from '../../../../runtime/kimi/session-index.js';
import { kimiTmuxSessionName, streamKimiTmuxTui } from '../../../../runtime/kimi/tmux-provider.js';

const execFileAsync = promisify(execFile);

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

async function readStream(stream: ReadableStream<string>): Promise<string> {
  let output = '';
  for await (const chunk of stream) {
    output += chunk;
  }
  return output;
}

function parseSse(raw: string): Array<{ type: string; data: unknown }> {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      const outer = JSON.parse(line.slice('data: '.length)) as { type: string; data: string };
      let data: unknown = outer.data;
      if (outer.data.startsWith('{')) {
        data = JSON.parse(outer.data);
      }
      return { type: outer.type, data };
    });
}

function writeFakeKimiExecutable(binDir: string, params: {
  sessionId: string;
  ctrlCPath: string;
  keyLogPath: string;
  launchLogPath: string;
}): string {
  const executablePath = path.join(binDir, 'kimi');
  const scriptPath = path.join(binDir, 'fake-kimi.cjs');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const fallbackSessionId = ${JSON.stringify(params.sessionId)};
const ctrlCPath = ${JSON.stringify(params.ctrlCPath)};
const keyLogPath = ${JSON.stringify(params.keyLogPath)};
const launchLogPath = ${JSON.stringify(params.launchLogPath)};
const kimiHome = process.env.KIMI_CODE_HOME;
if (!kimiHome) {
  process.stderr.write('KIMI_CODE_HOME is required\\n');
  process.exit(2);
}

const resumeIndex = process.argv.indexOf('-r');
const resumed = resumeIndex >= 0 && Boolean(process.argv[resumeIndex + 1]);
const sessionId = resumed ? process.argv[resumeIndex + 1] : fallbackSessionId;
const sessionDir = path.join(kimiHome, 'sessions', 'wd_fake-local-process', sessionId);
const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
fs.appendFileSync(launchLogPath, JSON.stringify({ argv: process.argv.slice(2), resumed }) + '\\n');
fs.mkdirSync(path.dirname(wirePath), { recursive: true });
fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
  createdAt: '2026-06-26T18:17:00.000Z',
  updatedAt: '2026-06-26T18:17:00.000Z',
  title: 'Fake Kimi local process smoke',
  lastPrompt: 'fake kimi prompt',
}, null, 2) + '\\n');
fs.writeFileSync(wirePath, '');
fs.appendFileSync(path.join(kimiHome, 'session_index.jsonl'), JSON.stringify({
  sessionId,
  sessionDir,
  workDir: process.cwd(),
}) + '\\n');

process.stdout.write('Kimi Code fake local process\\n');
process.stdout.write('Session: ' + sessionId + '\\n');
process.stdout.write('│ > \\ncontext: 0% (0/256k)\\n');

if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();

let answerCount = 0;
let ctrlCCount = 0;
const appendWire = (entry) => fs.appendFileSync(wirePath, JSON.stringify(entry) + '\\n');
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(keyLogPath, chunk.toString('hex') + '\\n');
  if (chunk.includes(0x13)) {
    answerCount += 1;
    const now = Date.now();
    const turnId = 'turn-' + answerCount;
    const stepId = 'step-' + answerCount;
    appendWire({ type: 'context.append_loop_event', time: now, event: { type: 'step.begin', turnId, stepUuid: stepId } });
    appendWire({ type: 'context.append_loop_event', time: now + 1, event: { type: 'content.part', turnId, part: { type: 'think', think: 'fake kimi thinking' } } });
    appendWire({ type: 'context.append_loop_event', time: now + 2, event: { type: 'content.part', turnId, part: { type: 'text', text: answerCount === 1 ? 'fake kimi answer' : 'fake kimi answer ' + answerCount } } });
    appendWire({ type: 'context.append_loop_event', time: now + 3, event: { type: 'step.end', turnId, stepUuid: stepId } });
  }
  for (const byte of chunk) {
    if (byte !== 0x03) continue;
    ctrlCCount += 1;
    fs.writeFileSync(ctrlCPath, String(ctrlCCount));
    if (ctrlCCount >= 2) {
      process.stdout.write('\\nTo resume this session: kimi -r ' + sessionId + '\\n');
      setTimeout(() => process.exit(0), 50);
    }
  }
});

setInterval(() => {}, 1000);
`, 'utf-8');

  fs.writeFileSync(executablePath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf-8');
  fs.chmodSync(executablePath, 0o755);
  return executablePath;
}

describe('scripted Kimi-like tmux adapter fixture', () => {
  it('drives and reuses a scripted wire producer through real tmux and Ctrl-S steer', { timeout: 30_000 }, async (t: TestContext) => {
    if (!(await tmuxAvailable())) {
      t.skip('tmux is not available');
      return;
    }

    const previousEnv = {
      KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
      KIMI_CODE_EXECUTABLE: process.env.KIMI_CODE_EXECUTABLE,
      CODELARK_KIMI_EXECUTABLE: process.env.CODELARK_KIMI_EXECUTABLE,
      CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: process.env.CODELARK_KIMI_TMUX_POLL_INTERVAL_MS,
      CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS: process.env.CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS,
      CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: process.env.CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS,
      CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: process.env.CODELARK_KIMI_TMUX_PROMPT_DELAY_MS,
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-real-kimi-tmux-'));
    const kimiHome = path.join(tempDir, 'kimi-home');
    const binDir = path.join(tempDir, 'bin');
    const workDir = path.join(tempDir, 'workspace');
    const ctrlCPath = path.join(tempDir, 'ctrl-c-count');
    const keyLogPath = path.join(tempDir, 'keys.hex');
    const launchLogPath = path.join(tempDir, 'launches.jsonl');
    const sessionId = 'session_bridge-kimi-local-e2e';
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(kimiHome, { recursive: true });

    process.env.KIMI_CODE_HOME = kimiHome;
    process.env.KIMI_CODE_EXECUTABLE = writeFakeKimiExecutable(binDir, { sessionId, ctrlCPath, keyLogPath, launchLogPath });
    process.env.CODELARK_KIMI_TMUX_POLL_INTERVAL_MS = '50';
    process.env.CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS = '5000';
    process.env.CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS = '5000';
    process.env.CODELARK_KIMI_TMUX_PROMPT_DELAY_MS = '150';
    const tmuxSessionName = kimiTmuxSessionName('bridge-kimi-local-e2e');
    await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => {});

    try {
      const raw = await readStream(streamKimiTmuxTui({
        sessionId: 'bridge-kimi-local-e2e',
        prompt: 'local kimi tmux smoke',
        workingDirectory: workDir,
      } as any));
      const events = parseSse(raw);

      assert.equal(events.some((event) => event.type === 'status' && (event.data as { session_id?: string }).session_id === sessionId), true);
      assert.equal(events.some((event) => event.type === 'status' && (event.data as { thinking?: string }).thinking === 'fake kimi thinking'), true);
      assert.equal(events.some((event) => event.type === 'text' && event.data === 'fake kimi answer'), true);
      assert.equal(events.some((event) => event.type === 'result' && (event.data as { session_id?: string }).session_id === sessionId), true);

      const keyLog = fs.readFileSync(keyLogPath, 'utf-8');
      assert.match(keyLog, /13/, 'Kimi tmux provider should send Ctrl-S after the prompt');
      assert.equal(fs.existsSync(ctrlCPath), false, 'fresh Kimi startup must not terminate the first TUI just to discover its session id');
      assert.equal(findKimiSessionFileById(sessionId, workDir)?.sessionId, sessionId);
      const launches = fs.readFileSync(launchLogPath, 'utf-8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { argv: string[]; resumed: boolean });
      assert.deepEqual(launches[0]?.argv, ['-y']);
      assert.equal(launches[0]?.resumed, false, 'fresh Kimi startup must let Kimi Code create the session id');

      const live = await execFileAsync('tmux', ['has-session', '-t', tmuxSessionName])
        .then(() => true, () => false);
      assert.equal(live, true, 'successful turns must keep the provider-owned Kimi tmux session alive');

      const secondRaw = await readStream(streamKimiTmuxTui({
        sessionId: 'bridge-kimi-local-e2e',
        prompt: 'local kimi tmux follow-up',
        workingDirectory: workDir,
        kimiSessionId: sessionId,
      } as any));
      const secondEvents = parseSse(secondRaw);
      assert.equal(secondEvents.some((event) => event.type === 'text' && event.data === 'fake kimi answer 2'), true);
      const launchesAfterFollowUp = fs.readFileSync(launchLogPath, 'utf-8').trim().split(/\r?\n/);
      assert.equal(launchesAfterFollowUp.length, 1, 'the follow-up must reuse the initial Kimi process');
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]).catch(() => {});
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
