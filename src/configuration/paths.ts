import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CODELARK_HOME = path.join(os.homedir(), '.codelark');
export const DEFAULT_WORKSPACE_ROOT = os.homedir();

export const CODELARK_HOME = process.env.CODELARK_HOME || DEFAULT_CODELARK_HOME;
export const CONFIG_PATH = path.join(CODELARK_HOME, 'config.env');
export const CONFIG_JSON_PATH = path.join(CODELARK_HOME, 'config.json');

export function expandHomePath(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
