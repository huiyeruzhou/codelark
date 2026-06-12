import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as p from '@clack/prompts';
import { registerApp } from '@larksuiteoapi/node-sdk';

import { feishuSetupUserAuthScopeArgument } from '../channels/feishu/permissions.js';
import {
  type ClaudeExecutable,
  type RuntimeProvider,
} from '../runtime/options.js';
import { CODELARK_HOME, DEFAULT_WORKSPACE_ROOT } from '../configuration/paths.js';
import {
  type FeishuChannelConfig,
  type FeishuSite,
} from '../channels/types.js';
import { normalizeFeishuSite } from '../channels/feishu/site.js';
import { createConfigService } from '../configuration/service.js';
import type { ConfigPatch, ConfigV2 } from '../configuration/schema.js';
import {
  INSTALLABLE_SKILLS,
  OFFICIAL_LARK_DOC_SKILL,
  applyLarkCliRuntimeIdentityPolicy,
  buildLarkCliRuntimeEnv,
  ensureLarkCliRuntimeConfig,
  installCodexIntegration,
  resetLegacyStrictLarkCliRuntimeForSetup,
  type CodexIntegrationInstallResult,
  type ExternalSkillInstallResult,
} from '../local-service/manager.js';

const require = createRequire(import.meta.url);

export interface SetupOptions {
  reason?: 'first-run' | 'manual';
  cwd?: string;
  homeDir?: string;
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  site: FeishuSite;
  alias?: string;
  allowedUsers?: string[];
}

export interface RuntimeRecommendation {
  runtime: RuntimeProvider;
  claudeExecutable?: ClaudeExecutable;
  reason: string;
}

type SetupMode = 'existing' | 'qr' | 'manual';
type RuntimeChoice = 'codex' | 'ccr' | 'claude';
type LarkCliRunOptions = { homeDir?: string; input?: string; inheritStdio?: boolean; env?: NodeJS.ProcessEnv };
type TmuxPrerequisiteResult = 'available' | 'installed' | 'sdk-fallback';

function assertInteractiveTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('当前终端不支持交互输入，请在可交互终端中运行 `codelark setup`，或使用 `codelark run` 进入 Web 工作台配置。');
  }
}

function cancelIfNeeded<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('已取消配置。');
    process.exit(0);
  }
  return value;
}

export function recommendRuntime(homeDir = os.homedir()): RuntimeRecommendation {
  if (fs.existsSync(path.join(homeDir, '.codex'))) {
    return {
      runtime: 'codex',
      reason: '检测到 ~/.codex，默认使用 Codex。',
    };
  }
  if (fs.existsSync(path.join(homeDir, '.claude-code-router'))) {
    return {
      runtime: 'claude',
      claudeExecutable: 'ccr',
      reason: '检测到 ~/.claude-code-router，默认使用 Claude Code Router。',
    };
  }
  if (fs.existsSync(path.join(homeDir, '.claude-code')) || fs.existsSync(path.join(homeDir, '.claude'))) {
    return {
      runtime: 'claude',
      claudeExecutable: 'claude',
      reason: '检测到 Claude Code 配置，默认使用 Claude Code。',
    };
  }
  return {
    runtime: 'claude',
    claudeExecutable: 'claude',
    reason: '未检测到 Codex 或 Claude Code Router 配置，默认使用 Claude Code。',
  };
}

export function runtimeChoiceToConfig(choice: RuntimeChoice): NonNullable<ConfigPatch['runtime']> {
  if (choice === 'codex') return { agent: 'codex' };
  return {
    agent: 'claude',
    claude: {
      executable: choice === 'ccr' ? 'ccr' : 'claude',
      provider: 'tmux',
    },
  };
}

export function recommendedRuntimeChoice(recommendation: RuntimeRecommendation): RuntimeChoice {
  if (recommendation.runtime === 'codex') return 'codex';
  return recommendation.claudeExecutable === 'ccr' ? 'ccr' : 'claude';
}

function splitAllowedUsers(value: string): string[] | undefined {
  const users = value.split(',').map((item) => item.trim()).filter(Boolean);
  return users.length > 0 ? users : undefined;
}

