import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CodexDesktopRestartResult {
  scriptPath: string;
  output: string;
}

function restartScriptCandidates(cwd: string): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [...new Set([
    path.join(cwd, 'scripts', 'restart-codex-desktop.sh'),
    path.resolve(moduleDir, '..', 'scripts', 'restart-codex-desktop.sh'),
    path.resolve(moduleDir, '..', '..', '..', 'scripts', 'restart-codex-desktop.sh'),
  ])];
}

export function findCodexDesktopRestartScript(cwd = process.cwd()): string | undefined {
  return restartScriptCandidates(cwd).find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
}

export async function restartCodexDesktop(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ stdout?: string; stderr?: string }>;
} = {}): Promise<CodexDesktopRestartResult> {
  if ((options.platform || process.platform) !== 'darwin') throw new Error('Codex Desktop 一键重启仅支持 macOS。');
  const cwd = options.cwd || process.cwd();
  const scriptPath = findCodexDesktopRestartScript(cwd);
  if (!scriptPath) throw new Error('找不到 scripts/restart-codex-desktop.sh，未重启 Desktop。');
  const run = options.run || (async (file, args, execOptions) => execFileAsync(file, args, {
    ...execOptions,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }));
  try {
    const result = await run('/bin/bash', [scriptPath], { cwd, env: options.env || process.env });
    return { scriptPath, output: [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join('\n') };
  } catch (error) {
    const detail = error as { message?: string; stdout?: string; stderr?: string };
    const output = [detail.stderr?.trim(), detail.stdout?.trim()].filter(Boolean).join('\n');
    throw new Error(output || detail.message || 'Codex Desktop 重启脚本执行失败。', { cause: error });
  }
}
