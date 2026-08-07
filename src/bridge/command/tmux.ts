import type { BridgeSession, BridgeStore } from '../../domain/index.js';
import type { ChannelChat, OutboundRichCard } from '../../domain/index.js';
import type { StructuredStreamingUiActionButton } from '../../channels/contracts.js';
import { createConfigService } from '../../configuration/service.js';
import { buildCommandCallbackData } from './callbacks.js';
import { buildCommandFields } from './presentation.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';
import { formatLocalClockTime } from '../../shared/date-time.js';
import { sanitizeInput } from '../../shared/security/validators.js';
import {
  claudeTmuxSessionName,
  codexTmuxSessionName,
  attachTmuxSession,
  CodexResumeTmuxLaunchError,
  createOrAttachTmuxSession,
  hasTmuxSession,
  inspectRuntimeTmuxSession,
  listTmuxSessions,
  sendTmuxActions,
  sendTmuxActionsAndCapture,
  startRuntimeTmuxSession,
  waitForRuntimeTmuxReady,
  waitForCodexResumeTmuxReady,
  type RuntimeTmuxKind,
  type RuntimeTmuxReadinessResult,
  type RuntimeTmuxSelectionPrompt,
  type StartCodexResumeTmuxSessionParams,
  type TmuxSendAction,
  type TmuxSessionInfo,
} from '../tmux/runtime.js';
import {
  resolveClaudeRuntimeConfig,
  resolveEffectiveRuntimeProvider,
  resolveKimiRuntimeConfig,
  resolveCursorRuntimeConfig,
  resolveSessionRuntimeConfig,
} from '../session/support.js';
import { getCodexThreadId } from '../turn/turn-classifier.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeSessionId,
  getSessionTmuxCaptureLines,
  getSessionTmuxEchoInput,
  getSessionRuntimeTmuxSessionName,
  getSessionTmuxSessionName,
  getSessionWorkingDirectory,
  setSessionKimiIdentityUpdate,
  setSessionCursorIdentityUpdate,
  setSessionClaudeTmuxProviderUpdate,
  setSessionCodexTmuxProviderUpdate,
} from '../../domain/session-runtime.js';
import {
  ensureKimiTmuxInputSession,
  kimiTmuxSessionName,
  retryKimiSubmitIfNoActivity,
  sendKimiTmuxExplicitSteer,
  syncKimiTmuxTurnStateFromSession,
} from '../../runtime/kimi/tmux-provider.js';
import {
  ensureCursorTmuxInputSession,
} from '../../runtime/cursor/tmux-provider.js';
import {
  bootstrapCodexThreadLocally,
  type BootstrapCodexThreadParams,
} from './runtime-settings.js';
import {
  DEFAULT_CAPTURE_LINES,
  isPureSpecialKeySyntax,
  normalizeCaptureLines,
  parseTmuxKeySequence,
  parseTmuxScreenArgs,
  parseTmuxSendActions,
  parseTmuxSetArgs,
  validateTmuxSessionName,
} from './tmux-args.js';
import type { CodexTuiSelectionPromptChoice } from '../../runtime/codex/tmux-provider.js';
import {
  inspectRuntimeTmuxInput,
  resolveRuntimeTmuxSteerOperation,
  sendRuntimeTmuxInput,
} from '../tmux/input-state-machine.js';
export {
  buildCodexResumeTmuxCommand,
  captureTmuxScreen,
  codexTmuxSessionName,
  createOrAttachTmuxSession,
  hasTmuxSession,
  listTmuxSessions,
  sendTmuxActions,
  sendTmuxActionsAndCapture,
  sendTmuxInterrupt,
  startCodexResumeTmuxSession,
  type StartCodexResumeTmuxSessionParams,
} from '../tmux/runtime.js';

const SEND_ACTION_DELAY_MS = 500;
const CAPTURE_AFTER_SEND_DELAY_MS = 250;

function scheduleTmuxMirrorReconcile(
  reconcile: (() => Promise<void>) | undefined,
  context: string,
): void {
  if (!reconcile) return;
  const immediate = setImmediate(() => {
    void reconcile().catch((error) => {
      console.error(`[tmux-command] Mirror reconcile failed during ${context}:`, error);
    });
  });
  immediate.unref?.();
}

function setSessionTmuxSessionName(store: BridgeStore, sessionId: string, tmuxSessionName: string): void {
  store.updateSession(sessionId, {
    runtime: {
      general: { tmuxSessionName },
    },
  });
}

function setSessionTmuxCaptureLinesToml(sessionId: string, tmuxCaptureLines: number): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { session: { tmuxCaptureLines } },
  );
}

function setSessionClaudeProviderToml(sessionId: string, provider: 'sdk' | 'pty' | 'tmux'): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { claude: { provider } } },
  );
}

function setSessionTmuxEchoInputToml(sessionId: string, tmuxEchoInput: boolean): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { session: { tmuxEchoInput } },
  );
}

function buildTmuxSwitchSelect(
  sessions: TmuxSessionInfo[],
  scopeSessionId: string,
): NonNullable<OutboundRichCard['selects']> {
  return [{
    id: 'tmux_select',
    placeholder: '选择要绑定的 tmux session',
    options: sessions.map((session, index) => {
      const command = `/tmux-attach ${session.name}`;
      return {
        text: session.name,
        callbackData: buildCommandCallbackData(command, scopeSessionId),
      };
    }),
  }];
}

export interface HandleTmuxBridgeCommandParams {
  command: string;
  args: string;
  store: BridgeStore;
  binding: ChannelChat;
  session: BridgeSession;
  markdown: boolean;
  screenMonitor?: {
    key: string;
    stopCallbackData?: string;
    deliver: (text: string) => Promise<void>;
    card?: {
      update: (text: string, statusText: string) => void;
      actions?: (actions: StructuredStreamingUiActionButton[][]) => void;
      finish: (status: 'completed' | 'interrupted' | 'error', text: string) => Promise<boolean>;
    };
  };
  richCard?: (card: OutboundRichCard) => void;
  autoRecoverProviderSession?: boolean;
  suppressSuccessfulResponse?: boolean;
  tmuxProviderAutoForward?: boolean;
  onTmuxProviderAutoForwarded?: () => Promise<void> | void;
  reconcileMirrorSubscriptions?: () => Promise<void>;
  requestCodexTuiSelection?: (
    selectionPrompt: RuntimeTmuxSelectionPrompt,
    options: {
      sessionId: string;
      autoForwardRecovery?: {
        target: string;
        actions: TmuxSendAction[];
      };
    },
  ) => Promise<CodexTuiSelectionPromptChoice | null>;
  notifyBackgroundOperation?: (message: string, options?: { force?: boolean }) => Promise<void> | void;
}

interface TmuxScreenMonitor {
  timer: ReturnType<typeof setTimeout>;
  target: string;
  lines: number;
  runtime?: RuntimeTmuxKind;
  intervalSeconds: number;
  markdown: boolean;
  deliver: (text: string) => Promise<void>;
  stopCallbackData?: string;
  card?: {
    update: (text: string, statusText: string) => void;
    actions?: (actions: StructuredStreamingUiActionButton[][]) => void;
    finish: (status: 'completed' | 'interrupted' | 'error', text: string) => Promise<boolean>;
  };
  busy: boolean;
  stopped: boolean;
}