function buildFeishuChannel(config: ConfigV2, credentials: FeishuCredentials): ConfigV2['channels'][number] {
  const existing = (config.channels || []).find((channel) => channel.provider === 'feishu');
  if (!existing) {
    throw new Error('Setup config is missing the Feishu channel template from defaults.toml.');
  }
  return {
    id: existing.id,
    alias: credentials.alias || existing.alias || '飞书',
    provider: 'feishu',
    enabled: true,
    config: {
      ...existing.config,
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      site: credentials.site,
      allowedUsers: credentials.allowedUsers ?? existing.config.allowedUsers,
      streamingEnabled: true,
      feedbackMarkdownEnabled: true,
    },
  };
}

export function buildSetupConfig(
  current: ConfigV2,
  credentials: FeishuCredentials,
  runtimeChoice: RuntimeChoice,
  workspaceRoot: string,
  options: { tmuxAvailable?: boolean } = {},
): ConfigV2 {
  const nextFeishu = buildFeishuChannel(current, credentials);
  const runtimeConfig = runtimeChoiceToConfig(runtimeChoice);
  const tmuxAvailable = options.tmuxAvailable !== false;
  return {
    ...current,
    runtime: {
      ...current.runtime,
      ...runtimeConfig,
      codex: {
        ...current.runtime.codex,
        provider: tmuxAvailable ? (current.runtime.codex.provider || 'tmux') : 'sdk',
      },
      claude: {
        ...current.runtime.claude,
        ...(runtimeConfig.claude || {}),
        provider: tmuxAvailable
          ? (runtimeConfig.claude?.provider || current.runtime.claude.provider || 'tmux')
          : 'sdk',
      },
    },
    bridge: {
      ...current.bridge,
      defaultWorkspace: workspaceRoot,
    },
    channels: [
      nextFeishu,
      ...(current.channels || []).filter((channel) => channel.id !== nextFeishu.id),
    ],
  };
}

export function loadSetupConfig(codelarkHome = CODELARK_HOME): ConfigV2 {
  return createConfigService({ codelarkHome, env: {} }).snapshot().config;
}

function homeWritableSetupPatch(config: ConfigV2): ConfigPatch {
  return {
    schemaVersion: config.schemaVersion,
    runtime: config.runtime,
    bridge: config.bridge,
    channels: config.channels,
  };
}

export function saveSetupConfigToHomeToml(config: ConfigV2, codelarkHome = CODELARK_HOME): void {
  createConfigService({ codelarkHome, migrate: false })
    .replace({ kind: 'home' }, homeWritableSetupPatch(config));
}

function resolveLarkCliScript(): string {
  return require.resolve('@larksuite/cli/scripts/run.js');
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/gs, '')
    .replace(/\x1b[@-_]/g, '');
}

function trimUrlPunctuation(url: string): string {
  return url.replace(/[),.;\]}，。；）】]+$/u, '');
}

export interface TmuxInstallGuidance {
  title: string;
  lines: string[];
  command: string;
  commandDisplay: string;
}

export function buildTmuxInstallGuidance(platform: NodeJS.Platform = process.platform): TmuxInstallGuidance {
  if (platform === 'darwin') {
    return {
      title: 'tmux 未安装',
      lines: [
        'CodeLark 默认使用 tmux provider，需要本机 PATH 中存在 tmux 命令。',
        'macOS 安装命令：',
        'brew install tmux',
        '安装完成后向导会再次检测 tmux 是否可用。',
      ],
      command: 'brew install tmux',
      commandDisplay: 'brew install tmux',
    };
  }
  if (platform === 'win32') {
    return {
      title: 'tmux 未安装',
      lines: [
        'CodeLark 默认使用 tmux provider，需要本机 PATH 中存在 tmux 命令。',
        'Windows 请安装 psmux，它会提供兼容的 tmux.exe 命令：',
        'winget install --id marlocarlo.psmux --accept-package-agreements --accept-source-agreements',
        '安装完成后向导会再次检测 tmux 是否可用；如果 PATH 尚未刷新，请重新打开 PowerShell / Windows Terminal 后再运行 codelark setup。',
      ],
      command: 'winget install --id marlocarlo.psmux --accept-package-agreements --accept-source-agreements',
      commandDisplay: 'winget install --id marlocarlo.psmux --accept-package-agreements --accept-source-agreements',
    };
  }
  if (platform === 'linux') {
    return {
      title: 'tmux 未安装',
      lines: [
        'CodeLark 默认使用 tmux provider，需要本机 PATH 中存在 tmux 命令。',
        'Linux 安装命令：',
        'sudo apt update && sudo apt install -y tmux',
        '安装完成后向导会再次检测 tmux 是否可用。',
      ],
      command: 'sudo apt update && sudo apt install -y tmux',
      commandDisplay: 'sudo apt update && sudo apt install -y tmux',
    };
  }
  return {
    title: 'tmux 未安装',
    lines: [
      'CodeLark 默认使用 tmux provider，需要本机 PATH 中存在 tmux 命令。',
      '请使用当前系统的包管理器安装 tmux，并确认 tmux -V 可以正常执行。',
      '安装完成后请重新打开终端，再运行 codelark setup。',
    ],
    command: '',
    commandDisplay: '请手动安装 tmux',
  };
}

