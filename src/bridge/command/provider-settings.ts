import type {
  CodexReasoningEffort,
  CodexSandboxMode,
} from '../../runtime/options.js';
import { createConfigService } from '../../configuration/service.js';
import type { RuntimeProviderChoice } from '../../domain/session.js';
import type { BridgeStore, ChannelChat, InboundMessage } from '../../domain/index.js';
import {
  getSessionClaudeSessionId,
  getSessionActiveRuntime,
  getSessionWorkingDirectory,
  mergeSessionRuntimeUpdates,
  setSessionClaudeTmuxProviderUpdate,
  setSessionCodexThreadIdUpdate,
  setSessionCodexTmuxProviderUpdate,
} from '../../domain/session-runtime.js';
import {
  CodexResumeTmuxLaunchError,
  claudeTmuxSessionName,
  codexTmuxSessionName,
  startRuntimeTmuxSession,
} from '../tmux/runtime.js';
import { getCodexThreadId } from '../turn/turn-classifier.js';
import {
  resolveEffectiveClaudeProvider,
  resolveEffectiveCodexProvider,
  resolveClaudeRuntimeConfig,
  resolveSessionRuntimeConfig,
} from '../session/support.js';
import { buildCommandFields } from './presentation.js';
import {
  bootstrapCodexThreadLocally,
  type RuntimeSettingsCommandDeps,
} from './runtime-bootstrap.js';
import {
  buildRuntimeSwitchWhileRunningResponse,
  formatSessionClaudeProvider,
  formatSessionCodexProvider,
  formatSessionMode,
  reconcileMirrorSubscriptionsBestEffort,
  sessionHasActiveRuntimeTurn,
} from './runtime-session.js';
import * as router from '../session/channel-router.js';
import {
  CODEX_PROVIDER_OPTIONS_TEXT,
  CLAUDE_PROVIDER_OPTIONS_TEXT,
  formatTmuxProviderUnavailable,
  parseCodexProviderArg,
  parseClaudeProviderArg,
} from './runtime-settings-options.js';

function setSessionCodexProviderToml(sessionId: string, provider: 'sdk' | 'tmux' | 'pty'): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { codex: { provider } } },
  );
}

function setSessionClaudeProviderToml(sessionId: string, provider: RuntimeProviderChoice): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { claude: { provider } } },
  );
}

function setSessionTmuxAutoEnterToml(sessionId: string, tmuxAutoEnter: boolean): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { session: { tmuxAutoEnter } },
  );
}

function claudeProviderSwitchNote(provider: RuntimeProviderChoice): string {
  switch (provider) {
    case 'sdk':
      return '之后的普通消息会使用 Claude Agent SDK 原生事件路径；Claude pty/tmux TUI 会话不会自动关闭。';
    case 'tmux':
      return '之后的普通消息会使用 Claude Code tmux/mirror 路径；SDK/pty session 不会自动关闭。';
    case 'pty':
      return '之后的普通消息会使用 Claude Code pty/mirror 路径；SDK/tmux session 不会自动关闭。';
  }
}

function truncateForCommandResponse(value: string | undefined, limit = 500): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+$/g, '').replace(/\r?\n/g, ' / ');
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function truncateBlockForCommandResponse(value: string | undefined, limit = 1_500): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+$/g, '');
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function fencedBlock(value: string | undefined, language = ''): string | undefined {
  const body = truncateBlockForCommandResponse(value);
  if (!body) return undefined;
  return `\`\`\`${language}\n${body.replace(/\`\`\`/g, '\`\`\u200b\`')}\n\`\`\``;
}

