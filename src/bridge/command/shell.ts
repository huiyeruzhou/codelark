import type { ChannelChat } from '../../domain/index.js';
import { getBridgeContext } from '../host/context.js';
import { buildCommandFields, formatCommandPath } from './presentation.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';
import { sanitizeInput } from '../../shared/security/validators.js';
import { getSessionWorkingDirectory } from '../../domain/session-runtime.js';
import {
  auditShellCommand,
  parseShellCommandArgs,
  type ParsedShellCommandArgs,
} from './shell-args.js';
import {
  defaultShellCommandRunner,
  type ShellCommandProgress,
  type ShellCommandRunner,
  type ShellCommandRunResult,
} from './shell-runner.js';

export {
  auditShellCommand,
  normalizeShellCommandTransportMarkdown,
  parseShellCommandArgs,
  type ParsedShellCommandArgs,
  type ShellAuditFinding,
  type ShellSandboxMode,
} from './shell-args.js';
export {
  buildCodexSandboxArgs,
  defaultShellCommandRunner,
  detectCodexSandboxCliStyleFromHelp,
  type CodexSandboxCliStyle,
  type ShellCommandProgress,
  type ShellCommandRunner,
  type ShellCommandRunRequest,
  type ShellCommandRunResult,
} from './shell-runner.js';
export { resolveCodexCliExecutable } from '../../runtime/codex/cli-executable.js';

const SHELL_COMMAND_TIMEOUT_MS = 60_000;

interface ShellStreamCard {
  update: (text: string, statusText: string) => void;
  finish: (status: 'completed' | 'interrupted' | 'error', text: string) => Promise<boolean>;
}

