import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  cancelConditionMonitorTask,
  createConditionMonitorTask,
  getConditionMonitorTask,
  _testOnly as taskTestOnly,
} from '../../../bridge/automation/condition-monitors.js';
import { runConditionMonitorTick } from '../../../bridge/automation/condition-monitor-runner.js';
import { parseConditionMonitorScriptDescription } from '../../../bridge/automation/condition-monitor-script.js';
import { _testOnly as bridgeTestOnly } from '../../../bridge/host/manager.js';

function writeTickScript(root: string, body: string): string {
  const scriptPath = path.join(root, `monitor-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(scriptPath, body, 'utf8');
  return scriptPath;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition monitor test timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('condition monitor lifecycle', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-condition-monitor-test-'));
    fs.rmSync(taskTestOnly.path, { force: true });
    bridgeTestOnly.resetStateForTests();
  });

  afterEach(() => {
    bridgeTestOnly.resetStateForTests();
    fs.rmSync(taskTestOnly.path, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('validates the Python template describe contract', () => {
    assert.deepEqual(parseConditionMonitorScriptDescription('{"interval_seconds":300,"timeout_seconds":45}'), {
      intervalSeconds: 300,
      timeoutSeconds: 45,
    });
    assert.deepEqual(parseConditionMonitorScriptDescription('{"interval_seconds":10}'), {
      intervalSeconds: 10,
      timeoutSeconds: 60,
    });
    assert.throws(() => parseConditionMonitorScriptDescription('{"interval_seconds":0}'), /大于 0/u);
  });

  it('ships a Python template whose false check is silent', (context) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const available = spawnSync(python, ['--version'], { encoding: 'utf8' });
    if (available.status !== 0) {
      context.skip(`${python} is unavailable`);
      return;
    }
    const template = fs.readFileSync(
      path.join(process.cwd(), 'skills', 'condition-monitor', 'scripts', 'condition_monitor_template.py'),
      'utf8',
    );
    const scriptPath = path.join(root, 'template-false.py');
    fs.writeFileSync(scriptPath, template.replace(
      'raise NotImplementedError("Replace with a read-only condition check")',
      'return False',
    ));
    const described = spawnSync(python, [scriptPath, '--describe'], { encoding: 'utf8' });
    assert.equal(described.status, 0, described.stderr);
    assert.deepEqual(JSON.parse(described.stdout), { interval_seconds: 300, timeout_seconds: 60 });
    const checked = spawnSync(python, [scriptPath, '--check'], { encoding: 'utf8' });
    assert.equal(checked.status, 1, checked.stderr);
    assert.equal(checked.stdout, '');
    assert.equal(checked.stderr, '');

    const probeEnv = { ...process.env };
    delete probeEnv.CODELARK_BIN;
    const commandProbe = spawnSync(python, ['-c', [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("condition_monitor", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'print(json.dumps(module.build_codelark_command(["send", "agent", "--idempotency-key", "stable-id"], "nt")))',
    ].join('; '), scriptPath], { encoding: 'utf8', env: probeEnv });
    assert.equal(commandProbe.status, 0, commandProbe.stderr);
    const windowsCommand = JSON.parse(commandProbe.stdout) as string[];
    assert.match(windowsCommand[0] || '', /(?:^|[\\/])cmd\.exe$/iu);
    assert.deepEqual(windowsCommand.slice(1), [
      '/d', '/s', '/c', 'codelark.cmd send agent --idempotency-key stable-id',
    ]);
  });

  it('passes the stable monitor UUID to codelark send on a true tick', (context) => {
    if (process.platform === 'win32') {
      context.skip('executable shim fixture is POSIX-only; Windows command composition is covered separately');
      return;
    }
    const python = 'python3';
    if (spawnSync(python, ['--version'], { encoding: 'utf8' }).status !== 0) {
      context.skip('python3 is unavailable');
      return;
    }
    const templatePath = path.join(
      process.cwd(), 'skills', 'condition-monitor', 'scripts', 'condition_monitor_template.py',
    );
    const scriptPath = path.join(root, 'template-true.py');
    fs.writeFileSync(scriptPath, fs.readFileSync(templatePath, 'utf8').replace(
      'raise NotImplementedError("Replace with a read-only condition check")',
      'return True',
    ));
    const argumentsPath = path.join(root, 'codelark-arguments.json');
    const fakeCodelark = path.join(root, 'fake-codelark.py');
    fs.writeFileSync(fakeCodelark, [
      '#!/usr/bin/env python3',
      'import json, sys',
      `open(${JSON.stringify(argumentsPath)}, "w", encoding="utf-8").write(json.dumps(sys.argv[1:]))`,
    ].join('\n'));
    fs.chmodSync(fakeCodelark, 0o755);
    const tick = spawnSync(python, [scriptPath, '--tick'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODELARK_BIN: fakeCodelark,
        CODELARK_MONITOR_ID: 'stable-monitor-uuid',
      },
    });
    assert.equal(tick.status, 0, tick.stderr);
    const args = JSON.parse(fs.readFileSync(argumentsPath, 'utf8')) as string[];
    assert.deepEqual(args.slice(-2), ['--idempotency-key', 'stable-monitor-uuid']);
    assert.deepEqual(args.slice(0, 2), ['send', 'message']);
  });

  it('treats exit 1 as a silent pending poll and exit 0 as notification success', async () => {
    const pending = writeTickScript(root, 'process.exit(1);\n');
    const notified = writeTickScript(root, 'process.exit(0);\n');
    const base = { id: 'task', pythonExecutable: process.execPath, timeoutSeconds: 5 };
    assert.deepEqual(await runConditionMonitorTick({ ...base, scriptPath: pending }), { outcome: 'pending' });
    assert.deepEqual(await runConditionMonitorTick({ ...base, scriptPath: notified }), { outcome: 'notified' });
  });

  it('stays running without a notification while false', async () => {
    const scriptPath = writeTickScript(root, 'process.exit(1);\n');
    const task = createConditionMonitorTask({
      ownerInternalChatId: 'owner-chat',
      ownerBridgeSessionId: 'owner-session',
      label: 'pending monitor',
      scriptPath,
      pythonExecutable: process.execPath,
      intervalSeconds: 1,
      timeoutSeconds: 5,
    });
    bridgeTestOnly.startConditionMonitor(task.id);
    await waitFor(() => (getConditionMonitorTask(task.id)?.checkedCount || 0) >= 1);
    assert.equal(getConditionMonitorTask(task.id)?.status, 'running');
    assert.equal(getConditionMonitorTask(task.id)?.lastError, undefined);
  });

  it('sends once, marks completed, and does not poll again', async () => {
    const notificationFile = path.join(root, 'sent.log');
    const scriptPath = writeTickScript(root, [
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(notificationFile)}, 'sent\\n');`,
      'process.exit(0);',
    ].join('\n'));
    const task = createConditionMonitorTask({
      ownerInternalChatId: 'owner-chat',
      ownerBridgeSessionId: 'owner-session',
      label: 'one shot',
      scriptPath,
      pythonExecutable: process.execPath,
      intervalSeconds: 1,
      timeoutSeconds: 5,
    });
    bridgeTestOnly.startConditionMonitor(task.id);
    await waitFor(() => getConditionMonitorTask(task.id)?.status === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(fs.readFileSync(notificationFile, 'utf8'), 'sent\n');
    assert.equal(getConditionMonitorTask(task.id)?.checkedCount, 1);
  });

  it('cancels by stable UUID before the next poll', async () => {
    const notificationFile = path.join(root, 'cancelled.log');
    const scriptPath = writeTickScript(root, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(notificationFile)}, 'sent');\n`);
    const task = createConditionMonitorTask({
      ownerInternalChatId: 'owner-chat',
      ownerBridgeSessionId: 'owner-session',
      label: 'cancel me',
      scriptPath,
      pythonExecutable: process.execPath,
      intervalSeconds: 1,
      timeoutSeconds: 5,
    });
    bridgeTestOnly.startConditionMonitor(task.id);
    assert.equal(cancelConditionMonitorTask(task.id)?.id, task.id);
    bridgeTestOnly.stopConditionMonitor(task.id);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(getConditionMonitorTask(task.id)?.status, 'cancelled');
    assert.equal(fs.existsSync(notificationFile), false);
  });

  it('restores a persisted running monitor after Bridge restart', async () => {
    const notificationFile = path.join(root, 'restored.log');
    const scriptPath = writeTickScript(root, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(notificationFile)}, 'sent');\n`);
    const task = createConditionMonitorTask({
      ownerInternalChatId: 'owner-chat',
      ownerBridgeSessionId: 'owner-session',
      label: 'restore me',
      scriptPath,
      pythonExecutable: process.execPath,
      intervalSeconds: 1,
      timeoutSeconds: 5,
    });
    bridgeTestOnly.resetStateForTests();
    bridgeTestOnly.startPersistedConditionMonitors();
    await waitFor(() => getConditionMonitorTask(task.id)?.status === 'completed');
    assert.equal(fs.readFileSync(notificationFile, 'utf8'), 'sent');
  });
});
