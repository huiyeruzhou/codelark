import path from 'node:path';

import { CODELARK_HOME } from '../configuration/paths.js';

const LEGACY_LARK_CLI_BIN_DIR = path.join(CODELARK_HOME, 'runtime', 'bin');

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function readPathValue(env: NodeJS.ProcessEnv): string {
  if (env.PATH !== undefined) return env.PATH;
  if (process.platform !== 'win32') return '';
  return Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
}

function writePathValue(env: NodeJS.ProcessEnv, value: string): void {
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key !== 'PATH' && key.toLowerCase() === 'path') delete env[key];
    }
  }
  env.PATH = value;
}

/**
 * Project lark-cli calls onto the user's standard ~/.lark-cli environment.
 *
 * Older CodeLark releases injected a private lark-channel config and shim. A
 * restarted bridge can inherit those values, so merely stopping new writes is
 * insufficient: every lark-cli boundary must remove the deprecated overrides.
 */
export function buildStandardLarkCliEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey === 'LARK_CHANNEL'
      || normalizedKey.startsWith('LARK_CHANNEL_')
      || normalizedKey === 'LARKSUITE_CLI_CONFIG_DIR'
    ) {
      delete env[key];
    }
  }

  const pathValue = readPathValue(env);
  if (pathValue) {
    writePathValue(
      env,
      pathValue
        .split(path.delimiter)
        .filter(Boolean)
        .filter((entry) => !samePath(entry, LEGACY_LARK_CLI_BIN_DIR))
        .join(path.delimiter),
    );
  }
  return env;
}

/** Apply the standard projection in place at a process boundary. */
export function applyStandardLarkCliEnv(
  targetEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const projected = buildStandardLarkCliEnv(targetEnv);
  for (const key of Object.keys(targetEnv)) {
    if (!Object.prototype.hasOwnProperty.call(projected, key)) delete targetEnv[key];
  }
  Object.assign(targetEnv, projected);
  return targetEnv;
}
