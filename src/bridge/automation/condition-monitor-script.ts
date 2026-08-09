import { spawn } from 'node:child_process';

export interface ConditionMonitorScriptDescription {
  intervalSeconds: number;
  timeoutSeconds: number;
}

export function parseConditionMonitorScriptDescription(raw: string): ConditionMonitorScriptDescription {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('检测脚本 --describe 必须只输出一个 JSON 对象');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('检测脚本 --describe 必须输出 JSON 对象');
  }
  const record = value as Record<string, unknown>;
  const intervalSeconds = Number(record.interval_seconds);
  const timeoutSeconds = record.timeout_seconds === undefined ? 60 : Number(record.timeout_seconds);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new Error('interval_seconds 必须是大于 0 的整数');
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new Error('timeout_seconds 必须是大于 0 的整数');
  }
  return { intervalSeconds, timeoutSeconds };
}

export async function describeConditionMonitorScript(options: {
  pythonExecutable: string;
  scriptPath: string;
  timeoutMs?: number;
}): Promise<ConditionMonitorScriptDescription> {
  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(options.pythonExecutable, [options.scriptPath, '--describe'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        try { resolve(parseConditionMonitorScriptDescription(stdout.trim())); }
        catch (parseError) { reject(parseError); }
      }
    };
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `检测脚本 --describe 退出码 ${code ?? 'null'}`));
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('检测脚本 --describe 超时'));
    }, options.timeoutMs ?? 10_000);
    timer.unref?.();
  });
}
