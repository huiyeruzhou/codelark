import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { CODELARK_HOME } from '../configuration/paths.js';
import type { FeishuChannelConfig } from '../channels/types.js';
import { createConfigService } from '../configuration/service.js';
import type { ConfigPatch, ConfigV2 } from '../configuration/schema.js';
import { normalizeFeishuSite } from '../channels/feishu/site.js';
import {
  clearStaleBridgeInstanceLock,
  readBridgeInstanceLock,
  releaseBridgeInstanceLock,
} from './instance-lock.js';

export interface BridgeStatus {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  adapters?: Array<{
    channelType: string;
    channelProvider?: string;
    channelAlias?: string;
    running: boolean;
    connectedAt: string | null;
    lastMessageAt: string | null;
    error: string | null;
  }>;
  lastExitReason?: string;
}

export interface UiServerStatus {
  running: boolean;
  pid?: number;
  port?: number;
  startedAt?: string;
}

export interface BridgeAutostartStatus {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  mode: 'startup';
  taskName: string;
  runAsUser?: string;
  state?: string;
  launcherPath?: string;
  error?: string;
}

export interface DeferredGlobalNpmUninstallLaunch {
  command: string;
  args: string[];
  npmCommand: string;
  logPath: string;
  delayMs: number;
}

export interface PackageUninstallResult {
  ui: UiServerStatus;
  bridge: BridgeStatus;
  autostart: BridgeAutostartStatus;
  npmCommand: string;
  logPath: string;
  scheduled: boolean;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
function resolvePackageRoot(startDir: string): string {
  let current = startDir;
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir, '..');
    current = parent;
  }
}

const packageRoot = resolvePackageRoot(moduleDir);
const runtimeDir = path.join(CODELARK_HOME, 'runtime');
const logsDir = path.join(CODELARK_HOME, 'logs');
const larkCliRuntimeDir = path.join(runtimeDir, 'lark-cli');
const larkCliSourceDir = path.join(runtimeDir, 'lark-cli-source');
const larkCliBinDir = path.join(runtimeDir, 'bin');
const larkCliSourceConfigFile = path.join(larkCliSourceDir, 'config.json');
const larkCliTargetConfigFile = path.join(larkCliRuntimeDir, 'lark-channel', 'config.json');
const bridgePidFile = path.join(runtimeDir, 'bridge.pid');
const bridgeStatusFile = path.join(runtimeDir, 'status.json');
const bridgeStartLockFile = path.join(runtimeDir, 'bridge.start.lock');
const uiStatusFile = path.join(runtimeDir, 'ui-server.json');
const uiPort = 4781;
const primaryBridgeAutostartTaskName = 'CodeLarkBridge';
const bridgeAutostartTaskNames = [primaryBridgeAutostartTaskName] as const;
const bridgeAutostartLauncherFile = path.join(runtimeDir, 'bridge-autostart.ps1');
const npmUninstallLogFile = path.join(runtimeDir, 'npm-uninstall.log');
const PRIMARY_CLI_COMMAND = 'codelark';
const PRIMARY_CODEX_SKILL_NAME = 'codelark';
const WINDOWS_HIDE = process.platform === 'win32' ? { windowsHide: true } : {};
const BRIDGE_START_LOCK_STALE_MS = 30_000;
const LARK_CLI_BIND_TIMEOUT_MS = 30_000;

function ensureDirs(): void {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(larkCliRuntimeDir, { recursive: true });
  fs.mkdirSync(larkCliBinDir, { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function readPid(filePath: string): number | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function collectTrackedBridgePids(
  bridgePid: number | undefined,
  statusPid: number | undefined,
  instanceLockPid?: number,
): number[] {
  const unique = new Set<number>();
  for (const pid of [bridgePid, statusPid, instanceLockPid]) {
    if (Number.isFinite(pid) && (pid as number) > 0) {
      unique.add(pid as number);
    }
  }
  return [...unique];
}

function resolveTrackedBridgePid(
  bridgePid: number | undefined,
  statusPid: number | undefined,
  instanceLockPid: number | undefined,
  isAlive: (pid?: number) => boolean = isProcessAlive,
): number | undefined {
  if (isAlive(bridgePid)) return bridgePid;
  if (isAlive(statusPid)) return statusPid;
  if (isAlive(instanceLockPid)) return instanceLockPid;
  return bridgePid ?? statusPid ?? instanceLockPid;
}

function getTrackedBridgePids(status?: BridgeStatus): number[] {
  const resolvedStatus = status ?? readJsonFile<BridgeStatus>(bridgeStatusFile, { running: false });
  return collectTrackedBridgePids(
    readPid(bridgePidFile),
    resolvedStatus.pid,
    readBridgeInstanceLock()?.pid,
  );
}

function clearBridgePidFile(): void {
  try {
    fs.unlinkSync(bridgePidFile);
  } catch {
    // ignore missing/stale pid file cleanup errors
  }
}

interface BridgeStartLock {
  pid: number;
  createdAt: string;
}

function readBridgeStartLock(filePath = bridgeStartLockFile): BridgeStartLock | null {
  const parsed = readJsonFile<Partial<BridgeStartLock> | null>(filePath, null);
  const pid = Number(parsed?.pid);
  const createdAt = typeof parsed?.createdAt === 'string' ? parsed.createdAt : '';
  if (!Number.isFinite(pid) || pid <= 0 || !createdAt) return null;
  return { pid, createdAt };
}

function isBridgeStartLockStale(
  lock: BridgeStartLock | null,
  options: {
    nowMs?: number;
    staleMs?: number;
    isAlive?: (pid?: number) => boolean;
  } = {},
): boolean {
  if (!lock) return true;
  const nowMs = options.nowMs ?? Date.now();
  const staleMs = options.staleMs ?? BRIDGE_START_LOCK_STALE_MS;
  const isAlive = options.isAlive ?? isProcessAlive;
  const createdAtMs = Date.parse(lock.createdAt);
  if (!Number.isFinite(createdAtMs)) return true;
  if (!isAlive(lock.pid)) return true;
  return nowMs - createdAtMs > staleMs;
}

function tryAcquireBridgeStartLock(
  options: {
    filePath?: string;
    ownerPid?: number;
    nowMs?: number;
    staleMs?: number;
    isAlive?: (pid?: number) => boolean;
  } = {},
): { acquired: boolean; holderPid?: number } {
  const filePath = options.filePath ?? bridgeStartLockFile;
  const ownerPid = options.ownerPid ?? process.pid;
  const nowMs = options.nowMs ?? Date.now();
  const payload: BridgeStartLock = {
    pid: ownerPid,
    createdAt: new Date(nowMs).toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', flag: 'wx' });
      return { acquired: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const existing = readBridgeStartLock(filePath);
      if (!isBridgeStartLockStale(existing, {
        nowMs,
        staleMs: options.staleMs,
        isAlive: options.isAlive,
      })) {
        return { acquired: false, holderPid: existing?.pid };
      }
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Another process may have already cleared or replaced the stale lock.
      }
    }
  }

  const existing = readBridgeStartLock(filePath);
  return { acquired: false, holderPid: existing?.pid };
}

function releaseBridgeStartLock(filePath = bridgeStartLockFile, ownerPid = process.pid): void {
  const existing = readBridgeStartLock(filePath);
  if (!existing) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore missing lock file
    }
    return;
  }
  if (existing.pid !== ownerPid) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore missing/stale lock cleanup errors
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCurrentWindowsUser(): string {
  const user = process.env.USERNAME || os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...WINDOWS_HIDE,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { code: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    timer = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, options.timeoutMs)
      : undefined;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', fail);
    child.on('close', (code) => {
      finish({
        code: timedOut ? 124 : code ?? 0,
        stdout,
        stderr: timedOut ? `${stderr}\nCommand timed out after ${options.timeoutMs}ms.` : stderr,
      });
    });
  });
}

