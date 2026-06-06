import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';
import { configPatchSchema, configToTomlShape, tomlToConfigPatch, type ConfigPatch } from './schema.js';

export interface ConfigPaths {
  defaultsToml: string;
  homeToml: string;
  localToml?: string;
  channelConfigDir: string;
  sessionConfigDir: string;
}

export interface SourceLoadResult {
  patch: ConfigPatch;
  file: string;
}

export function defaultCodelarkHome(): string {
  return process.env.CODELARK_HOME || path.join(os.homedir(), '.codelark');
}

export function resolveConfigPaths(options: {
  codelarkHome?: string;
  cwd?: string;
} = {}): ConfigPaths {
  const codelarkHome = options.codelarkHome || defaultCodelarkHome();
  return {
    defaultsToml: path.join(path.dirname(fileURLToPath(import.meta.url)), 'defaults.toml'),
    homeToml: path.join(codelarkHome, 'config.toml'),
    localToml: findLocalConfig(options.cwd),
    channelConfigDir: path.join(codelarkHome, 'config', 'channels'),
    sessionConfigDir: path.join(codelarkHome, 'config', 'sessions'),
  };
}

export function findLocalConfig(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const direct = path.join(cwd, '.codelark', 'config.toml');
  if (fs.existsSync(direct)) return direct;
  const dotfile = path.join(cwd, '.codelark.toml');
  if (fs.existsSync(dotfile)) return dotfile;
  return direct;
}

export function readTomlConfig(file: string): SourceLoadResult | null {
  try {
    const content = fs.readFileSync(file, 'utf-8');
    return { file, patch: tomlToConfigPatch(parse(content)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readDefaultsConfig(file: string): SourceLoadResult {
  const loaded = readTomlConfig(file);
  if (!loaded) throw new Error(`Missing defaults TOML: ${file}`);
  return loaded;
}

export function writeTomlConfig(file: string, patch: ConfigPatch): void {
  const parsed = configPatchSchema.parse(patch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, stringify(configToTomlShape(parsed)), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function channelTomlPath(paths: ConfigPaths, channelId: string): string {
  return path.join(paths.channelConfigDir, `${channelId}.toml`);
}

export function sessionTomlPath(paths: ConfigPaths, sessionId: string): string {
  return path.join(paths.sessionConfigDir, `${sessionId}.toml`);
}
