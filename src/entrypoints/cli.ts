#!/usr/bin/env node

import fs from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CODELARK_HOME } from '../configuration/paths.js';
import { parseConfigCliOverrides, type ParsedConfigCliOverrides } from '../configuration/cli-overrides.js';
import { createConfigService } from '../configuration/service.js';
import type { ConfigPatch, ConfigV2 } from '../configuration/schema.js';
import {
  INSTALLABLE_SKILLS,
  type BridgeStatus,
  ensureUiServerRunning,
  ensureWindowsAdminSession,
  getBridgeAutostartStatus,
  getBridgeStatus,
  getCurrentUiServerUrl,
  getUiServerStatus,
  getUiServerUrl,
  installCodexIntegration,
  type UiServerStatus,
  installBridgeAutostart,
  uninstallBridgeAutostart,
  loadStartupProjection,
  openBrowser,
  startBridge,
  stopBridge,
  stopUiServer,
  uninstallCodelarkPackage,
} from '../local-service/manager.js';
import { runSetupWizard } from './setup-wizard.js';

const PRIMARY_CLI_NAME = 'codelark';

type CliCommand =
  | 'default'
  | 'setup'
  | 'install-skills'
  | 'install-codex-skills'
  | 'start'
  | 'run'
  | 'url'
  | 'stop'
  | 'status'
  | 'autostart'
  | 'uninstall'
  | 'help'
  | 'unknown';

interface ParsedCliCommand {
  command: CliCommand;
  args: string[];
  rawCommand?: string;
}

export interface ParsedCliInvocation extends ParsedCliCommand {
  configOverrides: ParsedConfigCliOverrides;
}

function isInteractiveTerminal(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

async function promptHidden(question: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('当前终端不支持隐藏输入，请在可交互终端中执行。');
  }

  output.write(question);
  input.resume();
  input.setEncoding('utf8');
  input.setRawMode?.(true);

  return await new Promise<string>((resolve, reject) => {
    let value = '';

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          cleanup();
          reject(new Error('已取消。'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0008' || ch === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };

    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
    };

    input.on('data', onData);
  });
}

async function promptYesNo(question: string, defaultValue = false): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    throw new Error('当前终端不支持交互确认，请在可交互终端中执行。');
  }

  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
      if (!answer) return defaultValue;
      if (['y', 'yes', '是'].includes(answer)) return true;
      if (['n', 'no', '否'].includes(answer)) return false;
      output.write('请输入 y 或 n。\n');
    }
  } finally {
    rl.close();
  }
}

type RunningBridgeStartAction = 'start' | 'restart' | 'reuse';

export function formatRunningBridgePrompt(command: 'start' | 'run', status: BridgeStatus): string {
  const pid = status.pid ? `（PID ${status.pid}）` : '';
  return `Bridge 已经在运行${pid}。是否先停止已有实例并重新执行 codelark ${command}？`;
}

export async function resolveRunningBridgeStartAction(options: {
  command: 'start' | 'run';
  status: BridgeStatus;
  interactive?: boolean;
  prompt?: (question: string) => Promise<boolean>;
}): Promise<RunningBridgeStartAction> {
  if (!options.status.running) return 'start';
  if (options.interactive === false) return 'reuse';
  const prompt = options.prompt || ((question: string) => promptYesNo(question, false));
  return await prompt(formatRunningBridgePrompt(options.command, options.status)) ? 'restart' : 'reuse';
}

function hasConfiguredFeishu(config: ConfigV2): boolean {
  return Boolean(config.channels.some((channel) => {
    if (channel.provider !== 'feishu' || channel.enabled === false) return false;
    return Boolean(channel.config.appId && channel.config.appSecret);
  }));
}

function hasConfigPatchValues(patch: ConfigPatch | undefined): boolean {
  if (!patch) return false;
  return Object.keys(patch).length > 0;
}

function loadCliEffectiveConfig(cli: ConfigPatch | undefined): ConfigV2 {
  return createConfigService({
    codelarkHome: CODELARK_HOME,
    ...(hasConfigPatchValues(cli) ? { cli } : {}),
  }).snapshot().config;
}

