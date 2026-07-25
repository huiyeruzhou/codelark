import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../configuration/paths.js';
import { normalizeVersion } from './version-check.js';

const UPDATE_WORKER_NAME = 'update-global-codelark.mjs';

export interface GlobalUpdateDispatchResult {
  pid: number | null;
  logPath: string;
}

export type GlobalUpdateDispatcher = (expectedVersion: string) => Promise<GlobalUpdateDispatchResult>;

export function findGlobalUpdateWorker(options: {
  entrypoint?: string;
  cwd?: string;
} = {}): string | null {
  const entrypoint = options.entrypoint || process.argv[1] || '';
  const candidates = [
    entrypoint ? path.resolve(path.dirname(entrypoint), UPDATE_WORKER_NAME) : '',
    path.resolve(options.cwd || process.cwd(), 'dist', UPDATE_WORKER_NAME),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export const dispatchGlobalCodelarkUpdate: GlobalUpdateDispatcher = async (expectedVersion) => {
  const version = normalizeVersion(expectedVersion);
  if (!version) throw new Error('invalid CodeLark update version');
  const workerPath = findGlobalUpdateWorker();
  if (!workerPath) throw new Error(`cannot find dist/${UPDATE_WORKER_NAME}`);

  const logDirectory = path.join(CODELARK_HOME, 'logs');
  fs.mkdirSync(logDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const logPath = path.join(logDirectory, `version-update-${stamp}.log`);
  const logFd = fs.openSync(logPath, 'a', 0o600);
  return new Promise<GlobalUpdateDispatchResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [workerPath, '--version', version], {
        cwd: path.dirname(path.dirname(workerPath)),
        detached: true,
        env: process.env,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
    } finally {
      fs.closeSync(logFd);
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid ?? null, logPath });
    });
  });
};