const screenMonitors = new Map<string, TmuxScreenMonitor>();

function stopAllTmuxScreenMonitors(): number {
  const monitors = [...screenMonitors.values()];
  for (const monitor of monitors) {
    monitor.stopped = true;
    clearTimeout(monitor.timer);
  }
  screenMonitors.clear();
  return monitors.length;
}

export const _testOnlyTmuxScreenMonitors = {
  activeCount: () => screenMonitors.size,
  stopAll: stopAllTmuxScreenMonitors,
};

function buildTmuxCommandPreview(commands: string[], markdown: boolean): string {
  const normalized = commands.map((command) => command.trim()).filter(Boolean);
  if (normalized.length === 0) return '';
  if (markdown) {
    return [
      '**真实 tmux 底层命令**',
      '',
      buildFencedCodeBlock(normalized.join('\n'), 'sh'),
    ].join('\n').trim();
  }
  return ['真实 tmux 底层命令', '', ...normalized].join('\n').trim();
}

export const _testOnlyTmuxCommandFormatting = {
  buildCommandPreview: buildTmuxCommandPreview,
};

function appendTmuxCommandPreview(response: string, commands: string[], markdown: boolean): string {
  const preview = buildTmuxCommandPreview(commands, markdown);
  return preview ? [response, preview].filter(Boolean).join('\n\n') : response;
}

function getCaptureLines(session: BridgeSession): number {
  return normalizeCaptureLines(getSessionTmuxCaptureLines(session) || DEFAULT_CAPTURE_LINES);
}

function getProviderAutoEnter(): boolean {
  return true;
}

function getEchoInput(session: BridgeSession): boolean {
  return getSessionTmuxEchoInput(session) === true;
}

function formatOnOff(value: boolean): string {
  return value ? 'on' : 'off';
}

function truncateTmuxErrorBlock(value: string | undefined, limit = 1_500): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+$/g, '');
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function formatCodexTmuxLaunchFailure(error: CodexResumeTmuxLaunchError, markdown: boolean): string {
  const details = error.details;
  const diagnosticCommands = details.commands
    .filter((command) => command !== details.killCommand)
    .slice(-6)
    .join('\n');
  const sections = [
    buildCommandFields(
      'Codex tmux 启动失败',
      [
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
        ['最后屏幕', truncateTmuxErrorBlock(details.lastScreen, 500)],
      ],
      [
        '未发送本次 tmux 输入，也没有更新 tmux Provider 绑定。',
        '请根据原进程输出修复 Codex TUI 启动问题；修复后重新发送原消息或 `/p tmux`。',
      ],
      markdown,
    ),
  ];
  const launchOutput = truncateTmuxErrorBlock(details.launchOutput);
  if (launchOutput) {
    sections.push(markdown
      ? `**原进程输出**\n${buildFencedCodeBlock(launchOutput, 'text')}`
      : `原进程输出\n${launchOutput}`);
  }
  if (diagnosticCommands) {
    sections.push(markdown
      ? `**诊断命令**\n${buildFencedCodeBlock(diagnosticCommands, 'sh')}`
      : `诊断命令\n${diagnosticCommands}`);
  }
  return sections.join('\n\n');
}

function formatTmuxError(error: unknown, markdown = false): string {
  if (error instanceof CodexResumeTmuxLaunchError) {
    return formatCodexTmuxLaunchFailure(error, markdown);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT/.test(message)) {
    return process.platform === 'win32'
      ? '没有找到 tmux 兼容命令。Windows 上请安装 psmux 并确认兼容的 `tmux` 命令在 PATH 中。'
      : '没有找到 `tmux` 命令，请先安装 tmux 并确认它在 PATH 中。';
  }
  return `tmux 执行失败：${message}`;
}

function buildTmuxSwitchResponse(
  sessions: TmuxSessionInfo[],
  currentName: string | undefined,
  markdown: boolean,
): string {
  if (sessions.length === 0) {
    return buildCommandFields(
      'tmux session 选择',
      [],
      ['当前没有 tmux session。可发送 `/tmux-new <name>` 新建并绑定。'],
      markdown,
    );
  }

  const lines = sessions.map((session, index) => {
    const marker = session.name === currentName ? '*' : ' ';
    const attached = Number(session.attached || '0');
    return `${marker} ${index + 1}. ${session.name}  windows=${session.windows || '?'} attached=${attached}`;
  });
  return [
    buildCommandFields(
      'tmux session 选择',
      [
        ['当前绑定', currentName || '未绑定'],
        ['选择方式', '`/tmux-attach <session>`'],
      ],
      ['下面的列表类似 `Ctrl+b s` 的 session 选择；`*` 表示当前绑定。'],
      markdown,
    ),
    markdown ? buildFencedCodeBlock(lines.join('\n'), 'text') : lines.join('\n'),
  ].join('\n\n');
}

function buildTmuxSwitchCommandCard(
  sessions: TmuxSessionInfo[],
  scopeSessionId: string,
): OutboundRichCard {
  if (sessions.length === 0) {
    return {
      title: 'tmux session 选择',
      subtitle: '当前没有 tmux session。',
      template: 'blue',
      sections: [{
        text: '可以发送纯文本命令 `/tmux-new <name>` 新建并绑定。',
      }],
    };
  }

  return {
    title: 'tmux session 选择',
    subtitle: '点击“绑定”会执行对应命令；也可以继续发送纯文本命令。',
    template: 'blue',
    table: {
      pageSize: 10,
      rowHeight: 'low',
      freezeFirstColumn: false,
      columns: [
        { name: 'session', displayName: 'session', width: '260px' },
        { name: 'windows', displayName: '窗口', width: '80px', horizontalAlign: 'right' },
        { name: 'attached', displayName: '连接', width: '80px', horizontalAlign: 'right' },
        { name: 'command', displayName: '命令', width: '320px' },
      ],
      rows: sessions.map((tmuxSession) => ({
        session: tmuxSession.name,
        windows: Number(tmuxSession.windows || '0'),
        attached: Number(tmuxSession.attached || '0'),
        command: `/tmux-attach ${tmuxSession.name}`,
      })),
    },
    sections: [],
    selects: buildTmuxSwitchSelect(sessions, scopeSessionId),
    footer: [
      '纯文本命令：`/tmux-attach <session>` 绑定指定 session。',
      '表格横向可滚动；长 session 名和命令会省略，可悬浮或点击查看。',
    ],
  };
}

function tmuxDirectHelp(): string[] {
  return [
    '普通文本：直接写在 `/tmux` 后面，例如 `/tmux pwd`；如果整段不是特殊键序列，尖括号会按原文发送。',
    '纯特殊键序列：`/tmux <C-c><Enter>` 会按顺序发送 Ctrl+C 和 Enter。',
    '特殊键：使用 `/tmux-key`（或 `/tmux-keys`）和尖括号，例如 `/tmux-key <Enter>`、`/tmux-key <Tab>`、`/tmux-key <Esc>`。',
    'Ctrl/Cmd：写成 `/tmux-key <C-c>`、`/tmux-key <Ctrl+C>` 或 `/tmux-key <Cmd+C>`，都会按 tmux 的 `C-c` 形式发送。',
    'Option/Alt：写成 `/tmux-key <Option+Enter>`、`/tmux-key <Alt+Enter>` 或 tmux 原生命名 `/tmux-key <M-Enter>`。',
    '混合按键：`/tmux-keys git status<Enter><C-c>` 会先输入普通字符，再按回车，再发 Ctrl+C。',
  ];
}

