import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ThreadProcessProbeStatus = 'alive' | 'not_found' | 'unsupported' | 'error';

export interface ThreadProcessProbeResult {
  threadId: string;
  status: ThreadProcessProbeStatus;
  supported: boolean;
  checkedAt: string;
  pid?: number;
  createdAt?: string;
  commandLine?: string;
  error?: string;
}

function normalizeProbeRecord(
  threadId: string,
  checkedAt: string,
  raw: unknown,
): ThreadProcessProbeResult {
  const record = Array.isArray(raw) ? raw[0] : raw;
  if (!record || typeof record !== 'object') {
    return {
      threadId,
      status: 'not_found',
      supported: true,
      checkedAt,
    };
  }

  const processId = Number((record as { ProcessId?: unknown }).ProcessId);
  return {
    threadId,
    status: Number.isFinite(processId) && processId > 0 ? 'alive' : 'not_found',
    supported: true,
    checkedAt,
    ...(Number.isFinite(processId) && processId > 0 ? { pid: processId } : {}),
    ...(
      typeof (record as { CreationDate?: unknown }).CreationDate === 'string'
        ? { createdAt: (record as { CreationDate: string }).CreationDate }
        : {}
    ),
    ...(
      typeof (record as { CommandLine?: unknown }).CommandLine === 'string'
        ? { commandLine: (record as { CommandLine: string }).CommandLine }
        : {}
    ),
  };
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

export async function probeCodexThreadProcess(threadId: string): Promise<ThreadProcessProbeResult> {
  const checkedAt = new Date().toISOString();
  const trimmedThreadId = threadId.trim();

  if (!trimmedThreadId) {
    return {
      threadId: trimmedThreadId,
      status: 'error',
      supported: false,
      checkedAt,
      error: 'missing thread id',
    };
  }

  if (process.platform !== 'win32') {
    return {
      threadId: trimmedThreadId,
      status: 'unsupported',
      supported: false,
      checkedAt,
    };
  }

  const psThreadId = escapePowerShellSingleQuoted(trimmedThreadId);
  const script = [
    `$threadId = '${psThreadId}'`,
    '$escaped = [regex]::Escape($threadId)',
    '$proc = Get-CimInstance Win32_Process | Where-Object {',
    "  $_.Name -ieq 'codex.exe' -and $_.CommandLine -match $escaped",
    '} | Select-Object -First 1 ProcessId, CreationDate, CommandLine',
    "if ($null -eq $proc) { '' } else { $proc | ConvertTo-Json -Compress }",
  ].join('; ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 512 * 1024,
      },
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {
        threadId: trimmedThreadId,
        status: 'not_found',
        supported: true,
        checkedAt,
      };
    }
    return normalizeProbeRecord(trimmedThreadId, checkedAt, JSON.parse(trimmed) as unknown);
  } catch (error) {
    return {
      threadId: trimmedThreadId,
      status: 'error',
      supported: true,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
