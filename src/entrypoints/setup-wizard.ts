import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as p from '@clack/prompts';
import { registerApp } from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';

import { feishuSetupUserAuthScopeArgument } from '../channels/feishu/permissions.js';
import {
  CODELARK_HOME,
  DEFAULT_WORKSPACE_ROOT,
  loadConfig,
  normalizeFeishuSite,
  saveConfig,
  type ChannelInstance,
  type ClaudeExecutable,
  type Config,
  type FeishuChannelConfig,
  type FeishuSite,
  type RuntimeProvider,
} from '../configuration/index.js';
import {
  INSTALLABLE_SKILLS,
  OFFICIAL_LARK_DOC_SKILL,
  buildLarkCliRuntimeEnv,
  ensureLarkCliRuntimeConfig,
  installCodexIntegration,
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

export function runtimeChoiceToConfig(choice: RuntimeChoice): Pick<Config, 'runtime' | 'claudeExecutable' | 'claudeProvider'> {
  if (choice === 'codex') return { runtime: 'codex' };
  return {
    runtime: 'claude',
    claudeExecutable: choice === 'ccr' ? 'ccr' : 'claude',
    claudeProvider: 'pty',
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

function buildFeishuChannel(config: Config, credentials: FeishuCredentials): ChannelInstance {
  const existing = (config.channels || []).find((channel) => channel.provider === 'feishu');
  const timestamp = new Date().toISOString();
  const existingConfig = (existing?.config || {}) as FeishuChannelConfig;
  return {
    id: existing?.id || 'feishu-default',
    alias: credentials.alias || existing?.alias || '飞书',
    provider: 'feishu',
    enabled: true,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    config: {
      ...existingConfig,
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      site: credentials.site,
      allowedUsers: credentials.allowedUsers,
      streamingEnabled: true,
      feedbackMarkdownEnabled: true,
    },
  };
}

export function buildSetupConfig(
  current: Config,
  credentials: FeishuCredentials,
  runtimeChoice: RuntimeChoice,
  workspaceRoot: string,
): Config {
  const nextFeishu = buildFeishuChannel(current, credentials);
  const runtimeConfig = runtimeChoiceToConfig(runtimeChoice);
  return {
    ...current,
    ...runtimeConfig,
    defaultWorkspaceRoot: workspaceRoot,
    defaultProvider: current.defaultProvider || 'tmux',
    defaultMode: current.defaultMode || 'normal',
    historyMessageLimit: current.historyMessageLimit || 8,
    streamStatusIdleStartSeconds: current.streamStatusIdleStartSeconds || 60,
    streamStatusCheckIntervalSeconds: current.streamStatusCheckIntervalSeconds || 5,
    codexSkipGitRepoCheck: current.codexSkipGitRepoCheck !== false,
    codexSandboxMode: current.codexSandboxMode || 'workspace-write',
    codexNetworkAccess: current.codexNetworkAccess !== false,
    codexReasoningEffort: current.codexReasoningEffort || 'medium',
    claudeExecutable: runtimeConfig.claudeExecutable || current.claudeExecutable,
    claudeProvider: runtimeConfig.claudeProvider || current.claudeProvider || 'sdk',
    uiAllowLan: current.uiAllowLan === true,
    channels: [
      nextFeishu,
      ...(current.channels || []).filter((channel) => channel.id !== nextFeishu.id),
    ],
  };
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
  const qr = await QRCode.toString(url, {
    type: 'terminal',
    errorCorrectionLevel: 'M',
    margin: 1,
  });
  return [
    '',
    '检测到 lark-cli 授权链接，可扫码打开：',
    url,
    qr.trimEnd(),
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

async function ensureCodeLarkUserAuthorization(config: Config): Promise<void> {
  const runtime = await ensureLarkCliRuntimeConfig(config);
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
          hint: '从 ~/.codelark/config.json 或 config.env 加载，不读取 ~/.lark-cli',
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
      const qr = await QRCode.toString(info.url, {
        type: 'terminal',
        errorCorrectionLevel: 'M',
        margin: 1,
      });
      const minutes = Math.max(1, Math.round(info.expireIn / 60));
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
  const current = loadConfig();
  const existingFeishu = (current.channels || []).find((channel) => channel.provider === 'feishu');
  const existingFeishuConfig = existingFeishu?.config as FeishuChannelConfig | undefined;
  const existingCredentials = existingFeishuCredentials(existingFeishuConfig);
  const homeDir = options.homeDir || os.homedir();
  const cwd = path.resolve(options.cwd || process.cwd());

  p.intro(options.reason === 'first-run' ? 'CodeLark 首次配置' : 'CodeLark 配置向导');

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
    message: '保存以上配置到 ~/.codelark/config.json 和 config.env？',
    initialValue: true,
  }));
  if (!shouldSave) {
    p.cancel('未保存配置。');
    return;
  }

  const next = buildSetupConfig(current, credentials, runtimeChoice, workspaceRoot);
  saveConfig(next);
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
