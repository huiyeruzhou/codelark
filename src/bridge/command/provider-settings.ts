import type { OutboundRichCard } from '../../domain/index.js';
import type {
  CodexReasoningEffort,
  CodexSandboxMode,
} from '../../runtime/options.js';
import { createConfigService } from '../../configuration/service.js';
import { prepareCodexAppServerForBinding, scheduleCodexAppServerView } from './tmux.js';
import { getCodexAppServerSession, releaseCodexAppServerSession } from '../../runtime/codex/app-server-registry.js';
import { getProviderOwnedRuntimeTmuxTarget } from '../session/stop-running-session.js';
import { tmuxCore } from '../../runtime/tmux/core.js';
import type { CursorProviderChoice, RuntimeProviderChoice } from '../../domain/session.js';
import type { BridgeStore, ChannelChat, InboundMessage } from '../../domain/index.js';
import {
  getSessionClaudeSessionId,
  getSessionActiveRuntime,
  getSessionKimiSessionId,
  getSessionCursorSessionId,
  getSessionCursorNativeProvider,
  getSessionCursorSessionIdForProvider,
  setSessionCursorProviderUpdate,
  getSessionZcodeSessionId,
  getSessionWorkingDirectory,
  mergeSessionRuntimeUpdates,
  setSessionClaudeTmuxProviderUpdate,
  setSessionCodexThreadIdUpdate,
  setSessionCodexTmuxProviderUpdate,
  setSessionKimiIdentityUpdate,
  setSessionCursorIdentityUpdate,
  setSessionZcodeIdentityUpdate,
} from '../../domain/session-runtime.js';
import { restartKimiTmuxInputSession } from '../../runtime/kimi/tmux-provider.js';
import {
  cursorTmuxSessionName,
} from '../../runtime/cursor/tmux-provider.js';
import {
  restartZcodeTmuxInputSession,
  zcodeTmuxSessionName,
} from '../../runtime/zcode/tmux-provider.js';
import {
  ClaudeTmuxLaunchError,
  CodexResumeTmuxLaunchError,
  claudeTmuxSessionName,
  cleanupRuntimeTmuxSession,
  codexTmuxSessionName,
  startRuntimeTmuxSession,
} from '../../runtime/tmux/runtime.js';
import { CliExecutableNotFoundError } from '../../runtime/codex/cli-executable.js';
import { getCodexThreadId } from '../turn/turn-classifier.js';
import {
  scopedConfigForRuntime,
  resolveEffectiveClaudeProvider,
  resolveEffectiveCodexProvider,
  resolveClaudeRuntimeConfig,
  resolveKimiRuntimeConfig,
  resolveCursorRuntimeConfig,
  resolveCursorInvocationModel,
  resolveZcodeRuntimeConfig,
  resolveCodexInvocationModel,
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
  readSessionCodexBackendStatus,
  formatCodexBackendStatusFields,
  scheduleMirrorSubscriptionsBestEffort,
  sessionHasActiveRuntimeTurn,
} from './runtime-session.js';
import * as router from '../session/channel-router.js';
import type { SessionCommandResult } from '../session/command-use-cases/types.js';
import { consumeProviderTransition, pendingProviderTransitionId, requestProviderTransition } from './provider-transition-confirmation.js';
import {
  CODEX_PROVIDER_OPTIONS_TEXT,
  CLAUDE_PROVIDER_OPTIONS_TEXT,
  formatTmuxProviderUnavailable,
  parseCodexProviderArg,
  parseClaudeProviderArg,
} from './runtime-settings-options.js';

function setSessionCodexProviderToml(sessionId: string, provider: 'tmux'): void {
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

function setSessionKimiProviderToml(sessionId: string): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { kimi: { provider: 'tmux' } } },
  );
}

function clearSessionKimiProviderToml(sessionId: string): void {
  createConfigService({ migrate: false }).unset(
    { kind: 'session', sessionId },
    'runtime.kimi.provider',
  );
}

function setSessionCursorProviderToml(sessionId: string, provider: CursorProviderChoice = 'acp'): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { cursor: { provider } } },
  );
}