function tmuxCommandFamilyHelp(): string[] {
  return [
    '`/tmux-switch`：列出 tmux sessions，类似 `Ctrl+b s`。',
    '`/tmux-attach <session>`：把当前 IM 会话绑定到指定 tmux session。',
    '`/tmux-new [session]`：新建并绑定 tmux session；如果已存在，会提示并直接绑定。',
    '`/tmux-status`：查看当前绑定到哪个 tmux session，以及当前展示行数。',
    '`/tmux-set lines <1-500>`：设置 `/tmux ...` 自动截屏返回的行数，默认 20。',
    '`/tmux-set echo on|off`：设置 `/tmux ...` 发送后是否在回复里回显输入内容。',
    '`/tmux-screen [lines] [seconds]s`：查看当前绑定 tmux session 的屏幕状态；`lines` 只对本次/本轮定时生效。',
    '`/tmux-screen 5s`：使用默认行数，并每 5 秒刷新一次。',
    '`/tmux-screen 120 5s`：临时展示 120 行，并每 5 秒刷新一次；最低间隔 3 秒。',
    '`/tmux-screen stop`：停止当前聊天的 tmux 屏幕定时刷新。',
    '`/tmux ...`：把后面的普通文本发送给当前绑定的 tmux session，并自动截屏返回；尖括号按原文发送。',
    '`/tmux-key ...` / `/tmux-keys ...`：解析 `<Enter>`、`<C-c>` 等特殊键，适合需要按键控制或混合文本/按键的场景。',
  ];
}

function tmuxFullHelp(): string[] {
  return [
    ...tmuxCommandFamilyHelp(),
    ...tmuxDirectHelp(),
  ];
}

function buildTmuxStatusResponse(session: BridgeSession, markdown: boolean): string {
  return buildCommandFields(
    'tmux 状态',
    [
      ['当前绑定', getSessionTmuxSessionName(session) || '未绑定'],
      ['展示行数', `${getCaptureLines(session)}`],
      ['输入回显', formatOnOff(getEchoInput(session))],
    ],
    ['查看当前 IM 会话绑定到哪个 tmux session，以及 `/tmux ...` 自动截屏返回的展示行数和发送设置。'],
    markdown,
  );
}

function buildTmuxOverviewResponse(session: BridgeSession, markdown: boolean): string {
  return buildCommandFields(
    'tmux',
    [
      ['当前绑定', getSessionTmuxSessionName(session) || '未绑定'],
      ['展示行数', `${getCaptureLines(session)}`],
      ['输入回显', formatOnOff(getEchoInput(session))],
    ],
    tmuxFullHelp(),
    markdown,
  );
}

function shouldAppendAutoEnter(actions: TmuxSendAction[]): boolean {
  const lastAction = actions.at(-1);
  return !(lastAction?.type === 'key' && lastAction.key === 'Enter');
}

function applyAutoEnter(actions: TmuxSendAction[]): TmuxSendAction[] {
  return shouldAppendAutoEnter(actions)
    ? [...actions, { type: 'key', key: 'Enter' }]
    : actions;
}

function applyPlainTextTmuxActions(
  actions: TmuxSendAction[],
): TmuxSendAction[] {
  return applyAutoEnter(actions);
}

function buildInputEchoBlock(input: string, markdown: boolean): string {
  const { text, truncated } = sanitizeInput(input, 12_000);
  const body = markdown ? buildFencedCodeBlock(text, 'text') : text;
  const suffix = truncated ? '\n\n（输入内容过长已截断）' : '';
  return [
    buildCommandFields('tmux 输入回显', [], [], markdown),
    '',
    body + suffix,
  ].join('\n').trim();
}

function buildTmuxCaptureResponse(
  screen: string,
  lines: number,
  commands: string[],
  markdown: boolean,
  options?: { echoInput?: string },
): string {
  const { text, truncated } = sanitizeInput(screen || '(empty)', 24_000);
  const body = markdown ? buildFencedCodeBlock(text, 'sh') : text;
  const suffix = truncated ? '\n\n（屏幕内容过长已截断）' : '';
  return appendTmuxCommandPreview([
    ...(options?.echoInput !== undefined ? [buildInputEchoBlock(options.echoInput, markdown), ''] : []),
    body + suffix,
    '',
    buildCommandFields(
      'tmux 发送结果',
      [['展示行数', `${lines}`]],
      [],
      markdown,
    ),
  ].join('\n').trim(), commands, markdown);
}

function buildTmuxScreenResponse(
  target: string,
  screen: string,
  lines: number,
  markdown: boolean,
  options?: {
    intervalSeconds?: number;
    monitorStarted?: boolean;
    commands?: string[];
    selectionPrompt?: RuntimeTmuxSelectionPrompt;
  },
): string {
  const { text, truncated } = sanitizeInput(screen || '(empty)', 24_000);
  const screenBlock = markdown ? buildFencedCodeBlock(text, 'sh') : text;
  const suffix = truncated ? '\n\n（屏幕内容过长已截断）' : '';
  const notes = ['只查看当前屏幕，不发送任何按键。'];
  if (options?.intervalSeconds) {
    notes.push(options.monitorStarted
      ? `已开启定时刷新：每 ${options.intervalSeconds} 秒刷新一次；发送 \`/tmux-screen stop\` 停止。`
      : `定时刷新：每 ${options.intervalSeconds} 秒。`);
  }
  if (options?.selectionPrompt) {
    notes.push(`检测到 ${formatRuntimeTmuxSelectionPrompt(options.selectionPrompt)}。`);
  }
  const response = [
    buildCommandFields(
      'tmux 当前屏幕状态',
      [
        ['tmux session', target],
        ['展示行数', `${lines}`],
        ...(options?.intervalSeconds ? [['定时刷新', `${options.intervalSeconds}s`] as [string, string]] : []),
      ],
      notes,
      markdown,
    ),
    '',
    screenBlock + suffix,
  ].join('\n').trim();
  return appendTmuxCommandPreview(response, options?.commands || [], markdown);
}

function formatRuntimeTmuxSelectionPrompt(selectionPrompt: RuntimeTmuxSelectionPrompt): string {
  if (selectionPrompt.runtime === 'codex') {
    const action = selectionPrompt.defaultChoice
      ? `默认动作：${selectionPrompt.defaultChoice}`
      : '需要用户选择';
    return `Codex ${selectionPrompt.kind} selection prompt（${action}）`;
  }
  return `Claude ${selectionPrompt.kind} prompt（默认动作：Enter）`;
}

