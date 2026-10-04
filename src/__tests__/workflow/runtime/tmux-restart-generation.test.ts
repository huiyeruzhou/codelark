import '../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmuxCore, type TmuxCore } from '../../../bridge/tmux/core.js';
import { getRuntimeTmuxInputState, resetRuntimeTmuxInputStatesForTests, setRuntimeTmuxTurnState, transitionRuntimeTmuxInputState } from '../../../bridge/tmux/input-state-machine.js';
import { restartCursorTmuxInputSession, streamCursorTmuxTui } from '../../../runtime/cursor/tmux-provider.js';
import { restartKimiTmuxInputSession, streamKimiTmuxTui } from '../../../runtime/kimi/tmux-provider.js';
import { restartZcodeTmuxInputSession, streamZcodeTmuxTui } from '../../../runtime/zcode/tmux-provider.js';
import { computeKimiWorkspaceDirName } from '../../../runtime/kimi/session-index.js';
import { cursorWorkspaceHash, getCursorTranscriptCandidates } from '../../../runtime/cursor/session-index.js';
import type { StreamChatParams } from '../../../runtime/contracts.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function drain(stream: ReadableStream<string>) { for await (const _chunk of stream) { /* consume the actual provider */ } }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const providers = [
  { runtime: 'cursor', stream: streamCursorTmuxTui, restart: restartCursorTmuxInputSession, screen: 'Agent\nContext 2%\n› ' },
  { runtime: 'kimi', stream: streamKimiTmuxTui, restart: restartKimiTmuxInputSession, screen: 'Kimi Code\n│ > \ncontext: 42% (107k/256k)' },
  { runtime: 'zcode', stream: streamZcodeTmuxTui, restart: restartZcodeTmuxInputSession,
    screen: '────────────────────────────────────────────────────────\n                                                        \n────────────────────────────────────────────────────────\n ◈ default ─ ◉ build ─ ctx 100% left ─ 0 tokens' },
] as const;