function clearSessionCursorProviderToml(sessionId: string): void {
  createConfigService({ migrate: false }).unset(
    { kind: 'session', sessionId },
    'runtime.cursor.provider',
  );
}

function setSessionZcodeProviderToml(sessionId: string): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { zcode: { provider: 'tmux' } } },
  );
}

function clearSessionZcodeProviderToml(sessionId: string): void {
  createConfigService({ migrate: false }).unset(
    { kind: 'session', sessionId },
    'runtime.zcode.provider',
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

async function cancelStaleTmuxProviderStart(options: {
  store: BridgeStore;
  msg: InboundMessage;
  sessionId: string;
  runtime: 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode';
  tmuxSessionName?: string;
  markdown: boolean;
}): Promise<string | null> {
  const currentBinding = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
  if (currentBinding?.bridgeSessionId === options.sessionId) return null;
  const cleanup = options.tmuxSessionName
    ? await cleanupRuntimeTmuxSession({
        runtime: options.runtime,
        sessionName: options.tmuxSessionName,
      })
    : null;
  return buildCommandFields(
    'tmux 启动已取消',
    options.tmuxSessionName ? [['tmux session', options.tmuxSessionName]] : [],
    [
      '启动期间当前聊天已切换到其他会话，因此没有写入旧会话的 Provider 配置。',
      ...(cleanup
        ? [cleanup.error
            ? `旧 tmux 清理失败：${cleanup.error}`
            : '已清理这次启动创建的旧 tmux 会话。']
        : []),
    ],
    options.markdown,
  );
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
    ['启动探测结束时 session 存活', details.sessionExists === undefined
      ? undefined
      : details.sessionExists
        ? details.killCommand ? 'yes（随后已清理）' : 'yes'
        : 'no'],
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

function formatClaudeTmuxLaunchFailure(
  error: ClaudeTmuxLaunchError | CliExecutableNotFoundError,
  currentProvider: RuntimeProviderChoice,
  markdown: boolean,
): string {
  const details = error instanceof ClaudeTmuxLaunchError ? error.details : undefined;
  const executable = error instanceof ClaudeTmuxLaunchError ? error.details.executable : error.command;
  const diagnosticCommands = details?.commands
    .filter((command) => command !== details.killCommand)
    .slice(-6)
    .join(' ; ');
  const fields: Array<[string, string | null | undefined]> = [
    ['Runtime', 'claude'],
    ['Provider', `未切换（仍为 ${currentProvider}）`],
    ['Claude executable', executable],
    ['tmux session', details?.sessionName],
    ['cwd', details?.workingDirectory],
    ['失败原因', details?.reason || error.message],
    ['最后错误', details?.lastError],
    ['最后屏幕', truncateForCommandResponse(details?.lastScreen)],
  ];
  const sections = [buildCommandFields('Claude tmux 启动失败', fields, [], markdown)];
  const launchOutput = fencedBlock(details?.launchOutput, 'text');
  if (launchOutput) sections.push(markdown ? `**原进程输出**\n${launchOutput}` : `原进程输出\n${launchOutput}`);
  const diagnosticCommand = fencedBlock(diagnosticCommands, 'bash');
  if (diagnosticCommand) sections.push(markdown ? `**诊断命令**\n${diagnosticCommand}` : `诊断命令\n${diagnosticCommand}`);
  const recovery = error instanceof CliExecutableNotFoundError
    ? '安装或修复 Claude executable 后重新发送 `/p tmux`。'
    : '请根据失败原因检查 Claude Code TUI；修复后重新发送 `/p tmux`。';
  sections.push(markdown
    ? [
      '**说明**',
      '- 没有写入 `runtime.claude.provider=tmux`，也没有把当前会话绑定到这个 tmux session。',
      `- ${recovery}`,
    ].join('\n')
    : [
      '说明',
      '- 没有写入 runtime.claude.provider=tmux，也没有把当前会话绑定到这个 tmux session。',
      `- ${recovery.replaceAll('`', '')}`,
    ].join('\n'));
  return sections.filter(Boolean).join('\n\n');
}

interface ProviderCommandOptions {
  richCard?: (card: OutboundRichCard) => void;
  msg: InboundMessage;
  args: string;
  currentBinding: ChannelChat | null;
  store: BridgeStore;
  deps: RuntimeSettingsCommandDeps;
  markdown: boolean;
}

export async function handleProviderCommand(options: ProviderCommandOptions): Promise<SessionCommandResult> {
  const confirmation = /^(tmux|acp) --(restart|cancel-restart)=([a-f0-9-]+)$/i.exec(options.args.trim());
  const rawRequested = confirmation?.[1]?.toLowerCase() || options.args.trim().toLowerCase();
  const binding = options.currentBinding || router.resolve(options.msg.address);
  const session = options.store.getSession(binding.bridgeSessionId);
  if (!session) return { response: '当前会话不存在。' };
  const runtime = getSessionActiveRuntime(session) || 'codex';
  const cursorAliasedFromTmux = runtime === 'cursor' && (rawRequested === 'tmux' || rawRequested === 'tmux --confirm');
  const requested = cursorAliasedFromTmux
    ? (rawRequested === 'tmux --confirm' ? 'acp --confirm' : 'acp')
    : rawRequested;
  if (runtime === 'cursor' && requested === 'acp --confirm') {
    const id = pendingProviderTransitionId(binding, session, 'acp');
    if (!id) return { response: '没有待确认的 ACP 切换，请先执行 /p acp。' };
    return handleProviderCommand({ ...options, args: `acp --restart=${id}` });
  }
  const isCursorAcp = runtime === 'cursor' && requested === 'acp';
  if (requested !== 'tmux' && !isCursorAcp) {
    let richCard: OutboundRichCard | undefined;
    const response = await applyProviderCommand({ ...options, richCard: card => { richCard = card; } });
    return { response, richCard };
  }
  const provider = isCursorAcp ? 'acp' : 'tmux';
  const task = options.deps.getActiveTask?.(session.id)?.abortController;
  if (cursorAliasedFromTmux && resolveCursorRuntimeConfig(session, binding).transport === 'desktop') {
    return { response: await applyProviderCommand({ ...options, args: 'tmux' }) };
  }
  if (confirmation) {
    if (!consumeProviderTransition(confirmation[3]!, binding, session, provider, task)) {
      return { response: provider === 'tmux' ? '这个重启操作已失效，当前任务未受影响。' : '这个切换操作已失效，当前任务未受影响。' };
    }
    if (confirmation[2]!.toLowerCase() === 'cancel-restart') return { response: provider === 'tmux' ? '已取消重启，当前对话保持不变。' : '已取消切换，当前对话保持不变。' };
    options.deps.cancelRuntimeWaits?.(session.id);
    options.deps.cancelQueuedSessionMessages?.(session.id);
    if (options.deps.forceStopSession) await options.deps.forceStopSession(session.id, `用户确认 /p ${provider}，结束旧任务并切换。`);
    else options.deps.getActiveTask?.(session.id)?.abortController.abort();
    if (options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId)?.bridgeSessionId !== session.id
      || (getSessionActiveRuntime(options.store.getSession(session.id)) || 'codex') !== runtime) {
      return { response: '当前聊天已切换会话，未操作旧对话。' };
    }
    // ACP has a separate native store. Retire the bridge-owned TUI before
    // committing the new owner; stale transcript state cannot block this choice.
    if (isCursorAcp) {
      const recordedTarget = session.runtime?.general?.tmuxSessionName;
      const ownsOldTui = (session.runtime?.cursor?.sessionProvider || 'tmux') === 'tmux'
        && session.runtime?.cursor?.transport !== 'desktop'
        && recordedTarget === cursorTmuxSessionName(session.id);
      if (ownsOldTui) {
        const cleanup = await cleanupRuntimeTmuxSession({ runtime: 'cursor', sessionName: recordedTarget });
        if (cleanup.error) throw new Error(`Cursor 原终端未能停止，尚未切换 Provider：${cleanup.error}`);
      }
      if (options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId)?.bridgeSessionId !== session.id
        || (getSessionActiveRuntime(options.store.getSession(session.id)) || 'codex') !== runtime
        || (options.deps.getActiveTask?.(session.id)?.abortController && options.deps.getActiveTask?.(session.id)?.abortController !== task)) {
        return { response: '停止期间会话已变化，未继续切换。' };
      }
    }
  } else {
    const shared = runtime === 'codex'
      && (session.runtime?.codex?.appServerEndpoint || getCodexAppServerSession(session.id));
    const target = getProviderOwnedRuntimeTmuxTarget(session, binding);
    const currentCursorProvider = resolveCursorRuntimeConfig(session, binding).provider;
    const changingCursor = isCursorAcp && (currentCursorProvider !== 'acp'
      || getSessionCursorNativeProvider(session, currentCursorProvider) !== 'acp');
    if ((!isCursorAcp && !shared && (sessionHasActiveRuntimeTurn(options.deps, session) || Boolean(target)))
      || (changingCursor && sessionHasActiveRuntimeTurn(options.deps, session))) {
      return requestProviderTransition(binding, session, provider, task);
    }
  }
  return {
    response: await applyProviderCommand(
      { ...options, args: cursorAliasedFromTmux ? 'tmux' : provider },
      Boolean(confirmation) && isCursorAcp,
    ),
  };
}

async function applyProviderCommand(options: ProviderCommandOptions, confirmedCursorSwitch = false): Promise<string> {
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
    if (requestedProvider !== 'tmux' && requestedProvider !== resolveEffectiveClaudeProvider(session, binding)
      && sessionHasActiveRuntimeTurn(options.deps, session)) {
      return buildRuntimeSwitchWhileRunningResponse({
        sessionId: session.id, richCard: options.richCard,
        commandLabel: `\`/provider ${requestedProvider}\``,
        runtime: 'claude',
        provider: requestedProvider,
        markdown: options.markdown,
      });
    }
    let claudeTmuxStartResult: { existed: boolean } | null = null;
    if (requestedProvider === 'tmux') {
      const claudeSessionId = getSessionClaudeSessionId(session) || undefined;
      const tmuxSessionName = claudeTmuxSessionName(claudeSessionId || session.id);
      const claudeConfig = resolveClaudeRuntimeConfig(session, binding);
      try {
        await options.deps.notifyBackgroundOperation?.(`正在启动 tmux 后台会话 \`${tmuxSessionName}\` 并运行 Claude Code TUI。`);
        claudeTmuxStartResult = await startRuntimeTmuxSession({
          runtime: 'claude',
          sessionName: tmuxSessionName,
          bridgeSessionId: session.id,
          claudeSessionId,
          workingDirectory: getSessionWorkingDirectory(session),
          executable: claudeConfig.executable,
          model: claudeConfig.model,
          permissionMode: claudeConfig.permissionMode,
          reasoningEffort: claudeConfig.reasoningEffort,
          recreate: true,
          waitReady: true,
          onSelectionPrompt: async (selectionPrompt) => {
            if (selectionPrompt.runtime !== 'claude' || selectionPrompt.kind !== 'bypass_permissions') return undefined;
            return options.deps.requestCodexTuiSelection?.(selectionPrompt, {
              sessionId: session.id,
              replyToMessageId: options.msg.messageId,
            });
          },
        });
      } catch (error) {
        const staleStart = await cancelStaleTmuxProviderStart({
          store: options.store,
          msg: options.msg,
          sessionId: session.id,
          runtime: 'claude',
          tmuxSessionName,
          markdown: options.markdown,
        });
        if (staleStart) return staleStart;
        if (error instanceof ClaudeTmuxLaunchError || error instanceof CliExecutableNotFoundError) {
          return formatClaudeTmuxLaunchFailure(
            error,
            resolveEffectiveClaudeProvider(session, binding),
            options.markdown,
          );
        }
        const unavailable = formatTmuxProviderUnavailable(error);
        if (unavailable) return unavailable;
        throw error;
      }
      const staleStart = await cancelStaleTmuxProviderStart({
        store: options.store,
        msg: options.msg,
        sessionId: session.id,
        runtime: 'claude',
        tmuxSessionName,
        markdown: options.markdown,
      });
      if (staleStart) return staleStart;
      options.store.updateSession(session.id, setSessionClaudeTmuxProviderUpdate({
        tmuxSessionName,
        autoEnter: true,
      }));
    }
    setSessionClaudeProviderToml(session.id, requestedProvider);
    scheduleMirrorSubscriptionsBestEffort(options.deps, `claude provider ${requestedProvider} switch`);
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
  if (getSessionActiveRuntime(session) === 'kimi') {
    const requested = options.args.trim().toLowerCase();
    if (!requested) {
      return buildCommandFields(
        '当前 Kimi Provider',
        [
          ['Runtime', 'kimi'],
          ['Provider', 'tmux'],
        ],
        ['Kimi Code 当前只支持 tmux Provider；发送 `/provider tmux` 固定为 tmux，或 `/provider default` 清除会话级覆盖。'],
        options.markdown,
      );
    }
    if (requested === 'default') {
      clearSessionKimiProviderToml(session.id);
      scheduleMirrorSubscriptionsBestEffort(options.deps, 'kimi provider default');
      return buildCommandFields(
        '已恢复默认 Kimi Provider',
        [['Runtime', 'kimi'], ['Provider', 'tmux']],
        ['Kimi Code 当前只支持 tmux Provider。'],
        options.markdown,
      );
    }
    if (requested !== 'tmux') {
      return buildCommandFields(
        'Kimi Provider 用法',
        [['命令', '`/provider tmux|default` 或 `/p tmux|default`']],
        ['Kimi Code 当前只支持 tmux Provider。'],
        options.markdown,
      );
    }
    const tmuxSessionName = `clk-kimi-${session.id}`;
    await options.deps.notifyBackgroundOperation?.(`正在重新启动 tmux 后台会话 \`${tmuxSessionName}\` 并运行 Kimi Code TUI。`);
    const kimiConfig = resolveKimiRuntimeConfig(session, binding);
    let prepared: Awaited<ReturnType<typeof restartKimiTmuxInputSession>>;
    try {
      prepared = await (options.deps.restartKimiTmuxSession || restartKimiTmuxInputSession)({
        prompt: '',
        sessionId: session.id,
        runtime: 'kimi',
        kimiSessionId: getSessionKimiSessionId(session),
        workingDirectory: getSessionWorkingDirectory(session),
        model: kimiConfig.model || undefined,
      });
    } catch (error) {
      const staleStart = await cancelStaleTmuxProviderStart({
        store: options.store,
        msg: options.msg,
        sessionId: session.id,
        runtime: 'kimi',
        tmuxSessionName,
        markdown: options.markdown,
      });
      if (staleStart) return staleStart;
      throw error;
    }
    const staleStart = await cancelStaleTmuxProviderStart({
      store: options.store,
      msg: options.msg,
      sessionId: session.id,
      runtime: 'kimi',
      tmuxSessionName: prepared.sessionName,
      markdown: options.markdown,
    });
    if (staleStart) return staleStart;
    const identityUpdate = setSessionKimiIdentityUpdate(prepared.sessionId, prepared.cwd);
    options.store.updateSession(session.id, {
      ...identityUpdate,
      runtime: {
        ...identityUpdate.runtime,
        general: {
          tmuxSessionName: prepared.sessionName,
          autoEnter: true,
        },
      },
    });
    setSessionKimiProviderToml(session.id);
    scheduleMirrorSubscriptionsBestEffort(options.deps, 'kimi provider tmux');
    return buildCommandFields(
      '已切换 Kimi Provider',
      [['Runtime', 'kimi'], ['Provider', 'tmux'], ['tmux session', prepared.sessionName]],
      [
        prepared.existed
          ? '同名 tmux session 已存在，已先销毁并重新启动 Kimi Code TUI。'
          : '已启动 Kimi Code TUI。',
        '之后的普通消息会使用 Kimi Code tmux 路径。',
      ],
      options.markdown,
    );
  }
  if (getSessionActiveRuntime(session) === 'cursor') {
    const rawRequested = options.args.trim().toLowerCase();
    const aliasedFromTmux = rawRequested === 'tmux';
    const requested = aliasedFromTmux ? 'acp' : rawRequested;
    const currentCursorConfig = resolveCursorRuntimeConfig(session, binding);
    if (!requested) {
      return buildCommandFields(
        '当前 Cursor Provider',
        [
          ['Runtime', 'cursor'],
          ['Provider', 'acp'],
          ...(currentCursorConfig.transport === 'desktop' ? [['接管来源', 'Cursor Desktop'] as [string, string]] : []),
        ],
        [currentCursorConfig.transport === 'desktop'
          ? '当前会话由 Cursor Desktop 管理，继续使用已绑定对话。Cursor 不再支持 tmux，非 Desktop 会话统一使用 ACP；发送 `/provider acp` 可切换到新 ACP 会话。'
          : 'Cursor 已统一使用 ACP 实时事件（不再支持 tmux，`/p tmux` 会自动按 `/p acp` 处理）；运行中的新消息会中断当前生成后继续。'],
        options.markdown,
      );
    }
    if (requested !== 'acp' && requested !== 'default') {
      return buildCommandFields(
        'Cursor Provider 用法',
        [['命令', '`/provider acp|default` 或 `/p acp|default`']],
        ['Cursor 不再支持 tmux（`/p tmux` 会自动解释为 `/p acp`）；已通过 `/t` 接管的 Cursor Desktop 对话会自动保持 Desktop 接管。'],
        options.markdown,
      );
    }
    if (aliasedFromTmux && currentCursorConfig.transport === 'desktop') {
      return buildCommandFields(
        '当前 Cursor Provider',
        [['Runtime', 'cursor'], ['Provider', 'acp'], ['接管来源', 'Cursor Desktop']],
        [
          'Cursor 不支持 tmux，已将 `/p tmux` 解释为 `/p acp`。',
          '当前会话由 Cursor Desktop 管理，继续使用已绑定对话；如需切换到全新 ACP 会话，请发送 `/p acp` 或 `/clear`。',
        ],
        options.markdown,
      );
    }
    const nativeProvider = getSessionCursorNativeProvider(session, currentCursorConfig.provider);
    const changingProvider = requested === 'acp'
      && (currentCursorConfig.transport === 'desktop' || nativeProvider !== 'acp');
    if (changingProvider && !confirmedCursorSwitch && sessionHasActiveRuntimeTurn(options.deps, session)) {
      return buildRuntimeSwitchWhileRunningResponse({
        sessionId: session.id, richCard: options.richCard, commandLabel: `/provider ${requested}`,
        runtime: 'cursor', provider: currentCursorConfig.provider, markdown: options.markdown,
      });
    }
    if (requested === 'default') {
      clearSessionCursorProviderToml(session.id);
      if (currentCursorConfig.transport === 'desktop') {
        scheduleMirrorSubscriptionsBestEffort(options.deps, 'cursor provider default');
        return buildCommandFields(
          '已清除 Cursor Provider 配置覆盖',
          [['Runtime', 'cursor'], ['Provider', 'acp'], ['接管来源', 'Cursor Desktop']],
          ['当前会话由 Cursor Desktop 管理，继续使用已绑定对话。'],
          options.markdown,
        );
      }
    } else {
      setSessionCursorProviderToml(session.id, 'acp');
    }
    options.store.updateSession(session.id, {
      ...setSessionCursorProviderUpdate(session, 'acp'),
      ...(confirmedCursorSwitch ? { runtime_status: 'idle' as const, queued_count: 0, pending_user_input: undefined } : {}),
    });
    scheduleMirrorSubscriptionsBestEffort(options.deps, `cursor provider ${requested}`);
    return buildCommandFields(
      requested === 'default' ? '已清除 Cursor Provider 配置覆盖' : '已切换 Cursor Provider',
      [['Runtime', 'cursor'], ['Provider', 'acp']],
      [
        ...(aliasedFromTmux ? ['Cursor 不支持 tmux，已将 `/p tmux` 解释为 `/p acp`。'] : []),
        '之后的消息使用 ACP 实时事件；运行中的新消息会中断当前生成，再继续处理新消息。',
        ...(changingProvider && getSessionCursorSessionId(session)
          ? ['旧会话记录和身份已保留，下一条消息会创建新的 ACP 会话。'] : []),
      ],
      options.markdown,
    );
  }
  if (getSessionActiveRuntime(session) === 'zcode') {
    const requested = options.args.trim().toLowerCase();
    if (!requested) {
      return buildCommandFields(
        '当前 ZCode Provider',
        [['Runtime', 'zcode'], ['Provider', 'tmux']],
        ['ZCode 只使用 tmux Provider；发送 `/p tmux` 会以稳定 session ID 重启 TUI，`/p default` 清除会话级覆盖。'],
        options.markdown,
      );
    }
    if (requested === 'default') {
      clearSessionZcodeProviderToml(session.id);
      scheduleMirrorSubscriptionsBestEffort(options.deps, 'zcode provider default');
      return buildCommandFields('已恢复默认 ZCode Provider', [['Runtime', 'zcode'], ['Provider', 'tmux']], [], options.markdown);
    }
    if (requested !== 'tmux') {
      return buildCommandFields(
        'ZCode Provider 用法',
        [['命令', '`/provider tmux|default` 或 `/p tmux|default`']],
        ['ZCode 当前只支持 tmux Provider。'],
        options.markdown,
      );
    }
    const config = resolveZcodeRuntimeConfig(session, binding);
    const tmuxSessionName = zcodeTmuxSessionName(session.id);
    await options.deps.notifyBackgroundOperation?.(`正在重新启动 ZCode tmux 后台会话 \`${tmuxSessionName}\`。`, { force: true });
    let prepared: Awaited<ReturnType<typeof restartZcodeTmuxInputSession>>;
    try {
      prepared = await (options.deps.restartZcodeTmuxSession || restartZcodeTmuxInputSession)({
        prompt: '',
        sessionId: session.id,
        runtime: 'zcode',
        zcodeSessionId: getSessionZcodeSessionId(session),
        zcodeMode: config.mode,
        workingDirectory: getSessionWorkingDirectory(session),
        model: config.model,
      });
    } catch (error) {
      const staleStart = await cancelStaleTmuxProviderStart({
        store: options.store,
        msg: options.msg,
        sessionId: session.id,
        runtime: 'zcode',
        tmuxSessionName,
        markdown: options.markdown,
      });
      if (staleStart) return staleStart;
      throw error;
    }
    const staleStart = await cancelStaleTmuxProviderStart({
      store: options.store,
      msg: options.msg,
      sessionId: session.id,
      runtime: 'zcode',
      tmuxSessionName: prepared.sessionName,
      markdown: options.markdown,
    });
    if (staleStart) return staleStart;
    const identityUpdate = setSessionZcodeIdentityUpdate(prepared.sessionId, prepared.cwd);
    options.store.updateSession(session.id, {
      ...identityUpdate,
      runtime: {
        ...identityUpdate.runtime,
        general: { tmuxSessionName: prepared.sessionName, autoEnter: true },
      },
    });
    setSessionZcodeProviderToml(session.id);
    scheduleMirrorSubscriptionsBestEffort(options.deps, 'zcode provider tmux');
    return buildCommandFields(
      '已切换 ZCode Provider',
      [['Runtime', 'zcode'], ['Provider', 'tmux'], ['tmux session', prepared.sessionName]],
      [
        prepared.existed ? '同名 tmux session 已先销毁并以原 ZCode session 重启。' : '已启动 ZCode TUI。',
        '之后的普通消息与 `//` 转义后的原生命令都会进入该 ZCode TUI。',
      ],
      options.markdown,
    );
  }
  if (!options.args) {
    const backendStatus = readSessionCodexBackendStatus(session);
    return buildCommandFields(
      '当前 Codex Provider',
      [
        ['模式', formatSessionMode(binding, session)],
        ['Provider 配置', formatSessionCodexProvider(session, binding)],
        ...formatCodexBackendStatusFields(backendStatus),
      ],
      backendStatus?.backend === 'app-server'
        ? ['当前会话绑定 app-server；`/p tmux` 只建立或复用查看入口，不更换后端。']
        : backendStatus?.backend === 'unstarted'
          ? [CODEX_PROVIDER_OPTIONS_TEXT,
            '会话尚未启动；直接发送消息会优先连接 app-server，tmux 只用于查看或兼容回退。']
          : [CODEX_PROVIDER_OPTIONS_TEXT,
            '当前会话还在使用旧版 tmux 执行方式；启动或恢复时会优先迁移到 app-server。'],
      options.markdown,
    );
  }
  const requestedProvider = parseCodexProviderArg(options.args);
  if (!requestedProvider) {
    return buildCommandFields(
      'Codex Provider 用法',
      [['命令', '`/provider tmux` 或 `/p tmux`']],
      [CODEX_PROVIDER_OPTIONS_TEXT],
      options.markdown,
    );
  }
  const currentProvider = resolveEffectiveCodexProvider(session, binding);
  const protocol = await prepareCodexAppServerForBinding(options.store, binding, session);
  if (protocol) {
    const currentBinding = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId);
    if (currentBinding?.bridgeSessionId !== session.id) {
      await releaseCodexAppServerSession(session.id);
      return '聊天已切换，已解除旧线程的本端订阅。';
    }
    setSessionCodexProviderToml(session.id, 'tmux');
    scheduleMirrorSubscriptionsBestEffort(options.deps, 'app-server thread prepared');
    void scheduleCodexAppServerView({ store: options.store, binding, session, handle: protocol,
      notify: (message) => options.deps.notifyBackgroundOperation?.(message, { force: true }) });
    return '共享 Codex 线程已就绪，可直接发送消息；正在后台准备 tmux 查看入口。';
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
    const staleStart = await cancelStaleTmuxProviderStart({
      store: options.store,
      msg: options.msg,
      sessionId: session.id,
      runtime: 'codex',
      markdown: options.markdown,
    });
    if (staleStart) return staleStart;
    didBootstrapThread = true;
    options.store.updateSessionCodexThreadId(session.id, threadId);
  }
  const tmuxSessionName = codexTmuxSessionName(threadId);
  let startResult: { existed: boolean; selectionPrompts?: unknown[]; updateRestartCount?: number };
  try {
    await options.deps.notifyBackgroundOperation?.(`正在启动 tmux 后台会话 \`${tmuxSessionName}\` 并 resume 当前 Codex thread。`);
    startResult = await startRuntimeTmuxSession({
      runtime: 'codex',
      sessionName: tmuxSessionName,
      threadId,
      bridgeSessionId: session.id,
      workingDirectory: getSessionWorkingDirectory(session),
      model: resolveCodexInvocationModel(binding, session, { resuming: true }),
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
      onStatus: options.deps.notifyBackgroundOperation,
    });
  } catch (error) {
    const staleStart = await cancelStaleTmuxProviderStart({
      store: options.store,
      msg: options.msg,
      sessionId: session.id,
      runtime: 'codex',
      tmuxSessionName,
      markdown: options.markdown,
    });
    if (staleStart) return staleStart;
    if (error instanceof CodexResumeTmuxLaunchError) {
      return formatCodexTmuxLaunchFailure(error, currentProvider, options.markdown);
    }
    const unavailable = formatTmuxProviderUnavailable(error);
    if (unavailable) return unavailable;
    throw error;
  }
  const staleStart = await cancelStaleTmuxProviderStart({
    store: options.store,
    msg: options.msg,
    sessionId: session.id,
    runtime: 'codex',
    tmuxSessionName,
    markdown: options.markdown,
  });
  if (staleStart) return staleStart;
  options.store.updateSession(session.id, setSessionCodexTmuxProviderUpdate({
    tmuxSessionName,
    autoEnter: true,
    threadId,
  }));
  setSessionCodexProviderToml(session.id, 'tmux');
  scheduleMirrorSubscriptionsBestEffort(options.deps, 'provider tmux switch');
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
      ...(startResult.updateRestartCount && startResult.updateRestartCount > 0
        ? ['选择 Codex CLI 更新后 TUI 已退出，CodeLark 已重新启动 tmux 并继续完成 Provider 切换。']
        : []),
      '这是 `/p tmux` 的标准行为：每次都会强制重新加载同名 tmux session，确保和底层 Codex JSONL 会话一致。',
      '之后普通消息会发送到这个 tmux session；回复由 mirror 机制从 Codex session JSONL 自动同步。',
      '可发送 `/tmux-screen` 查看当前 tmux 屏幕；如果需要应用新的 tmux/TUI 启动参数，发送 `/p tmux` 并确认“结束并重启”。',
    ],
    options.markdown,
  );
}
