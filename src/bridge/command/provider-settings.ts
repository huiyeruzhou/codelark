import type {
  CodexReasoningEffort,
  CodexSandboxMode,
} from '../../configuration/index.js';
import { createConfigService } from '../../configuration/service.js';
import type { BridgeStore, ChannelChat, InboundMessage } from '../../domain/index.js';
import {
  getSessionActiveRuntime,
  getSessionWorkingDirectory,
  mergeSessionRuntimeUpdates,
  setSessionClaudeProviderUpdate,
  setSessionCodexProviderUpdate,
  setSessionCodexThreadIdUpdate,
  setSessionCodexTmuxProviderUpdate,
} from '../../domain/session-runtime.js';
import { codexTmuxSessionName, startCodexResumeTmuxSession } from '../tmux/runtime.js';
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

const CODEX_PROVIDER_OPTIONS_TEXT = '可选：`sdk`（默认 SDK 路径） `pty`（跨平台 Codex TUI 路径） `tmux`（可 attach 的 Codex TUI/tmux 路径）';
const CLAUDE_PROVIDER_OPTIONS_TEXT = '可选：`pty`（Claude Code TUI/mirror 路径，默认） `sdk`（Claude Agent SDK 原生事件路径）';

function setSessionCodexProviderToml(sessionId: string, provider: 'sdk' | 'tmux' | 'pty'): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { codex: { provider } } },
  );
}

function setSessionClaudeProviderToml(sessionId: string, provider: 'sdk' | 'pty'): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { claude: { provider } } },
  );
}

function parseCodexProviderArg(raw: string): 'sdk' | 'tmux' | 'pty' | null {
  const token = raw.trim().toLowerCase();
  if (token === 'sdk' || token === 'tmux' || token === 'pty') return token;
  return null;
}

function parseClaudeProviderArg(raw: string): 'sdk' | 'pty' | null {
  const token = raw.trim().toLowerCase();
  if (token === 'sdk' || token === 'pty') return token;
  return null;
}

function formatTmuxProviderUnavailable(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/ENOENT|not found|cannot find|没有找到/i.test(message)) return null;
  return process.platform === 'win32'
    ? '没有找到 tmux 兼容命令。Windows 上请安装 psmux 并确认兼容的 `tmux` 命令在 PATH 中；也可以先使用 `/provider pty`。'
    : '没有找到 `tmux` 命令。请先安装 tmux 并确认它在 PATH 中；也可以先使用 `/provider pty`。';
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
          ['Provider', formatSessionClaudeProvider(session)],
          ['Claude executable', resolveClaudeRuntimeConfig(session)?.executable || 'claude'],
          ['记住的 Codex BridgeSession', codexSession?.id || '-'],
          ['记住的 Codex Provider', codexSession ? formatSessionCodexProvider(codexSession) : '-'],
        ],
        [CLAUDE_PROVIDER_OPTIONS_TEXT, '发送 `/provider pty|sdk` 或 `/p pty|sdk` 切换；修改从下一轮 Claude 请求开始生效。'],
        options.markdown,
      );
    }
    const requestedProvider = parseClaudeProviderArg(options.args);
    if (!requestedProvider) {
      return buildCommandFields(
        'Claude Provider 用法',
        [['命令', '`/provider pty|sdk` 或 `/p pty|sdk`']],
        [CLAUDE_PROVIDER_OPTIONS_TEXT],
        options.markdown,
      );
    }
    if (requestedProvider !== resolveEffectiveClaudeProvider(session)
      && sessionHasActiveRuntimeTurn(options.deps, session)) {
      return buildRuntimeSwitchWhileRunningResponse({
        commandLabel: '`/provider`',
        runtime: 'claude',
        provider: requestedProvider,
        markdown: options.markdown,
      });
    }
    options.store.updateSession(session.id, setSessionClaudeProviderUpdate(requestedProvider));
    setSessionClaudeProviderToml(session.id, requestedProvider);
    await reconcileMirrorSubscriptionsBestEffort(options.deps, `claude provider ${requestedProvider} switch`);
    return buildCommandFields(
      '已切换 Claude Provider',
      [
        ['Runtime', 'claude'],
        ['Provider', requestedProvider],
      ],
      [
        requestedProvider === 'sdk'
          ? '之后的普通消息会使用 Claude Agent SDK 原生事件路径；Claude pty/TUI 会话不会自动关闭。'
          : '之后的普通消息会使用 Claude Code pty/mirror 路径；SDK session 不会自动关闭。',
      ],
      options.markdown,
    );
  }
  if (!options.args) {
    return buildCommandFields(
      '当前 Codex Provider',
      [
        ['模式', formatSessionMode(binding, session)],
        ['Provider', formatSessionCodexProvider(session)],
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
  const currentProvider = resolveEffectiveCodexProvider(session);
  if ((requestedProvider !== currentProvider || requestedProvider === 'tmux') && sessionHasActiveRuntimeTurn(options.deps, session)) {
    return buildRuntimeSwitchWhileRunningResponse({
      commandLabel: '`/provider`',
      runtime: 'codex',
      provider: requestedProvider,
      markdown: options.markdown,
    });
  }
  if (requestedProvider === 'sdk') {
    options.store.updateSession(session.id, setSessionCodexProviderUpdate('sdk'));
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
      setSessionCodexProviderUpdate('pty'),
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
  let startResult: Awaited<ReturnType<typeof startCodexResumeTmuxSession>>;
  try {
    await options.deps.notifyBackgroundOperation?.(`正在启动 tmux 后台会话 \`${tmuxSessionName}\` 并 resume 当前 Codex thread。`);
    startResult = await startCodexResumeTmuxSession({
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
    });
  } catch (error) {
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
      '这是 `/p tmux` 的标准行为：每次都会强制重新加载同名 tmux session，确保和底层 Codex JSONL 会话一致。',
      '之后普通消息会发送到这个 tmux session；回复由 mirror 机制从 Codex session JSONL 自动同步。',
      '可发送 `/tmux-screen` 查看当前 tmux 屏幕；如果需要应用新的 tmux/TUI 启动参数，请先 `/stop`，再重新发送 `/p tmux`。',
    ],
    options.markdown,
  );
}