async function runPowerShell(script: string): Promise<string> {
  const result = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
  );
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || 'PowerShell command failed.').trim());
  }
  return result.stdout.trim();
}

export async function ensureWindowsAdminSession(): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  const raw = await runPowerShell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
  if (raw.trim().toLowerCase() !== 'true') {
    throw new Error('请先以管理员身份打开 PowerShell 或终端，再执行开机自启动安装/卸载命令。');
  }
}

function ensureBridgeAutostartLauncher(): string {
  ensureDirs();
  const content = [
    "$ErrorActionPreference = 'Stop'",
    `$env:CODELARK_HOME = '${escapePowerShellSingleQuoted(CODELARK_HOME)}'`,
    `$cmd = Get-Command '${PRIMARY_CLI_COMMAND}.cmd' -ErrorAction SilentlyContinue`,
    `if (-not $cmd) { $cmd = Get-Command '${PRIMARY_CLI_COMMAND}' -ErrorAction SilentlyContinue }`,
    "$node = (Get-Command 'node' -ErrorAction Stop).Source",
    'if ($cmd) {',
    '  & $cmd.Source start',
    '  exit $LASTEXITCODE',
    '}',
    "$npm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue",
    "if (-not $npm) { $npm = Get-Command 'npm' -ErrorAction SilentlyContinue }",
    'if ($npm) {',
    '  try {',
    '    $globalRoot = (& $npm.Source root -g 2>$null).Trim()',
    '    if ($globalRoot) {',
    `      $cliPath = Join-Path (Join-Path $globalRoot '${PRIMARY_CLI_COMMAND}') 'dist\\cli.mjs'`,
    '      if (Test-Path $cliPath) {',
    '        & $node $cliPath start',
    '        exit $LASTEXITCODE',
    '      }',
    '    }',
    '  } catch { }',
    '}',
    `& $node '${escapePowerShellSingleQuoted(path.join(packageRoot, 'dist', 'cli.mjs'))}' start`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');

  fs.writeFileSync(bridgeAutostartLauncherFile, content, 'utf-8');
  return bridgeAutostartLauncherFile;
}

function parsePowerShellJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function buildBridgeAutostartStatusScript(): string {
  const taskNames = bridgeAutostartTaskNames
    .map((name) => `'${escapePowerShellSingleQuoted(name)}'`)
    .join(', ');
  return [
    `$taskNames = @(${taskNames})`,
    '$taskName = $null',
    '$task = $null',
    'foreach ($candidate in $taskNames) {',
    '  $candidateTask = Get-ScheduledTask -TaskName $candidate -ErrorAction SilentlyContinue',
    '  if ($candidateTask) {',
    '    $taskName = $candidate',
    '    $task = $candidateTask',
    '    break',
    '  }',
    '}',
    'if (-not $task) {',
    '  [pscustomobject]@{',
    '    supported = $true',
    '    installed = $false',
    '    enabled = $false',
    `    mode = 'startup'`,
    `    taskName = '${escapePowerShellSingleQuoted(primaryBridgeAutostartTaskName)}'`,
    `    launcherPath = '${escapePowerShellSingleQuoted(bridgeAutostartLauncherFile)}'`,
    '  } | ConvertTo-Json -Compress',
    '  exit 0',
    '}',
    '$info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue',
    '[pscustomobject]@{',
    '  supported = $true',
    '  installed = $true',
    '  enabled = [bool]$task.Settings.Enabled',
    `  mode = 'startup'`,
    '  taskName = $taskName',
    `  launcherPath = '${escapePowerShellSingleQuoted(bridgeAutostartLauncherFile)}'`,
    '  runAsUser = $task.Principal.UserId',
    '  state = [string]$task.State',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
}

function buildInstallBridgeAutostartScript(launcherPath: string, user: string, password: string): string {
  return [
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "${escapePowerShellSingleQuoted(launcherPath)}"'`,
    '$trigger = New-ScheduledTaskTrigger -AtStartup',
    '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
    `Register-ScheduledTask -TaskName '${escapePowerShellSingleQuoted(primaryBridgeAutostartTaskName)}' -Action $action -Trigger $trigger -Settings $settings -User '${escapePowerShellSingleQuoted(user)}' -Password '${escapePowerShellSingleQuoted(password)}' -RunLevel Limited -Force | Out-Null`,
  ].join('; ');
}

function buildUninstallBridgeAutostartScript(): string {
  const taskNames = bridgeAutostartTaskNames
    .map((name) => `'${escapePowerShellSingleQuoted(name)}'`)
    .join(', ');
  return [
    `$taskNames = @(${taskNames})`,
    'foreach ($taskName in $taskNames) {',
    '  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue',
    '  if ($task) {',
    '    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false',
    '  }',
    '}',
  ].join('; ');
}

export function buildDeferredGlobalNpmUninstallLaunch(options: {
  packageName?: string;
  logPath?: string;
  delayMs?: number;
  nodePath?: string;
  npmCommand?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
} = {}): DeferredGlobalNpmUninstallLaunch {
  const packageName = options.packageName || 'codelark';
  const logPath = options.logPath || npmUninstallLogFile;
  const delayMs = options.delayMs ?? 1500;
  const platform = options.platform || process.platform;
  const npmCommand = options.npmCommand || (platform === 'win32' ? 'npm.cmd' : 'npm');
  const command = options.nodePath || process.execPath;
  const cwd = options.cwd || os.homedir();
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const logPath = ${JSON.stringify(logPath)};`,
    `const npmCommand = ${JSON.stringify(npmCommand)};`,
    `const npmArgs = ['uninstall', '-g', ${JSON.stringify(packageName)}];`,
    `const childCwd = ${JSON.stringify(cwd)};`,
    `const delayMs = ${JSON.stringify(delayMs)};`,
    'const writeLog = (message) => {',
    "  try { fs.appendFileSync(logPath, String(message).endsWith('\\n') ? String(message) : String(message) + '\\n'); } catch {}",
    '};',
    'setTimeout(() => {',
    '  let fd;',
    "  try { fd = fs.openSync(logPath, 'a'); } catch (error) { writeLog(error); process.exit(1); return; }",
    "  const child = spawn(npmCommand, npmArgs, { cwd: childCwd, detached: false, stdio: ['ignore', fd, fd], windowsHide: true });",
    '  child.on(\'error\', (error) => { writeLog(error); process.exit(1); });',
    "  child.on('close', (code) => { process.exit(typeof code === 'number' ? code : 0); });",
    '}, delayMs);',
  ].join('\n');

  return {
    command,
    args: ['-e', script],
    npmCommand,
    logPath,
    delayMs,
  };
}

async function launchDeferredGlobalNpmUninstall(): Promise<DeferredGlobalNpmUninstallLaunch> {
  ensureDirs();
  const launch = buildDeferredGlobalNpmUninstallLaunch();
  // The current CLI process still lives inside the global package directory, so
  // npm uninstall has to run from a detached follow-up process after this command exits.
  fs.writeFileSync(
    launch.logPath,
    [
      `[${new Date().toISOString()}] Scheduling global uninstall.`,
      `${launch.npmCommand} uninstall -g codelark`,
      '',
    ].join('\n'),
    'utf-8',
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: os.homedir(),
      detached: true,
      stdio: 'ignore',
      ...WINDOWS_HIDE,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

  return launch;
}

export function getPackageRoot(): string {
  return packageRoot;
}

export function getUiServerUrl(port = uiPort): string {
  return `http://127.0.0.1:${port}`;
}

export function getCurrentUiServerUrl(): string | undefined {
  const status = readJsonFile<UiServerStatus | null>(uiStatusFile, null);
  if (!status?.port) return undefined;
  return getUiServerUrl(status.port);
}

export function getBridgeStatus(): BridgeStatus {
  const status = readJsonFile<BridgeStatus>(bridgeStatusFile, { running: false });
  const pid = resolveTrackedBridgePid(
    readPid(bridgePidFile),
    status.pid,
    readBridgeInstanceLock()?.pid,
  );
  if (!isProcessAlive(pid)) {
    return {
      ...status,
      pid,
      running: false,
    };
  }
  return {
    ...status,
    pid,
    running: true,
  };
}

export function getUiServerStatus(): UiServerStatus {
  const status = readJsonFile<UiServerStatus>(uiStatusFile, { running: false, port: uiPort });
  if (!isProcessAlive(status.pid)) {
    return {
      ...status,
      running: false,
      port: status.port ?? uiPort,
    };
  }
  return {
    ...status,
    running: true,
    port: status.port ?? uiPort,
  };
}

export interface StartupConfigProjection {
  config: ConfigV2;
}

export interface ServiceConfigOverrideOptions {
  cli?: ConfigPatch;
  startupProjection?: StartupConfigProjection;
}

export interface LarkCliRuntimeConfigOptions {
  allowUserAuthorization?: boolean;
}

function hasConfigPatchValues(patch: ConfigPatch | undefined): boolean {
  if (!patch) return false;
  return Object.keys(patch).length > 0;
}

type LocalServiceChannelConfig = Pick<FeishuChannelConfig, 'appId' | 'appSecret' | 'site'>;

interface LocalServiceChannel {
  id?: string;
  alias?: string;
  provider?: string;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
  config?: LocalServiceChannelConfig;
}

interface LocalServiceConfig {
  channels?: LocalServiceChannel[];
}

export function loadStartupProjection(options: ServiceConfigOverrideOptions = {}): StartupConfigProjection {
  const service = createConfigService({
    codelarkHome: CODELARK_HOME,
    ...(hasConfigPatchValues(options.cli) ? { cli: options.cli } : {}),
  });
  return {
    config: service.snapshot().config,
  };
}

function startupProjectionFor(options: ServiceConfigOverrideOptions = {}): StartupConfigProjection {
  return options.startupProjection || loadStartupProjection(options);
}

function loadStartupConfig(options: ServiceConfigOverrideOptions = {}): ConfigV2 {
  return startupProjectionFor(options).config;
}

function buildDaemonEnv(
  _options: ServiceConfigOverrideOptions = {},
): NodeJS.ProcessEnv {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  const legacyEnvPrefix = ['C', 'T', 'I'].join('');
  for (const key of Object.keys(env)) {
    if (key === `${legacyEnvPrefix}_HOME` || key.startsWith(`${legacyEnvPrefix}_`)) delete env[key];
  }
  delete env.CLAUDECODE;
  Object.assign(env, buildLarkCliRuntimeEnv());
  const shimDir = ensureLarkCliShim();
  env.PATH = prependPathEntry(env.PATH, shimDir);
  return env;
}

function buildUiServerEnv(
  _options: ServiceConfigOverrideOptions = {},
): NodeJS.ProcessEnv {
  return { ...process.env } as NodeJS.ProcessEnv;
}

export function buildLarkCliRuntimeEnv(): NodeJS.ProcessEnv {
  return {
    LARK_CHANNEL: '1',
    LARK_CHANNEL_HOME: CODELARK_HOME,
    LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
    LARKSUITE_CLI_CONFIG_DIR: larkCliRuntimeDir,
  };
}

function prependPathEntry(pathValue: string | undefined, entry: string): string {
  const delimiter = path.delimiter;
  const parts = (pathValue || '').split(delimiter).filter(Boolean);
  const withoutEntry = parts.filter((part) => path.resolve(part) !== path.resolve(entry));
  return [entry, ...withoutEntry].join(delimiter);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function ensureLarkCliShim(): string {
  ensureDirs();
  const script = resolveLarkCliScript();
  if (!script) return larkCliBinDir;

  if (process.platform === 'win32') {
    const cmdPath = path.join(larkCliBinDir, 'lark-cli.cmd');
    fs.writeFileSync(
      cmdPath,
      [
        '@echo off',
        `"${process.execPath}" "${script}" %*`,
        '',
      ].join('\r\n'),
      'utf-8',
    );
    return larkCliBinDir;
  }

  const shimPath = path.join(larkCliBinDir, 'lark-cli');
  fs.writeFileSync(
    shimPath,
    [
      '#!/bin/sh',
      `exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(script)} "$@"`,
      '',
    ].join('\n'),
    { encoding: 'utf-8', mode: 0o755 },
  );
  try {
    fs.chmodSync(shimPath, 0o755);
  } catch {
    // Best effort for filesystems that ignore chmod.
  }
  return larkCliBinDir;
}

function findPrimaryFeishuChannel(config: LocalServiceConfig): LocalServiceChannel | undefined {
  const channels = config.channels || [];
  return channels.find((channel) => channel.provider === 'feishu' && channel.enabled !== false)
    || channels.find((channel) => channel.provider === 'feishu');
}

function getFeishuCredentials(config: LocalServiceConfig): Required<Pick<FeishuChannelConfig, 'appId' | 'appSecret' | 'site'>> | null {
  const channel = findPrimaryFeishuChannel(config);
  const feishu = channel?.config;
  const appId = feishu?.appId?.trim();
  const appSecret = feishu?.appSecret?.trim();
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    site: normalizeFeishuSite(feishu?.site),
  };
}

function isSameFeishuApp(app: { appId?: unknown; brand?: unknown } | undefined, config: LocalServiceConfig): boolean {
  const credentials = getFeishuCredentials(config);
  if (!credentials || !app) return false;
  return app.appId === credentials.appId && app.brand === credentials.site;
}

function writeLarkCliSourceProjection(config: LocalServiceConfig): string | null {
  const credentials = getFeishuCredentials(config);
  if (!credentials) return null;
  fs.mkdirSync(larkCliSourceDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(larkCliSourceDir, 0o700);
  } catch {
    // Best-effort hardening; Windows and some file systems may ignore chmod.
  }

  const projection = {
    accounts: {
      app: {
        id: credentials.appId,
        secret: credentials.appSecret,
        tenant: credentials.site,
      },
    },
  };
  const tmpPath = `${larkCliSourceConfigFile}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, larkCliSourceConfigFile);
  return larkCliSourceConfigFile;
}

function isLarkCliKeychainFailure(output: string): boolean {
  return /keychain (?:Get |Set |access |unavailable|not initialized|is corrupted)|use file: reference in config to bypass keychain/i.test(output);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function structuredLarkCliUsers(users: unknown): unknown[] | null {
  if (!Array.isArray(users)) return null;
  const structured = users.filter((user) => user && typeof user === 'object');
  return structured.length > 0 ? structured : null;
}

function cloneLarkCliUsers(users: unknown[] | null): unknown[] | null {
  if (!users) return null;
  return JSON.parse(JSON.stringify(users)) as unknown[];
}

function readTargetLarkCliApp(config: LocalServiceConfig): {
  raw: Record<string, unknown>;
  app: Record<string, unknown>;
} | null {
  const raw = readJsonObject(larkCliTargetConfigFile);
  const apps = Array.isArray(raw?.apps) ? raw.apps : [];
  const matches = apps.filter((candidate) => (
    candidate && typeof candidate === 'object' && isSameFeishuApp(candidate as { appId?: unknown; brand?: unknown }, config)
  ));
  const app = matches.find((candidate) => (
    candidate && typeof candidate === 'object' && structuredLarkCliUsers((candidate as Record<string, unknown>).users)
  )) || matches.find((candidate) => (
    candidate && typeof candidate === 'object'
    && (candidate as Record<string, unknown>).strictMode !== 'bot'
    && (candidate as Record<string, unknown>).defaultAs !== 'bot'
  )) || matches[0];
  return raw && app && typeof app === 'object'
    ? { raw, app: app as Record<string, unknown> }
    : null;
}

function writePlainLarkCliTargetProjection(config: LocalServiceConfig): boolean {
  const credentials = getFeishuCredentials(config);
  if (!credentials) return false;
  fs.mkdirSync(path.dirname(larkCliTargetConfigFile), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(larkCliRuntimeDir, 0o700);
    fs.chmodSync(path.dirname(larkCliTargetConfigFile), 0o700);
  } catch {
    // Best-effort hardening; Windows and some file systems may ignore chmod.
  }

  const raw = readJsonObject(larkCliTargetConfigFile) || {};
  const existingApps = Array.isArray(raw.apps) ? raw.apps : [];
  const existing = readTargetLarkCliApp(config)?.app;
  const replacement: Record<string, unknown> = {
    ...(existing || {}),
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    brand: credentials.site,
  };
  const apps = [
    ...existingApps.filter((candidate) => !(
      candidate && typeof candidate === 'object'
      && isSameFeishuApp(candidate as { appId?: unknown; brand?: unknown }, config)
    )),
    replacement,
  ];
  const next = { ...raw, apps };
  const tmpPath = `${larkCliTargetConfigFile}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, larkCliTargetConfigFile);
  return true;
}

function hasTargetLarkCliUsers(config: LocalServiceConfig): boolean {
  const target = readTargetLarkCliApp(config);
  if (!target) return false;
  return Boolean(structuredLarkCliUsers(target.app.users));
}

function snapshotTargetLarkCliUsers(config: LocalServiceConfig): unknown[] | null {
  return cloneLarkCliUsers(structuredLarkCliUsers(readTargetLarkCliApp(config)?.app.users));
}

function restoreTargetLarkCliUsers(config: LocalServiceConfig, users: unknown[] | null): boolean {
  const cloned = cloneLarkCliUsers(users);
  if (!cloned) return false;
  const target = readTargetLarkCliApp(config);
  if (!target) return false;
  target.app.users = cloned;
  const tmpPath = `${larkCliTargetConfigFile}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(target.raw, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, larkCliTargetConfigFile);
  return true;
}

function hasLegacyStrictLarkCliRuntime(config: LocalServiceConfig): boolean {
  const target = readTargetLarkCliApp(config);
  if (!target) return false;
  return target.app.strictMode === 'bot' || target.app.defaultAs === 'bot';
}

export function resetLegacyStrictLarkCliRuntimeForSetup(config: LocalServiceConfig = loadStartupConfig()): boolean {
  // 旧版 setup 会把私有 lark-cli workspace 绑定成 bot-only。
  // 这个策略会在 OAuth 成功后继续拒绝显式 `--as user` 命令，
  // 所以下一次交互式 setup 必须从头重建隔离 runtime。
  if (!hasLegacyStrictLarkCliRuntime(config)) return false;
  fs.rmSync(larkCliRuntimeDir, { recursive: true, force: true });
  return true;
}

function larkCliIdentityPolicyCommands(hasUser: boolean, options: LarkCliRuntimeConfigOptions = {}): string[][] {
  void hasUser;
  void options;
  // Setup explicitly asks the user to authorize CodeLark's private lark-cli
  // runtime. Bridge startup must preserve that user-capable policy; when no
  // user token exists, lark-cli should report that naturally instead of strict
  // mode rejecting --as user before auth can be diagnosed.
  return [
    ['config', 'strict-mode', 'off'],
    ['config', 'default-as', 'auto'],
  ];
}

export async function applyLarkCliRuntimeIdentityPolicy(
  hasUser: boolean,
  options: LarkCliRuntimeConfigOptions = {},
  config: LocalServiceConfig = loadStartupConfig(),
): Promise<string | undefined> {
  const env = buildLarkCliRuntimeEnv();
  const preservedUsers = snapshotTargetLarkCliUsers(config);
  for (const args of larkCliIdentityPolicyCommands(hasUser, options)) {
    const result = await runBundledLarkCli(args, env);
    if (result.code !== 0) {
      restoreTargetLarkCliUsers(config, preservedUsers);
      return formatLarkCliFailure(args, result);
    }
  }
  restoreTargetLarkCliUsers(config, preservedUsers);
  return undefined;
}

function resolveLarkCliScript(): string | null {
  try {
    return require.resolve('@larksuite/cli/scripts/run.js');
  } catch {
    return null;
  }
}

function formatLarkCliFailure(command: string[], result: { code: number; stdout: string; stderr: string }): string {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return [
    `lark-cli ${command.join(' ')} failed with exit code ${result.code}.`,
    output ? output.split(/\r?\n/).slice(-20).join('\n') : 'No output.',
  ].join('\n');
}

async function runBundledLarkCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = resolveLarkCliScript();
  if (!script) {
    return {
      code: 127,
      stdout: '',
      stderr: 'Bundled @larksuite/cli entry script was not found.',
    };
  }
  return runCommand(process.execPath, [script, ...args], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ...env,
      CODELARK_HOME,
    },
    timeoutMs: LARK_CLI_BIND_TIMEOUT_MS,
  });
}

export async function ensureLarkCliRuntimeConfig(
  config: LocalServiceConfig = loadStartupConfig(),
  options: LarkCliRuntimeConfigOptions = {},
): Promise<{
  ready: boolean;
  skipped: boolean;
  sourceConfigFile?: string;
  configDir: string;
  warning?: string;
}> {
  ensureDirs();
  const sourceConfigFile = writeLarkCliSourceProjection(config);
  if (!sourceConfigFile) {
    return {
      ready: false,
      skipped: true,
      configDir: larkCliRuntimeDir,
      warning: '未找到完整飞书/Lark App ID 和 App Secret，已跳过 lark-cli 运行环境初始化。',
    };
  }

  const env = buildLarkCliRuntimeEnv();
  // setup 随后就会申请用户 OAuth，所以 bind 阶段使用允许用户身份的预设。
  // 如果当前还没有 user，再在下面临时收紧到 bot，避免永久把 workspace 锁死到 bot-only。
  const bindArgs = ['config', 'bind', '--source', 'lark-channel', '--identity', 'user-default', '--force'];
  const preservedUsers = snapshotTargetLarkCliUsers(config);
  const bind = await runBundledLarkCli(bindArgs, env);
  if (bind.code !== 0) {
    const warning = formatLarkCliFailure(bindArgs, bind);
    if (!isLarkCliKeychainFailure(warning) || !writePlainLarkCliTargetProjection(config)) {
      restoreTargetLarkCliUsers(config, preservedUsers);
      return {
        ready: false,
        skipped: false,
        sourceConfigFile,
        configDir: larkCliRuntimeDir,
        warning,
      };
    }
  }
  restoreTargetLarkCliUsers(config, preservedUsers);

  const policyWarning = await applyLarkCliRuntimeIdentityPolicy(hasTargetLarkCliUsers(config), options, config);
  if (policyWarning) {
    return {
      ready: false,
      skipped: false,
      sourceConfigFile,
      configDir: larkCliRuntimeDir,
      warning: policyWarning,
    };
  }

  const verify = await runBundledLarkCli(['config', 'show'], env);
  if (verify.code !== 0) {
    return {
      ready: false,
      skipped: false,
      sourceConfigFile,
      configDir: larkCliRuntimeDir,
      warning: formatLarkCliFailure(['config', 'show'], verify),
    };
  }

  return {
    ready: true,
    skipped: false,
    sourceConfigFile,
    configDir: larkCliRuntimeDir,
  };
}

function describeBridgeStartupPreflightFailure(channels: LocalServiceChannel[] | undefined): string | null {
  const configured = Array.isArray(channels) ? channels : [];
  if (configured.length === 0) {
    return '未配置任何通道实例。请先使用`codelark run`创建并保存至少一个飞书通道，然后再启动桥接服务。';
  }

  const enabled = configured.filter((channel) => channel.enabled !== false);
  if (enabled.length === 0) {
    return '当前所有通道实例都已禁用。请先启用至少一个通道实例，然后再启动桥接服务。';
  }

  return null;
}

function describeBridgeActivationFailure(
  status: BridgeStatus,
  channels: LocalServiceChannel[] | undefined,
): string | null {
  const statusReason = status.lastExitReason?.trim();
  if (statusReason) return statusReason;

  const preflightFailure = describeBridgeStartupPreflightFailure(channels);
  if (preflightFailure) return preflightFailure;

  const enabled = (channels || []).filter((channel) => channel.enabled !== false);
  if (enabled.length === 0) return null;

  const labels = enabled.map((channel) => channel.alias?.trim() || channel.id).join('、');
  return `没有任何通道适配器启动成功。请检查通道配置、凭据和日志。当前已启用通道：${labels}`;
}

async function waitForBridgeRunning(timeoutMs = 20_000): Promise<BridgeStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = getBridgeStatus();
    if (status.running) return status;
    await sleep(500);
  }
  return getBridgeStatus();
}

async function waitForBridgeStartupTurn(timeoutMs = 20_000): Promise<BridgeStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = getBridgeStatus();
    if (status.running) return status;

    const lock = readBridgeStartLock();
    if (!lock) return status;
    if (isBridgeStartLockStale(lock)) {
      releaseBridgeStartLock();
      return getBridgeStatus();
    }

    await sleep(300);
  }
  return getBridgeStatus();
}

async function waitForUiServer(timeoutMs = 15_000): Promise<UiServerStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = getUiServerStatus();
    if (status.running) {
      try {
        const response = await fetch(`${getUiServerUrl(status.port)}/api/ping`);
        if (response.ok) return status;
      } catch {
        // server not ready yet
      }
    }
    await sleep(300);
  }
  return getUiServerStatus();
}

export async function startBridge(options: ServiceConfigOverrideOptions = {}): Promise<BridgeStatus> {
  ensureDirs();
  // Creating the startup projection runs config migrations. Do this before
  // the already-running fast path so `codelark start` still upgrades legacy config.
  const startup = startupProjectionFor(options);
  const config = startup.config;
  const current = getBridgeStatus();
  const extraAlivePids = getTrackedBridgePids(current)
    .filter((pid) => pid !== current.pid && isProcessAlive(pid));
  if (current.running && extraAlivePids.length === 0) return current;
  if (current.running && extraAlivePids.length > 0) {
    await stopBridge();
  }

  const preflightFailure = describeBridgeStartupPreflightFailure(config.channels);
  if (preflightFailure) {
    throw new Error(preflightFailure);
  }

  let startLockHeld = false;
  let lockState = tryAcquireBridgeStartLock();
  if (!lockState.acquired) {
    const status = await waitForBridgeStartupTurn();
    if (status.running) return status;

    lockState = tryAcquireBridgeStartLock();
    if (!lockState.acquired) {
      throw new Error(
        describeBridgeActivationFailure(status, config.channels)
        || `另一个桥接服务启动请求仍在进行中（PID: ${lockState.holderPid || 'unknown'}）。请稍后重试。`,
      );
    }
  }
  startLockHeld = true;

  try {
    const currentAfterLock = getBridgeStatus();
    const extraAlivePidsAfterLock = getTrackedBridgePids(currentAfterLock)
      .filter((pid) => pid !== currentAfterLock.pid && isProcessAlive(pid));
    if (currentAfterLock.running && extraAlivePidsAfterLock.length === 0) return currentAfterLock;
    if (currentAfterLock.running && extraAlivePidsAfterLock.length > 0) {
      await stopBridge();
    }

    const daemonEntry = path.join(packageRoot, 'dist', 'daemon.mjs');
    if (!fs.existsSync(daemonEntry)) {
      throw new Error(`Daemon bundle not found at ${daemonEntry}. Run npm run build first.`);
    }

    const larkCliRuntime = await ensureLarkCliRuntimeConfig(config);
    if (larkCliRuntime.warning) {
      console.warn(`[CodeLark] ${larkCliRuntime.warning}`);
    }

    const stdoutFd = fs.openSync(path.join(logsDir, 'bridge-launcher.out.log'), 'a');
    const stderrFd = fs.openSync(path.join(logsDir, 'bridge-launcher.err.log'), 'a');

    const child = spawn(process.execPath, [daemonEntry], {
      cwd: packageRoot,
      detached: true,
      env: buildDaemonEnv(options),
      stdio: ['ignore', stdoutFd, stderrFd],
      ...WINDOWS_HIDE,
    });
    child.unref();

    const status = await waitForBridgeRunning();
    if (!status.running) {
      throw new Error(
        describeBridgeActivationFailure(status, config.channels)
        || 'Bridge failed to report running=true.',
      );
    }
    return status;
  } finally {
    if (startLockHeld) {
      releaseBridgeStartLock();
    }
  }
}

export async function stopBridge(): Promise<BridgeStatus> {
  const status = readJsonFile<BridgeStatus>(bridgeStatusFile, { running: false });
  const pids = getTrackedBridgePids(status).filter((pid) => isProcessAlive(pid));
  if (pids.length === 0) {
    clearBridgePidFile();
    clearStaleBridgeInstanceLock();
    return { ...getBridgeStatus(), running: false };
  }

  for (const pid of pids) {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('cmd', ['/c', 'taskkill', '/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          ...WINDOWS_HIDE,
        });
        killer.on('exit', () => resolve());
        killer.on('error', () => resolve());
      });
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      clearBridgePidFile();
      clearStaleBridgeInstanceLock();
      return getBridgeStatus();
    }
    await sleep(300);
  }

  clearBridgePidFile();
  clearStaleBridgeInstanceLock();
  return getBridgeStatus();
}

export const _testOnly = {
  collectTrackedBridgePids,
  resolveTrackedBridgePid,
  describeBridgeStartupPreflightFailure,
  describeBridgeActivationFailure,
  readBridgeStartLock,
  isBridgeStartLockStale,
  tryAcquireBridgeStartLock,
  releaseBridgeStartLock,
  readBridgeInstanceLock,
  releaseBridgeInstanceLock,
  clearStaleBridgeInstanceLock,
  buildDaemonEnv,
  buildUiServerEnv,
  loadStartupProjection,
  loadStartupConfig,
  applyLarkCliRuntimeIdentityPolicy,
  buildLarkCliRuntimeEnv,
  ensureLarkCliShim,
  isLarkCliKeychainFailure,
  prependPathEntry,
  writeLarkCliSourceProjection,
  writePlainLarkCliTargetProjection,
  hasTargetLarkCliUsers,
  hasLegacyStrictLarkCliRuntime,
  snapshotTargetLarkCliUsers,
  restoreTargetLarkCliUsers,
  larkCliIdentityPolicyCommands,
  resetLegacyStrictLarkCliRuntimeForSetup,
  readTargetLarkCliApp,
  primaryBridgeAutostartTaskName,
  buildBridgeAutostartStatusScript,
  buildInstallBridgeAutostartScript,
  buildUninstallBridgeAutostartScript,
};

export async function restartBridge(): Promise<BridgeStatus> {
  await stopBridge();
  return await startBridge();
}

export async function getBridgeAutostartStatus(): Promise<BridgeAutostartStatus> {
  const base: BridgeAutostartStatus = {
    supported: process.platform === 'win32',
    installed: false,
    enabled: false,
    mode: 'startup',
    taskName: primaryBridgeAutostartTaskName,
    runAsUser: process.platform === 'win32' ? getCurrentWindowsUser() : undefined,
    launcherPath: bridgeAutostartLauncherFile,
  };
  if (process.platform !== 'win32') {
    return {
      ...base,
      error: '当前只支持 Windows 自动启动。',
    };
  }

  try {
    const raw = await runPowerShell(buildBridgeAutostartStatusScript());
    return {
      ...base,
      ...parsePowerShellJson<BridgeAutostartStatus>(raw),
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installBridgeAutostart(password: string): Promise<BridgeAutostartStatus> {
  if (process.platform !== 'win32') {
    throw new Error('当前只支持 Windows 自动启动。');
  }
  if (!password) {
    throw new Error('当前 Windows 登录密码不能为空。');
  }

  await ensureWindowsAdminSession();

  const launcherPath = ensureBridgeAutostartLauncher();
  const user = getCurrentWindowsUser();
  await runPowerShell(buildInstallBridgeAutostartScript(launcherPath, user, password));
  return await getBridgeAutostartStatus();
}

export async function uninstallBridgeAutostart(): Promise<BridgeAutostartStatus> {
  if (process.platform !== 'win32') {
    return await getBridgeAutostartStatus();
  }

  await ensureWindowsAdminSession();

  await runPowerShell(buildUninstallBridgeAutostartScript());
  try {
    if (fs.existsSync(bridgeAutostartLauncherFile)) {
      fs.unlinkSync(bridgeAutostartLauncherFile);
    }
  } catch {
    // ignore launcher cleanup failure
  }
  return await getBridgeAutostartStatus();
}

export async function uninstallCodelarkPackage(): Promise<PackageUninstallResult> {
  const autostartBefore = await getBridgeAutostartStatus();
  if (process.platform === 'win32' && autostartBefore.installed) {
    await ensureWindowsAdminSession();
  }

  const ui = await stopUiServer();
  const bridge = await stopBridge();
  const autostart = autostartBefore.installed
    ? await uninstallBridgeAutostart()
    : autostartBefore;

  if (autostart.installed) {
    throw new Error(`未能删除开机自启动任务 ${autostart.taskName}，已取消 npm 全局卸载。`);
  }

  const launch = await launchDeferredGlobalNpmUninstall();
  return {
    ui,
    bridge,
    autostart,
    npmCommand: launch.npmCommand,
    logPath: launch.logPath,
    scheduled: true,
  };
}

export function getBridgeLogs(lines = 200): string {
  ensureDirs();
  const filePath = path.join(logsDir, 'bridge.log');
  if (!fs.existsSync(filePath)) return '';
  const all = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

export async function ensureUiServerRunning(options: ServiceConfigOverrideOptions = {}): Promise<UiServerStatus> {
  ensureDirs();
  const current = getUiServerStatus();
  if (current.running) return current;

  const serverEntry = path.join(packageRoot, 'dist', 'ui-server.mjs');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`UI server bundle not found at ${serverEntry}. Run npm run build first.`);
  }

  const stdoutFd = fs.openSync(path.join(logsDir, 'ui-server.out.log'), 'a');
  const stderrFd = fs.openSync(path.join(logsDir, 'ui-server.err.log'), 'a');

  const child = spawn(process.execPath, [serverEntry], {
    cwd: packageRoot,
    detached: true,
    env: buildUiServerEnv(options),
    stdio: ['ignore', stdoutFd, stderrFd],
    ...WINDOWS_HIDE,
  });
  child.unref();

  const status = await waitForUiServer();
  if (!status.running) {
    throw new Error('UI server failed to start.');
  }
  return status;
}

export async function stopUiServer(): Promise<UiServerStatus> {
  const status = getUiServerStatus();
  if (!status.pid || !isProcessAlive(status.pid)) {
    const next = { ...status, running: false };
    writeUiServerStatus(next);
    return next;
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('cmd', ['/c', 'taskkill', '/PID', String(status.pid), '/T', '/F'], {
        stdio: 'ignore',
        ...WINDOWS_HIDE,
      });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    });
  } else {
    try {
      process.kill(status.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const next = getUiServerStatus();
    if (!next.running) {
      writeUiServerStatus({ ...next, running: false });
      return { ...next, running: false };
    }
    await sleep(300);
  }

  const next = getUiServerStatus();
  if (!next.running) {
    writeUiServerStatus({ ...next, running: false });
  }
  return next;
}

export function writeUiServerStatus(status: UiServerStatus): void {
  ensureDirs();
  fs.writeFileSync(uiStatusFile, JSON.stringify(status, null, 2), 'utf-8');
}

export type CodexIntegrationInstallMethod = 'junction' | 'copy' | 'existing';
export type ExternalSkillInstallMethod = 'npx';

export interface CodexIntegrationSkillInstallResult {
  name: string;
  targetDir: string;
  method: CodexIntegrationInstallMethod;
}

export interface ExternalSkillInstallResult {
  name: string;
  command: string;
  args: string[];
  method: ExternalSkillInstallMethod;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface CodexIntegrationInstallResult extends CodexIntegrationSkillInstallResult {
  skills: CodexIntegrationSkillInstallResult[];
  externalSkills: ExternalSkillInstallResult[];
}

export interface BundledCodexSkill {
  name: string;
  label: string;
  description: string;
  sourceDir: string;
  linkPackageRoot?: boolean;
}

export interface InstallCodexIntegrationOptions {
  skillNames?: string[];
  externalSkillRunner?: (command: string, args: string[]) => Promise<ExternalSkillInstallResult>;
  skipExternalSkills?: boolean;
}

export const BUNDLED_CODEX_SKILLS: BundledCodexSkill[] = [
  {
    name: PRIMARY_CODEX_SKILL_NAME,
    label: '附件回传',
    description: '让 Codex 在需要时把本地图片或文件发送回当前 IM 会话。',
    sourceDir: path.join(packageRoot, 'skills', PRIMARY_CODEX_SKILL_NAME),
  },
  {
    name: 'codelark-question',
    label: '问题卡片',
    description: '让 Codex 在需要用户确认或选择时显式输出 CodeLark 问题卡片。',
    sourceDir: path.join(packageRoot, 'skills', 'codelark-question'),
  },
];

export interface ExternalSkillDefinition {
  name: string;
  label: string;
  description: string;
  command: string;
  args: string[];
}

function npxCommand(): string {
  const name = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const besideNode = path.join(path.dirname(process.execPath), name);
  return fs.existsSync(besideNode) ? besideNode : name;
}

export const OFFICIAL_LARK_DOC_SKILL: ExternalSkillDefinition = {
  name: 'lark-doc',
  label: '官方 Lark 文档 Skill',
  description: '使用 Lark 官方 skills 包提供的 lark-doc。',
  command: npxCommand(),
  args: ['skills', 'add', 'larksuite/cli', '-s', 'lark-doc', '-y', '-g', '-a', 'claude-code'],
};

export const INSTALLABLE_SKILLS = [
  ...BUNDLED_CODEX_SKILLS,
  OFFICIAL_LARK_DOC_SKILL,
] as const;

const REQUIRED_CODEX_SKILL_NAMES = [
  PRIMARY_CODEX_SKILL_NAME,
  'codelark-question',
] as const;

function codexHomeDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function copySkillSource(sourceDir: string, targetDir: string): void {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(sourceDir, source);
      if (!relative) return true;
      if (relative === '.git' || relative.startsWith(`.git${path.sep}`)) return false;
      if (relative === 'node_modules' || relative.startsWith(`node_modules${path.sep}`)) return false;
      return true;
    },
  });
}

function installBundledCodexSkill(skill: BundledCodexSkill): CodexIntegrationSkillInstallResult {
  const skillFile = path.join(skill.sourceDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    throw new Error(`SKILL.md not found at ${skillFile}`);
  }

  const skillsDir = path.join(codexHomeDir(), 'skills');
  const targetDir = path.join(skillsDir, skill.name);
  fs.mkdirSync(skillsDir, { recursive: true });

  if (fs.existsSync(path.join(targetDir, 'SKILL.md'))) {
    return { name: skill.name, targetDir, method: 'existing' };
  }

  if (skill.linkPackageRoot) {
    try {
      fs.symlinkSync(skill.sourceDir, targetDir, process.platform === 'win32' ? 'junction' : 'dir');
      return { name: skill.name, targetDir, method: 'junction' };
    } catch {
      copySkillSource(skill.sourceDir, targetDir);
      return { name: skill.name, targetDir, method: 'copy' };
    }
  }

  copySkillSource(skill.sourceDir, targetDir);
  return { name: skill.name, targetDir, method: 'copy' };
}

function runExternalSkillInstall(command: string, args: string[]): Promise<ExternalSkillInstallResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      const result: ExternalSkillInstallResult = {
        name: OFFICIAL_LARK_DOC_SKILL.name,
        command,
        args,
        method: 'npx',
        exitCode,
        stdout,
        stderr,
      };
      if (exitCode === 0) {
        resolve(result);
      } else {
        const message = stderr.trim() || stdout.trim() || `${command} exited with code ${exitCode}`;
        const error = new Error(`Official Lark skill install failed: ${message}`);
        Object.assign(error, { result });
        reject(error);
      }
    });
  });
}

export async function installCodexIntegration(options: InstallCodexIntegrationOptions = {}): Promise<CodexIntegrationInstallResult> {
  const selectedNames = options.skillNames || INSTALLABLE_SKILLS.map((skill) => skill.name);
  const knownNames = new Set(INSTALLABLE_SKILLS.map((skill) => skill.name));
  const unknownNames = selectedNames.filter((name) => !knownNames.has(name));
  if (unknownNames.length > 0) {
    throw new Error(`Unknown CodeLark skill(s): ${unknownNames.join(', ')}`);
  }
  if (selectedNames.length === 0) {
    throw new Error('At least one CodeLark skill must be selected for installation.');
  }

  const selectedNameSet = new Set(selectedNames);
  const skills = BUNDLED_CODEX_SKILLS
    .filter((skill) => selectedNameSet.has(skill.name))
    .map(installBundledCodexSkill);
  const externalSkills = selectedNameSet.has(OFFICIAL_LARK_DOC_SKILL.name) && !options.skipExternalSkills
    ? [await (options.externalSkillRunner || runExternalSkillInstall)(
      OFFICIAL_LARK_DOC_SKILL.command,
      OFFICIAL_LARK_DOC_SKILL.args,
    )]
    : [];
  const primary = skills[0];
  return {
    name: primary?.name || externalSkills[0]?.name || OFFICIAL_LARK_DOC_SKILL.name,
    targetDir: primary?.targetDir || '',
    method: primary?.method || 'existing',
    skills,
    externalSkills,
  };
}

export function isCodexIntegrationInstalled(): boolean {
  return REQUIRED_CODEX_SKILL_NAMES.every((name) => (
    fs.existsSync(path.join(codexHomeDir(), 'skills', name, 'SKILL.md'))
  ));
}

export function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', ...WINDOWS_HIDE });
    child.on('error', () => {});
    child.unref();
    return;
  }
  if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return;
  }
  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