function formatCodexTmuxLaunchFailure(
  error: CodexResumeTmuxLaunchError,
  currentProvider: RuntimeProviderChoice,
  markdown: boolean,
): string {
  const details = error.details;
  const diagnosticCommands = details.commands
    .filter((command) => command !== details.killCommand)
    .slice(-6)
    .join(' ; ');
  const fields: Array<[string, string | null | undefined]> = [
    ['Runtime', 'codex'],
    ['Provider', `未切换（仍为 ${currentProvider}）`],
    ['tmux session', details.sessionName],
    ['tmux session 仍存在', details.sessionExists === undefined ? undefined : details.sessionExists ? 'yes' : 'no'],
    ['codex_thread_id', details.threadId],
    ['cwd', details.workingDirectory],
    ['失败原因', details.reason],
    ['最后错误', details.lastError],
    ['最后屏幕', truncateForCommandResponse(details.lastScreen)],
  ];
  const base = buildCommandFields('Codex tmux 启动失败', fields, [], markdown);
  const sections = [base];
  const launchOutput = fencedBlock(details.launchOutput, 'text');
  if (launchOutput) sections.push(markdown ? `**原进程输出**\n${launchOutput}` : `原进程输出\n${launchOutput}`);
  const diagnosticCommand = fencedBlock(diagnosticCommands, 'bash');
  if (diagnosticCommand) sections.push(markdown ? `**诊断命令**\n${diagnosticCommand}` : `诊断命令\n${diagnosticCommand}`);
  sections.push(markdown
    ? [
      '**说明**',
      '- 没有写入 `runtime.codex.provider=tmux`，也没有把当前会话绑定到这个 tmux session。',
      '- 请根据失败原因检查 Codex CLI 是否能在本机 TUI 模式启动；修复后重新发送 `/p tmux`。',
    ].join('\n')
    : [
      '说明',
      '- 没有写入 `runtime.codex.provider=tmux`，也没有把当前会话绑定到这个 tmux session。',
      '- 请根据失败原因检查 Codex CLI 是否能在本机 TUI 模式启动；修复后重新发送 `/p tmux`。',
    ].join('\n'));
  return sections.filter(Boolean).join('\n\n');
}

