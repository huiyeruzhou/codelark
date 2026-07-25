import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { sanitizeInput } from '../../shared/security/validators.js';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import { deliverBridgeNotice } from '../../channels/delivery/feedback.js';
import type { ChannelAddress, OutboundRichCard } from '../../domain/index.js';
import {
  readDetachedLogTail,
  startDetachedLogMonitor,
} from '../background/detached-log-monitor.js';
import { formatCommandPath } from './presentation.js';

const execFileAsync = promisify(execFile);
export const HOT_UPDATE_LOG_REFRESH_INTERVAL_SECONDS = 3;
const HOT_UPDATE_LOG_TAIL_LINES = 100;
const HOT_UPDATE_LOG_MAX_CHARS = 24_000;
const HOT_UPDATE_LOG_MONITOR_MAX_MS = 30 * 60 * 1000;
const COMPATIBLE_PACKAGE_NAMES = new Set(['codelark', 'codelark']);

export interface HotUpdateRunRequest {
  cwd: string;
  scriptPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type HotUpdateRunner = (request: HotUpdateRunRequest) => Promise<{
  stdout: string;
  stderr: string;
}>;

export interface HotUpdateLogMonitorSpec {
  command: string;
  projectDir: string;
  summary: string;
  workerPid: number | null;
  logPath: string;
  bridgeLogPath: string | null;
  dispatchOutput: string;
  updateKey: string;
}

export interface HotUpdateCommandResult {
  response: string;
  richCard?: OutboundRichCard;
  monitor?: HotUpdateLogMonitorSpec;
}

function usage(): string {
  return [
    '用法：/hot-update [--pull] [--skip-tests] [--dry-run]',
    '默认只派发 detached hot update，不 pull、不跳过测试。',
    '`--pull` 会让 hot update worker 先执行 git pull。',
    '`--skip-tests` 会跳过 hot update worker 中的 npm test。',
    '`--dry-run` 只校验和打印计划，不派发 worker、不重启 bridge。',
  ].join('\n');
}

function parseHotUpdateArgs(rawArgs: string): { ok: true; args: string[]; summary: string; dryRun: boolean } | { ok: false; message: string } {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const args: string[] = [];
  let pull = false;
  let skipTests = false;
  let dryRun = false;

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (normalized === 'help' || normalized === '--help' || normalized === '-h') {
      return { ok: false, message: usage() };
    }
    if (normalized === 'pull' || normalized === '--pull') {
      if (!pull) args.push('--pull');
      pull = true;
      continue;
    }
    if (normalized === 'skip-tests' || normalized === '--skip-tests' || normalized === 'skip') {
      if (!skipTests) args.push('--skip-tests');
      skipTests = true;
      continue;
    }
    if (normalized === 'dry-run' || normalized === '--dry-run' || normalized === 'dryrun') {
      if (!dryRun) args.push('--dry-run');
      dryRun = true;
      continue;
    }
    if (normalized === '--run') {
      return { ok: false, message: '不能通过 IM 命令传 `--run`。热更新必须由脚本默认入口派发 detached worker。' };
    }
    return { ok: false, message: [`未知参数：${token}`, usage()].join('\n') };
  }

  return {
    ok: true,
    args,
    summary: `pull: ${pull ? 'yes' : 'no'}；skip tests: ${skipTests ? 'yes' : 'no'}；dry-run: ${dryRun ? 'yes' : 'no'}`,
    dryRun,
  };
}

function isCodelarkProjectDir(dir: string): boolean {
  const scriptPath = path.join(dir, 'scripts', 'hot-update-bridge.sh');
  const packagePath = path.join(dir, 'package.json');
  if (!fs.existsSync(scriptPath) || !fs.existsSync(packagePath)) return false;

  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as { name?: unknown };
    return typeof parsed.name === 'string' && COMPATIBLE_PACKAGE_NAMES.has(parsed.name);
  } catch {
    return false;
  }
}

