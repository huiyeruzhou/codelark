import { execFile } from 'node:child_process';

import { resolveCursorCliExecutable } from './tmux-provider.js';

export interface CursorAvailableModel {
  slug: string;
  name: string;
  current: boolean;
  default: boolean;
}

export interface CursorModelListCommandResult {
  stdout: string;
  stderr: string;
}

export type CursorModelListCommandRunner = (
  executable: string,
  args: string[],
) => Promise<CursorModelListCommandResult>;

const MODEL_LINE = /^(\S+)\s+-\s+(.+)$/u;
const STATUS_SUFFIX = /\s+\((current|default)\)\s*$/iu;

export function parseCursorAvailableModels(output: string): CursorAvailableModel[] {
  const seen = new Set<string>();
  const models: CursorAvailableModel[] = [];
  for (const rawLine of output.replace(/\r\n?/gu, '\n').split('\n')) {
    const match = MODEL_LINE.exec(rawLine.trim());
    if (!match) continue;
    const slug = match[1]?.trim() || '';
    let name = match[2]?.trim() || '';
    if (!slug || !name || seen.has(slug) || /\s|\0/u.test(slug)) continue;
    let current = false;
    let defaultModel = false;
    while (true) {
      const suffix = STATUS_SUFFIX.exec(name);
      if (!suffix) break;
      current ||= suffix[1]?.toLowerCase() === 'current';
      defaultModel ||= suffix[1]?.toLowerCase() === 'default';
      name = name.slice(0, suffix.index).trim();
    }
    if (!name) continue;
    seen.add(slug);
    models.push({ slug, name, current, default: defaultModel });
  }
  return models;
}

function runModelListCommand(executable: string, args: string[]): Promise<CursorModelListCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message || '').trim();
        reject(new Error(detail || 'Cursor Agent model list failed.'));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export async function listCursorAvailableModels(options: {
  executable?: string;
  run?: CursorModelListCommandRunner;
} = {}): Promise<CursorAvailableModel[]> {
  const executable = options.executable || resolveCursorCliExecutable();
  const result = await (options.run || runModelListCommand)(executable, ['models']);
  const models = parseCursorAvailableModels(result.stdout);
  if (models.length === 0) {
    const detail = result.stderr.trim();
    throw new Error(detail || 'Cursor Agent 没有返回可用模型。');
  }
  return models;
}