describe('legacy tmux restart ownership', { concurrency: false, timeout: 10_000 }, () => {
  let root: string;
  let savedEnv: Map<string, string | undefined>;
  let originalCore: TmuxCore;
  let params: StreamChatParams;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-restart-generation-'));
    const env = {
      KIMI_CODE_HOME: path.join(root, 'kimi'), CURSOR_CONFIG_DIR: path.join(root, 'cursor'), CURSOR_DATA_DIR: path.join(root, 'cursor-data'),
      ZCODE_SESSION_DB_PATH: path.join(root, 'zcode.sqlite'), CODELARK_DEBUG: '0', CODELARK_KIMI_TMUX_INPUT_STABILITY_MS: '0',
      CODELARK_CURSOR_TMUX_POLL_INTERVAL_MS: '50',
    };
    savedEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    originalCore = { ...tmuxCore };
    // A missed mock must never contact a real tmux server.
    for (const key of Object.keys(tmuxCore)) (tmuxCore as any)[key] = async () => { throw new Error(`unexpected tmux call: ${key}`); };
    resetRuntimeTmuxInputStatesForTests();
    params = { sessionId: 'bridge-test', prompt: 'old input', workingDirectory: root,
      cursorSessionId: '11111111-1111-4111-8111-111111111111', kimiSessionId: 'session_test', zcodeSessionId: 'sess_test' };
    const kimiDir = path.join(env.KIMI_CODE_HOME, 'sessions', computeKimiWorkspaceDirName(root), params.kimiSessionId!);
    fs.mkdirSync(path.join(kimiDir, 'agents', 'main'), { recursive: true });
    fs.writeFileSync(path.join(kimiDir, 'state.json'), JSON.stringify({ title: 'test', createdAt: '2026-06-27T00:00:00Z' }));
    fs.writeFileSync(path.join(kimiDir, 'agents', 'main', 'wire.jsonl'), '');
    fs.writeFileSync(path.join(env.KIMI_CODE_HOME, 'session_index.jsonl'), JSON.stringify({ sessionId: params.kimiSessionId, sessionDir: kimiDir, workDir: root }) + '\n');
    const cursorDir = path.join(env.CURSOR_CONFIG_DIR, 'chats', cursorWorkspaceHash(root), params.cursorSessionId!);
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(path.join(cursorDir, 'meta.json'), JSON.stringify({ schemaVersion: 1, title: 'test', cwd: root, hasConversation: true }));
    const cursorDb = new DatabaseSync(path.join(cursorDir, 'store.db')); cursorDb.close();
    const transcript = getCursorTranscriptCandidates(params.cursorSessionId!, root)[0]!;
    fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.writeFileSync(transcript, '');
    const db = new DatabaseSync(env.ZCODE_SESSION_DB_PATH);
    db.exec('CREATE TABLE session (id TEXT, directory TEXT, path TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)');
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, NULL)').run(params.zcodeSessionId!, root, root, 'test', 1000, 2000);
    db.close();
  });
  afterEach(() => {
    Object.assign(tmuxCore, originalCore);
    for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const provider of providers) {
    it(`${provider.runtime}: a late old failure cannot kill or mark the replacement failed`, async () => {
      const oldProbe = deferred<{ exists: boolean; command: string }>();
      const entered = deferred<void>();
      let first = true;
      let alive = true;
      let launches = 0;
      let kills = 0;
      const sessionName = `clk-${provider.runtime}-${params.sessionId}`;
      tmuxCore.hasSession = async () => { if (first) { first = false; entered.resolve(); return oldProbe.promise; } return { exists: alive, command: 'mock has' }; };
      tmuxCore.ensureDetachedSession = async () => { alive = true; launches++; return { existed: true, command: 'mock new', commands: [] }; };
      tmuxCore.ensureExtendedKeys = async () => 'mock keys';
      tmuxCore.capturePane = async () => ({ screen: provider.screen, command: 'mock capture' });
      tmuxCore.killSession = async () => { alive = false; kills++; return 'mock kill'; };
      const old = drain(provider.stream(params));
      try {
        await entered.promise;
        await provider.restart(params);
        assert.equal(launches, 1, 'restart completes without waiting for the old operation');
        setRuntimeTmuxTurnState(provider.runtime, sessionName, 'active', 'new turn');
        const replacementState = getRuntimeTmuxInputState(provider.runtime, sessionName);
        oldProbe.reject(new Error('controlled late old failure'));
        await old; await flush();
        assert.equal(alive, true, 'the replacement tmux survives old finally');
        assert.equal(kills, 0);
        assert.deepEqual(getRuntimeTmuxInputState(provider.runtime, sessionName), replacementState, 'old catch cannot overwrite replacement state');
      } finally { oldProbe.reject(new Error('test cleanup')); await old; }
    });
  }

  for (const provider of providers) {
    it(`${provider.runtime}: restart waits only for an already dispatched cleanup, not the old turn`, async () => {
      const killing = deferred<void>();
      const finishKill = deferred<void>();
      let first = true;
      let alive = true;
      let launches = 0;
      const sessionName = `clk-${provider.runtime}-${params.sessionId}`;
      tmuxCore.hasSession = async () => {
        if (first) { first = false; throw new Error('old stream failed before restart'); }
        return { exists: alive, command: 'mock has' };
      };
      tmuxCore.killSession = async () => {
        killing.resolve(); await finishKill.promise;
        alive = false; return 'mock kill';
      };
      tmuxCore.ensureDetachedSession = async () => { alive = true; launches++; return { existed: true, command: 'mock new', commands: [] }; };
      tmuxCore.ensureExtendedKeys = async () => 'mock keys';
      tmuxCore.capturePane = async () => ({ screen: provider.screen, command: 'mock capture' });
      const old = drain(provider.stream(params));
      let restarting: ReturnType<typeof provider.restart> | undefined;
      try {
        await killing.promise;
        restarting = provider.restart(params);
        await flush();
        assert.equal(launches, 0, 'a dispatched name-based kill must finish before replacing that name');
        finishKill.resolve();
        await restarting; await old; await flush();
        assert.equal(launches, 1);
        assert.equal(alive, true);
        assert.equal(getRuntimeTmuxInputState(provider.runtime, sessionName).state, 'running');
      } finally { finishKill.resolve(); await old; await restarting; }
    });
  }

  for (const restart of [false, true]) {
    it(`Cursor abort ${restart ? 'after restart preserves the replacement' : 'without restart still stops its own tmux'}`, async () => {
      const provider = providers[0];
      const controller = new AbortController();
      const poll = deferred<{ exists: boolean; command: string }>();
      const entered = deferred<void>();
      let probes = 0;
      let alive = true;
      let kills = 0;
      const sessionName = `clk-cursor-${params.sessionId}`;
      transitionRuntimeTmuxInputState('cursor', sessionName, 'running', 'existing turn');
      tmuxCore.hasSession = async () => { if (++probes === 2) { entered.resolve(); return poll.promise; } return { exists: alive, command: 'mock has' }; };
      tmuxCore.ensureDetachedSession = async () => { alive = true; return { existed: true, command: 'mock new', commands: [] }; };
      tmuxCore.ensureExtendedKeys = async () => 'mock keys';
      tmuxCore.injectPromptIntoPane = async () => ({ commands: [] });
      tmuxCore.capturePane = async () => ({ screen: provider.screen, command: 'mock capture' });
      tmuxCore.killSession = async () => { alive = false; kills++; return 'mock kill'; };
      const old = drain(provider.stream({ ...params, abortController: controller }));
      try {
        await entered.promise;
        controller.abort();
        if (restart) await provider.restart(params);
        const state = getRuntimeTmuxInputState('cursor', sessionName);
        poll.resolve({ exists: true, command: 'mock old has' });
        await old; await flush();
        assert.equal(alive, restart);
        assert.equal(kills, restart ? 0 : 1);
        if (restart) assert.deepEqual(getRuntimeTmuxInputState('cursor', sessionName), state);
      } finally { controller.abort(); poll.resolve({ exists: false, command: 'cleanup' }); await old; }
    });
  }
});
