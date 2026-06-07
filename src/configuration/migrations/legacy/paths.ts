import path from 'node:path';
import { CODELARK_HOME } from '../../paths.js';

export const LEGACY_CONFIG_ENV_PATH = path.join(CODELARK_HOME, 'config.env');
export const LEGACY_CONFIG_JSON_PATH = path.join(CODELARK_HOME, 'config.json');

export function legacyConfigEnvPath(codelarkHome: string): string {
  return path.join(codelarkHome, 'config.env');
}

export function legacyConfigJsonPath(codelarkHome: string): string {
  return path.join(codelarkHome, 'config.json');
}
