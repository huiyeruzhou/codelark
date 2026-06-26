import type { BridgeSession, ChannelChat } from '../../domain/index.js';
import type { StructuredStreamingUiActionButton } from '../../channels/contracts.js';
import { resolveEffectiveCodexProvider } from '../session/support.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeSessionId,
  getSessionCodexThreadId,
} from '../../domain/session-runtime.js';
import { buildCommandFields } from './presentation.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';
import { captureRuntimePtyScreen, type RuntimePtyScreenSnapshot } from '../pty/runtime.js';
import {
  DEFAULT_PTY_SCREEN_LINES,
  parsePtyScreenArgs,
} from './pty-args.js';

interface PtyScreenMonitor {
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  lines: number;
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

export interface HandlePtyScreenCommandParams {
  args: string;
  session: BridgeSession;
  binding?: ChannelChat | null;
  markdown: boolean;
  screenMonitor?: {
    key: string;
    stopCallbackData?: string;
    deliver: (text: string) => Promise<void>;
    card?: PtyScreenMonitor['card'];
  };
}

const screenMonitors = new Map<string, PtyScreenMonitor>();

function formatPtyScreenCardStatus(sessionId: string, lines: number, intervalSeconds: number): string {
  const refreshedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  return `pty ${sessionId.slice(0, 8)} · ${lines} lines · every ${intervalSeconds}s · ${refreshedAt}`;
}

function buildPtyScreenStopActions(callbackData: string, stopped: boolean): StructuredStreamingUiActionButton[][] {
  return [[{
    text: stopped ? '已停止' : '停止刷新',
    callbackData,
    disabled: stopped,
    type: stopped ? 'default' : 'danger',
  }]];
}

function stopPtyScreenMonitor(key: string): PtyScreenMonitor | null {
  const monitor = screenMonitors.get(key);
  if (!monitor) return null;
  monitor.stopped = true;
  clearTimeout(monitor.timer);
  screenMonitors.delete(key);
  return monitor;
}

function buildPtyScreenResponse(
  session: BridgeSession,
  capture: RuntimePtyScreenSnapshot | null,
  lines: number,
  markdown: boolean,
  options: { intervalSeconds?: number; monitorStarted?: boolean } = {},
): string {
  const runtime = getSessionActiveRuntime(session) || 'codex';
  const screen = capture?.screen || '';
  const notes = [
    screen ? undefined : '当前还没有 pty 输出。请确认 pty 任务正在运行，或稍后再试。',
    options.monitorStarted && options.intervalSeconds
      ? `已开启定时刷新：每 ${options.intervalSeconds} 秒刷新一次；发送 \`/pty-screen stop\` 停止。`
      : undefined,
  ].filter(Boolean) as string[];
  const response = buildCommandFields(
    'pty 当前屏幕状态',
    [
      ['Bridge session', session.id],
      ['Runtime', runtime],
      ['Provider', 'pty'],
      runtime === 'claude'
        ? ['claude_session_id', getSessionClaudeSessionId(session) || capture?.claudeSessionId || '-']
        : ['codex_thread_id', getSessionCodexThreadId(session) || capture?.codexThreadId || '-'],
      ['展示行数', `${lines}`],
      ['状态', capture?.exited ? 'exited' : 'running/latest'],
    ],
    notes,
    markdown,
  );
  const body = screen || '(empty)';
  return [
    response,
    markdown ? buildFencedCodeBlock(body, 'text') : body,
  ].join('\n\n');
}

function startPtyScreenMonitor(params: {
  key: string;
  session: BridgeSession;
  lines: number;
  intervalSeconds: number;
  markdown: boolean;
  deliver: (text: string) => Promise<void>;
  stopCallbackData?: string;
  card?: PtyScreenMonitor['card'];
}): void {
  stopPtyScreenMonitor(params.key);
  const monitor: PtyScreenMonitor = {
    timer: setTimeout(tick, params.intervalSeconds * 1000),
    sessionId: params.session.id,
    lines: params.lines,
    intervalSeconds: params.intervalSeconds,
    markdown: params.markdown,
    deliver: params.deliver,
    stopCallbackData: params.stopCallbackData,
    card: params.card,
    busy: false,
    stopped: false,
  };
  screenMonitors.set(params.key, monitor);

  async function tick(): Promise<void> {
    const current = screenMonitors.get(params.key);
    if (!current || current.stopped) return;
    if (current.busy) {
      current.timer = setTimeout(tick, current.intervalSeconds * 1000);
      return;
    }
    current.busy = true;
    try {
      const latestSession = { ...params.session, id: current.sessionId };
      const capture = captureRuntimePtyScreen(latestSession, current.lines);
      const text = buildPtyScreenResponse(
        latestSession,
        capture,
        current.lines,
        current.markdown,
        { intervalSeconds: current.intervalSeconds, monitorStarted: true },
      );
      if (current.card) {
        current.card.update(text, formatPtyScreenCardStatus(current.sessionId, current.lines, current.intervalSeconds));
      } else {
        await current.deliver(text);
      }
    } catch (error) {
      const text = `pty 屏幕刷新失败：${error instanceof Error ? error.message : String(error)}`;
      if (current.card) current.card.update(text, `pty ${current.sessionId.slice(0, 8)} · refresh failed`);
      else await current.deliver(text);
    } finally {
      current.busy = false;
      if (!current.stopped) {
        current.timer = setTimeout(tick, current.intervalSeconds * 1000);
      }
    }
  }
}

export async function handlePtyScreenCommand(params: HandlePtyScreenCommandParams): Promise<string> {
  const parsed = parsePtyScreenArgs(params.args);
  if (!parsed) {
    return buildCommandFields(
      'pty 屏幕用法',
      [['命令', '`/pty-screen [lines] [seconds]s`']],
      [
        '`/pty-screen`：查看默认行数。',
        '`/pty-screen 120`：临时查看 120 行。',
        '`/pty-screen 5s`：使用默认行数，每 5 秒刷新一次。',
        '`/pty-screen 120 5s`：临时查看 120 行，并每 5 秒刷新一次；最低 3 秒。',
        '`/pty-screen stop`：停止当前聊天的定时刷新。',
      ],
      params.markdown,
    );
  }

  if (parsed.action === 'stop') {
    if (!params.screenMonitor) return '当前环境不支持停止 pty 屏幕定时刷新。';
    const stopped = stopPtyScreenMonitor(params.screenMonitor.key);
    if (!stopped) return '当前聊天没有正在运行的 pty 屏幕定时刷新。';
    if (stopped.card) {
      if (stopped.stopCallbackData) {
        stopped.card.actions?.(buildPtyScreenStopActions(stopped.stopCallbackData, true));
      }
      await stopped.card.finish('interrupted', '已停止 pty 屏幕定时刷新。');
    }
    return '已停止 pty 屏幕定时刷新。';
  }

  const runtime = getSessionActiveRuntime(params.session) || 'codex';
  if (runtime === 'kimi') {
    return '当前 Kimi 会话使用 tmux Provider。请使用 `/tmux-screen` 查看当前屏幕。';
  }
  if (runtime !== 'claude' && resolveEffectiveCodexProvider(params.session, params.binding) !== 'pty') {
    return '当前会话不是 pty Provider。请先发送 `/provider pty`，或继续使用 `/tmux-screen` 查看 tmux Provider。';
  }

  const lines = parsed.lines ?? DEFAULT_PTY_SCREEN_LINES;
  const capture = captureRuntimePtyScreen(params.session, lines);
  const text = buildPtyScreenResponse(params.session, capture, lines, params.markdown, {
    intervalSeconds: parsed.intervalSeconds,
    monitorStarted: Boolean(parsed.intervalSeconds),
  });

  if (parsed.intervalSeconds) {
    if (!params.screenMonitor) return text;
    const card = params.screenMonitor.card;
    if (card) {
      if (params.screenMonitor.stopCallbackData) {
        card.actions?.(buildPtyScreenStopActions(params.screenMonitor.stopCallbackData, false));
      }
      card.update(text, formatPtyScreenCardStatus(params.session.id, lines, parsed.intervalSeconds));
    }
    startPtyScreenMonitor({
      key: params.screenMonitor.key,
      session: params.session,
      lines,
      intervalSeconds: parsed.intervalSeconds,
      markdown: params.markdown,
      deliver: params.screenMonitor.deliver,
      stopCallbackData: params.screenMonitor.stopCallbackData,
      card,
    });
    if (card) return '';
  }

  return text;
}

export const _testOnlyPtyScreenMonitors = {
  activeCount: () => screenMonitors.size,
  stopAll: () => {
    const monitors = [...screenMonitors.values()];
    for (const monitor of monitors) {
      monitor.stopped = true;
      clearTimeout(monitor.timer);
    }
    screenMonitors.clear();
    return monitors.length;
  },
};