async function runInstallSkillsCommand(args: string[]): Promise<void> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(
      [
        `Usage: ${PRIMARY_CLI_NAME} install-skills [skill ...]`,
        '',
        'Installs bundled CodeLark skills and the official Lark lark-doc skill.',
        'If no skill is provided, all default skills are installed.',
        'The official lark-doc skill is installed by running:',
        '  npx skills add larksuite/cli -s lark-doc -y -g -a claude-code',
        '',
        'Available skills:',
        ...INSTALLABLE_SKILLS.map((skill) => `  ${skill.name} - ${skill.description}`),
      ].join('\n') + '\n',
    );
    return;
  }
  const skillNames = args.length > 0 ? args : INSTALLABLE_SKILLS.map((skill) => skill.name);
  const result = await installCodexIntegration({ skillNames });
  process.stdout.write(
    [
      `CodeLark skills installed/confirmed: ${result.skills.map((skill) => skill.name).join(', ') || '(none)'}`,
      'Target directories:',
      ...result.skills.map((skill) => `  ${skill.name}: ${skill.targetDir} (${skill.method})`),
      `Official Lark skills installed/confirmed: ${result.externalSkills.map((skill) => `${skill.name} (${skill.command} ${skill.args.join(' ')})`).join(', ') || '(none)'}`,
      'Start a new Codex or Claude Code session for newly installed skills to be discoverable.',
    ].join('\n') + '\n',
  );
}

async function runFirstRunSetupIfNeeded(cli: ConfigPatch | undefined): Promise<void> {
  if (!isInteractiveTerminal()) return;
  const config = loadCliEffectiveConfig(cli);
  if (hasConfiguredFeishu(config)) return;
  await runSetupWizard({ reason: 'first-run' });
}

export function buildCliHelpText(): string {
  return [
    'CodeLark 本地桥接服务',
    '',
    '用法:',
    `  ${PRIMARY_CLI_NAME}                         打开本地工作台，并启动 Bridge`,
    `  ${PRIMARY_CLI_NAME} <command> [options]`,
    '',
    '命令:',
    '  setup                               配置飞书/Lark 凭据和默认 runtime',
    '  install-skills [skill ...]          手动安装可选 CodeLark skills',
    '  run                                 打开本地工作台，并启动 Bridge',
    '  start                               只在后台启动 Bridge',
    '  status                              查看 UI、Bridge 和开机启动状态',
    '  url                                 输出当前或上次记录的工作台地址',
    '  stop                                停止工作台 UI server 和 Bridge',
    '  autostart status                    查看 Windows Bridge 开机启动状态',
    '  autostart install                   安装 Windows Bridge 开机启动任务',
    '  autostart uninstall                 移除 Windows Bridge 开机启动任务',
    '  uninstall                           停止服务并安排 npm uninstall -g codelark',
    '  help, -h, --help                    显示本帮助',
    '',
    '常用流程:',
    `  ${PRIMARY_CLI_NAME}                         打开工作台并启动 Bridge`,
    `  ${PRIMARY_CLI_NAME} run                     显式打开工作台并启动 Bridge`,
    `  ${PRIMARY_CLI_NAME} setup                   配置或重新配置飞书/Lark 凭据`,
    `  ${PRIMARY_CLI_NAME} install-skills          安装默认全套 CodeLark skills`,
    `  ${PRIMARY_CLI_NAME} start                   只运行后台 Bridge`,
    `  ${PRIMARY_CLI_NAME} status                  检查本地服务是否正在运行`,
    '',
    '配置覆盖:',
    '  --set path=value                    单次覆盖 canonical 配置项，例如 --set runtime.agent=claude',
    '',
    '文件:',
    '  配置: ~/.codelark/config.toml',
    '  日志: ~/.codelark/logs/',
  ].join('\n') + '\n';
}

function stripConfigOverrideArgs(argv: string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--set' || arg === '--unset') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--set=') || arg.startsWith('--unset=')) continue;
    stripped.push(arg);
  }
  return stripped;
}

export function parseCliCommand(argv: string[]): ParsedCliCommand {
  const [rawCommand, ...args] = argv;
  if (!rawCommand) return { command: 'default', args: [] };
  if (rawCommand === 'help' || rawCommand === '-h' || rawCommand === '--help') {
    return { command: 'help', args };
  }
  switch (rawCommand) {
    case 'setup':
    case 'install-skills':
    case 'install-codex-skills':
    case 'start':
    case 'run':
    case 'url':
    case 'stop':
    case 'status':
    case 'autostart':
    case 'uninstall':
      return { command: rawCommand, args };
    case 'open':
      return { command: 'run', args, rawCommand };
    default:
      return { command: 'unknown', args, rawCommand };
  }
}

export function parseCliInvocation(argv: string[]): ParsedCliInvocation {
  const configOverrides = parseConfigCliOverrides(argv);
  if (configOverrides.unset.length > 0) {
    throw new Error('CLI --unset 暂未接入命令入口；如需单次覆盖，请使用 --set path=value。');
  }
  return {
    ...parseCliCommand(stripConfigOverrideArgs(argv)),
    configOverrides,
  };
}

