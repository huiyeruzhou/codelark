import type { BridgeSession } from '../../../domain/session.js';
import { getSessionActiveRuntime, getSessionCodexThreadId, getSessionRuntimeTmuxSessionName } from '../../../domain/session-runtime.js';
import { appServerCliUrl } from '../../../runtime/codex/app-server-client.js';
import type { AppServerThreadState } from '../../../runtime/codex/app-server-lifecycle.js';
import { getCodexAppServerSession, type CodexAppServerServiceStatus } from '../../../runtime/codex/app-server-registry.js';
export type { CodexAppServerServiceStatus } from '../../../runtime/codex/app-server-registry.js';
import { codexTmuxSessionName } from '../../tmux/runtime.js';

export interface CodexBackendStatus {
  backend: 'app-server' | 'legacy' | 'unstarted';
  threadId?: string;
  connection: 'connecting' | 'ready' | 'disconnected' | 'unknown' | 'not-applicable';
  activity: 'unknown' | 'idle' | 'active' | 'waiting';
  terminal: 'view' | 'execution' | 'attached' | 'none';
  terminalName?: string;
  backendLabel: string;
  connectionLabel: string;
  activityLabel: string;
  terminalLabel: string;
}

export interface BridgeRuntimeStatus {
  codexDefault: 'app-server-auto' | 'legacy';
  sessions: Record<string, CodexBackendStatus>;
  appServers?: CodexAppServerServiceStatus[];
}

type ProtocolSnapshot = Pick<AppServerThreadState, 'threadId' | 'attached' | 'connection' | 'activity'>;
type CachedProtocolSession = {
  endpoint: string;
  threadId: string;
  lifecycle: { snapshot(threadId: string): ProtocolSnapshot };
};

/** Persisted identity describes the selected backend; only a matching live snapshot describes its connection. */
export function projectCodexBackendStatus(session: BridgeSession, snapshot?: ProtocolSnapshot): CodexBackendStatus {
  const codex = (getSessionActiveRuntime(session) || 'codex') === 'codex';
  const threadId = codex ? getSessionCodexThreadId(session) || undefined : undefined;
  const selected = codex && Boolean(session.runtime?.codex?.appServerEndpoint?.trim());
  const backend = !codex ? 'legacy' : !threadId ? 'unstarted' : selected ? 'app-server' : 'legacy';
  const observed = snapshot && backend === 'app-server' && snapshot.threadId === threadId && snapshot.attached !== false
    ? snapshot : undefined;
  const connection = backend === 'app-server' ? observed?.connection || 'unknown' : 'not-applicable';
  const activity = connection === 'ready' ? observed?.activity || 'unknown' : 'unknown';
  const name = codex ? getSessionRuntimeTmuxSessionName(session) : undefined;
  const expected = threadId ? codexTmuxSessionName(threadId) : undefined;
  const terminal = expected && name === `${expected}-view` && backend === 'app-server' ? 'view'
    : expected && name === expected && backend === 'legacy' ? 'execution' : name ? 'attached' : 'none';
  return {
    backend, ...(threadId ? { threadId } : {}), connection, activity, terminal, ...(name ? { terminalName: name } : {}),
    backendLabel: { 'app-server': 'app-server', legacy: '旧版执行路径', unstarted: '尚未建立' }[backend],
    connectionLabel: { connecting: '连接中', ready: '已连接', disconnected: '连接已断开', unknown: '连接未确认', 'not-applicable': '不适用' }[connection],
    activityLabel: { unknown: '活动未确认', idle: '空闲', active: '运行中', waiting: '等待答复' }[activity],
    terminalLabel: { view: 'tmux 查看入口', execution: 'tmux 执行终端', attached: '附加 tmux 终端', none: '未记录终端' }[terminal],
  };
}

/** Read only this process's cache. Never prepare, connect, resume or probe a backend. */
export function readCodexBackendStatus(
  session: BridgeSession,
  getCached: (sessionId: string) => CachedProtocolSession | undefined = getCodexAppServerSession,
): CodexBackendStatus {
  if ((getSessionActiveRuntime(session) || 'codex') !== 'codex') return projectCodexBackendStatus(session);
  const threadId = getSessionCodexThreadId(session);
  const endpoint = session.runtime?.codex?.appServerEndpoint?.trim();
  if (!threadId || !endpoint) return projectCodexBackendStatus(session);
  const cached = getCached(session.id);
  if (!cached || cached.threadId !== threadId) return projectCodexBackendStatus(session);
  try {
    if (appServerCliUrl(cached.endpoint) !== appServerCliUrl(endpoint)) return projectCodexBackendStatus(session);
  } catch {
    return projectCodexBackendStatus(session);
  }
  return projectCodexBackendStatus(session, cached.lifecycle.snapshot(threadId));
}