function formatRuntimeTmuxAutoForwardReadinessError(
  runtime: RuntimeTmuxKind,
  readiness: Pick<RuntimeTmuxReadinessResult, 'lastError' | 'lastScreen' | 'paneDead' | 'selectionPrompt'>,
  markdown: boolean,
): string {
  const runtimeName = runtime === 'claude' ? 'Claude Code' : 'Codex';
  if (readiness.paneDead) {
    const status = readiness.paneDead.status !== undefined ? `（exit ${readiness.paneDead.status}）` : '';
    const { text, truncated } = sanitizeInput(readiness.lastScreen || readiness.paneDead.line, 12_000);
    const screenBlock = markdown ? buildFencedCodeBlock(text, 'text') : text;
    const suffix = truncated ? '\n\n（屏幕内容过长已截断）' : '';
    return [
      `${runtimeName} tmux Provider pane 已退出${status}，未发送 auto-forward 消息。`,
      '',
      '最后屏幕：',
      screenBlock + suffix,
      '',
      '修复运行时命令后发送 `/p tmux` 重新启动，或用 `/tmux-screen 80` 查看当前 pane。',
    ].join('\n').trim();
  }
  if (readiness.selectionPrompt) {
    return `${runtimeName} TUI 仍停在 ${formatRuntimeTmuxSelectionPrompt(readiness.selectionPrompt)}，未发送 auto-forward 消息。`;
  }
  if (readiness.lastError) {
    return `${runtimeName} tmux readiness 检查失败：${readiness.lastError}，未发送 auto-forward 消息。请用 \`/tmux-screen 80\` 检查。`;
  }
  return `${runtimeName} TUI 未在超时时间内进入可输入状态，未发送 auto-forward 消息。请用 \`/tmux-screen 80\` 检查。`;
}

