import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ResolveCodexCliExecutableOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fileExists?: (filePath: string) => boolean;
}

export interface ResolveCliExecutableOptions extends ResolveCodexCliExecutableOptions {
  command: string;
  overrideEnvVar?: string;
}

function defaultExecutableExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readSmallTextFile(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 64 * 1024) return '';
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function isHomeRelativeCodexWrapper(filePath: string): boolean {
  const content = readSmallTextFile(filePath);
  return content.includes('HOME/.local/lib/node_modules/@openai/codex/bin/codex.js');
}

function codexCliJsPathForHome(home: string): string {
  return path.join(home, '.local', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function findNode24ForHome(home: string, fileExists: (filePath: string) => boolean): string | null {
  const versionsDir = path.join(home, '.nvm', 'versions', 'node');
  let entries: string[];
  try {
    entries = fs.readdirSync(versionsDir);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => /^v24\./.test(entry))
    .sort()
    .map((entry) => path.join(versionsDir, entry, 'bin', 'node'))
    .filter(fileExists);
  return candidates.at(-1) || null;
}

function materializeCodexWrapperShim(nodePath: string, codexJsPath: string): string {
  const hash = crypto.createHash('sha256').update(`${nodePath}\n${codexJsPath}`).digest('hex').slice(0, 16);
  const shimDir = path.join(os.tmpdir(), 'codelark-codex-shims');
  const shimPath = path.join(shimDir, `codelark-codex-${hash}.sh`);
  const content = [
    '#!/usr/bin/env sh',
    `exec ${shellQuote(nodePath)} ${shellQuote(codexJsPath)} "$@"`,
    '',
  ].join('\n');
  fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(shimDir, 0o700);
  try {
    if (fs.readFileSync(shimPath, 'utf-8') === content) return shimPath;
  } catch {
    // create below
  }
  fs.writeFileSync(shimPath, content, { encoding: 'utf-8', mode: 0o755 });
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function pathModuleForPlatform(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function executableNames(command: string, platform: NodeJS.Platform): string[] {
  const trimmed = command.trim();
  if (!trimmed) return [];
  if (platform !== 'win32') return [trimmed];
  const lower = trimmed.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.exe')) return [trimmed];
  return [`${trimmed}.cmd`, `${trimmed}.exe`, trimmed];
}

function resolveHomeRelativeCodexWrapper(
  command: string,
  filePath: string,
  env: NodeJS.ProcessEnv,
  fileExists: (filePath: string) => boolean,
): string | null {
  if (command !== 'codex' || !isHomeRelativeCodexWrapper(filePath)) return null;

  const runtimeHome = env.HOME || env.USERPROFILE;
  if (runtimeHome && fileExists(codexCliJsPathForHome(runtimeHome))) {
    return null;
  }

  const normalized = filePath.replace(/\\/g, '/');
  const marker = '/.local/bin/';
  const markerIndex = normalized.indexOf(marker);
  const installHome = markerIndex > 0 ? filePath.slice(0, markerIndex) : os.homedir();
  const finalCodex = codexCliJsPathForHome(installHome);
  if (!fileExists(finalCodex)) return null;
  const nodePath = findNode24ForHome(installHome, fileExists);
  return nodePath ? materializeCodexWrapperShim(nodePath, finalCodex) : null;
}

export function isNodeModulesBinPath(dirPath: string): boolean {
  const parts = dirPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) === '.bin' && parts.includes('node_modules');
}

function normalizeResolveOptions(
  options: ResolveCodexCliExecutableOptions | NodeJS.ProcessEnv,
): ResolveCodexCliExecutableOptions {
  if (Object.keys(options).length === 0) return {};
  if ('env' in options || 'platform' in options || 'fileExists' in options) {
    return options as ResolveCodexCliExecutableOptions;
  }
  return { env: options as NodeJS.ProcessEnv };
}

export function resolveCodexCliExecutable(
  options: ResolveCodexCliExecutableOptions | NodeJS.ProcessEnv = {},
): string {
  return resolveCliExecutable({
    ...normalizeResolveOptions(options),
    command: 'codex',
    overrideEnvVar: 'CODELARK_CODEX_CLI_PATH',
  });
}

export function resolveCliExecutable(options: ResolveCliExecutableOptions): string {
  const env = options.env || process.env;
  const override = options.overrideEnvVar ? env[options.overrideEnvVar]?.trim() : '';
  if (override) return override;

  const platform = options.platform || process.platform;
  const fileExists = options.fileExists || defaultExecutableExists;
  const pathModule = pathModuleForPlatform(platform);
  const pathValue = env.PATH || '';
  const entries = pathValue.split(pathDelimiterForPlatform(platform)).filter(Boolean);
  const names = executableNames(options.command, platform);

  for (const dir of entries) {
    if (isNodeModulesBinPath(dir)) continue;
    for (const name of names) {
      const candidate = pathModule.join(dir, name);
      if (!fileExists(candidate)) continue;
      const resolvedWrapper = resolveHomeRelativeCodexWrapper(options.command, candidate, env, fileExists);
      if (resolvedWrapper) return resolvedWrapper;
      return candidate;
    }
  }

  for (const dir of entries) {
    for (const name of names) {
      const candidate = pathModule.join(dir, name);
      if (!fileExists(candidate)) continue;
      const resolvedWrapper = resolveHomeRelativeCodexWrapper(options.command, candidate, env, fileExists);
      if (resolvedWrapper) return resolvedWrapper;
      return candidate;
    }
  }

  return names[0] || options.command;
}

export function resolveClaudeCliExecutable(
  command: 'claude' | 'ccr',
  options: ResolveCodexCliExecutableOptions | NodeJS.ProcessEnv = {},
): string {
  const overrideEnvVar = command === 'ccr' ? 'CODELARK_CCR_CLI_PATH' : 'CODELARK_CLAUDE_CLI_PATH';
  return resolveCliExecutable({
    ...normalizeResolveOptions(options),
    command,
    overrideEnvVar,
  });
}