function resolveUserShell(): string {
  return process.env.SHELL || (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/bash');
}

function formatShellOutput(label: string, value: string, maxLength: number): string[] {
  const { text, truncated } = sanitizeInput(value.trim() || '(empty)', maxLength);
  return [
    `**${label}**`,
    '',
    buildFencedCodeBlock(text, 'text'),
    ...(truncated ? ['输出过长，已截断。'] : []),
  ];
}

function formatShellElapsed(startedAtMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function buildShellStatusText(
  parsed: ParsedShellCommandArgs,
  startedAtMs: number,
  state: 'running' | 'done' | 'failed' | 'timeout',
): string {
  return `shell · ${state} · ${formatShellElapsed(startedAtMs)} · refresh ${parsed.refreshIntervalSeconds}s`;
}

function buildShellExecutionResponse(params: {
  workDir: string;
  markdown: boolean;
  parsed: ParsedShellCommandArgs;
  result: ShellCommandRunResult | ShellCommandProgress;
  running: boolean;
  startedAtMs: number;
  warnings: string[];
}): string {
  const { markdown, parsed, result, running, startedAtMs, warnings, workDir } = params;
  const exitCode = 'exitCode' in result ? result.exitCode : null;
  const lines = [
    ...buildCommandFields(
      running ? '/shell 执行中' : '/shell 执行完成',
      [
        ['命令', buildFencedCodeBlock(parsed.command, 'sh')],
        ['工作目录', formatCommandPath(workDir)],
        ['Codex sandbox', parsed.sandboxMode],
        ['网络', 'on'],
        ['刷新间隔', `${parsed.refreshIntervalSeconds}s`],
        ['Shell', resolveUserShell()],
        ['运行时间', formatShellElapsed(startedAtMs)],
        ['退出码', exitCode === undefined || exitCode === null ? '-' : String(exitCode)],
      ],
      [
        ...warnings.map((warning) => `已确认高风险操作：${warning}`),
        result.timedOut ? `命令超过 ${Math.round(SHELL_COMMAND_TIMEOUT_MS / 1000)} 秒，已超时终止。` : '',
        result.outputTruncated ? '输出超过限制，已终止或截断。' : '',
      ],
      markdown,
    ).split('\n'),
    '',
    ...formatShellOutput('stdout', result.stdout, 24_000),
    '',
    ...formatShellOutput('stderr', result.stderr, 8_000),
  ];
  return lines.join('\n').trim();
}

export async function handleShellCommand(options: {
  args: string;
  binding: ChannelChat | null;
  card?: ShellStreamCard;
  markdown: boolean;
  runner?: ShellCommandRunner;
}): Promise<string> {
  const parsed = parseShellCommandArgs(options.args);
  if ('error' in parsed) return parsed.error;
  if (!parsed.command) {
    return [
      '用法：/shell [--force] <command>',
      '示例：/shell --sandbox read-only git status --short',
    ].join('\n');
  }
  if (!options.binding) {
    return '当前聊天还没有绑定会话，无法确定命令工作目录。请先用 `/new` 或 `/t` 选择会话。';
  }
  const session = getBridgeContext().store.getSession(options.binding.bridgeSessionId);
  const workDir = getSessionWorkingDirectory(session) || '';
  if (!workDir) {
    return '当前会话没有工作目录，无法执行 /shell。';
  }

  const findings = auditShellCommand(parsed.command);
  const blocked = findings.filter((finding) => finding.level === 'block');
  if (blocked.length > 0) {
    return buildCommandFields(
      '/shell 已拒绝执行',
      [
        ['命令', buildFencedCodeBlock(parsed.command, 'sh')],
        ['工作目录', formatCommandPath(workDir)],
      ],
      blocked.map((finding) => finding.message),
      options.markdown,
    );
  }

  const warnings = findings.filter((finding) => finding.level === 'warn').map((finding) => finding.message);
  if (warnings.length > 0 && !parsed.force) {
    return buildCommandFields(
      '/shell 需要确认',
      [
        ['命令', buildFencedCodeBlock(parsed.command, 'sh')],
        ['工作目录', formatCommandPath(workDir)],
        ['Codex sandbox', parsed.sandboxMode],
        ['网络', 'on'],
        ['刷新间隔', `${parsed.refreshIntervalSeconds}s`],
        ['Shell', resolveUserShell()],
      ],
      [
        ...warnings,
        '如果确认要在 Codex sandbox 内直接执行该命令，请追加 `--force` 后重发。',
      ],
      options.markdown,
    );
  }

  const runner = options.runner || defaultShellCommandRunner;
  const startedAtMs = Date.now();
  const card = options.card;
  let latestProgress: ShellCommandProgress = { stdout: '', stderr: '' };
  let lastCardUpdateAt = 0;
  let hasOutputProgressUpdate = false;
  const pushCardSnapshot = (force = false, outputProgress = false) => {
    if (!card) return;
    const now = Date.now();
    if (!force && hasOutputProgressUpdate && now - lastCardUpdateAt < parsed.refreshIntervalSeconds * 1000) return;
    if (outputProgress) hasOutputProgressUpdate = true;
    lastCardUpdateAt = now;
    card.update(
      buildShellExecutionResponse({
        workDir,
        markdown: options.markdown,
        parsed,
        result: latestProgress,
        running: true,
        startedAtMs,
        warnings,
      }),
      buildShellStatusText(parsed, startedAtMs, 'running'),
    );
  };
  const cardTimer = card
    ? setInterval(() => pushCardSnapshot(true), parsed.refreshIntervalSeconds * 1000)
    : null;
  pushCardSnapshot(true);
  const result = await runner({
    command: parsed.command,
    cwd: workDir,
    sandboxMode: parsed.sandboxMode,
    networkAccess: true,
    shell: resolveUserShell(),
    timeoutMs: SHELL_COMMAND_TIMEOUT_MS,
    refreshIntervalSeconds: parsed.refreshIntervalSeconds,
    onProgress: card
      ? (progress) => {
          latestProgress = progress;
          pushCardSnapshot(false, true);
        }
      : undefined,
  });
  if (cardTimer) clearInterval(cardTimer);

  const finalText = buildShellExecutionResponse({
    workDir,
    markdown: options.markdown,
    parsed,
    result,
    running: false,
    startedAtMs,
    warnings,
  });
  if (card) {
    const state = result.timedOut ? 'timeout' : result.exitCode === 0 ? 'done' : 'failed';
    card.update(finalText, buildShellStatusText(parsed, startedAtMs, state));
    const finalized = await card.finish(result.exitCode === 0 ? 'completed' : 'error', finalText);
    if (finalized) return '';
  }
  return finalText;
}