async function ensureRuntimeTmuxSessionForProvider(
  params: Pick<HandleTmuxBridgeCommandParams, 'store' | 'binding' | 'session' | 'autoRecoverProviderSession' | 'tmuxProviderAutoForward' | 'reconcileMirrorSubscriptions' | 'requestCodexTuiSelection' | 'notifyBackgroundOperation'> & {
    pendingAutoForwardActions?: TmuxSendAction[];
  },
): Promise<{
  target: string | undefined;
  commands: string[];
  recovered: boolean;
  error?: string;
  kimiSubmission?: {
    sessionFilePath?: string;
    sessionId: string;
    cwd?: string;
    startOffset: number;
  };
}> {
  const { store, binding, session } = params;
  const runtimeTarget = getSessionRuntimeTmuxSessionName(session) || '';
  const manualTarget = getSessionTmuxSessionName(session) || '';
  const configuredTarget = runtimeTarget || manualTarget;
  const hasManualOnlyTarget = !runtimeTarget && Boolean(manualTarget);
  const runtimeProvider = resolveEffectiveRuntimeProvider(session, binding);
  if (runtimeProvider.provider !== 'tmux') {
    return { target: configuredTarget || undefined, commands: [], recovered: false };
  }
  if (runtimeProvider.runtime === 'claude') {
    const target = configuredTarget || claudeTmuxSessionName(getSessionClaudeSessionId(session) || session.id);
    if (!configuredTarget && params.autoRecoverProviderSession !== true) {
      return {
        target: undefined,
        commands: [],
        recovered: false,
        error: 'Claude tmux Provider 缺少 tmux session。请先发送 `/provider tmux` 初始化当前 Claude Code tmux 绑定。',
      };
    }
    const inspected = await inspectRuntimeTmuxInput({
      runtime: 'claude',
      sessionName: target,
      hasSession: () => hasTmuxSession(target),
    });
    if (inspected.exists) {
      if (!configuredTarget) {
        store.updateSession(session.id, setSessionClaudeTmuxProviderUpdate({
          tmuxSessionName: target,
          autoEnter: getProviderAutoEnter(),
        }));
        setSessionClaudeProviderToml(session.id, 'tmux');
        scheduleTmuxMirrorReconcile(params.reconcileMirrorSubscriptions, 'existing Claude provider binding');
      }
      if (
        params.tmuxProviderAutoForward === true
        && inspected.needsReadiness
      ) {
        console.log('[tmux-command] Waiting for existing Claude tmux provider session before auto-forward:', {
          event: 'tmux.provider.claude.existing.wait_ready',
          bridge_session_id: session.id,
          tmux_session: target,
          input_state: inspected.state.state,
        });
        const readiness = await waitForRuntimeTmuxReady({
          runtime: 'claude',
          sessionName: target,
          target: `${target}:0.0`,
        });
        if (!readiness.ready) {
          return {
            target,
            commands: [inspected.command || '', ...readiness.commands].filter(Boolean),
            recovered: false,
            error: formatRuntimeTmuxAutoForwardReadinessError('claude', readiness, true),
          };
        }
        return { target, commands: [inspected.command || '', ...readiness.commands].filter(Boolean), recovered: false };
      }
      return { target, commands: inspected.command ? [inspected.command] : [], recovered: false };
    }
    if (params.autoRecoverProviderSession !== true || hasManualOnlyTarget) {
      return {
        target,
        commands: inspected.command ? [inspected.command] : [],
        recovered: false,
        error: `tmux session 不存在：${target}。请先发送 \`/provider tmux\` 重新初始化 Claude Code tmux，或发送 \`/tmux-new ${target}\` 手动创建。`,
      };
    }
    const claudeConfig = resolveClaudeRuntimeConfig(session, binding);
    await params.notifyBackgroundOperation?.(
      configuredTarget
        ? `tmux session \`${target}\` 不存在，正在后台重新启动 Claude Code TUI。`
        : `Claude tmux Provider 缺少 tmux session，正在后台启动 Claude Code TUI \`${target}\`。`,
    );
    const started = await startRuntimeTmuxSession({
      runtime: 'claude',
      sessionName: target,
      bridgeSessionId: session.id,
      workingDirectory: getSessionWorkingDirectory(session),
      executable: claudeConfig.executable,
      model: claudeConfig.model,
      permissionMode: claudeConfig.permissionMode,
      reasoningEffort: claudeConfig.reasoningEffort,
      recreate: true,
      waitReady: true,
    });
    if (!started.ready) {
      const readiness = started.runtime === 'claude' ? started.readiness : undefined;
      return {
        target,
        commands: [inspected.command || '', ...started.commands].filter(Boolean),
        recovered: false,
        error: formatRuntimeTmuxAutoForwardReadinessError('claude', readiness || {
          lastScreen: undefined,
          lastError: undefined,
        }, true),
      };
    }
    store.updateSession(session.id, setSessionClaudeTmuxProviderUpdate({
      tmuxSessionName: target,
      autoEnter: getProviderAutoEnter(),
    }));
    setSessionClaudeProviderToml(session.id, 'tmux');
    scheduleTmuxMirrorReconcile(params.reconcileMirrorSubscriptions, 'recovered Claude provider session');
    return { target, commands: [inspected.command || '', ...started.commands].filter(Boolean), recovered: true };
  }

  if (runtimeProvider.runtime === 'kimi') {
    if (configuredTarget) {
      const inspected = await inspectRuntimeTmuxInput({
        runtime: 'kimi',
        sessionName: configuredTarget,
        hasSession: () => hasTmuxSession(configuredTarget),
      });
      if (
        inspected.exists
        && Boolean(session.runtime?.kimi?.sessionId)
        && !(
          params.tmuxProviderAutoForward === true
          && inspected.needsReadiness
        )
      ) {
        const kimiSubmission = syncKimiTmuxTurnStateFromSession({
          sessionName: configuredTarget,
          sessionId: session.runtime?.kimi?.sessionId,
          cwd: getSessionWorkingDirectory(session),
        });
        return {
          target: configuredTarget,
          commands: inspected.command ? [inspected.command] : [],
          recovered: false,
          ...(session.runtime?.kimi?.sessionId ? {
            kimiSubmission: {
              ...(kimiSubmission.sessionFilePath
                ? { sessionFilePath: kimiSubmission.sessionFilePath }
                : {}),
              sessionId: session.runtime.kimi.sessionId,
              cwd: getSessionWorkingDirectory(session),
              startOffset: kimiSubmission.startOffset,
            },
          } : {}),
        };
      }
      if (params.autoRecoverProviderSession !== true) {
        return {
          target: configuredTarget,
          commands: inspected.command ? [inspected.command] : [],
          recovered: false,
          error: `tmux session 不存在：${configuredTarget}。请先发送 \`/provider tmux\` 重新初始化 Kimi Code tmux。`,
        };
      }
    }
    const kimiConfig = resolveKimiRuntimeConfig(session, binding);
    const prepared = await ensureKimiTmuxInputSession({
      prompt: '',
      sessionId: session.id,
      runtime: 'kimi',
      kimiSessionId: session.runtime?.kimi?.sessionId,
      workingDirectory: getSessionWorkingDirectory(session),
      model: kimiConfig.model || undefined,
    });
    store.updateSession(session.id, {
      ...setSessionKimiIdentityUpdate(prepared.sessionId, prepared.cwd),
      runtime: {
        ...setSessionKimiIdentityUpdate(prepared.sessionId, prepared.cwd).runtime,
        general: { tmuxSessionName: prepared.sessionName },
      },
    });
    scheduleTmuxMirrorReconcile(params.reconcileMirrorSubscriptions, 'initialized Kimi provider session');
    return {
      target: prepared.sessionName,
      commands: [],
      recovered: !prepared.existed,
      kimiSubmission: {
        ...(prepared.sessionFilePath ? { sessionFilePath: prepared.sessionFilePath } : {}),
        sessionId: prepared.sessionId,
        ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
        startOffset: prepared.nextOffset,
      },
    };
  }

  if (runtimeProvider.runtime === 'cursor') {
    if (configuredTarget) {
      const inspected = await inspectRuntimeTmuxInput({
        runtime: 'cursor',
        sessionName: configuredTarget,
        hasSession: () => hasTmuxSession(configuredTarget),
      });
      if (inspected.exists) {
        return {
          target: configuredTarget,
          commands: inspected.command ? [inspected.command] : [],
          recovered: false,
        };
      }
      if (params.autoRecoverProviderSession !== true) {
        return {
          target: configuredTarget,
          commands: inspected.command ? [inspected.command] : [],
          recovered: false,
          error: `tmux session 不存在：${configuredTarget}。请先发送 \`/provider tmux\` 重新初始化 Cursor Agent tmux。`,
        };
      }
    }
    const cursorConfig = resolveCursorRuntimeConfig(session, binding);
    const prepared = await ensureCursorTmuxInputSession({
      prompt: '',
      sessionId: session.id,
      runtime: 'cursor',
      cursorSessionId: session.runtime?.cursor?.sessionId,
      cursorForce: cursorConfig.force,
      workingDirectory: getSessionWorkingDirectory(session),
      model: cursorConfig.model,
    });
    const identityUpdate = setSessionCursorIdentityUpdate(prepared.sessionId, prepared.cwd);
    store.updateSession(session.id, {
      ...identityUpdate,
      runtime: {
        ...identityUpdate.runtime,
        general: { tmuxSessionName: prepared.sessionName },
      },
    });
    scheduleTmuxMirrorReconcile(params.reconcileMirrorSubscriptions, 'initialized Cursor provider session');
    return { target: prepared.sessionName, commands: [], recovered: !prepared.existed };
  }

  let threadId = getCodexThreadId(session, binding);
  if (!threadId && params.autoRecoverProviderSession === true) {
    await params.notifyBackgroundOperation?.('tmux Provider 缺少 codex_thread_id，正在本地预创建 Codex thread。');
    const runtimeConfig = resolveSessionRuntimeConfig(binding, session);
    const bootstrapParams: BootstrapCodexThreadParams = {
      session,
      binding,
      mode: runtimeConfig.mode,
      sandboxMode: runtimeConfig.sandboxMode as BootstrapCodexThreadParams['sandboxMode'],
      networkAccessEnabled: runtimeConfig.networkAccessEnabled,
      modelReasoningEffort: runtimeConfig.reasoningEffort as BootstrapCodexThreadParams['modelReasoningEffort'],
      skipGitRepoCheck: runtimeConfig.skipGitRepoCheck,
    };
    threadId = await bootstrapCodexThreadLocally(bootstrapParams);
    store.updateSessionCodexThreadId(session.id, threadId);
  }

  const target = configuredTarget || (threadId ? codexTmuxSessionName(threadId) : '');
  if (!target) {
    return {
      target: undefined,
      commands: [],
      recovered: false,
      error: 'tmux Provider 缺少 codex_thread_id，无法自动恢复 Codex TUI。请先发送 `/provider tmux` 重新初始化。',
    };
  }

  const inspected = await inspectRuntimeTmuxInput({
    runtime: 'codex',
    sessionName: target,
    hasSession: () => hasTmuxSession(target),
  });
  if (inspected.exists) {
    const commands = inspected.command ? [inspected.command] : [];
    if (!configuredTarget || !getCodexThreadId(session, binding)) {
      store.updateSession(session.id, setSessionCodexTmuxProviderUpdate({
        tmuxSessionName: target,
        autoEnter: getProviderAutoEnter(),
        threadId,
      }));
      scheduleTmuxMirrorReconcile(params.reconcileMirrorSubscriptions, 'existing Codex provider binding');
    }
    if (
      params.tmuxProviderAutoForward === true
      && inspected.needsReadiness
    ) {
      console.log('[tmux-command] Waiting for existing Codex tmux provider session before auto-forward:', {
        event: 'tmux.provider.existing.wait_ready',
        bridge_session_id: session.id,
        tmux_session: target,
        thread_id: threadId,
        input_state: inspected.state.state,
        has_selection_handler: typeof params.requestCodexTuiSelection === 'function',
      });
      const readiness = await waitForCodexResumeTmuxReady(target, undefined, {
        onSelectionPrompt: async (selectionPrompt) => {
          if (selectionPrompt.runtime !== 'codex') return undefined;
          return params.requestCodexTuiSelection?.(selectionPrompt, {
            sessionId: session.id,
            ...(params.tmuxProviderAutoForward === true && params.pendingAutoForwardActions
              ? { autoForwardRecovery: { target, actions: params.pendingAutoForwardActions } }
              : {}),
          });
        },
      });
      commands.push(...readiness.commands);
      console.log('[tmux-command] Existing Codex tmux provider readiness before auto-forward resolved:', {
        event: 'tmux.provider.existing.ready',
        bridge_session_id: session.id,
        tmux_session: target,
        thread_id: threadId,
        ready: readiness.ready,
        selection_prompt_count: readiness.selectionPrompts?.length || 0,
      });
      if (!readiness.ready) {
        return {
          target,
          commands,
          recovered: false,
          error: formatRuntimeTmuxAutoForwardReadinessError('codex', {
            lastError: readiness.lastError,
            lastScreen: readiness.lastScreen,
            paneDead: readiness.paneDead,
            selectionPrompt: readiness.selectionPrompts?.at(-1),
          }, true),
        };
      }
    }
    return { target, commands, recovered: false };
  }

  if (params.autoRecoverProviderSession !== true || hasManualOnlyTarget) {
    return {
      target,
      commands: inspected.command ? [inspected.command] : [],
      recovered: false,
      error: `tmux session 不存在：${target}。请先发送 \`/provider tmux\` 重新启动 Codex TUI。`,
    };
  }

  if (!threadId) {
    return {
      target,
      commands: inspected.command ? [inspected.command] : [],
      recovered: false,
      error: 'tmux Provider 缺少 codex_thread_id，无法自动恢复 Codex TUI。请先发送 `/provider tmux` 重新初始化。',
    };
  }

  const runtimeConfig = resolveSessionRuntimeConfig(binding, session);
  await params.notifyBackgroundOperation?.(`tmux session \`${target}\` 不存在，正在后台重新启动 Codex TUI。`);
  console.log('[tmux-command] Recovering missing Codex tmux provider session:', {
    event: 'tmux.provider.recover.start',
    bridge_session_id: session.id,
    tmux_session: target,
    thread_id: threadId,
    cwd: getSessionWorkingDirectory(session),
    has_selection_handler: typeof params.requestCodexTuiSelection === 'function',
  });
  const started = await startRuntimeTmuxSession({
    runtime: 'codex',
    sessionName: target,
    threadId,
    bridgeSessionId: session.id,
    workingDirectory: getSessionWorkingDirectory(session),
    model: runtimeConfig.model || undefined,
    sandboxMode: runtimeConfig.sandboxMode as StartCodexResumeTmuxSessionParams['sandboxMode'],
    networkAccessEnabled: runtimeConfig.networkAccessEnabled,
    modelReasoningEffort: runtimeConfig.reasoningEffort as StartCodexResumeTmuxSessionParams['modelReasoningEffort'],
    skipGitRepoCheck: runtimeConfig.skipGitRepoCheck,
    codexMode: runtimeConfig.mode === 'yolo' ? 'yolo' : 'normal',
    permissionMode: runtimeConfig.mode === 'yolo' ? 'never' : 'acceptEdits',
    onSelectionPrompt: async (selectionPrompt) => {
      if (selectionPrompt.runtime !== 'codex') return undefined;
      return params.requestCodexTuiSelection?.(selectionPrompt, {
        sessionId: session.id,
        ...(params.tmuxProviderAutoForward === true && params.pendingAutoForwardActions
          ? { autoForwardRecovery: { target, actions: params.pendingAutoForwardActions } }
          : {}),
      });
    },
    onStatus: (message, options) => params.notifyBackgroundOperation?.(message, options),
  });
  console.log('[tmux-command] Recovered missing Codex tmux provider session:', {
    event: 'tmux.provider.recover.done',
    bridge_session_id: session.id,
    tmux_session: target,
    thread_id: threadId,
    ready: started.ready,
    selection_prompt_count: started.runtime === 'codex' ? started.selectionPrompts?.length || 0 : 0,
  });
  store.updateSession(session.id, setSessionCodexTmuxProviderUpdate({
    tmuxSessionName: target,
    autoEnter: getProviderAutoEnter(),
    threadId,
  }));
  scheduleTmuxMirrorReconcile(params.reconcileMirrorSubscriptions, 'recovered Codex provider session');
  return { target, commands: [inspected.command || '', ...started.commands].filter(Boolean), recovered: true };
}

