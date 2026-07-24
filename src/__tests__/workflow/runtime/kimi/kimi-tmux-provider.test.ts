import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tmuxCore, type TmuxCore, type TmuxSendAction } from '../../../../bridge/tmux/core.js';
import { computeKimiWorkspaceDirName } from '../../../../runtime/kimi/session-index.js';
import { streamKimiTmuxTui } from '../../../../runtime/kimi/tmux-provider.js';

interface ParsedSse {
  type: string;
  data: unknown;
}

async function readSse(stream: ReadableStream<string>): Promise<ParsedSse[]> {
  let raw = '';
  for await (const chunk of stream) raw += chunk;
  return raw
    .split(/\n/)
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

function patchTmuxCore(patch: Partial<TmuxCore>): () => void {
  const previous = new Map<keyof TmuxCore, TmuxCore[keyof TmuxCore]>();
  for (const [key, value] of Object.entries(patch) as Array<[keyof TmuxCore, TmuxCore[keyof TmuxCore]]>) {
    previous.set(key, tmuxCore[key]);
    (tmuxCore as any)[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      (tmuxCore as any)[key] = value;
    }
  };
}

function withEnv<T>(updates: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    process.env[key] = updates[key];
  }
  return fn().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function createKimiSessionFile(options: {
  kimiHome: string;
  cwd: string;
  sessionId: string;
}): string {
  const sessionDir = path.join(
    options.kimiHome,
    'sessions',
    computeKimiWorkspaceDirName(options.cwd),
    options.sessionId,
  );
  const agentDir = path.join(sessionDir, 'agents', 'main');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
    title: 'workflow kimi',
  }), 'utf-8');
  const wirePath = path.join(agentDir, 'wire.jsonl');
  fs.writeFileSync(wirePath, '', 'utf-8');
  fs.writeFileSync(
    path.join(options.kimiHome, 'session_index.jsonl'),
    `${JSON.stringify({
      sessionId: options.sessionId,
      sessionDir,
      workDir: options.cwd,
    })}\n`,
    'utf-8',
  );
  return wirePath;
}

function appendKimiTurn(wirePath: string, prompt: string): void {
  fs.appendFileSync(wirePath, [
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1782540000000,
      event: { type: 'step.begin', turnId: 'turn-1', stepUuid: 'step-1' },
    }),
    JSON.stringify({
      type: 'context.append_message',
      time: 1782540000100,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1782540000200,
      event: {
        type: 'content.part',
        turnId: 'turn-1',
        part: { type: 'think', think: 'Kimi is checking the workspace.' },
      },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1782540000300,
      event: {
        type: 'content.part',
        turnId: 'turn-1',
        part: { type: 'text', text: 'Kimi visible answer.' },
      },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1782540000400,
      event: { type: 'step.end', turnId: 'turn-1', stepUuid: 'step-1', finishReason: 'end_turn' },
    }),
    '',
  ].join('\n'), 'utf-8');
}

function actionNames(actions: TmuxSendAction[]): string[] {
  return actions.map((action) => action.type === 'key' ? action.key : action.text);
}