export function formatRunSuccessMessage(options: {
  url: string;
  ui: UiServerStatus;
  bridge: BridgeStatus;
  wasUiRunning: boolean;
  wasBridgeRunning: boolean;
}): string {
  const uiState = options.wasUiRunning ? '已在运行' : '本次已启动';
  const bridgeState = options.wasBridgeRunning ? '已在运行' : '本次已启动';
  const uiPid = options.ui.pid ? `，PID ${options.ui.pid}` : '';
  const bridgePid = options.bridge.pid ? `，PID ${options.bridge.pid}` : '';
  const channelCount = options.bridge.adapters?.length ?? options.bridge.channels?.length ?? 0;
  const channelLine = channelCount > 0
    ? `通道：已加载 ${channelCount} 个通道/适配器。`
    : '通道：未从状态文件读取到通道详情；可在工作台检查飞书/Lark 配置。';

  return [
    'CodeLark 启动成功。',
    `UI：正在运行，已确认进程存活（${uiState}${uiPid}）`,
    `工作台：${options.url}`,
    `Bridge：正在运行，已确认进程存活（${bridgeState}${bridgePid}）`,
    channelLine,
    '如果飞书/Lark 应用权限和事件订阅已经配置完成，现在应该可以在飞书/Lark 里给机器人发消息并看到回复。',
    '需要排查时，请在工作台查看通道状态和日志。',
  ].join('\n') + '\n';
}

export const formatOpenSuccessMessage = formatRunSuccessMessage;

