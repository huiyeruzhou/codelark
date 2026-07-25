import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tmuxCore, type TmuxCore } from '../../../../bridge/tmux/core.js';
import {
  getClaudeProjectDir,
  parseClaudeSessionMirrorRecordText,
} from '../../../../runtime/claude/session-jsonl.js';
import {
  _testOnlyClaudeTmux,
  startClaudeTmuxSession,
  streamClaudeTmuxTui,
} from '../../../../runtime/claude/tmux-provider.js';

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

describe('claude-tmux-provider', () => {
  it('uses symmetric Claude tmux session names', () => {
    assert.equal(_testOnlyClaudeTmux.tmuxSessionName('claude/session 1'), 'claude_claude-session-1');
  });

  it('keeps a newer completion terminal when Claude JSONL lines arrive out of event-time order', () => {
    const records = parseClaudeSessionMirrorRecordText([
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        timestamp: '2026-07-25T09:53:38.924Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'instant response' }],
          stop_reason: 'end_turn',
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        promptId: 'prompt-1',
        timestamp: '2026-07-25T09:53:38.854Z',
        message: { role: 'user', content: 'hello' },
      }),
    ].join('\n'));
    let controller!: ReadableStreamDefaultController<string>;
    new ReadableStream<string>({
      start(streamController) {
        controller = streamController;
      },
    });
    const context = {
      sessionName: 'claude_test',
      targetPane: 'claude_test:0.0',
      bridgeSessionId: 'bridge-test',
      cwd: '/tmp/work',
      nextOffset: 0,
      trailingText: '',
      nextTurnId: null,
      nextSpecialCallIds: [],
      emittedToolStarts: new Set<string>(),
      emittedRecordSignatures: new Set<string>(),
      lastAssistantText: '',
      terminalSeen: false,
      latestLifecycleTimestampMs: null,
      hasError: false,
    };

    for (const record of records) {
      _testOnlyClaudeTmux.enqueueClaudeTmuxRecordAsSse(controller, context, record);
    }

    assert.deepEqual(records.map((record) => record.type), [
      'message',
      'task_complete',
      'task_started',
      'message',
    ]);
    assert.equal(context.terminalSeen, true);
  });

  it('recreates an existing Claude tmux session when explicitly started', async () => {
    const calls: Array<{ name: string; recreate?: boolean }> = [];
    const fakeCore: TmuxCore = {
      async hasSession(name: string) {
        return { exists: true, command: `tmux has-session -t ${name}` };
      },
      async ensureDetachedSession(params) {
        calls.push({ name: params.name, recreate: params.recreate });
        return {
          existed: true,
          command: `tmux new-session -d -s ${params.name}`,
          commands: [
            `tmux has-session -t ${params.name}`,
            `tmux kill-session -t ${params.name}`,
            `tmux new-session -d -s ${params.name}`,
          ],
        };
      },
      async killSession(name: string) {
        return `tmux kill-session -t ${name}`;
      },
      async listSessions() {
        return { sessions: [], command: 'tmux list-sessions' };
      },
      async capturePane(target: string) {
        return { screen: '', command: `tmux capture-pane -t ${target}` };
      },
      async sendActions() {
        return { commands: [] };
      },
      async sendInterrupt(target: string) {
        return `tmux send-keys -t ${target} C-c`;
      },
      async injectPromptIntoPane() {
        return { commands: [] };
      },
      commandPreview(args: readonly string[]) {
        return ['tmux', ...args].join(' ');
      },
    };

    const result = await startClaudeTmuxSession({
      sessionName: 'claude_existing',
      bridgeSessionId: 'bridge-session-existing',
      core: fakeCore,
    });

    assert.deepEqual(calls, [{ name: 'claude_existing', recreate: true }]);
    assert.equal(result.existed, true);
    assert.deepEqual(result.commands, [
      'tmux has-session -t claude_existing',
      'tmux kill-session -t claude_existing',
      'tmux new-session -d -s claude_existing',
    ]);
  });

  it('streams a Claude tmux turn through JSONL mirror records', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-tmux-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-tmux-cwd-'));
    const projectDir = getClaudeProjectDir(cwd, homeDir);
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionFile = path.join(projectDir, 'claude-tmux-session.jsonl');
    const calls: string[] = [];
    const restoreTmux = patchTmuxCore({
      async hasSession(name: string) {
        calls.push(`has:${name}`);
        return { exists: true, command: `tmux has-session -t ${name}` };
      },
      async ensureDetachedSession(params) {
        calls.push(`ensure:${params.name}:${params.cwd}`);
        return { existed: false, commands: ['tmux new-session'] };
      },
      async capturePane(target: string) {
        calls.push(`capture:${target}`);
        return {
          screen: [
            'Claude Code v2.1.160',
            '❯ ',
            '? for shortcuts',
          ].join('\n'),
          command: `tmux capture-pane -t ${target}`,
        };
      },
      async sendActions(target: string, actions) {
        calls.push(`send-actions:${target}:${actions.map((action) => action.type === 'key' ? action.key : action.text).join(',')}`);
        return { commands: [] };
      },
      async injectPromptIntoPane(targetPane: string, prompt: string) {
        calls.push(`inject:${targetPane}:${prompt}`);
        const now = new Date().toISOString();
        fs.writeFileSync(sessionFile, [
          JSON.stringify({
            type: 'user',
            uuid: 'user-1',
            sessionId: 'claude-tmux-session',
            cwd,
            timestamp: now,
            message: { role: 'user', content: prompt },
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'assistant-1',
            parentUuid: 'user-1',
            sessionId: 'claude-tmux-session',
            cwd,
            timestamp: now,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'tmux hello' }],
              stop_reason: 'end_turn',
            },
          }),
          '',
        ].join('\n'), 'utf-8');
        return { commands: ['tmux paste-buffer'] };
      },
    });
    try {
      const events = await withEnv({
        CODELARK_CLAUDE_HOME: homeDir,
        CODELARK_CLAUDE_TMUX_PROMPT_DELAY_MS: '0',
        CODELARK_CLAUDE_TMUX_AFTER_SETUP_DELAY_MS: '0',
        CODELARK_CLAUDE_TMUX_INPUT_READY_TIMEOUT_MS: '0',
        CODELARK_CLAUDE_TMUX_SESSION_FILE_TIMEOUT_MS: '1000',
        CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_TIMEOUT_MS: '1000',
        CODELARK_CLAUDE_PTY_JSONL_DISCOVERY_POLL_MS: '10',
      }, () => readSse(streamClaudeTmuxTui({
        prompt: 'hello from tmux',
        sessionId: 'bridge-session-1',
        runtime: 'claude',
        claudeProvider: 'tmux',
        workingDirectory: cwd,
      })));

      assert.ok(calls.some((call) => call === `ensure:claude_bridge-session-1:${cwd}`));
      assert.ok(calls.some((call) => call === 'inject:claude_bridge-session-1:0.0:hello from tmux'));
      assert.ok(events.some((event) => event.type === 'status'
        && typeof event.data === 'object'
        && event.data !== null
        && (event.data as { session_id?: string }).session_id === 'claude-tmux-session'));
      assert.ok(events.some((event) => event.type === 'text' && event.data === 'tmux hello'));
      assert.ok(events.some((event) => event.type === 'result'
        && typeof event.data === 'object'
        && event.data !== null
        && (event.data as { transcript_path?: string }).transcript_path === sessionFile));
    } finally {
      restoreTmux();
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