describe('kimi-tmux-provider workflow', () => {
  it('bootstraps fresh Kimi sessions through resume hints, steers with Ctrl-S, and streams wire records', async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-workflow-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-workflow-cwd-'));
    const sessionId = 'session_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const ensureCalls: string[] = [];
    const sendCalls: Array<{ target: string; actions: string[] }> = [];
    const injectCalls: Array<{ target: string; prompt: string }> = [];
    let resumeHintReady = false;
    let resumedTuiReady = false;
    let wirePath: string | null = null;
    let tmuxExists = false;

    const restoreTmux = patchTmuxCore({
      async hasSession(name: string) {
        return { exists: tmuxExists, command: `tmux has-session -t ${name}` };
      },
      async ensureDetachedSession(params) {
        tmuxExists = true;
        ensureCalls.push(params.command || '');
        if (params.command?.includes(`-r ${sessionId}`)) {
          resumedTuiReady = true;
          wirePath = createKimiSessionFile({ kimiHome, cwd, sessionId });
        }
        return { existed: false, command: `tmux new-session -d -s ${params.name}`, commands: [] };
      },
      async capturePane(target: string) {
        return {
          screen: resumedTuiReady
            ? `Kimi Code\nSession: ${sessionId}\nReady for input`
            : resumeHintReady
              ? `To resume this session: kimi -r ${sessionId}`
            : 'Kimi Code\nWaiting for input',
          command: `tmux capture-pane -t ${target}`,
        };
      },
      async sendActions(target: string, actions) {
        const names = actionNames(actions);
        sendCalls.push({ target, actions: names });
        if (names.join(',') === 'C-c,C-c') {
          resumeHintReady = true;
        }
        return { commands: names.map((name) => `tmux send-keys -t ${target} ${name}`) };
      },
      async injectPromptIntoPane(target: string, prompt: string) {
        injectCalls.push({ target, prompt });
        assert.ok(wirePath, 'Kimi wire file must exist before prompt injection');
        appendKimiTurn(wirePath, prompt);
        return { commands: [`tmux paste-buffer -t ${target}`] };
      },
      async killSession(name: string) {
        tmuxExists = false;
        return `tmux kill-session -t ${name}`;
      },
    });

    try {
      const events = await withEnv({
        KIMI_CODE_HOME: kimiHome,
        CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: '1000',
        CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS: '1000',
        CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: '50',
        CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: '0',
      }, () => readSse(streamKimiTmuxTui({
        prompt: 'hello fresh kimi',
        sessionId: 'bridge-kimi-workflow',
        runtime: 'kimi',
        workingDirectory: cwd,
      })));

      assert.equal(ensureCalls.length, 2);
      assert.match(ensureCalls[0]!, /\bkimi -y\b/);
      assert.doesNotMatch(ensureCalls[0]!, / -r /);
      assert.match(ensureCalls[1]!, new RegExp(`\\bkimi -r ${sessionId} -y\\b`));

      assert.ok(sendCalls.some((call) => call.actions.join(',') === 'C-c,C-c'));
      assert.deepEqual(injectCalls, [{
        target: 'clk-kimi-bridge-kimi-workflow:0.0',
        prompt: 'hello fresh kimi',
      }]);
      assert.ok(sendCalls.some((call) => call.actions.join(',') === 'C-s'));

      assert.ok(events.some((event) => event.type === 'status'
        && typeof event.data === 'object'
        && event.data !== null
        && (event.data as { session_id?: string }).session_id === sessionId));
      assert.ok(events.some((event) => event.type === 'status'
        && typeof event.data === 'object'
        && event.data !== null
        && (event.data as { reasoning?: string; thinking?: string }).reasoning === '思考'
        && (event.data as { thinking?: string }).thinking === 'Kimi is checking the workspace.'));
      assert.deepEqual(
        events.filter((event) => event.type === 'text').map((event) => event.data),
        ['Kimi visible answer.'],
      );
      assert.ok(events.some((event) => event.type === 'result'
        && typeof event.data === 'object'
        && event.data !== null
        && (event.data as { session_id?: string }).session_id === sessionId));
      assert.equal(events.some((event) => event.type === 'error'), false);
    } finally {
      restoreTmux();
      fs.rmSync(kimiHome, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('continues an existing Kimi session directly without a fresh resume-hint bootstrap', async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-resume-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-resume-cwd-'));
    const sessionId = 'session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const wirePath = createKimiSessionFile({ kimiHome, cwd, sessionId });
    const ensureCalls: string[] = [];
    const sendCalls: Array<{ target: string; actions: string[] }> = [];
    const injectCalls: Array<{ target: string; prompt: string }> = [];
    let tmuxExists = true;
    let captureCount = 0;

    const restoreTmux = patchTmuxCore({
      async hasSession(name: string) {
        return { exists: tmuxExists, command: `tmux has-session -t ${name}` };
      },
      async ensureDetachedSession(params) {
        tmuxExists = true;
        ensureCalls.push(params.command || '');
        return { existed: false, command: `tmux new-session -d -s ${params.name}`, commands: [] };
      },
      async capturePane(target: string) {
        captureCount += 1;
        return {
          screen: `Kimi Code\nSession: ${sessionId}\nReady for input`,
          command: `tmux capture-pane -t ${target}`,
        };
      },
      async sendActions(target: string, actions) {
        const names = actionNames(actions);
        sendCalls.push({ target, actions: names });
        return { commands: names.map((name) => `tmux send-keys -t ${target} ${name}`) };
      },
      async injectPromptIntoPane(target: string, prompt: string) {
        injectCalls.push({ target, prompt });
        appendKimiTurn(wirePath, prompt);
        return { commands: [`tmux paste-buffer -t ${target}`] };
      },
      async killSession(name: string) {
        tmuxExists = false;
        return `tmux kill-session -t ${name}`;
      },
    });

    try {
      const events = await withEnv({
        KIMI_CODE_HOME: kimiHome,
        CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: '1000',
        CODELARK_KIMI_TMUX_SESSION_FILE_TIMEOUT_MS: '1000',
        CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: '50',
        CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: '0',
      }, () => readSse(streamKimiTmuxTui({
        prompt: 'hello existing kimi',
        sessionId: 'bridge-kimi-resume-workflow',
        runtime: 'kimi',
        kimiSessionId: sessionId,
        workingDirectory: cwd,
      })));

      assert.equal(ensureCalls.length, 0, 'cold takeover must reuse the existing Kimi tmux process');
      assert.equal(captureCount, 1, 'cold takeover must verify the active Session header exactly once');
      assert.deepEqual(injectCalls, [{
        target: 'clk-kimi-bridge-kimi-resume-workflow:0.0',
        prompt: 'hello existing kimi',
      }]);
      assert.ok(sendCalls.some((call) => call.actions.join(',') === 'C-s'));
      assert.equal(sendCalls.some((call) => call.actions.join(',') === 'C-c,C-c'), false);

      assert.ok(events.some((event) => event.type === 'status'
        && typeof event.data === 'object'
        && event.data !== null
        && (event.data as { session_id?: string }).session_id === sessionId));
      assert.ok(events.some((event) => event.type === 'status'
        && typeof event.data === 'object'
        && event.data !== null
        && (event.data as { reasoning?: string; thinking?: string }).reasoning === '思考'
        && (event.data as { thinking?: string }).thinking === 'Kimi is checking the workspace.'));
      assert.deepEqual(
        events.filter((event) => event.type === 'text').map((event) => event.data),
        ['Kimi visible answer.'],
      );
      assert.ok(events.some((event) => event.type === 'result'
        && typeof event.data === 'object'
        && event.data !== null
        && (event.data as { session_id?: string }).session_id === sessionId));
      assert.equal(events.some((event) => event.type === 'error'), false);
    } finally {
      restoreTmux();
      fs.rmSync(kimiHome, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('surfaces Kimi session-log authentication failures without waiting for the idle timeout', async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-auth-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-auth-cwd-'));
    const sessionId = 'session_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const wirePath = createKimiSessionFile({ kimiHome, cwd, sessionId });
    const sessionDir = path.resolve(path.dirname(wirePath), '..', '..');
    let tmuxExists = false;
    let killed = false;

    const restoreTmux = patchTmuxCore({
      async hasSession(name: string) {
        return { exists: tmuxExists, command: `tmux has-session -t ${name}` };
      },
      async ensureDetachedSession(params) {
        tmuxExists = true;
        return { existed: false, command: `tmux new-session -d -s ${params.name}`, commands: [] };
      },
      async capturePane(target: string) {
        return {
          screen: `Kimi Code\nSession: ${sessionId}\nReady for input`,
          command: `tmux capture-pane -t ${target}`,
        };
      },
      async injectPromptIntoPane(target: string, prompt: string) {
        fs.appendFileSync(wirePath, `${JSON.stringify({
          type: 'context.append_loop_event',
          time: Date.now(),
          event: { type: 'step.begin', turnId: 'turn-auth', stepUuid: 'step-auth' },
        })}\n`, 'utf8');
        const logDir = path.join(sessionDir, 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(path.join(logDir, 'kimi-code.log'), [
          '2026-07-24T09:27:41.997Z WARN  llm request failed  turnStep=1.1 attempt=1/10 model=k3 errorName=KimiError errorMessage="OAuth provider \\"managed:kimi-code\\" requires login before it can be used."',
          '2026-07-24T09:27:42.028Z ERROR turn failed  turnId=1',
          '',
        ].join('\n'), 'utf8');
        return { commands: [`tmux paste-buffer -t ${target} # ${prompt}`] };
      },
      async sendActions(target: string, actions) {
        return { commands: actions.map((action) => `tmux send-keys -t ${target} ${action.type === 'key' ? action.key : action.text}`) };
      },
      async killSession(name: string) {
        killed = true;
        tmuxExists = false;
        return `tmux kill-session -t ${name}`;
      },
    });

    try {
      const startedAt = Date.now();
      const events = await withEnv({
        KIMI_CODE_HOME: kimiHome,
        CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: '1000',
        CODELARK_KIMI_TMUX_OUTPUT_IDLE_TIMEOUT_MS: '5000',
        CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: '50',
        CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: '0',
      }, () => readSse(streamKimiTmuxTui({
        prompt: 'hello auth failure',
        sessionId: 'bridge-kimi-auth-workflow',
        runtime: 'kimi',
        kimiSessionId: sessionId,
        workingDirectory: cwd,
      })));

      assert.ok(Date.now() - startedAt < 1_000, 'explicit authentication failures should not wait for idle timeout');
      assert.ok(events.some((event) => event.type === 'error'
        && String(event.data).includes('requires login before it can be used')));
      assert.equal(killed, true, 'a failed half-initialized Kimi lifecycle should be cleaned up');
    } finally {
      restoreTmux();
      fs.rmSync(kimiHome, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