function findProjectDir(startCwd: string): string | null {
  let current = path.resolve(startCwd);
  while (true) {
    if (isCodelarkProjectDir(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const defaultHotUpdateRunner: HotUpdateRunner = async (request) => {
  const result = await execFileAsync('bash', [request.scriptPath, ...request.args], {
    cwd: request.cwd,
    env: request.env,
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
};

function formatCommand(scriptPath: string, args: string[]): string {
  const relativeScriptPath = path.join('scripts', path.basename(scriptPath));
  return ['bash', relativeScriptPath, ...args].join(' ');
}

function extractOutputPath(output: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'mi'));
  return match?.[1]?.trim() || null;
}

function extractOutputPid(output: string): number | null {
  const raw = extractOutputPath(output, 'PID');
  if (!raw) return null;
  const pid = Number.parseInt(raw, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function readHotUpdateLog(logPath: string): { text: string; exists: boolean } {
  const log = readDetachedLogTail(logPath, HOT_UPDATE_LOG_TAIL_LINES);
  return log.exists ? log : { ...log, text: '(hot update log 尚未创建或暂时不可读)' };
}

function detectHotUpdateLogState(logText: string): 'running' | 'completed' | 'error' {
  if (/\[hot-update\] completed\b/.test(logText)) return 'completed';
  if (/\[hot-update\].*(failed|error|refusing|required)/i.test(logText)) return 'error';
  return 'running';
}

function formatHotUpdateRefreshedAt(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function buildHotUpdateLogRichCard(params: {
  command: string;
  projectDir: string;
  summary: string;
  workerPid: number | null;
  logPath: string;
  bridgeLogPath: string | null;
  dispatchOutput: string;
  logText: string;
  logExists: boolean;
  state: 'running' | 'completed' | 'error';
  stateDetail?: string | null;
  updateKey: string;
}): OutboundRichCard {
  const { text, truncated } = sanitizeInput(params.logText || '(empty)', HOT_UPDATE_LOG_MAX_CHARS);
  const title = params.state === 'completed'
    ? 'CodeLark 热更新完成'
    : params.state === 'error'
      ? 'CodeLark 热更新异常'
      : 'CodeLark 热更新日志';
  const template = params.state === 'completed'
    ? 'green'
    : params.state === 'error'
      ? 'red'
      : 'yellow';
  return {
    title,
    subtitle: `普通卡片后台每 ${HOT_UPDATE_LOG_REFRESH_INTERVAL_SECONDS} 秒刷新，用 tail -n ${HOT_UPDATE_LOG_TAIL_LINES} 展示日志，不使用流式“处理中”卡片。`,
    template,
    updateKey: params.updateKey,
    updateTtlMs: null,
    sections: [
      {
        fields: [
          ['执行目录', formatCommandPath(params.projectDir)],
          ['命令', params.command],
          ['参数', params.summary],
          ['Worker PID', params.workerPid ? String(params.workerPid) : '-'],
          ['刷新间隔', `${HOT_UPDATE_LOG_REFRESH_INTERVAL_SECONDS}s`],
          ['Hot update log', formatCommandPath(params.logPath)],
          ['Bridge log', params.bridgeLogPath ? formatCommandPath(params.bridgeLogPath) : '-'],
        ],
      },
      {
        title: `Hot update log (tail -n ${HOT_UPDATE_LOG_TAIL_LINES})`,
        code: {
          text,
          language: 'text',
        },
      },
    ],
    footer: [
      params.logExists ? '' : '等待 hot update log 创建。',
      params.stateDetail || '',
      `最近刷新：${formatHotUpdateRefreshedAt()}`,
      truncated ? '日志内容过长，已截断。' : '',
    ].filter(Boolean),
  };
}

function buildHotUpdateLogRichCardFromSpec(spec: HotUpdateLogMonitorSpec): OutboundRichCard {
  const log = readHotUpdateLog(spec.logPath);
  const state = detectHotUpdateLogState(log.text);
  return buildHotUpdateLogRichCard({
    command: spec.command,
    projectDir: spec.projectDir,
    summary: spec.summary,
    workerPid: spec.workerPid,
    logPath: spec.logPath,
    bridgeLogPath: spec.bridgeLogPath,
    dispatchOutput: spec.dispatchOutput,
    logText: log.text,
    logExists: log.exists,
    state,
    updateKey: spec.updateKey,
  });
}

export function startHotUpdateLogMonitor(params: {
  adapter: BaseChannelAdapter;
  address: ChannelAddress;
  messageId?: string;
  refreshIntervalMs?: number;
  spec: HotUpdateLogMonitorSpec;
}): void {
  const refreshIntervalMs = params.refreshIntervalMs || HOT_UPDATE_LOG_REFRESH_INTERVAL_SECONDS * 1000;
  startDetachedLogMonitor({
    logPath: params.spec.logPath,
    workerPid: params.spec.workerPid,
    refreshIntervalMs,
    maxDurationMs: HOT_UPDATE_LOG_MONITOR_MAX_MS,
    tailLines: HOT_UPDATE_LOG_TAIL_LINES,
    workerLabel: 'hot update worker',
    detectState: detectHotUpdateLogState,
    async onSnapshot(snapshot) {
      const log = snapshot.exists
        ? snapshot
        : { ...snapshot, text: '(hot update log 尚未创建或暂时不可读)' };
      const richCard = buildHotUpdateLogRichCard({
        command: params.spec.command,
        projectDir: params.spec.projectDir,
        summary: params.spec.summary,
        workerPid: params.spec.workerPid,
        logPath: params.spec.logPath,
        bridgeLogPath: params.spec.bridgeLogPath,
        dispatchOutput: params.spec.dispatchOutput,
        logText: log.text,
        logExists: log.exists,
        state: snapshot.state,
        stateDetail: snapshot.stateDetail,
        updateKey: params.spec.updateKey,
      });
      const fallbackText = [
        richCard.title,
        `Hot update log: ${params.spec.logPath}`,
      ].join('\n');
      await deliverBridgeNotice(params.adapter, params.address, fallbackText, {
        richCard,
        richCardUpdateMessageId: params.messageId,
      });
    },
  });
}

function buildHotUpdateLogMonitorSpec(params: {
  updateKey: string;
  command: string;
  projectDir: string;
  summary: string;
  workerPid: number | null;
  logPath: string;
  bridgeLogPath: string | null;
  dispatchOutput: string;
}): HotUpdateLogMonitorSpec {
  return params;
}

export async function handleHotUpdateCommand(options: {
  args: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: HotUpdateRunner;
  updateKey?: string;
}): Promise<HotUpdateCommandResult> {
  const parsedArgs = parseHotUpdateArgs(options.args);
  if (!parsedArgs.ok) return { response: parsedArgs.message };

  const projectDir = findProjectDir(options.cwd || process.cwd());
  if (!projectDir) {
    return { response: '热更新派发失败：当前路径不是 CodeLark/codelark 项目，也没有在父目录中找到 `scripts/hot-update-bridge.sh`。' };
  }

  const scriptPath = path.join(projectDir, 'scripts', 'hot-update-bridge.sh');
  try {
    const runner = options.runner || defaultHotUpdateRunner;
    const result = await runner({
      cwd: projectDir,
      scriptPath,
      args: parsedArgs.args,
      env: options.env || process.env,
    });
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    const response = [
      parsedArgs.dryRun ? 'CodeLark 热更新 dry-run 通过。' : '已派发 CodeLark 热更新。',
      `执行目录：${projectDir}`,
      `命令：${formatCommand(scriptPath, parsedArgs.args)}`,
      `参数：${parsedArgs.summary}`,
      output ? ['', output].join('\n') : '',
    ].filter(Boolean).join('\n');
    const logPath = extractOutputPath(output, 'Hot update log');
    if (!parsedArgs.dryRun && options.updateKey && logPath) {
      const monitor = buildHotUpdateLogMonitorSpec({
        updateKey: options.updateKey,
        command: formatCommand(scriptPath, parsedArgs.args),
        projectDir,
        summary: parsedArgs.summary,
        workerPid: extractOutputPid(output),
        logPath,
        bridgeLogPath: extractOutputPath(output, 'Bridge log'),
        dispatchOutput: response,
      });
      return {
        response,
        richCard: buildHotUpdateLogRichCardFromSpec(monitor),
        monitor,
      };
    }
    return { response };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { response: [
      '热更新派发失败。',
      `执行目录：${projectDir}`,
      `命令：${formatCommand(scriptPath, parsedArgs.args)}`,
      `错误：${message}`,
    ].join('\n') };
  }
}
