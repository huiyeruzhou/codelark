import fs from 'node:fs';

export type DetachedLogMonitorState = 'running' | 'completed' | 'error';

export interface DetachedLogSnapshot {
  text: string;
  exists: boolean;
  state: DetachedLogMonitorState;
  stateDetail: string | null;
}

export interface DetachedLogMonitorHandle {
  refresh(): Promise<void>;
  stop(): void;
}

export function readDetachedLogTail(logPath: string, tailLines: number): {
  text: string;
  exists: boolean;
} {
  try {
    const rawLog = fs.readFileSync(logPath, 'utf-8');
    const lines = rawLog.split(/\r?\n/u);
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    return { text: lines.slice(-Math.max(1, tailLines)).join('\n'), exists: true };
  } catch {
    return { text: '(任务日志尚未创建或暂时不可读)', exists: false };
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function startDetachedLogMonitor(params: {
  logPath: string;
  workerPid: number | null;
  refreshIntervalMs: number;
  maxDurationMs: number;
  tailLines: number;
  workerLabel: string;
  detectState(logText: string): DetachedLogMonitorState;
  onSnapshot(snapshot: DetachedLogSnapshot): Promise<void> | void;
  processAlive?: (pid: number) => boolean;
  now?: () => number;
}): DetachedLogMonitorHandle {
  const now = params.now || Date.now;
  const processAlive = params.processAlive || isProcessAlive;
  const startedAt = now();
  let busy = false;
  let finished = false;
  let timer: NodeJS.Timeout | null = null;

  const stop = () => {
    finished = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  const refresh = async () => {
    if (busy || finished) return;
    busy = true;
    try {
      const log = readDetachedLogTail(params.logPath, params.tailLines);
      let state = params.detectState(log.text);
      let stateDetail: string | null = null;
      if (state === 'running' && params.workerPid && !processAlive(params.workerPid)) {
        state = 'error';
        stateDetail = `${params.workerLabel} PID ${params.workerPid} 已退出，但日志没有完成标记；停止刷新。`;
      }
      if (state === 'running' && now() - startedAt > params.maxDurationMs) {
        state = 'error';
        stateDetail = `超过 ${Math.ceil(params.maxDurationMs / 60_000)} 分钟仍未完成；停止刷新。`;
      }
      await params.onSnapshot({ ...log, state, stateDetail });
      if (state !== 'running') stop();
    } catch (error) {
      console.warn('[detached-log-monitor] Refresh failed:', error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
  };

  timer = setInterval(() => { void refresh(); }, Math.max(1, params.refreshIntervalMs));
  timer.unref?.();
  return { refresh, stop };
}