async function runRunCommand(options: { firstRunSetup: boolean; configOverrides?: ParsedConfigCliOverrides }): Promise<void> {
  if (options.firstRunSetup) {
    await runFirstRunSetupIfNeeded(options.configOverrides?.patch);
  }
  const serviceOptions = { cli: options.configOverrides?.patch };
  const startupProjection = loadStartupProjection(serviceOptions);
  const uiBefore = getUiServerStatus();
  const bridgeBefore = getBridgeStatus();
  const bridgeAction = await resolveRunningBridgeStartAction({
    command: 'run',
    status: bridgeBefore,
    interactive: isInteractiveTerminal(),
  });
  if (bridgeAction === 'restart') {
    await stopBridge();
  }
  const status = await ensureUiServerRunning({ ...serviceOptions, startupProjection });
  const url = getUiServerUrl(status.port);
  openBrowser(url);
  try {
    const bridge = bridgeAction === 'reuse' && bridgeBefore.running
      ? bridgeBefore
      : await startBridge({ ...serviceOptions, startupProjection });
    process.stdout.write(formatRunSuccessMessage({
      url,
      ui: status,
      bridge,
      wasUiRunning: uiBefore.running,
      wasBridgeRunning: bridgeAction === 'reuse' && bridgeBefore.running,
    }));
  } catch (error) {
    process.stdout.write(
      [
        'CodeLark 工作台已打开，但 Bridge 启动失败。',
        `UI：正在运行，已确认进程存活（${uiBefore.running ? '已在运行' : '本次已启动'}${status.pid ? `，PID ${status.pid}` : ''}）`,
        `工作台：${url}`,
      ].join('\n') + '\n',
    );
    process.stderr.write(
      `Bridge 启动失败。请先在工作台检查配置、通道状态和日志：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliInvocation(argv);
  const command = parsed.command;

  switch (command) {
    case 'default': {
      await runRunCommand({ firstRunSetup: true, configOverrides: parsed.configOverrides });
      return;
    }

    case 'help': {
      process.stdout.write(buildCliHelpText());
      return;
    }

    case 'setup': {
      await runSetupWizard({ reason: 'manual' });
      return;
    }

    case 'install-skills':
    case 'install-codex-skills': {
      await runInstallSkillsCommand(parsed.args);
      return;
    }

    case 'start': {
      const before = getBridgeStatus();
      const bridgeAction = await resolveRunningBridgeStartAction({
        command: 'start',
        status: before,
        interactive: isInteractiveTerminal(),
      });
      if (bridgeAction === 'reuse' && before.running) {
        process.stdout.write(`Bridge already running. PID: ${before.pid || '-'}\n`);
        return;
      }
      if (bridgeAction === 'restart') {
        await stopBridge();
      }
      const status = await startBridge({ cli: parsed.configOverrides.patch });
      process.stdout.write(`Bridge started. PID: ${status.pid || '-'}\n`);
      return;
    }

    case 'run': {
      await runRunCommand({ firstRunSetup: true, configOverrides: parsed.configOverrides });
      return;
    }

    case 'url': {
      const status = getUiServerStatus();
      const url = getCurrentUiServerUrl();
      if (status.running && url) {
        process.stdout.write(`${url}\n`);
        return;
      }
      if (url) {
        process.stdout.write(`UI server is not running. Last known URL: ${url}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write('UI server is not running and no known URL is available.\n');
      process.exitCode = 1;
      return;
    }

    case 'stop': {
      const ui = await stopUiServer();
      const bridge = await stopBridge();
      process.stdout.write(
        `Stopped services. UI running=${ui.running ? 'yes' : 'no'}, Bridge running=${bridge.running ? 'yes' : 'no'}\n`
      );
      return;
    }

    case 'uninstall': {
      const result = await uninstallCodelarkPackage();
      process.stdout.write(
        [
          `Stopped services. UI running=${result.ui.running ? 'yes' : 'no'}, Bridge running=${result.bridge.running ? 'yes' : 'no'}`,
          result.autostart.installed ? `Bridge autostart still installed: ${result.autostart.taskName}` : 'Bridge autostart removed.',
          `Background npm uninstall scheduled via ${result.npmCommand}.`,
          `Log: ${result.logPath}`,
          '当前命令退出后，后台会尝试执行 npm uninstall -g codelark。',
          '这一步不是立即完成；如需确认结果，请查看上面的日志文件。',
          '如果几秒后 codelark 仍可执行，请手动运行：npm uninstall -g codelark',
          '本命令不会删除 ~/.codelark 或 ~/.codex/skills/codelark，请按需手动删除。',
        ].join('\n') + '\n',
      );
      return;
    }

    case 'status': {
      const ui = getUiServerStatus();
      const bridge = getBridgeStatus();
      const url = getCurrentUiServerUrl();
      const autostart = await getBridgeAutostartStatus();
      process.stdout.write(
        [
          `UI: ${ui.running ? 'running' : 'stopped'}${url ? ` (${url})` : ''}`,
          `Bridge: ${bridge.running ? 'running' : 'stopped'}`,
          `Bridge Autostart: ${autostart.installed ? (autostart.enabled ? 'enabled' : 'disabled') : 'not installed'}`,
        ].join('\n') + '\n'
      );
      return;
    }

    case 'autostart': {
      const subcommand = parsed.args[0] || 'status';
      switch (subcommand) {
        case 'status': {
          const status = await getBridgeAutostartStatus();
          process.stdout.write(
            [
              `Supported: ${status.supported ? 'yes' : 'no'}`,
              `Installed: ${status.installed ? 'yes' : 'no'}`,
              `Enabled: ${status.enabled ? 'yes' : 'no'}`,
              `Mode: ${status.mode}`,
              `Task: ${status.taskName}`,
              status.runAsUser ? `Run As: ${status.runAsUser}` : undefined,
              status.state ? `State: ${status.state}` : undefined,
              status.error ? `Error: ${status.error}` : undefined,
            ].filter(Boolean).join('\n') + '\n',
          );
          return;
        }
        case 'install': {
          await ensureWindowsAdminSession();
          const password = await promptHidden('请输入当前 Windows 登录密码（用于创建开机启动任务）: ');
          const status = await installBridgeAutostart(password);
          process.stdout.write(`Bridge autostart installed. Task: ${status.taskName}\n`);
          return;
        }
        case 'uninstall': {
          const status = await uninstallBridgeAutostart();
          process.stdout.write(
            status.installed
              ? `Bridge autostart task still exists: ${status.taskName}\n`
              : 'Bridge autostart removed.\n',
          );
          return;
        }
        default:
          process.stderr.write(`未知 autostart 命令：${subcommand}\n`);
          process.stdout.write(`用法: ${PRIMARY_CLI_NAME} autostart [status|install|uninstall]\n`);
          process.exitCode = 1;
          return;
      }
    }

    default:
      process.stderr.write(`未知命令：${parsed.rawCommand || ''}\n`);
      process.stdout.write(buildCliHelpText());
      process.exitCode = 1;
  }
}

function realFileUrlFromPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return pathToFileURL(fs.realpathSync(resolved)).href;
  } catch {
    return pathToFileURL(resolved).href;
  }
}

function realFileUrlFromModuleUrl(moduleUrl: string): string {
  try {
    return realFileUrlFromPath(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl;
  }
}

export function isDirectCliRun(
  entrypoint = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (!entrypoint) return false;
  return realFileUrlFromModuleUrl(moduleUrl) === realFileUrlFromPath(entrypoint);
}

if (isDirectCliRun()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