function formatTmuxScreenCardStatus(target: string, lines: number, intervalSeconds: number): string {
  const refreshedAt = formatLocalClockTime(Date.now()) || '--:--:--';
  return `tmux ${target} · ${lines} lines · every ${intervalSeconds}s · ${refreshedAt}`;
}

function buildTmuxScreenStopActions(callbackData: string, stopped: boolean): StructuredStreamingUiActionButton[][] {
  return [[{
    text: stopped ? '已停止' : '停止',
    callbackData,
    type: stopped ? 'default' : 'danger',
    disabled: stopped,
  }]];
}

function buildTmuxAttachResponse(
  title: string,
  fields: Array<[string, string | null | undefined]>,
  screen: string,
  lines: number,
  commands: string[],
  markdown: boolean,
): string {
  const { text, truncated } = sanitizeInput(screen || '(empty)', 24_000);
  const screenBlock = markdown ? buildFencedCodeBlock(text, 'sh') : text;
  const suffix = truncated ? '\n\n（屏幕内容过长已截断）' : '';
  const response = [
    buildCommandFields(
      title,
      fields,
      ['已展示当前 tmux 屏幕；之后发送 `/tmux ...` 会把按键传给这个 tmux session，并自动截屏返回。'],
      markdown,
    ),
    '',
    screenBlock + suffix,
  ].join('\n').trim();
  return appendTmuxCommandPreview(response, commands, markdown);
}

function stopTmuxScreenMonitor(key: string): TmuxScreenMonitor | null {
  const existing = screenMonitors.get(key);
  if (!existing) return null;
  existing.stopped = true;
  clearTimeout(existing.timer);
  screenMonitors.delete(key);
  return existing;
}

function startTmuxScreenMonitor(params: {
  key: string;
  target: string;
  lines: number;
  runtime?: RuntimeTmuxKind;
  intervalSeconds: number;
  markdown: boolean;
  deliver: (text: string) => Promise<void>;
  stopCallbackData?: string;
  card?: {
    update: (text: string, statusText: string) => void;
    actions?: (actions: StructuredStreamingUiActionButton[][]) => void;
    finish: (status: 'completed' | 'interrupted' | 'error', text: string) => Promise<boolean>;
  };
}): void {
  stopTmuxScreenMonitor(params.key);
  const monitor: TmuxScreenMonitor = {
    timer: setTimeout(() => {}, params.intervalSeconds * 1000),
    target: params.target,
    lines: params.lines,
    intervalSeconds: params.intervalSeconds,
    markdown: params.markdown,
    deliver: params.deliver,
    stopCallbackData: params.stopCallbackData,
    card: params.card,
    busy: false,
    stopped: false,
  };
  const scheduleNext = () => {
    if (monitor.stopped) return;
    monitor.timer = setTimeout(async () => {
      if (monitor.stopped) return;
      if (monitor.busy) {
        scheduleNext();
        return;
      }
      monitor.busy = true;
      try {
        const inspected = await inspectRuntimeTmuxSession({
          sessionName: monitor.target,
          lines: monitor.lines,
          runtime: monitor.runtime,
        });
        if (monitor.stopped) return;
        if (!inspected.exists) {
          throw new Error(`tmux session 不存在：${monitor.target}`);
        }
        const inspectCommands = [inspected.existsCommand, inspected.captureCommand || ''].filter(Boolean);
        const text = buildTmuxScreenResponse(
          monitor.target,
          inspected.screen || '',
          monitor.lines,
          monitor.markdown,
          {
            intervalSeconds: monitor.intervalSeconds,
            commands: monitor.card ? [] : inspectCommands,
            selectionPrompt: inspected.selectionPrompt,
          },
        );
        if (monitor.card) {
          monitor.card.update(text, formatTmuxScreenCardStatus(monitor.target, monitor.lines, monitor.intervalSeconds));
        } else {
          await monitor.deliver(text);
        }
      } catch (error) {
        if (monitor.stopped) return;
        const text = formatTmuxError(error, monitor.markdown);
        if (monitor.card) {
          monitor.card.update(text, `tmux ${monitor.target} · refresh failed`);
        } else {
          await monitor.deliver(text);
        }
      } finally {
        monitor.busy = false;
        scheduleNext();
      }
    }, monitor.intervalSeconds * 1000);
    monitor.timer.unref?.();
  };
  clearTimeout(monitor.timer);
  scheduleNext();
  screenMonitors.set(params.key, monitor);
}

