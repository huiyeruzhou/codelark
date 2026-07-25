import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CodexShellType = 'zsh' | 'bash' | 'powershell' | 'sh' | 'cmd';

export interface CodexUserShell {
  type: CodexShellType;
  path: string;
}

export interface ResolveDefaultUserShellOptions {
  platform?: NodeJS.Platform;
  userShellPath?: string | null;
  pathEnv?: string;
  fileExists?: (filePath: string) => boolean;
}

export interface ShellSnapshot {
  shell: CodexUserShell;
  path: string;
  content: string;
}

export interface ShellLaunchCommandOptions {
  platform?: NodeJS.Platform;
  stderrLogPath?: string;
}

const EXCLUDED_EXPORT_VARS = new Set(['PWD', 'OLDPWD']);
const shellSnapshotCache = new Map<string, ShellSnapshot>();
let cleanupRegistered = false;

function defaultFileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function executableNamesForPlatform(binaryName: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [binaryName];
  const lower = binaryName.toLowerCase();
  if (lower.endsWith('.exe') || lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return [binaryName];
  }
  return [`${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.bat`, binaryName];
}

function findOnPath(
  binaryName: string,
  options: Required<Pick<ResolveDefaultUserShellOptions, 'platform' | 'pathEnv' | 'fileExists'>>,
): string | null {
  const names = executableNamesForPlatform(binaryName, options.platform);
  const pathModule = options.platform === 'win32' ? path.win32 : path.posix;
  for (const dir of options.pathEnv.split(pathDelimiterForPlatform(options.platform))) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = pathModule.join(dir, name);
      if (options.fileExists(candidate)) return candidate;
    }
  }
  return null;
}

export function detectCodexShellType(shellPath: string | null | undefined): CodexShellType | null {
  const normalized = (shellPath || '').replace(/\\/g, '/');
  const base = path.basename(normalized).toLowerCase().replace(/\.exe$/, '');
  switch (base) {
    case 'zsh': return 'zsh';
    case 'bash': return 'bash';
    case 'pwsh':
    case 'powershell': return 'powershell';
    case 'sh': return 'sh';
    case 'cmd': return 'cmd';
    default: return null;
  }
}

function resolveUserShellPath(): string | null {
  try {
    const info = os.userInfo() as os.UserInfo<string> & { shell?: string | null };
    return info.shell || null;
  } catch {
    return null;
  }
}

function fallbackPaths(shellType: CodexShellType, platform: NodeJS.Platform): string[] {
  switch (shellType) {
    case 'zsh': return ['/bin/zsh'];
    case 'bash': return ['/bin/bash'];
    case 'sh': return ['/bin/sh'];
    case 'powershell':
      return platform === 'win32'
        ? [
            'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          ]
        : ['/usr/local/bin/pwsh'];
    case 'cmd': return platform === 'win32' ? ['cmd.exe'] : [];
  }
}

function shellBinaryNames(shellType: CodexShellType): string[] {
  switch (shellType) {
    case 'powershell': return ['pwsh', 'powershell'];
    default: return [shellType];
  }
}

function resolveShellByType(
  shellType: CodexShellType,
  options: Required<Pick<ResolveDefaultUserShellOptions, 'platform' | 'userShellPath' | 'pathEnv' | 'fileExists'>>,
): CodexUserShell | null {
  if (
    options.userShellPath
    && detectCodexShellType(options.userShellPath) === shellType
    && options.fileExists(options.userShellPath)
  ) {
    return { type: shellType, path: options.userShellPath };
  }

  for (const binaryName of shellBinaryNames(shellType)) {
    const found = findOnPath(binaryName, options);
    if (found) return { type: shellType, path: found };
  }

  for (const candidate of fallbackPaths(shellType, options.platform)) {
    if (options.fileExists(candidate)) return { type: shellType, path: candidate };
  }

  return null;
}

function ultimateFallbackShell(platform: NodeJS.Platform): CodexUserShell {
  return platform === 'win32'
    ? { type: 'cmd', path: 'cmd.exe' }
    : { type: 'sh', path: '/bin/sh' };
}

export function resolveDefaultUserShell(options: ResolveDefaultUserShellOptions = {}): CodexUserShell {
  const platform = options.platform || process.platform;
  const userShellPath = options.userShellPath === undefined ? resolveUserShellPath() : options.userShellPath;
  const resolvedOptions = {
    platform,
    userShellPath,
    pathEnv: options.pathEnv ?? process.env.PATH ?? '',
    fileExists: options.fileExists || defaultFileExists,
  };

  if (platform === 'win32') {
    return resolveShellByType('powershell', resolvedOptions)
      || resolveShellByType('cmd', resolvedOptions)
      || ultimateFallbackShell(platform);
  }

  const userShellType = detectCodexShellType(userShellPath);
  const userDefaultShell = userShellType ? resolveShellByType(userShellType, resolvedOptions) : null;
  const fallbackOrder: CodexShellType[] = platform === 'darwin'
    ? ['zsh', 'bash']
    : ['bash', 'zsh'];

  return userDefaultShell
    || fallbackOrder.map((shellType) => resolveShellByType(shellType, resolvedOptions)).find(Boolean)
    || ultimateFallbackShell(platform);
}

function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function sortedSnapshotEnv(env: Record<string, string>): Array<[string, string]> {
  return Object.entries(env)
    .filter(([key, value]) => value !== undefined && isValidEnvName(key) && !EXCLUDED_EXPORT_VARS.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
}

function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function cmdSetQuote(key: string, value: string): string {
  return `set "${key}=${value.replace(/"/g, '""')}"`;
}

export function buildShellSnapshotContent(shellType: CodexShellType, env: Record<string, string>): string {
  const entries = sortedSnapshotEnv(env);
  const lines = [
    '# Snapshot file',
    `# shell ${shellType}`,
    `# exports ${entries.length}`,
  ];

  switch (shellType) {
    case 'bash':
      for (const [key, value] of entries) {
        lines.push(`declare -x ${key}=${posixSingleQuote(value)}`);
      }
      break;
    case 'zsh':
      for (const [key, value] of entries) {
        lines.push(`typeset -gx ${key}=${posixSingleQuote(value)}`);
      }
      break;
    case 'sh':
      for (const [key, value] of entries) {
        lines.push(`export ${key}=${posixSingleQuote(value)}`);
      }
      break;
    case 'powershell':
      for (const [key, value] of entries) {
        lines.push(`Set-Item -LiteralPath ${powershellSingleQuote(`Env:${key}`)} -Value ${powershellSingleQuote(value)}`);
      }
      break;
    case 'cmd':
      for (const [key, value] of entries) {
        lines.push(cmdSetQuote(key, value));
      }
      break;
  }

  return `${lines.join('\n')}\n`;
}

function snapshotExtension(shellType: CodexShellType): string {
  switch (shellType) {
    case 'powershell': return 'ps1';
    case 'cmd': return 'cmd';
    default: return 'sh';
  }
}

function fingerprintSnapshot(shell: CodexUserShell, env: Record<string, string>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      shell,
      env: sortedSnapshotEnv(env),
    }))
    .digest('hex')
    .slice(0, 16);
}

function registerSnapshotCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', () => {
    for (const snapshot of shellSnapshotCache.values()) {
      try { fs.unlinkSync(snapshot.path); } catch { /* ignore */ }
    }
  });
}

export function ensureShellSnapshot(
  env: Record<string, string>,
  shell = resolveDefaultUserShell(),
): ShellSnapshot {
  const fingerprint = fingerprintSnapshot(shell, env);
  const existing = shellSnapshotCache.get(fingerprint);
  if (existing && fs.existsSync(existing.path)) return existing;

  const content = buildShellSnapshotContent(shell.type, env);
  const snapshotPath = path.join(
    os.tmpdir(),
    `codelark-shell-snapshot-${process.pid}-${fingerprint}.${snapshotExtension(shell.type)}`,
  );
  fs.writeFileSync(snapshotPath, content, { encoding: 'utf-8', mode: 0o600 });
  try { fs.chmodSync(snapshotPath, 0o600); } catch { /* best effort */ }
  const snapshot = { shell, path: snapshotPath, content };
  shellSnapshotCache.set(fingerprint, snapshot);
  registerSnapshotCleanup();
  return snapshot;
}

export function buildShellSnapshotLaunchCommand(
  command: string,
  args: string[],
  snapshot: ShellSnapshot,
  options: ShellLaunchCommandOptions = {},
): string {
  const platform = options.platform || process.platform;
  return buildShellSnapshotLaunchArgs(command, args, snapshot, options)
    .map((value) => quoteCommandLineArg(value, platform))
    .join(' ');
}

export function buildShellSnapshotLaunchArgs(
  command: string,
  args: string[],
  snapshot: ShellSnapshot,
  options: ShellLaunchCommandOptions = {},
): string[] {
  switch (snapshot.shell.type) {
    case 'bash':
    case 'zsh':
    case 'sh': {
      const commandText = [command, ...args].map(posixShellQuote).join(' ');
      const script = options.stderrLogPath
        ? [
            `. ${posixShellQuote(snapshot.path)}`,
            `${commandText} 2> ${posixShellQuote(options.stderrLogPath)}`,
            'status=$?',
            `if [ "$status" -ne 0 ]; then printf '%s\\n' "[codelark] process exited with status $status" >> ${posixShellQuote(options.stderrLogPath)}; fi`,
            'exit "$status"',
          ].join('; ')
        : `. ${posixShellQuote(snapshot.path)}; exec ${commandText}`;
      return [snapshot.shell.path, '-c', script];
    }
    case 'powershell': {
      const commandText = [command, ...args].map(powershellSingleQuote).join(' ');
      const script = options.stderrLogPath
        ? [
            `. ${powershellSingleQuote(snapshot.path)}`,
            `& ${commandText} 2> ${powershellSingleQuote(options.stderrLogPath)}`,
            '$status = $LASTEXITCODE',
            'if ($null -eq $status) { $status = 0 }',
            `if ($status -ne 0) { Add-Content -LiteralPath ${powershellSingleQuote(options.stderrLogPath)} -Value ('[codelark] process exited with status ' + $status) }`,
            'exit $status',
          ].join('; ')
        : `. ${powershellSingleQuote(snapshot.path)}; & ${commandText}`;
      return [snapshot.shell.path, '-NoProfile', '-Command', script];
    }
    case 'cmd': {
      const commandText = [command, ...args].map(cmdArgQuote).join(' ');
      const script = options.stderrLogPath
        ? `call ${cmdArgQuote(snapshot.path)} && ${commandText} 2> ${cmdArgQuote(options.stderrLogPath)}`
        : `call ${cmdArgQuote(snapshot.path)} && ${commandText}`;
      return [snapshot.shell.path, '/c', script];
    }
  }
}

export function quoteCommandLineArg(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return posixShellQuote(value);
  if (value && !/[\s"]/u.test(value)) return value;

  // CreateProcess/CommandLineToArgvW escaping: backslashes are doubled only
  // when they precede a quote or the closing quote.
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += '\\'.repeat((backslashes * 2) + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"';
}

function posixShellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return posixSingleQuote(value);
}

function cmdArgQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./\\:-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