export async function handleProviderCommand(options: {
  msg: InboundMessage;
  args: string;
  currentBinding: ChannelChat | null;
  store: BridgeStore;
  deps: RuntimeSettingsCommandDeps;
  markdown: boolean;
}): Promise<string> {
  const binding = options.currentBinding || router.resolve(options.msg.address);
  const session = options.store.getSession(binding.bridgeSessionId);
  if (!session) {
    return '当前会话不存在。';
  }
  if (getSessionActiveRuntime(session) === 'claude') {
    if (!options.args) {
      const codexSessionId = binding.runtimeBridgeSessionIds?.codex;
      const codexSession = codexSessionId ? options.store.getSession(codexSessionId) : null;
      return buildCommandFields(
        '当前 Claude Provider',
        [
          ['Runtime', 'claude'],
          ['Provider', formatSessionClaudeProvider(session, binding)],
          ['Claude executable', resolveClaudeRuntimeConfig(session, binding)?.executable || 'claude'],
          ['记住的 Codex BridgeSession', codexSession?.id || '-'],
          ['记住的 Codex Provider', codexSession ? formatSessionCodexProvider(codexSession, binding) : '-'],
        ],
        [CLAUDE_PROVIDER_OPTIONS_TEXT, '发送 `/provider pty|tmux|sdk` 或 `/p pty|tmux|sdk` 切换；修改从下一轮 Claude 请求开始生效。'],
        options.markdown,
      );
    }
    const requestedProvider = parseClaudeProviderArg(options.args);
    if (!requestedProvider) {
      return buildCommandFields(
        'Claude Provider 用法',
        [['命令', '`/provider pty|tmux|sdk` 或 `/p pty|tmux|sdk`']],
        [CLAUDE_PROVIDER_OPTIONS_TEXT],
        options.markdown,
      );
    }
    if (requestedProvider !== resolveEffectiveClaudeProvider(session, binding)
      && sessionHasActiveRuntimeTurn(options.deps, session)) {
      return buildRuntimeSwitchWhileRunningResponse({
        commandLabel: '`/provider`',
        runtime: 'claude',
        provider: requestedProvider,
        markdown: options.markdown,
      });
    }
    let claudeTmuxStartResult: { existed: boolean } | null = null;
    if (requestedProvider === 'tmux') {
      const tmuxSessionName = claudeTmuxSessionName(getSessionClaudeSessionId(session) || session.id);
      const claudeConfig = resolveClaudeRuntimeConfig(session, binding);
      try {
        await options.deps.notifyBackgroundOperation?.(`正在启动 tmux 后台会话 \`${tmuxSessionName}\` 并运行 Claude Code TUI。`);
        claudeTmuxStartResult = await startRuntimeTmuxSession({
          runtime: 'claude',
          sessionName: tmuxSessionName,
          bridgeSessionId: session.id,
          workingDirectory: getSessionWorkingDirectory(session),
          executable: claudeConfig.executable,
          model: claudeConfig.model,
          permissionMode: claudeConfig.permissionMode,
          reasoningEffort: claudeConfig.reasoningEffort,
          recreate: true,
        });
      } catch (error) {
        const unavailable = formatTmuxProviderUnavailable(error);
        if (unavailable) return unavailable;
        throw error;
      }
      options.store.updateSession(session.id, setSessionClaudeTmuxProviderUpdate({
        tmuxSessionName,
        autoEnter: true,
      }));
      setSessionTmuxAutoEnterToml(session.id, true);
    }
    setSessionClaudeProviderToml(session.id, requestedProvider);
    await reconcileMirrorSubscriptionsBestEffort(options.deps, `claude provider ${requestedProvider} switch`);
    return buildCommandFields(
      '已切换 Claude Provider',
      [
        ['Runtime', 'claude'],
        ['Provider', requestedProvider],
        ...(requestedProvider === 'tmux'
          ? [['tmux session', claudeTmuxSessionName(getSessionClaudeSessionId(session) || session.id)] as [string, string]]
          : []),
      ],
      [
        claudeProviderSwitchNote(requestedProvider),
        ...(requestedProvider === 'tmux'
          ? [
            claudeTmuxStartResult?.existed
              ? '同名 tmux session 已存在，已先销毁并重新启动 Claude Code TUI。'
              : '已启动 Claude Code TUI。',
            '这是 `/p tmux` 的标准行为：每次都会强制重新加载同名 tmux session，确保新的 TUI 启动参数生效。',
          ]
          : []),
      ],
      options.markdown,
    );
  }
  if (!options.args) {
    return buildCommandFields(
      '当前 Codex Provider',
      [
        ['模式', formatSessionMode(binding, session)],
        ['Provider', formatSessionCodexProvider(session, binding)],
      ],
      [CODEX_PROVIDER_OPTIONS_TEXT, '发送 `/provider sdk|pty|tmux` 或 `/p sdk|pty|tmux` 切换；修改从下一轮 Codex 请求开始生效。'],
      options.markdown,
    );
  }
  const requestedProvider = parseCodexProviderArg(options.args);
  if (!requestedProvider) {
    return buildCommandFields(
      'Codex Provider 用法',
      [['命令', '`/provider sdk|pty|tmux` 或 `/p sdk|pty|tmux`']],
      [CODEX_PROVIDER_OPTIONS_TEXT],
      options.markdown,
    );
  }
  const currentProvider = resolveEffectiveCodexProvider(session, binding);
  if ((requestedProvider !== currentProvider || requestedProvider === 'tmux') && sessionHasActiveRuntimeTurn(options.deps, session)) {
    return buildRuntimeSwitchWhileRunningResponse({
      commandLabel: '`/provider`',
      runtime: 'codex',
      provider: requestedProvider,
      markdown: options.markdown,
    });
  }
  if (requestedProvider === 'sdk') {
    setSessionCodexProviderToml(session.id, 'sdk');
    await reconcileMirrorSubscriptionsBestEffort(options.deps, 'provider sdk switch');
    return buildCommandFields(
      '已切换 Codex Provider',
      [
        ['模式', formatSessionMode(binding, options.store.getSession(session.id))],
        ['Provider', 'sdk'],
      ],
      ['之后的普通消息会回到 SDK Provider；tmux 会话不会自动关闭。'],
      options.markdown,
    );
  }
  const runtimeConfig = resolveSessionRuntimeConfig(binding, session);
  const mode = runtimeConfig.mode;
  const sandboxMode = runtimeConfig.sandboxMode as CodexSandboxMode;
  const networkAccessEnabled = runtimeConfig.networkAccessEnabled;
  const modelReasoningEffort = runtimeConfig.reasoningEffort as CodexReasoningEffort;
  const skipGitRepoCheck = runtimeConfig.skipGitRepoCheck;
  let threadId = getCodexThreadId(session, binding) || undefined;
  let didBootstrapThread = false;
  if (!threadId) {
    await options.deps.notifyBackgroundOperation?.('正在本地预创建 Codex thread，完成后会切换到终端 Provider。');
    const bootstrap = options.deps.bootstrapCodexThread
      || bootstrapCodexThreadLocally;
    threadId = await bootstrap({
      session,
      binding,
      mode,
      sandboxMode,
      networkAccessEnabled,
      modelReasoningEffort,
      skipGitRepoCheck,
    });
    didBootstrapThread = true;
    options.store.updateSessionCodexThreadId(session.id, threadId);
  }
  if (requestedProvider === 'pty') {
    options.store.updateSession(session.id, mergeSessionRuntimeUpdates(
      setSessionCodexThreadIdUpdate(threadId),
    ));
    setSessionCodexProviderToml(session.id, 'pty');
    await reconcileMirrorSubscriptionsBestEffort(options.deps, 'provider pty switch');
    return buildCommandFields(
      '已切换 Codex Provider',
      [
        ['模式', mode],
        ['Provider', 'pty'],
        ['codex_thread_id', threadId],
      ],
      [
        didBootstrapThread
          ? '已在本地预创建 Codex thread；之后普通消息会通过 pty 启动 Codex TUI 并 resume 当前 thread。'
          : '之后普通消息会通过 pty 启动 Codex TUI 并 resume 当前 thread。',
        '`/tmux-*` 命令仍只控制真实 tmux session。',
      ],
      options.markdown,
    );
  }
  const tmuxSessionName = codexTmuxSessionName(threadId);
  let startResult: { existed: boolean; selectionPrompts?: unknown[] };
  try {
    await options.deps.notifyBackgroundOperation?.(`正在启动 tmux 后台会话 \`${tmuxSessionName}\` 并 resume 当前 Codex thread。`);
    startResult = await startRuntimeTmuxSession({
      runtime: 'codex',
      sessionName: tmuxSessionName,
      threadId,
      bridgeSessionId: session.id,
      workingDirectory: getSessionWorkingDirectory(session),
      model: runtimeConfig.model || undefined,
      sandboxMode,
      networkAccessEnabled,
      modelReasoningEffort,
      skipGitRepoCheck,
      codexMode: mode === 'yolo' ? 'yolo' : 'normal',
      permissionMode: mode === 'yolo' ? 'never' : 'acceptEdits',
      onSelectionPrompt: async (selectionPrompt) => {
        if (selectionPrompt.runtime !== 'codex') return undefined;
        return options.deps.requestCodexTuiSelection?.(selectionPrompt, {
          sessionId: session.id,
          replyToMessageId: options.msg.messageId,
        });
      },
    });
  } catch (error) {
    if (error instanceof CodexResumeTmuxLaunchError) {
      return formatCodexTmuxLaunchFailure(error, currentProvider, options.markdown);
    }
    const unavailable = formatTmuxProviderUnavailable(error);
    if (unavailable) return unavailable;
    throw error;
  }
  options.store.updateSession(session.id, setSessionCodexTmuxProviderUpdate({
    tmuxSessionName,
    autoEnter: true,
    threadId,
  }));
  setSessionCodexProviderToml(session.id, 'tmux');
  setSessionTmuxAutoEnterToml(session.id, true);
  await reconcileMirrorSubscriptionsBestEffort(options.deps, 'provider tmux switch');
  return buildCommandFields(
    '已切换 Codex Provider',
    [
      ['模式', mode],
      ['Provider', 'tmux'],
      ['codex_thread_id', threadId],
      ['tmux session', tmuxSessionName],
      ['自动回车', 'on'],
    ],
    [
      startResult.existed
        ? '同名 tmux session 已存在，已先销毁并重新启动 Codex TUI。'
        : didBootstrapThread
          ? '已在本地预创建 Codex thread，并启动 Codex TUI resume 当前 thread。'
          : '已启动 Codex TUI 并 resume 当前 thread。',
      ...(startResult.selectionPrompts && startResult.selectionPrompts.length > 0
        ? ['启动阶段检测到 Codex TUI 选择提示，已通过 IM 选择框确认后继续。']
        : []),
      '这是 `/p tmux` 的标准行为：每次都会强制重新加载同名 tmux session，确保和底层 Codex JSONL 会话一致。',
      '之后普通消息会发送到这个 tmux session；回复由 mirror 机制从 Codex session JSONL 自动同步。',
      '可发送 `/tmux-screen` 查看当前 tmux 屏幕；如果需要应用新的 tmux/TUI 启动参数，请先 `/stop`，再重新发送 `/p tmux`。',
    ],
    options.markdown,
  );
}