export async function isTmuxCommandAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn('tmux', ['-V'], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function runTmuxInstallCommand(guidance: TmuxInstallGuidance): Promise<void> {
  if (!guidance.command) {
    throw new Error(guidance.lines.join('\n'));
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(guidance.command, {
      stdio: 'inherit',
      shell: true,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tmux 安装命令退出失败：${signal || code}`));
    });
  });
}

async function promptTmuxPrerequisite(): Promise<TmuxPrerequisiteResult> {
  if (await isTmuxCommandAvailable()) return 'available';

  const guidance = buildTmuxInstallGuidance();
  p.note([
    ...guidance.lines,
    '',
    `即将执行：${guidance.commandDisplay}`,
  ].join('\n'), guidance.title);
  const shouldInstall = cancelIfNeeded(await p.confirm({
    message: '未检测到 tmux，是否现在自动安装？',
    initialValue: true,
  }));
  if (!shouldInstall) {
    p.note(
      [
        '本次向导将继续完成配置，但不会默认使用 tmux provider。',
        '将写入 runtime.codex.provider=sdk，并把 Claude 默认 provider 写为 runtime.claude.provider=sdk。',
        '之后安装 tmux 后，可通过 IM 命令 `/provider tmux` 或配置文件切回 tmux。',
      ].join('\n'),
      '改用 SDK provider',
    );
    return 'sdk-fallback';
  }

  p.note(`开始执行：${guidance.commandDisplay}`, '安装 tmux');
  await runTmuxInstallCommand(guidance);
  if (await isTmuxCommandAvailable()) {
    p.note('tmux 已安装并可执行。', 'tmux 已就绪');
    return 'installed';
  }
  throw new Error([
    'tmux 安装命令已执行，但当前终端仍检测不到 tmux。',
    '请重新打开终端后运行 `tmux -V` 检查 PATH，再重新运行 `codelark setup`。',
  ].join('\n'));
}

export function extractHttpUrlsFromText(text: string): string[] {
  const cleaned = stripAnsi(text);
  const urls = new Set<string>();
  for (const match of cleaned.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
    const url = trimUrlPunctuation(match[0]);
    if (url) urls.add(url);
  }
  return [...urls];
}

export async function renderLarkCliUrlQr(url: string): Promise<string> {
  const script = resolveLarkCliScript();
  const qr = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [script, 'auth', 'qrcode', url, '--ascii'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(stdout.trimEnd());
        return;
      }
      reject(new Error(`lark-cli auth qrcode 退出失败：${signal || code}${stderr ? `\n${stderr.trim()}` : ''}`));
    });
  });
  return [
    '',
    qr,
    '',
  ].join('\n');
}

async function runLarkCli(
  args: string[],
  options: LarkCliRunOptions = {},
): Promise<void> {
  const script = resolveLarkCliScript();
  const inheritStdio = options.inheritStdio !== false;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: [
        inheritStdio && options.input === undefined ? 'inherit' : 'pipe',
        'pipe',
        'pipe',
      ],
      env: {
        ...process.env,
        ...(options.env || {}),
        ...(options.homeDir ? {
          HOME: options.homeDir,
          USERPROFILE: options.homeDir,
          XDG_DATA_HOME: path.join(options.homeDir, '.local', 'share'),
        } : {}),
      },
    });
    let combinedOutput = '';
    const renderedUrls = new Set<string>();
    let qrRenderQueue = Promise.resolve();
    let stderr = '';
    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
    const handleOutput = (chunk: Buffer, stream: NodeJS.WriteStream) => {
      const text = chunk.toString();
      if (inheritStdio) stream.write(chunk);
      combinedOutput += text;
      for (const url of extractHttpUrlsFromText(combinedOutput)) {
        if (renderedUrls.has(url)) continue;
        renderedUrls.add(url);
        qrRenderQueue = qrRenderQueue
          .then(() => renderLarkCliUrlQr(url))
          .then((rendered) => {
            if (inheritStdio) process.stdout.write(rendered);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (inheritStdio) process.stderr.write(`\n生成授权二维码失败：${message}\n`);
          });
      }
      if (combinedOutput.length > 20_000) {
        combinedOutput = combinedOutput.slice(-10_000);
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      handleOutput(chunk, process.stdout);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      handleOutput(chunk, process.stderr);
    });
    child.on('error', reject);
    child.on('exit', async (code, signal) => {
      await qrRenderQueue;
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`lark-cli ${args.join(' ')} 退出失败：${signal || code}${stderr ? `\n${stderr.trim()}` : ''}`));
    });
  });
}

async function hasCodeLarkUserAuthorization(): Promise<boolean> {
  try {
    await runLarkCli(
      [
        'auth',
        'check',
        '--scope',
        feishuSetupUserAuthScopeArgument(),
      ],
      { env: buildLarkCliRuntimeEnv(), inheritStdio: false },
    );
    return true;
  } catch {
    return false;
  }
}

async function ensureCodeLarkUserAuthorization(config: ConfigV2): Promise<void> {
  // 先于常规 readiness check 清理旧 runtime。旧 bot-only runtime 可能让
  // bot 操作看起来可用，但仍然阻止 setup 接下来要申请的用户身份。
  const resetLegacyRuntime = resetLegacyStrictLarkCliRuntimeForSetup(config);
  if (resetLegacyRuntime) {
    p.note(
      [
        '检测到旧版 CodeLark 私有 lark-cli runtime 使用 bot-only strict policy。',
        '已清理该隔离 runtime，本次 setup 会重新完成用户授权。',
      ].join('\n'),
      '飞书权限需重新授权',
    );
  }
  const runtime = await ensureLarkCliRuntimeConfig(config, { allowUserAuthorization: true });
  if (runtime.warning) {
    throw new Error(runtime.warning);
  }
  if (await hasCodeLarkUserAuthorization()) {
    p.note(
      '检测到 CodeLark 私有 lark-cli 配置已经包含 doc-to-chat 所需用户授权，本次 setup 不会重复打开授权页面。',
      '飞书权限已就绪',
    );
    return;
  }

  const preLoginPolicyWarning = await applyLarkCliRuntimeIdentityPolicy(true);
  if (preLoginPolicyWarning) {
    throw new Error(preLoginPolicyWarning);
  }

  p.note(
    [
      '接下来会打开 CodeLark 当前飞书应用的用户授权扫码流程。',
      '授权写入 ~/.codelark/runtime/lark-cli，不读取用户 HOME 下的默认 ~/.lark-cli。',
      `Scope：${feishuSetupUserAuthScopeArgument()}`,
    ].join('\n'),
    '飞书权限申请',
  );
  await runLarkCli(
    [
      'auth',
      'login',
      '--recommend',
      '--scope',
      feishuSetupUserAuthScopeArgument(),
    ],
    { env: buildLarkCliRuntimeEnv() },
  );
  // login 会把 user 写进私有 lark-cli config。这里立即刷新 runtime policy，
  // 但不要再次 bind --force；重复绑定同一个 app 可能覆盖刚写入的 user。
  const policyWarning = await applyLarkCliRuntimeIdentityPolicy(true);
  if (policyWarning) {
    throw new Error(policyWarning);
  }
  if (!(await hasCodeLarkUserAuthorization())) {
    throw new Error(
      [
        '飞书用户授权流程已结束，但 CodeLark 私有 lark-cli runtime 仍未通过权限检查。',
        '这通常表示重复授权同一个 bot 后本地 runtime 未写入 user，或当前进程无法读取 lark-cli keychain。',
        '请重新运行 setup；如果仍失败，请先在交互式终端运行 lark-cli config keychain-downgrade 后再重试。',
      ].join('\n'),
    );
  }
}

function existingFeishuCredentials(current?: FeishuChannelConfig): FeishuCredentials | null {
  const appId = current?.appId?.trim();
  const appSecret = current?.appSecret?.trim();
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    site: normalizeFeishuSite(current?.site),
    alias: '飞书',
    allowedUsers: current?.allowedUsers,
  };
}

async function selectSetupMode(hasExistingCodeLarkConfig: boolean): Promise<SetupMode> {
  const options: Array<{ value: SetupMode; label: string; hint: string }> = [
    ...(hasExistingCodeLarkConfig
      ? [{
          value: 'existing' as const,
          label: '使用现有 CodeLark 配置',
          hint: '从 ~/.codelark/config.toml 加载，不读取 ~/.lark-cli',
        }]
      : []),
    {
      value: 'qr',
      label: '扫码创建新的机器人配置',
      hint: '通过开放平台扫码创建 App，不读取用户 HOME 下的 .lark-cli',
    },
    {
      value: 'manual',
      label: '手动粘贴 App ID / Secret',
      hint: '已有飞书开放平台机器人凭据时使用',
    },
  ];
  return cancelIfNeeded(await p.select<SetupMode>({
    message: '选择飞书机器人配置方式',
    initialValue: hasExistingCodeLarkConfig ? 'existing' : 'qr',
    options,
  }));
}

async function scanNewBotCredentials(): Promise<FeishuCredentials> {
  p.note(
    [
      '接下来会打开扫码创建流程。',
      'App ID / App Secret 直接来自开放平台扫码创建结果，不读取用户 HOME 下的 ~/.lark-cli。',
      '请按终端中的链接或二维码完成授权；命令结束后会回到 CodeLark 向导。',
    ].join('\n'),
    '扫码创建',
  );
  const result = await registerApp({
    source: 'codelark',
    onQRCodeReady: async (info) => {
      const minutes = Math.max(1, Math.round(info.expireIn / 60));
      const qr = await renderLarkCliUrlQr(info.url);
      process.stdout.write([
        '',
        '请用飞书/Lark App 扫描以下二维码完成应用创建：',
        `二维码有效期：约 ${minutes} 分钟`,
        `也可以直接打开：${info.url}`,
        qr.trimEnd(),
        '',
      ].join('\n'));
    },
    onStatusChange: (info) => {
      if (info.status === 'domain_switched') {
        console.log('识别到国际版租户，已切换到 larksuite.com。');
      } else if (info.status === 'slow_down') {
        console.log('扫码状态轮询已自动降速。');
      }
    },
  });
  const site = normalizeFeishuSite(result.user_info?.tenant_brand);
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    site,
    alias: '飞书',
    allowedUsers: result.user_info?.open_id ? [result.user_info.open_id] : undefined,
  };
}

async function promptManualCredentials(current?: FeishuChannelConfig): Promise<FeishuCredentials> {
  const appId = cancelIfNeeded(await p.text({
    message: '飞书 App ID',
    initialValue: current?.appId || '',
    validate(value) {
      return String(value || '').trim() ? undefined : 'App ID 不能为空。';
    },
  })).trim();
  const secretInput = cancelIfNeeded(await p.password({
    message: current?.appSecret ? '飞书 App Secret（留空表示保持不变）' : '飞书 App Secret',
    validate(value) {
      if (current?.appSecret && !String(value || '').trim()) return undefined;
      return String(value || '').trim() ? undefined : 'App Secret 不能为空。';
    },
  })).trim();
  const site = cancelIfNeeded(await p.select<FeishuSite>({
    message: '选择飞书站点',
    initialValue: current?.site || 'feishu',
    options: [
      { value: 'feishu', label: '飞书（open.feishu.cn）' },
      { value: 'lark', label: 'Lark（open.larksuite.com）' },
    ],
  }));
  return {
    appId,
    appSecret: secretInput || current?.appSecret || '',
    site,
    alias: '飞书',
  };
}

async function promptRuntime(homeDir: string): Promise<RuntimeChoice> {
  const recommendation = recommendRuntime(homeDir);
  const initialValue = recommendedRuntimeChoice(recommendation);
  p.note(recommendation.reason, 'Runtime 推荐');
  return cancelIfNeeded(await p.select<RuntimeChoice>({
    message: '确认默认 runtime',
    initialValue,
    options: [
      { value: 'codex', label: 'Codex', hint: '检测到 ~/.codex 时推荐' },
      { value: 'ccr', label: 'Claude Code Router', hint: '写入 runtime=claude，claudeExecutable=ccr' },
      { value: 'claude', label: 'Claude Code', hint: '写入 runtime=claude，claudeExecutable=claude' },
    ],
  }));
}

async function promptWorkspaceRoot(cwd: string): Promise<string> {
  const workspace = cancelIfNeeded(await p.text({
    message: '默认工作目录（/new 未指定目录时使用）',
    initialValue: cwd,
    validate(value) {
      return String(value || '').trim() ? undefined : '工作目录不能为空。';
    },
  })).trim();
  return path.resolve(workspace || cwd || DEFAULT_WORKSPACE_ROOT);
}

async function promptCodexSkillInstallSelection(): Promise<string[]> {
  p.note(
    [
      'CodeLark 内置 skills 会安装到 ~/.codex/skills，只有 Codex 在任务匹配时才会读取。',
      '官方 lark-doc 使用 npx skills add larksuite/cli -s lark-doc -y -g -a claude-code 安装。',
      '默认全选。可逐个关闭，不需要时也可以全部取消。',
    ].join('\n'),
    '可选 Skills',
  );
  return cancelIfNeeded(await p.multiselect<string>({
    message: '选择要安装/确认的 skills（空格选择，回车确认）',
    initialValues: INSTALLABLE_SKILLS.map((skill) => skill.name),
    required: false,
    options: INSTALLABLE_SKILLS.map((skill) => ({
      value: skill.name,
      label: `${skill.name} - ${skill.label}`,
      hint: skill.description,
    })),
  }));
}

async function promptAllowedUsers(current?: FeishuChannelConfig): Promise<string[] | undefined> {
  const raw = cancelIfNeeded(await p.text({
    message: '允许的飞书 open_id（逗号分隔；留空表示不限制）',
    initialValue: current?.allowedUsers?.join(',') || '',
  })).trim();
  return splitAllowedUsers(raw);
}

function splitSelectedSkillNames(skillNames: string[]): { bundled: string[]; external: string[] } {
  return {
    bundled: skillNames.filter((name) => name !== OFFICIAL_LARK_DOC_SKILL.name),
    external: skillNames.filter((name) => name === OFFICIAL_LARK_DOC_SKILL.name),
  };
}

async function installSelectedCodexSkillsWithProgress(skillNames: string[]): Promise<{
  result: CodexIntegrationInstallResult | null;
  bundledError?: string;
  externalError?: string;
}> {
  const selected = splitSelectedSkillNames(skillNames);
  let result: CodexIntegrationInstallResult | null = null;
  let bundledError: string | undefined;
  let externalError: string | undefined;

  if (selected.bundled.length > 0) {
    const spinner = p.spinner();
    spinner.start('安装 CodeLark 本地 skills');
    try {
      result = await installCodexIntegration({
        skillNames: selected.bundled,
        skipExternalSkills: true,
      });
      spinner.stop(`本地 skills 已安装/确认：${result.skills.map((skill) => skill.name).join(', ')}`);
    } catch (error) {
      bundledError = error instanceof Error ? error.message : String(error);
      spinner.stop('本地 skills 安装失败');
    }
  }

  if (selected.external.length > 0) {
    const spinner = p.spinner();
    spinner.start('安装官方 lark-doc skill');
    try {
      const externalResult = await installCodexIntegration({
        skillNames: selected.external,
      });
      const mergedSkills = result?.skills ?? [];
      result = {
        ...externalResult,
        name: mergedSkills[0]?.name || externalResult.name,
        targetDir: mergedSkills[0]?.targetDir || externalResult.targetDir,
        method: mergedSkills[0]?.method || externalResult.method,
        skills: mergedSkills,
        externalSkills: externalResult.externalSkills,
      };
      spinner.stop(`官方 lark-doc 已安装/确认：${externalResult.externalSkills.map((skill) => skill.name).join(', ')}`);
    } catch (error) {
      const enriched = error as Error & { result?: ExternalSkillInstallResult };
      externalError = enriched.message || String(error);
      spinner.stop('官方 lark-doc 安装失败');
    }
  }

  return { result, bundledError, externalError };
}

export async function runSetupWizard(options: SetupOptions = {}): Promise<void> {
  assertInteractiveTerminal();
  const current = loadSetupConfig();
  const existingFeishu = (current.channels || []).find((channel) => channel.provider === 'feishu');
  const existingFeishuConfig = existingFeishu?.config as FeishuChannelConfig | undefined;
  const existingCredentials = existingFeishuCredentials(existingFeishuConfig);
  const homeDir = options.homeDir || os.homedir();
  const cwd = path.resolve(options.cwd || process.cwd());

  p.intro(options.reason === 'first-run' ? 'CodeLark 首次配置' : 'CodeLark 配置向导');
  const tmuxPrerequisite = await promptTmuxPrerequisite();

  const mode = await selectSetupMode(Boolean(existingCredentials));
  const credentials = mode === 'existing'
    ? existingCredentials!
    : mode === 'qr'
      ? await scanNewBotCredentials()
      : await promptManualCredentials(existingFeishuConfig);
  credentials.allowedUsers = await promptAllowedUsers(existingFeishuConfig);

  const runtimeChoice = await promptRuntime(homeDir);
  const workspaceRoot = await promptWorkspaceRoot(cwd);
  const selectedCodexSkillNames = await promptCodexSkillInstallSelection();
  const shouldSave = cancelIfNeeded(await p.confirm({
    message: '保存以上配置到 ~/.codelark/config.toml？',
    initialValue: true,
  }));
  if (!shouldSave) {
    p.cancel('未保存配置。');
    return;
  }

  const next = buildSetupConfig(current, credentials, runtimeChoice, workspaceRoot, {
    tmuxAvailable: tmuxPrerequisite !== 'sdk-fallback',
  });
  saveSetupConfigToHomeToml(next);
  try {
    await ensureCodeLarkUserAuthorization(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(
      [
        'CodeLark 配置已保存，但用户 OAuth 授权未完成。',
        message,
        '后续 doc-to-chat 需要用户身份建群时，请重新运行 `codelark setup` 完成授权。',
      ].join('\n'),
      '用户授权未完成',
    );
  }

  let codexSkillsSummary = '';
  if (selectedCodexSkillNames.length === 0) {
    codexSkillsSummary = 'Skills：已跳过安装。稍后可手动运行 bash scripts/install-codex-skills.sh。';
  } else {
    const install = await installSelectedCodexSkillsWithProgress(selectedCodexSkillNames);
    const installedNames = [
      ...(install.result?.skills.map((skill) => skill.name) ?? []),
      ...(install.result?.externalSkills.map((skill) => skill.name) ?? []),
    ];
    const issues = [
      install.bundledError ? `本地 skills 失败：${install.bundledError}` : '',
      install.externalError ? `官方 lark-doc 失败：${install.externalError}` : '',
    ].filter(Boolean);
    codexSkillsSummary = installedNames.length > 0
      ? `Skills：已安装/确认 ${installedNames.join(', ')}${issues.length > 0 ? `；${issues.join('；')}` : ''}`
      : `Skills：安装失败，稍后可手动运行 codelark install-skills。${issues.join('；')}`;
    if (issues.length > 0) {
      p.note(
        [
          'CodeLark 本地 skills 与官方 lark-doc 分开安装。',
          installedNames.length > 0 ? `已可用：${installedNames.join(', ')}` : '当前没有确认可用的 skills。',
          ...issues,
        ].join('\n'),
        'Skills 安装结果',
      );
    }
  }

  const runtimeSummary = runtimeChoice === 'codex'
    ? 'Codex'
    : runtimeChoice === 'ccr'
      ? 'Claude Code Router'
      : 'Claude Code';
  p.outro(
    [
      '配置已保存。',
      `机器人：${credentials.appId} (${credentials.site})`,
      `默认 runtime：${runtimeSummary}`,
      `默认工作目录：${workspaceRoot}`,
      codexSkillsSummary,
      '',
      '启动方式：',
      '  codelark run',
      '或只启动后台 bridge：',
      '  codelark start',
    ].join('\n'),
  );
}
