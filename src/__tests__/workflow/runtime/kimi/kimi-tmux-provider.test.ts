import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tmuxCore, type TmuxCore, type TmuxSendAction } from '../../../../bridge/tmux/core.js';
import { getRuntimeTmuxInputState } from '../../../../bridge/tmux/input-state-machine.js';
import { computeKimiWorkspaceDirName } from '../../../../runtime/kimi/session-index.js';
import {
  buildKimiTmuxLaunchCommand,
  restartKimiTmuxInputSession,
  streamKimiTmuxTui,
} from '../../../../runtime/kimi/tmux-provider.js';

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
      type: 'context.append_message',
      time: 1782540000000,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      time: 1782540000100,
      event: { type: 'step.begin', turnId: 'turn-1', stepUuid: 'step-1' },
    }),
    JSON.stringify({
      type: 'llm.request',
      kind: 'loop',
      turnStep: '0.1',
      time: 1782540000150,
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

function commandHasArg(command: string, arg: string): boolean {
  return command.includes(` ${arg}`)
    || command.includes(`'${arg}'`)
    || command.includes(`"${arg}"`);
}

describe('kimi-tmux-provider workflow', () => {
  it('launches Kimi through an environment snapshot on Windows', () => {
    const command = buildKimiTmuxLaunchCommand(
      'C:\\Program Files\\nodejs\\kimi.cmd',
      ['-y', '-m', 'kimi-for-coding'],
      {
        platform: 'win32',
        env: {
          PATH: 'C:\\Program Files\\nodejs',
          KIMI_CODE_HOME: 'C:\\Users\\tester\\.kimi-code',
        },
        shell: { type: 'cmd', path: 'cmd.exe' },
      },
    );

    assert.ok(Array.isArray(command));
    assert.equal(command[0], 'cmd.exe');
    assert.equal(command[1], '/c');
    assert.match(command[2] || '', /call .*codelark-shell-snapshot/u);
    assert.match(command[2] || '', /C:\\Program Files\\nodejs\\kimi\.cmd/u);
    assert.match(command[2] || '', /kimi-for-coding/u);
    assert.equal(commandHasArg(command.join(' '), '-y'), true);
    assert.equal(commandHasArg(command.join(' '), '-r'), false);
    const snapshotPath = (command[2] || '')
      .match(/call ([^ ]*codelark-shell-snapshot[^ ]*) &&/u)?.[1]
      ?.replace(/^["']|["']$/gu, '');
    assert.ok(snapshotPath);
    assert.match(
      fs.readFileSync(snapshotPath, 'utf-8'),
      /set "KIMI_CODE_HOME=C:\\Users\\tester\\\.kimi-code"/u,
    );
  });

  it('submits the first prompt before a fresh Kimi session creates its wire file', async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-workflow-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-workflow-cwd-'));
    const sessionId = 'session_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const ensureCalls: string[] = [];
    let extendedKeysCalls = 0;
    const sendCalls: Array<{ target: string; actions: string[] }> = [];
    const injectCalls: Array<{ target: string; prompt: string }> = [];
    let resumeHintReady = false;
    let resumedTuiReady = false;
    let workspaceTrustConfirmationStartedAtMs: number | undefined;
    let wirePath: string | null = null;
    let pendingPrompt = '';
    let tmuxExists = false;

    const restoreTmux = patchTmuxCore({
      async ensureExtendedKeys() {
        extendedKeysCalls += 1;
        return 'tmux set-option -g extended-keys on';
      },
      async hasSession(name: string) {
        return { exists: tmuxExists, command: `tmux has-session -t ${name}` };
      },
      async ensureDetachedSession(params) {
        tmuxExists = true;
        const commandText = Array.isArray(params.command) ? params.command.join(' ') : params.command || '';
        ensureCalls.push(commandText);
        if (commandHasArg(commandText, '-y')) {
          resumedTuiReady = true;
        }
        return { existed: false, command: `tmux new-session -d -s ${params.name}`, commands: [] };
      },
      async capturePane(target: string) {
        const workspaceTrustConfirmed = workspaceTrustConfirmationStartedAtMs !== undefined
          && Date.now() - workspaceTrustConfirmationStartedAtMs >= 400;
        return {
          screen: !workspaceTrustConfirmed
            ? 'MCP servers only run in trusted folders.\n❯ Trust this folder\n  Enable project MCP servers.\n  Don\'t trust'
            : resumedTuiReady
            ? `Kimi Code\nSession: ${sessionId}\n│ > \ncontext: 0% (0/256k)`
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
        if (names.join(',') === 'Enter' && workspaceTrustConfirmationStartedAtMs === undefined) {
          workspaceTrustConfirmationStartedAtMs = Date.now();
        }
        if (names.join(',') === 'Enter' && pendingPrompt) {
          wirePath = createKimiSessionFile({ kimiHome, cwd, sessionId });
          appendKimiTurn(wirePath, pendingPrompt);
          pendingPrompt = '';
        }
        return { commands: names.map((name) => `tmux send-keys -t ${target} ${name}`) };
      },
      async injectPromptIntoPane(target: string, prompt: string) {
        injectCalls.push({ target, prompt });
        assert.equal(wirePath, null, 'fresh Kimi may defer wire creation until its first prompt');
        if (pendingPrompt === prompt) {
          wirePath = createKimiSessionFile({ kimiHome, cwd, sessionId });
          appendKimiTurn(wirePath, prompt);
          pendingPrompt = '';
        } else {
          pendingPrompt = prompt;
        }
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
        CODELARK_KIMI_TMUX_INPUT_STABILITY_MS: '0',
        CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: '0',
        CODELARK_KIMI_TMUX_STEER_DELAY_MS: '0',
        CODELARK_KIMI_TMUX_SUBMISSION_ACK_TIMEOUT_MS: '100',
      }, () => readSse(streamKimiTmuxTui({
        prompt: 'hello fresh kimi',
        sessionId: 'bridge-kimi-workflow',
        runtime: 'kimi',
        workingDirectory: cwd,
      })));

      assert.equal(ensureCalls.length, 1);
      assert.equal(extendedKeysCalls, 1, 'fresh lifecycle enables Kimi-compatible Enter handling once');
      assert.equal(commandHasArg(ensureCalls[0]!, '-y'), true);
      assert.equal(commandHasArg(ensureCalls[0]!, '-r'), false);

      assert.equal(sendCalls.some((call) => call.actions.join(',') === 'C-c,C-c'), false);
      assert.equal(
        sendCalls.filter((call) => call.actions.join(',') === 'Enter').length,
        1,
        'the only standalone Enter confirms workspace trust; idle prompt submission does not need a retry key',
      );
      assert.deepEqual(injectCalls, [
        { target: 'clk-kimi-bridge-kimi-workflow:0.0', prompt: 'hello fresh kimi' },
        { target: 'clk-kimi-bridge-kimi-workflow:0.0', prompt: 'hello fresh kimi' },
      ], 'fresh lifecycle retries the complete prompt when its user turn is not recorded');
      assert.equal(sendCalls.some((call) => call.actions.join(',') === 'C-s'), false, 'fresh idle Kimi must not steer');

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

  it('continues an existing Kimi session directly without starting another process', async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-resume-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-resume-cwd-'));
    const sessionId = 'session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const wirePath = createKimiSessionFile({ kimiHome, cwd, sessionId });
    const ensureCalls: string[] = [];
    let extendedKeysCalls = 0;
    const sendCalls: Array<{ target: string; actions: string[] }> = [];
    const injectCalls: Array<{ target: string; prompt: string }> = [];
    let tmuxExists = true;
    let captureCount = 0;
    let pendingPrompt = '';

    const restoreTmux = patchTmuxCore({
      async ensureExtendedKeys() {
        extendedKeysCalls += 1;
        return 'tmux set-option -g extended-keys on';
      },
      async hasSession(name: string) {
        return { exists: tmuxExists, command: `tmux has-session -t ${name}` };
      },
      async ensureDetachedSession(params) {
        tmuxExists = true;
        ensureCalls.push(Array.isArray(params.command) ? params.command.join(' ') : params.command || '');
        return { existed: false, command: `tmux new-session -d -s ${params.name}`, commands: [] };
      },
      async capturePane(target: string) {
        captureCount += 1;
        return {
          screen: 'Kimi Code\nrestored conversation history\n│ > \ncontext: 42% (107k/256k)',
          command: `tmux capture-pane -t ${target}`,
        };
      },
      async sendActions(target: string, actions) {
        const names = actionNames(actions);
        sendCalls.push({ target, actions: names });
        if (names.join(',') === 'Enter' && pendingPrompt) {
          appendKimiTurn(wirePath, pendingPrompt);
          pendingPrompt = '';
        }
        return { commands: names.map((name) => `tmux send-keys -t ${target} ${name}`) };
      },
      async injectPromptIntoPane(target: string, prompt: string) {
        injectCalls.push({ target, prompt });
        fs.appendFileSync(wirePath, `${JSON.stringify({
          type: 'context.append_message',
          time: 1782540000000,
          message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        })}\n`, 'utf-8');
        pendingPrompt = prompt;
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
        CODELARK_KIMI_TMUX_INPUT_STABILITY_MS: '0',
        CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: '0',
        CODELARK_KIMI_TMUX_STEER_DELAY_MS: '0',
        CODELARK_KIMI_TMUX_SUBMISSION_ACK_TIMEOUT_MS: '100',
      }, () => readSse(streamKimiTmuxTui({
        prompt: 'hello existing kimi',
        sessionId: 'bridge-kimi-resume-workflow',
        runtime: 'kimi',
        kimiSessionId: sessionId,
        workingDirectory: cwd,
      })));

      assert.equal(ensureCalls.length, 0, 'cold takeover must reuse the existing Kimi tmux process');
      assert.equal(extendedKeysCalls, 1, 'cold takeover enables Kimi-compatible Enter handling once');
      assert.equal(captureCount, 1, 'cold takeover must verify editor readiness exactly once');
      assert.deepEqual(injectCalls, [
        { target: 'clk-kimi-bridge-kimi-resume-workflow:0.0', prompt: 'hello existing kimi' },
      ]);
      assert.equal(sendCalls.some((call) => call.actions.join(',') === 'C-s'), false, 'idle existing Kimi must not steer');
      assert.ok(sendCalls.some((call) => call.actions.join(',') === 'Enter'), 'accepted prompt without turn start retries submit keys');
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

  it('restarts a known Kimi session without repeating trust confirmation during a delayed redraw', async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-restart-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-restart-cwd-'));
    const sessionId = 'session_bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc';
    createKimiSessionFile({ kimiHome, cwd, sessionId });
    const ensureCalls: string[] = [];
    let tmuxExists = true;
    let captureCount = 0;
    let trustConfirmationStartedAtMs: number | undefined;
    const sendCalls: string[] = [];
    let extendedKeysCalls = 0;

    const restoreTmux = patchTmuxCore({
      async ensureExtendedKeys() {
        extendedKeysCalls += 1;
        if (extendedKeysCalls <= 2) throw new Error('no server running on /tmp/clk-test/tmux/default');
        return 'tmux set-option -g extended-keys on';
      },
      async hasSession(name: string) {
        return { exists: tmuxExists, command: `tmux has-session -t ${name}` };
      },
      async ensureDetachedSession(params) {
        tmuxExists = true;
        ensureCalls.push(Array.isArray(params.command) ? params.command.join(' ') : params.command || '');
        return { existed: false, command: `tmux new-session -d -s ${params.name}`, commands: [] };
      },
      async capturePane(target: string) {
        captureCount += 1;
        const trustConfirmed = trustConfirmationStartedAtMs !== undefined
          && Date.now() - trustConfirmationStartedAtMs >= 400;
        return {
          screen: trustConfirmed
            ? 'Kimi Code\nrestored conversation history\n│ > \ncontext: 42% (107k/256k)'
            : [
              'Kimi Code',
              `Session: ${sessionId}`,
              'restored conversation history',
              '│ > ',
              'context: 42% (107k/256k)',
              'MCP servers only run in trusted folders.',
              '❯ Trust this folder',
              '  Enable project MCP servers.',
              '  Don\'t trust',
            ].join('\n'),
          command: `tmux capture-pane -t ${target}`,
        };
      },
      async sendActions(target: string, actions) {
        const names = actionNames(actions);
        sendCalls.push(...names);
        if (names.join(',') === 'Enter' && trustConfirmationStartedAtMs === undefined) {
          trustConfirmationStartedAtMs = Date.now();
        }
        return { commands: names.map((name) => `tmux send-keys -t ${target} ${name}`) };
      },
      async killSession(name: string) {
        tmuxExists = false;
        return `tmux kill-session -t ${name}`;
      },
    });

    try {
      const prepared = await withEnv({
        KIMI_CODE_HOME: kimiHome,
        CODELARK_KIMI_TMUX_SESSION_ID_TIMEOUT_MS: '1000',
        CODELARK_KIMI_TMUX_INPUT_READY_TIMEOUT_MS: '1000',
        CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: '50',
        CODELARK_KIMI_TMUX_INPUT_STABILITY_MS: '0',
      }, () => restartKimiTmuxInputSession({
        prompt: '',
        sessionId: 'bridge-kimi-restart-workflow',
        runtime: 'kimi',
        kimiSessionId: sessionId,
        workingDirectory: cwd,
      }));

      assert.equal(prepared.sessionId, sessionId);
      assert.ok(captureCount >= 4, 'the trust screen remains visible while Kimi redraws');
      assert.deepEqual(sendCalls, ['Enter'], 'one trust dialog receives exactly one confirmation key');
      assert.equal(ensureCalls.length, 3, 'repeated server-shutdown races relaunch Kimi with a fixed limit');
      assert.equal(extendedKeysCalls, 3);
      assert.equal(commandHasArg(ensureCalls[0] || '', '-r'), true);
      assert.match(ensureCalls[0] || '', new RegExp(sessionId));
    } finally {
      restoreTmux();
      fs.rmSync(kimiHome, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('relaunches a known Kimi session when tmux exits while waiting for input readiness', async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-ready-race-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-ready-race-cwd-'));
    const sessionId = 'session_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    createKimiSessionFile({ kimiHome, cwd, sessionId });
    const ensureCalls: string[] = [];
    let captureCount = 0;
    let extendedKeysCalls = 0;

    const restoreTmux = patchTmuxCore({
      async ensureExtendedKeys() {
        extendedKeysCalls += 1;
        return 'tmux set-option -g extended-keys on';
      },
      async hasSession(name: string) {
        return { exists: false, command: `tmux has-session -t ${name}` };
      },
      async ensureDetachedSession(params) {
        ensureCalls.push(Array.isArray(params.command) ? params.command.join(' ') : params.command || '');
        return { existed: false, command: `tmux new-session -d -s ${params.name}`, commands: [] };
      },
      async capturePane(target: string) {
        captureCount += 1;
        if (captureCount === 1) {
          throw new Error('no server running on /tmp/clk-test/tmux/default');
        }
        return {
          screen: 'Kimi Code\nrestored conversation history\n│ > \ncontext: 42% (107k/256k)',
          command: `tmux capture-pane -t ${target}`,
        };
      },
    });

    try {
      const prepared = await withEnv({
        KIMI_CODE_HOME: kimiHome,
        CODELARK_KIMI_TMUX_INPUT_READY_TIMEOUT_MS: '1000',
        CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: '50',
        CODELARK_KIMI_TMUX_INPUT_STABILITY_MS: '1',
      }, () => restartKimiTmuxInputSession({
        prompt: '',
        sessionId: 'bridge-kimi-ready-race-workflow',
        runtime: 'kimi',
        kimiSessionId: sessionId,
        workingDirectory: cwd,
      }));

      assert.equal(prepared.sessionId, sessionId);
      assert.equal(ensureCalls.length, 2, 'the vanished tmux server is relaunched once');
      assert.equal(extendedKeysCalls, 2);
      assert.equal(captureCount, 3, 'readiness must remain stable across a second capture');
      assert.equal(commandHasArg(ensureCalls[1] || '', '-r'), true);
    } finally {
      restoreTmux();
      fs.rmSync(kimiHome, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('marks a failed Kimi restart recoverable instead of leaving checking_session behind', async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-restart-fail-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-kimi-restart-fail-cwd-'));
    const sessionId = 'session_cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const otherSessionId = 'session_dcdcdcdc-dcdc-4dcd-8dcd-dcdcdcdcdcdc';
    createKimiSessionFile({ kimiHome, cwd, sessionId });
    const bridgeSessionId = 'bridge-kimi-restart-fail-workflow';
    const tmuxSessionName = `clk-kimi-${bridgeSessionId}`;
    let tmuxExists = true;

    const restoreTmux = patchTmuxCore({
      async ensureExtendedKeys() {
        return 'tmux set-option -g extended-keys on';
      },
      async hasSession(name: string) {
        return { exists: tmuxExists, command: `tmux has-session -t ${name}` };
      },
      async ensureDetachedSession(params) {
        tmuxExists = true;
        return { existed: false, command: `tmux new-session -d -s ${params.name}`, commands: [] };
      },
      async capturePane(target: string) {
        return {
          screen: `Kimi Code\nSession: ${otherSessionId}\n│ > \ncontext: 0% (0/256k)`,
          command: `tmux capture-pane -t ${target}`,
        };
      },
      async killSession(name: string) {
        tmuxExists = false;
        return `tmux kill-session -t ${name}`;
      },
    });

    try {
      await assert.rejects(withEnv({
        KIMI_CODE_HOME: kimiHome,
        CODELARK_KIMI_TMUX_INPUT_READY_TIMEOUT_MS: '1000',
        CODELARK_KIMI_TMUX_POLL_INTERVAL_MS: '50',
        CODELARK_KIMI_TMUX_INPUT_STABILITY_MS: '0',
      }, () => restartKimiTmuxInputSession({
        prompt: '',
        sessionId: bridgeSessionId,
        runtime: 'kimi',
        kimiSessionId: sessionId,
        workingDirectory: cwd,
      })), new RegExp(`unexpected session ${otherSessionId}`));

      const state = getRuntimeTmuxInputState('kimi', tmuxSessionName);
      assert.equal(state.state, 'failed');
      assert.match(state.error || '', new RegExp(`unexpected session ${otherSessionId}`));
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
    let extendedKeysCalls = 0;
    let appendFatalTimer: NodeJS.Timeout | undefined;

    const restoreTmux = patchTmuxCore({
      async ensureExtendedKeys() {
        extendedKeysCalls += 1;
        return 'tmux set-option -g extended-keys on';
      },
      async hasSession(name: string) {
        return { exists: tmuxExists, command: `tmux has-session -t ${name}` };
      },
      async ensureDetachedSession(params) {
        tmuxExists = true;
        return { existed: false, command: `tmux new-session -d -s ${params.name}`, commands: [] };
      },
      async capturePane(target: string) {
        return {
          screen: `Kimi Code\nSession: ${sessionId}\n│ > \ncontext: 0% (0/256k)`,
          command: `tmux capture-pane -t ${target}`,
        };
      },
      async injectPromptIntoPane(target: string, prompt: string) {
        fs.appendFileSync(wirePath, [
          JSON.stringify({
            type: 'context.append_message',
            time: Date.now(),
            message: { role: 'user', content: prompt },
          }),
          JSON.stringify({
            type: 'context.append_loop_event',
            time: Date.now() + 1,
            event: { type: 'step.begin', turnId: 'turn-auth', stepUuid: 'step-auth' },
          }),
          JSON.stringify({
            type: 'llm.request',
            kind: 'loop',
            turnStep: '1.1',
            time: Date.now() + 2,
          }),
          '',
        ].join('\n'), 'utf8');
        const logDir = path.join(sessionDir, 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, 'kimi-code.log');
        fs.writeFileSync(logPath, [
          '2026-07-24T09:27:41.997Z WARN  llm request failed  turnStep=1.1 attempt=1/10 model=k3 errorName=KimiError errorMessage="OAuth provider \\"managed:kimi-code\\" requires login before it can be used."',
          '',
        ].join('\n'), 'utf8');
        appendFatalTimer = setTimeout(() => {
          fs.appendFileSync(logPath, [
            '2026-07-24T09:27:42.028Z ERROR turn failed  turnId=1',
            '  KimiError: OAuth provider "managed:kimi-code" requires login before it can be used.',
            '',
          ].join('\n'), 'utf8');
        }, 150);
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
        CODELARK_KIMI_TMUX_INPUT_STABILITY_MS: '0',
        CODELARK_KIMI_TMUX_PROMPT_DELAY_MS: '0',
      }, () => readSse(streamKimiTmuxTui({
        prompt: 'hello auth failure',
        sessionId: 'bridge-kimi-auth-workflow',
        runtime: 'kimi',
        kimiSessionId: sessionId,
        workingDirectory: cwd,
      })));

      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs >= 100, `retryable WARN must not terminate before the fatal record; elapsed=${elapsedMs}ms`);
      assert.ok(elapsedMs < 1_000, 'explicit authentication failures should not wait for idle timeout');
      assert.ok(events.some((event) => event.type === 'error'
        && String(event.data).includes('KimiError: OAuth provider "managed:kimi-code" requires login before it can be used.')));
      assert.equal(extendedKeysCalls, 1);
      assert.equal(killed, true, 'a failed half-initialized Kimi lifecycle should be cleaned up');
    } finally {
      if (appendFatalTimer) clearTimeout(appendFatalTimer);
      restoreTmux();
      fs.rmSync(kimiHome, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
