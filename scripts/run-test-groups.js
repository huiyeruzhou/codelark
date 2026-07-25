import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const requestedArgs = process.argv.slice(2);
const parallelSelected = requestedArgs.includes('--parallel');
const selectedArgs = requestedArgs.filter((arg) => arg !== '--parallel');
const startedAt = Date.now();
const children = new Set();

function runSelectedLayers(args) {
  const child = spawn(process.execPath, ['scripts/run-tests.js', ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

if (requestedArgs.length > 0 && !parallelSelected) {
  runSelectedLayers(requestedArgs);
} else {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-test-groups-'));
  let groups = [
    { name: 'unit-1', args: ['--unit', '--test-shard=1/2'] },
    { name: 'unit-2', args: ['--unit', '--test-shard=2/2'] },
    { name: 'workflow-1', args: ['--workflow', '--test-shard=1/4'] },
    { name: 'workflow-2', args: ['--workflow', '--test-shard=2/4'] },
    { name: 'workflow-3', args: ['--workflow', '--test-shard=3/4'] },
    { name: 'workflow-4', args: ['--workflow', '--test-shard=4/4'] },
    { name: 'mock-e2e-1', args: ['--mock-e2e', '--test-shard=1/2'] },
    { name: 'mock-e2e-2', args: ['--mock-e2e', '--test-shard=2/2'] },
    { name: 'harness', args: ['--harness'] },
    { name: 'local-e2e', args: ['--local-e2e'] },
  ];
  if (parallelSelected) {
    const supportedLayers = new Set(groups.flatMap((group) => group.args.filter((arg) => !arg.startsWith('--test-shard='))));
    const selectedLayers = new Set(selectedArgs);
    groups = groups.filter((group) => group.args.some((arg) => selectedLayers.has(arg)));
    if (groups.length === 0 || selectedArgs.some((arg) => !supportedLayers.has(arg))) {
      process.stderr.write('[test-groups] --parallel requires one or more layer flags and no shard override.\n');
      process.exit(1);
    }
  }

  function tail(text, lineLimit = 200) {
    return text.split(/\r?\n/u).slice(-lineLimit).join('\n');
  }

  function parseSummary(text) {
    const values = {};
    for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
      const match = text.match(new RegExp(`^ℹ ${key} (\\d+)$`, 'mu'));
      values[key] = match ? Number(match[1]) : 0;
    }
    const duration = text.match(/^ℹ duration_ms ([\d.]+)$/mu);
    values.durationMs = duration ? Number(duration[1]) : 0;
    return values;
  }

  function runGroup(group) {
    const logPath = path.join(runRoot, `${group.name}.log`);
    const logFd = fs.openSync(logPath, 'w');
    const child = spawn(process.execPath, ['scripts/run-tests.js', ...group.args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', logFd, logFd],
    });
    fs.closeSync(logFd);
    children.add(child);
    process.stderr.write(`[test-groups] started ${group.name} pid=${child.pid} log=${logPath}\n`);
    return new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        children.delete(child);
        const output = fs.readFileSync(logPath, 'utf-8');
        const summary = parseSummary(output);
        process.stderr.write([
          `[test-groups] completed ${group.name}`,
          `exit=${code ?? '-'}${signal ? ` signal=${signal}` : ''}`,
          `tests=${summary.tests}`,
          `pass=${summary.pass}`,
          `fail=${summary.fail}`,
          `skipped=${summary.skipped}`,
          `duration_ms=${summary.durationMs}`,
          `log=${logPath}`,
        ].join(' ') + '\n');
        if ((code ?? 1) !== 0 || signal) {
          process.stderr.write(`\n[test-groups] ${group.name} failure tail\n${tail(output)}\n`);
        }
        resolve({ ...group, code: code ?? 1, signal, logPath, summary });
      });
    });
  }

  const terminateChildren = (signal) => {
    for (const child of children) {
      try {
        child.kill(signal);
      } catch {
        // best effort
      }
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      terminateChildren(signal);
      process.exit(1);
    });
  }

  const results = new Array(groups.length);
  const workerCount = Math.min(groups.length, os.availableParallelism());
  let nextGroupIndex = 0;
  async function runWorker() {
    while (nextGroupIndex < groups.length) {
      const index = nextGroupIndex;
      nextGroupIndex += 1;
      results[index] = await runGroup(groups[index]);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  const totals = results.reduce((sum, result) => {
    for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
      sum[key] += result.summary[key];
    }
    return sum;
  }, { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  const wallMs = Date.now() - startedAt;
  process.stdout.write([
    '[test-groups] total',
    `tests=${totals.tests}`,
    `suites=${totals.suites}`,
    `pass=${totals.pass}`,
    `fail=${totals.fail}`,
    `cancelled=${totals.cancelled}`,
    `skipped=${totals.skipped}`,
    `todo=${totals.todo}`,
    `wall_ms=${wallMs}`,
    `logs=${runRoot}`,
  ].join(' ') + '\n');
  process.exitCode = results.some((result) => result.code !== 0 || result.signal) ? 1 : 0;
}
