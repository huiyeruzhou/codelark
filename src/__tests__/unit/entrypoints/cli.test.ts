import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  buildCliHelpText,
  formatRunSuccessMessage,
  formatRunningBridgePrompt,
  isDirectCliRun,
  parseCliCommand,
  parseCliInvocation,
  resolveRunningBridgeStartAction,
} from '../../../entrypoints/cli.js';

describe('cli entrypoint', () => {
  it('parses default, help, run/open, and nested autostart commands', () => {
    assert.deepEqual(parseCliCommand([]), { command: 'default', args: [] });
    assert.deepEqual(parseCliCommand(['help']), { command: 'help', args: [] });
    assert.deepEqual(parseCliCommand(['--help']), { command: 'help', args: [] });
    assert.deepEqual(parseCliCommand(['-h']), { command: 'help', args: [] });
    assert.deepEqual(parseCliCommand(['autostart', 'install']), {
      command: 'autostart',
      args: ['install'],
    });
    assert.deepEqual(parseCliCommand(['run']), { command: 'run', args: [] });
    assert.deepEqual(parseCliCommand(['open']), { command: 'run', args: [], rawCommand: 'open' });
  });

  it('parses config overrides before dispatching the command', () => {
    assert.deepEqual(parseCliInvocation([
      '--set', 'runtime.agent=claude',
      'run',
      '--set', 'runtime.codex.provider=tmux',
    ]), {
      command: 'run',
      args: [],
      configOverrides: {
        patch: {
          runtime: {
            agent: 'claude',
            codex: { provider: 'tmux' },
          },
        },
        unset: [],
      },
    });
  });

  it('rejects CLI unset at command entrypoints until reset semantics are defined', () => {
    assert.throws(
      () => parseCliInvocation(['run', '--unset', 'runtime.codex.model']),
      /CLI --unset 暂未接入命令入口/,
    );
  });

  it('renders actionable help for common local service flows', () => {
    const help = buildCliHelpText();

    assert.match(help, /codelark\s+打开本地工作台，并启动 Bridge/);
    assert.match(help, /codelark run\s+显式打开工作台并启动 Bridge/);
    assert.doesNotMatch(help, /codelark open\s+显式打开工作台并启动 Bridge/);
    assert.match(help, /codelark setup\s+配置或重新配置飞书\/Lark 凭据/);
    assert.match(help, /autostart install\s+安装 Windows Bridge 开机启动任务/);
    assert.match(help, /--set path=value/);
    assert.match(help, /~\/\.codelark\/config\.toml/);
    assert.match(help, /~\/\.codelark\/logs\//);
  });

  it('renders run success with explicit UI, bridge, and IM readiness guidance', () => {
    const text = formatRunSuccessMessage({
      url: 'http://127.0.0.1:17373',
      ui: { running: true, pid: 111, port: 17373 },
      bridge: {
        running: true,
        pid: 222,
        adapters: [{
          channelType: 'feishu',
          channelProvider: 'feishu',
          running: true,
          connectedAt: '2026-06-04T00:00:00.000Z',
          lastMessageAt: null,
          error: null,
        }],
      },
      wasUiRunning: false,
      wasBridgeRunning: true,
    });

    assert.match(text, /CodeLark 启动成功。/);
    assert.match(text, /UI：正在运行，已确认进程存活（本次已启动，PID 111）/);
    assert.match(text, /Bridge：正在运行，已确认进程存活（已在运行，PID 222）/);
    assert.match(text, /工作台：http:\/\/127\.0\.0\.1:17373/);
    assert.match(text, /现在应该可以在飞书\/Lark 里给机器人发消息并看到回复/);
  });

  it('asks interactive start/run callers whether to restart an already-running Bridge', async () => {
    const running = { running: true, pid: 222 };
    assert.equal(formatRunningBridgePrompt('start', running), 'Bridge 已经在运行（PID 222）。是否先停止已有实例并重新执行 codelark start？');

    const restart = await resolveRunningBridgeStartAction({
      command: 'start',
      status: running,
      prompt: async (question) => {
        assert.equal(question, 'Bridge 已经在运行（PID 222）。是否先停止已有实例并重新执行 codelark start？');
        return true;
      },
    });
    assert.equal(restart, 'restart');

    assert.equal(await resolveRunningBridgeStartAction({
      command: 'run',
      status: running,
      interactive: false,
    }), 'reuse');

    assert.equal(await resolveRunningBridgeStartAction({
      command: 'run',
      status: { running: false },
      prompt: async () => {
        throw new Error('prompt should not run when Bridge is stopped');
      },
    }), 'start');
  });

  it('treats npm bin symlinks as direct CLI runs', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-cli-entrypoint-'));
    try {
      const realEntrypoint = path.join(tempDir, 'dist', 'cli.mjs');
      const binDir = path.join(tempDir, 'bin');
      const symlinkEntrypoint = path.join(binDir, 'codelark');

      fs.mkdirSync(path.dirname(realEntrypoint), { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(realEntrypoint, '#!/usr/bin/env node\n');
      fs.symlinkSync(realEntrypoint, symlinkEntrypoint);

      assert.equal(isDirectCliRun(symlinkEntrypoint, pathToFileURL(realEntrypoint).href), true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
