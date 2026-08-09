import { spawn } from 'node:child_process';

import type { ConditionMonitorTask } from './condition-monitors.js';

const MAX_CAPTURE_CHARS = 16_000;

export type ConditionMonitorTickResult =
  | { outcome: 'notified' }
  | { outcome: 'pending' }
  | { outcome: 'error'; error: string };

function appendLimited(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  return next.length <= MAX_CAPTURE_CHARS ? next : next.slice(-MAX_CAPTURE_CHARS);
}

export async function runConditionMonitorTick(
  task: Pick<ConditionMonitorTask, 'id' | 'scriptPath' | 'pythonExecutable' | 'timeoutSeconds'>,
  options: { signal?: AbortSignal } = {},
): Promise<ConditionMonitorTickResult> {
  return await new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const child = spawn(task.pythonExecutable, [task.scriptPath, '--tick'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODELARK_MONITOR_ID: task.id },
      signal: options.signal,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ConditionMonitorTickResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };
    child.stdout?.on('data', (chunk) => { stdout = appendLimited(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = appendLimited(stderr, chunk); });
    child.once('error', (error) => {
      if (options.signal?.aborted) finish({ outcome: 'pending' });
      else if (timedOut) finish({ outcome: 'error', error: `检测脚本超过 ${task.timeoutSeconds}s 未结束` });
      else finish({ outcome: 'error', error: error.message });
    });
    child.once('close', (code, signal) => {
      if (options.signal?.aborted) return finish({ outcome: 'pending' });
      if (timedOut) return finish({ outcome: 'error', error: `检测脚本超过 ${task.timeoutSeconds}s 未结束` });
      if (code === 0) return finish({ outcome: 'notified' });
      if (code === 1) return finish({ outcome: 'pending' });
      const detail = stderr.trim() || stdout.trim() || `exit=${code ?? 'null'} signal=${signal || '-'}`;
      return finish({ outcome: 'error', error: detail });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceKillTimer.unref?.();
    }, Math.max(1, task.timeoutSeconds) * 1000);
    timer.unref?.();
  });
}
