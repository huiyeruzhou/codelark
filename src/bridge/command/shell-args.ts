const DEFAULT_SHELL_SANDBOX_MODE = 'workspace-write';
const DEFAULT_SHELL_REFRESH_INTERVAL_SECONDS = 5;
const MIN_SHELL_REFRESH_INTERVAL_SECONDS = 5;

export type ShellSandboxMode = 'read-only' | 'workspace-write';

export interface ParsedShellCommandArgs {
  command: string;
  force: boolean;
  sandboxMode: ShellSandboxMode;
  refreshIntervalSeconds: number;
}

export interface ShellAuditFinding {
  level: 'block' | 'warn';
  message: string;
}

export function parseShellCommandArgs(rawArgs: string): ParsedShellCommandArgs | { error: string } {
  let rest = rawArgs.trim();
  let force = false;
  let sandboxMode: ShellSandboxMode = DEFAULT_SHELL_SANDBOX_MODE;

  while (rest.startsWith('--')) {
    if (rest === '--') {
      rest = '';
      break;
    }
    if (rest.startsWith('-- ')) {
      rest = rest.slice(3).trimStart();
      break;
    }
    if (rest === '--force' || rest.startsWith('--force ')) {
      force = true;
      rest = rest.slice('--force'.length).trimStart();
      continue;
    }
    if (rest.startsWith('--sandbox=')) {
      const next = consumeLeadingToken(rest.slice('--sandbox='.length));
      const parsed = parseShellSandboxMode(next?.token || '');
      if (!parsed) return { error: 'sandbox 只能是 read-only 或 workspace-write；/shell 不允许 danger-full-access。' };
      sandboxMode = parsed;
      rest = next?.rest.trimStart() || '';
      continue;
    }
    if (rest === '--sandbox' || rest.startsWith('--sandbox ')) {
      const next = consumeLeadingToken(rest.slice('--sandbox'.length));
      const parsed = parseShellSandboxMode(next?.token || '');
      if (!parsed) return { error: 'sandbox 只能是 read-only 或 workspace-write；/shell 不允许 danger-full-access。' };
      sandboxMode = parsed;
      rest = next?.rest.trimStart() || '';
      continue;
    }
    return { error: `未知 /shell 参数：${rest.split(/\s+/)[0]}` };
  }

  const refresh = consumeLeadingRefreshInterval(rest);
  if (refresh) {
    rest = refresh.rest.trimStart();
  }

  return {
    command: normalizeShellCommandTransportMarkdown(rest).trim(),
    force,
    refreshIntervalSeconds: refresh?.intervalSeconds || DEFAULT_SHELL_REFRESH_INTERVAL_SECONDS,
    sandboxMode,
  };
}

export function normalizeShellCommandTransportMarkdown(command: string): string {
  return command.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gi, (_match, label: string) => label);
}

function consumeLeadingToken(raw: string): { token: string; rest: string } | null {
  const match = raw.trimStart().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    token: match[1] || '',
    rest: match[2] || '',
  };
}

function consumeLeadingRefreshInterval(raw: string): { intervalSeconds: number; rest: string } | null {
  const match = raw.trimStart().match(/^(\d+)(?:s|秒)?\s+([\s\S]+)$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return {
    intervalSeconds: Math.max(MIN_SHELL_REFRESH_INTERVAL_SECONDS, Math.floor(parsed)),
    rest: match[2] || '',
  };
}

function parseShellSandboxMode(value: string): ShellSandboxMode | null {
  const normalized = value.trim().toLowerCase();
  return normalized === 'read-only' || normalized === 'workspace-write' ? normalized : null;
}

export function auditShellCommand(command: string): ShellAuditFinding[] {
  const findings: ShellAuditFinding[] = [];
  if (!command) {
    findings.push({ level: 'block', message: '缺少 shell 命令。' });
    return findings;
  }
  if (command.length > 8_000) {
    findings.push({ level: 'block', message: '命令过长，请拆成更小的命令。' });
  }
  if (command.includes('\0')) {
    findings.push({ level: 'block', message: '命令包含 null byte，已拒绝。' });
  }
  if (command === '/' || command.startsWith('/ ')) {
    findings.push({
      level: 'block',
      message: '命令开头是单独的 `/`，这通常是绝对路径被空格拆开。请检查路径后重新发送。',
    });
  }

  const highRiskPatterns: Array<{ pattern: RegExp; message: string }> = [
    { pattern: /(^|[;&|]\s*)(sudo\s+)?rm(\s|$)/, message: '`rm` 会删除文件或目录。' },
    { pattern: /\bfind\b[\s\S]*\s-delete(\s|$)/, message: '`find ... -delete` 会批量删除文件。' },
    { pattern: /(^|[;&|]\s*)git\s+clean\b/, message: '`git clean` 会删除未跟踪文件。' },
    { pattern: /(^|[;&|]\s*)dd\s+[\s\S]*\bof=/, message: '`dd of=...` 可能覆盖磁盘或文件。' },
    { pattern: /(^|[;&|]\s*)(mkfs|wipefs|shred|truncate)(\s|$)/, message: '该命令可能擦除或破坏数据。' },
    { pattern: /(^|[;&|]\s*)(shutdown|reboot|halt|poweroff)(\s|$)/, message: '该命令会影响系统运行状态。' },
    { pattern: /(^|[;&|]\s*)docker\s+system\s+prune\b/, message: '`docker system prune` 会批量删除 Docker 资源。' },
    { pattern: /(^|[;&|]\s*)chmod\s+-R\s+777\s+\//, message: '`chmod -R 777 /...` 会大范围放宽权限。' },
    { pattern: /(^|[;&|]\s*)chown\s+-R\b/, message: '`chown -R` 会递归修改所有权。' },
  ];

  for (const { pattern, message } of highRiskPatterns) {
    if (pattern.test(command)) {
      findings.push({
        level: 'warn',
        message,
      });
    }
  }

  return findings;
}