export async function handleTmuxBridgeCommand(params: HandleTmuxBridgeCommandParams): Promise<string> {
  const { command, args, store, binding, session, markdown } = params;

  try {
    if (command === '/tmux-switch') {
      const { sessions, command: listCommand } = await listTmuxSessions();
      params.richCard?.(buildTmuxSwitchCommandCard(sessions, params.binding.bridgeSessionId));
      return appendTmuxCommandPreview(
        buildTmuxSwitchResponse(sessions, getSessionTmuxSessionName(session), markdown),
        [listCommand],
        markdown,
      );
    }

    if (command === '/tmux-status') {
      return buildTmuxStatusResponse(session, markdown);
    }

    if (command === '/tmux-screen') {
      const parsed = parseTmuxScreenArgs(args);
      if (!parsed) {
        return buildCommandFields(
          'tmux 屏幕用法',
          [['命令', '`/tmux-screen [lines] [seconds]s`']],
          [
            '`/tmux-screen`：查看默认行数。',
            '`/tmux-screen 120`：临时查看 120 行，不修改 `/tmux-set` 的默认值。',
            '`/tmux-screen 5s`：使用默认行数，每 5 秒刷新一次。',
            '`/tmux-screen 120 5s`：临时查看 120 行，并每 5 秒刷新一次；最低 3 秒。',
            '`/tmux-screen stop`：停止当前聊天的定时刷新。',
          ],
          markdown,
        );
      }
      if (parsed.action === 'stop') {
        if (!params.screenMonitor) return '当前环境不支持停止 tmux 屏幕定时刷新。';
        const stopped = stopTmuxScreenMonitor(params.screenMonitor.key);
        if (!stopped) return '当前聊天没有正在运行的 tmux 屏幕定时刷新。';
        if (stopped.card) {
          if (stopped.stopCallbackData) {
            stopped.card.actions?.(buildTmuxScreenStopActions(stopped.stopCallbackData, true));
          }
          await stopped.card.finish('interrupted', '已停止 tmux 屏幕定时刷新。');
        }
        return '已停止 tmux 屏幕定时刷新。';
      }

      const ensured = await ensureRuntimeTmuxSessionForProvider(params);
      if (ensured.error) return ensured.error;
      const captureTarget = ensured.target || getSessionTmuxSessionName(session);
      if (!captureTarget) {
        return 'tmux 未绑定。先发送 `/tmux-switch` 查看 session，或 `/tmux-attach <session>` / `/tmux-new <session>` 绑定。';
      }
      const lines = parsed.lines ?? getCaptureLines(session);
      const runtimeProvider = resolveEffectiveRuntimeProvider(session, binding);
      const inspected = await inspectRuntimeTmuxSession({
        runtime: runtimeProvider.provider === 'tmux'
          ? runtimeProvider.runtime
          : undefined,
        sessionName: captureTarget,
        lines,
      });
      if (!inspected.exists) {
        return appendTmuxCommandPreview(
          `tmux session 不存在：${captureTarget}。如果这是当前 tmux Provider，请发送 \`/p tmux\` 重新启动 TUI。`,
          [...ensured.commands, inspected.existsCommand],
          markdown,
        );
      }
      if (parsed.intervalSeconds) {
        const inspectCommands = [inspected.existsCommand, inspected.captureCommand || ''].filter(Boolean);
        if (!params.screenMonitor) return appendTmuxCommandPreview('当前环境不支持 tmux 屏幕定时刷新。', inspectCommands, markdown);
        const card = params.screenMonitor.card;
        const initialText = buildTmuxScreenResponse(captureTarget, inspected.screen || '', lines, markdown, {
          intervalSeconds: parsed.intervalSeconds,
          monitorStarted: true,
          commands: card ? [] : [...ensured.commands, ...inspectCommands],
          selectionPrompt: inspected.selectionPrompt,
        });
        if (card) {
          if (params.screenMonitor.stopCallbackData) {
            card.actions?.(buildTmuxScreenStopActions(params.screenMonitor.stopCallbackData, false));
          }
          card.update(initialText, formatTmuxScreenCardStatus(captureTarget, lines, parsed.intervalSeconds));
        }
        startTmuxScreenMonitor({
          key: params.screenMonitor.key,
          target: captureTarget,
          lines,
          runtime: runtimeProvider.provider === 'tmux'
            ? runtimeProvider.runtime
            : undefined,
          intervalSeconds: parsed.intervalSeconds,
          markdown,
          deliver: params.screenMonitor.deliver,
          stopCallbackData: params.screenMonitor.stopCallbackData,
          card,
        });
        if (card) return '';
      }
      return buildTmuxScreenResponse(captureTarget, inspected.screen || '', lines, markdown, {
        intervalSeconds: parsed.intervalSeconds,
        monitorStarted: Boolean(parsed.intervalSeconds),
        commands: [...ensured.commands, inspected.existsCommand, inspected.captureCommand || ''].filter(Boolean),
        selectionPrompt: inspected.selectionPrompt,
      });
    }

    if (command === '/tmux-set') {
      const parsed = parseTmuxSetArgs(args);
      if (!parsed) {
        return buildCommandFields(
          'tmux 设置用法',
          [['命令', '`/tmux-set lines <1-500>` 或 `/tmux-set echo on|off`']],
          [
            `当前展示行数：${getCaptureLines(session)}`,
            `当前输入回显：${formatOnOff(getEchoInput(session))}`,
          ],
          markdown,
        );
      }
      if (parsed.key === 'lines') {
        setSessionTmuxCaptureLinesToml(session.id, parsed.value);
        return buildCommandFields(
          '已更新 tmux 设置',
          [['展示行数', `${parsed.value}`]],
          ['下一次 `/tmux ...` 截屏生效。'],
          markdown,
        );
      }
      if (parsed.key === 'echo') {
        setSessionTmuxEchoInputToml(session.id, parsed.value);
        return buildCommandFields(
          '已更新 tmux 设置',
          [['输入回显', formatOnOff(parsed.value)]],
          [
            parsed.value
              ? '之后 `/tmux ...` 会在发送内容后把本次输入回显到回复里。'
              : '之后 `/tmux ...` 不会额外回显输入内容。',
          ],
        markdown,
      );
      }
    }

    if (command === '/tmux-attach') {
      const name = validateTmuxSessionName(args);
      if (!name) return '用法：/tmux-attach <session>';
      const attached = await attachTmuxSession(name, getCaptureLines(session));
      if (!attached.exists) {
        return appendTmuxCommandPreview(
          `没有找到 tmux session：${name}。可先发送 \`/tmux-switch\` 查看，或 \`/tmux-new ${name}\` 新建。`,
          [attached.existsCommand],
          markdown,
        );
      }
      setSessionTmuxSessionName(store, session.id, name);
      const lines = getCaptureLines(session);
      return buildTmuxAttachResponse(
        '已绑定 tmux session',
        [
          ['tmux session', name],
          ['Bridge session', binding.bridgeSessionId],
          ['展示行数', `${lines}`],
          ...(attached.selectionPrompt
            ? [['Selection', formatRuntimeTmuxSelectionPrompt(attached.selectionPrompt)] as [string, string]]
            : []),
        ],
        attached.screen || '',
        lines,
        [attached.existsCommand, attached.captureCommand || ''].filter(Boolean),
        markdown,
      );
    }

    if (command === '/tmux-new') {
      const requestedName = args.trim() || `codelark-${binding.bridgeSessionId.slice(0, 8)}`;
      const name = validateTmuxSessionName(requestedName);
      if (!name) return '用法：/tmux-new [session]';
      const cwd = getSessionWorkingDirectory(session) || process.cwd();
      setSessionTmuxSessionName(store, session.id, name);
      const lines = getCaptureLines(session);
      const ensured = await createOrAttachTmuxSession({ name, cwd, lines });
      return buildTmuxAttachResponse(
        ensured.existed ? 'tmux session 已存在，已直接绑定' : '已新建并绑定 tmux session',
        [
          ['tmux session', name],
          ['目录', cwd],
          ['展示行数', `${lines}`],
        ],
        ensured.screen,
        lines,
        ensured.commands,
        markdown,
      );
    }

    if (command === '/tmux' || command === '/tmux-key') {
      if (!args.trim()) {
        return buildTmuxOverviewResponse(session, markdown);
      }
      const keySequenceActions = command === '/tmux' ? parseTmuxKeySequence(args) : null;
      if (command === '/tmux' && !keySequenceActions && isPureSpecialKeySyntax(args)) {
        const invalid = parseTmuxSendActions(args);
        return buildCommandFields(
          'tmux 按键用法',
          [['错误', invalid.error || '特殊键序列不合法。']],
          ['`/tmux` 单独发送尖括号序列时只接受合法控制键，例如 `/tmux <C-c><Enter>`；普通文本请不要写成单独的尖括号 token。'],
          markdown,
        );
      }
      const parsed = command === '/tmux-key'
        ? parseTmuxSendActions(args)
        : { actions: keySequenceActions || [{ type: 'literal', text: args }] as TmuxSendAction[] };
      if (parsed.error) {
        return buildCommandFields(
          'tmux 按键用法',
          [['错误', parsed.error]],
          ['发送 `/tmux` 查看完整用法；普通尖括号文本请用 `/tmux ...`，特殊按键请用 `/tmux-key ...`。'],
          markdown,
        );
      }
      const actions = parsed.actions || [];
      const pendingAutoForwardActions = params.tmuxProviderAutoForward === true && command === '/tmux'
        ? (keySequenceActions ? actions : applyPlainTextTmuxActions(actions))
        : undefined;
      const ensured = await ensureRuntimeTmuxSessionForProvider({
        ...params,
        pendingAutoForwardActions,
      });
      const target = ensured.target || getSessionTmuxSessionName(session);
      if (ensured.error) {
        if (params.suppressSuccessfulResponse === true) {
          throw new Error(ensured.error);
        }
        return ensured.error;
      }
      if (!target) {
        return buildCommandFields(
          'tmux 未绑定',
          [],
          ['先发送 `/tmux-switch` 查看 session，或 `/tmux-attach <session>` / `/tmux-new <session>` 绑定。'],
          markdown,
        );
      }
      const effectiveSession = store.getSession(session.id) || session;
      const actionsToSend = command === '/tmux' && !keySequenceActions
        ? applyPlainTextTmuxActions(actions)
        : actions;
      if (params.suppressSuccessfulResponse === true) {
        const runtimeProvider = resolveEffectiveRuntimeProvider(effectiveSession, binding);
        if (runtimeProvider.provider === 'tmux') {
          const submitProviderInput = () => sendRuntimeTmuxInput({
            runtime: runtimeProvider.runtime,
            sessionName: target,
            send: () => sendTmuxActions(target, actionsToSend, {
              delayMs: SEND_ACTION_DELAY_MS,
              forcePasteLiterals: (
                runtimeProvider.runtime === 'codex'
                || runtimeProvider.runtime === 'kimi'
              ) && !keySequenceActions,
            }),
            ...(runtimeProvider.runtime === 'kimi'
              ? { steer: () => sendKimiTmuxExplicitSteer(`${target}:0.0`) }
              : {}),
          });
          await submitProviderInput();
          if (runtimeProvider.runtime === 'kimi') {
            if (!ensured.kimiSubmission) {
              throw new Error('Kimi Code 输入确认信息缺失；已停止本次转发，避免把未提交的消息误报为成功。');
            }
            const expectedPrompt = actionsToSend
              .filter((action): action is Extract<TmuxSendAction, { type: 'literal' }> => action.type === 'literal')
              .map((action) => action.text)
              .join('');
            if (!expectedPrompt) {
              throw new Error('Kimi Code 输入确认内容为空；已停止本次转发，避免把未提交的消息误报为成功。');
            }
            const accepted = await retryKimiSubmitIfNoActivity({
              sessionName: target,
              targetPane: `${target}:0.0`,
              sessionFilePath: ensured.kimiSubmission.sessionFilePath,
              sessionId: ensured.kimiSubmission.sessionId,
              cwd: ensured.kimiSubmission.cwd,
              startOffset: ensured.kimiSubmission.startOffset,
              expectedPrompt,
              retrySubmit: () => submitProviderInput().then(() => undefined),
            });
            if (!accepted) {
              throw new Error('Kimi Code 输入未能启动 turn；已根据 wire 状态重发完整输入或提交键，仍未提交。');
            }
          }
        } else {
          await sendTmuxActions(target, actionsToSend, { delayMs: SEND_ACTION_DELAY_MS });
        }
        await params.onTmuxProviderAutoForwarded?.();
        return '';
      }
      const lines = getCaptureLines(session);
      const manualRuntime = getSessionActiveRuntime(effectiveSession);
      const manualActions = manualRuntime
        && resolveRuntimeTmuxSteerOperation(manualRuntime, target) === 'explicit'
        ? [...actionsToSend, { type: 'key' as const, key: 'C-s' }]
        : actionsToSend;
      const sent = await sendTmuxActionsAndCapture({
        target,
        actions: manualActions,
        lines,
        sendDelayMs: SEND_ACTION_DELAY_MS,
        captureDelayMs: CAPTURE_AFTER_SEND_DELAY_MS,
      });
      return buildTmuxCaptureResponse(
        sent.screen,
        lines,
        [...ensured.commands, ...sent.commands],
        markdown,
        getEchoInput(session) ? { echoInput: args } : undefined,
      );
    }

    return `未知 tmux 命令：${command}`;
  } catch (error) {
    return formatTmuxError(error, markdown);
  }
}
