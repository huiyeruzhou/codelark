import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODELARK_HOME } from '../../configuration/paths.js';
import { CodexAppServerClient, appServerCliUrl } from './app-server-client.js';
import { CodexAppServerLifecycle, type AppServerSubmission, type AppServerThreadOptions } from './app-server-lifecycle.js';
import { prepareCodexDesktopRemote, validateLocalEndpoint, type CodexDesktopRemote } from './desktop-remote.js';
import { resolveCodexCliExecutable } from './cli-executable.js';
import { buildCodexTuiEnv } from './tmux-provider.js';

export interface CodexAppServerSession {
  lifecycle: CodexAppServerLifecycle;
  threadId: string;
  endpoint: string;
  remote?: CodexDesktopRemote;
  direct: boolean;
  directTurnIds: Set<string>;
}
const sessions = new Map<string, CodexAppServerSession>();
const backends = new Map<string, CodexAppServerLifecycle>();
const preparing = new Map<string, Promise<CodexAppServerSession | undefined>>();
const sessionVersions = new Map<string, number>();
const preparingTargets = new Map<symbol, string>();
let generation = 0;
const root = path.join(CODELARK_HOME, 'codex-app-server');
function fileName(key: string): string { return path.join(root, `${createHash('sha256').update(key).digest('hex')}.json`); }
function read<T>(key: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(fileName(key), 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function save(key: string, value: unknown): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = fileName(key);
  if (value === undefined) { fs.rmSync(target, { force: true }); return; }
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, target);
}
const canonical = (value: string) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };

/** No input is sent during selection. A persisted backend is never silently replaced. */
export async function prepareCodexAppServerSession(options: AppServerThreadOptions & {
  sessionId: string;
  endpoint?: string;
}): Promise<CodexAppServerSession | undefined> {
  const cached = sessions.get(options.sessionId);
  if (cached && (!options.threadId || cached.threadId === options.threadId)) {
    if (options.endpoint && appServerCliUrl(options.endpoint) !== cached.endpoint) throw new Error('此线程已经绑定另一 app-server，未切换执行后端。');
    return cached;
  }
  const pending = preparing.get(options.sessionId);
  if (pending) {
    const prepared = await pending;
    if (prepared && ((options.threadId && options.threadId !== prepared.threadId)
      || (options.endpoint && appServerCliUrl(options.endpoint) !== prepared.endpoint))) throw new Error('此会话正在准备另一个线程，请完成切换后再发送。');
    return prepared;
  }
  const epoch = generation;
  const version = sessionVersions.get(options.sessionId) || 0;
  const token = Symbol();
  const assertCurrent = () => { if (epoch !== generation || version !== (sessionVersions.get(options.sessionId) || 0)) throw new Error('Bridge 连接或会话绑定已结束，未重新绑定旧准备请求。'); };
  const operation = (async () => {
    if (cached) await releaseBinding(options.sessionId);
    assertCurrent();
    const persisted = read<{ endpoint: string; threadId: string }>(`session:${options.sessionId}`);
    const pinned = persisted && (!options.threadId || persisted.threadId === options.threadId) ? persisted : undefined;
    if (pinned && options.endpoint && appServerCliUrl(options.endpoint) !== pinned.endpoint) throw new Error('此线程已经绑定另一 app-server，未切换执行后端。');
    let endpoint = options.endpoint || pinned?.endpoint || process.env.CODELARK_CODEX_APP_SERVER_URL;
    // Existing legacy threads keep their writer and adapter across an upgrade.
    // Migration is explicit (endpoint) or starts with a new thread.
    if (!endpoint && options.threadId) return;
    let remote: CodexDesktopRemote | undefined;
    if (!endpoint) {
      // Avoid touching CLI resolution for old/non-macOS installations.
      if (process.platform !== 'darwin') return;
      const env = buildCodexTuiEnv();
      remote = await prepareCodexDesktopRemote({ env, executable: resolveCodexCliExecutable({ env }) });
      endpoint = remote?.endpoint;
    }
    assertCurrent();
    if (!endpoint) return;
    validateLocalEndpoint(endpoint);
    endpoint = appServerCliUrl(endpoint);
    let lifecycle = backends.get(endpoint);
    if (!lifecycle) {
      const backendKey = endpoint;
      const expectedHome = canonical(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
      lifecycle = new CodexAppServerLifecycle(endpoint, {
        connect: async () => {
          const client = await CodexAppServerClient.connect(backendKey);
          try {
            if (!client.serverInfo.codexHome || canonical(client.serverInfo.codexHome) !== expectedHome) throw new Error('app-server 的 CODEX_HOME 与此 Bridge 不一致，未接管线程。');
            await client.request('thread/loaded/list');
            return client;
          } catch (error) { client.close(); throw error; }
        },
        loadSubmission: (threadId) => read<AppServerSubmission>(`submission:${backendKey}:${threadId}`),
        saveSubmission: (threadId, submission) => save(`submission:${backendKey}:${threadId}`, submission),
        loadActiveTurn: (threadId) => read<string>(`active:${backendKey}:${threadId}`),
        saveActiveTurn: (threadId, turnId) => save(`active:${backendKey}:${threadId}`, turnId),
        resumeConfig: { 'shell_environment_policy.set.CODELARK_HOME': CODELARK_HOME },
      });
      backends.set(endpoint, lifecycle);
    }
    const { sessionId: _, endpoint: __, ...threadOptions } = options;
    const targetThread = options.threadId || pinned?.threadId;
    if (targetThread) preparingTargets.set(token, `${endpoint}:${targetThread}`);
    const threadId = await lifecycle.ensureThread({ ...threadOptions, threadId: options.threadId || pinned?.threadId,
      config: { ...threadOptions.config, 'shell_environment_policy.set.CODELARK_HOME': CODELARK_HOME },
    });
    try { assertCurrent(); }
    catch (error) {
      preparingTargets.delete(token);
      if (epoch === generation && ![...sessions.values()].some((s) => s.endpoint === endpoint && s.threadId === threadId)
        && ![...preparingTargets.values()].includes(`${endpoint}:${threadId}`)) await lifecycle.detach(threadId);
      throw error;
    }
    // Durable binding precedes any user input. It also protects a Bridge restart before store.updateSession.
    save(`session:${options.sessionId}`, { endpoint, threadId });
    const session = { lifecycle, threadId, endpoint, remote, direct: false, directTurnIds: new Set<string>() };
    sessions.set(options.sessionId, session);
    return session;
  })().finally(() => { preparingTargets.delete(token); if (preparing.get(options.sessionId) === operation) preparing.delete(options.sessionId); });
  preparing.set(options.sessionId, operation);
  return operation;
}

export function getCodexAppServerSession(sessionId: string): CodexAppServerSession | undefined { return sessions.get(sessionId); }
export function getCodexAppServerSessionByThread(threadId: string): CodexAppServerSession | undefined {
  return [...sessions.values()].find((session) => session.threadId === threadId);
}
export async function releaseCodexAppServerSession(sessionId: string): Promise<void> {
  sessionVersions.set(sessionId, (sessionVersions.get(sessionId) || 0) + 1);
  preparing.delete(sessionId);
  await releaseBinding(sessionId);
}
async function releaseBinding(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  save(`session:${sessionId}`, undefined);
  if (session && ![...sessions.values()].some((s) => s.threadId === session.threadId && s.endpoint === session.endpoint)
    && ![...preparingTargets.values()].includes(`${session.endpoint}:${session.threadId}`)) await session.lifecycle.detach(session.threadId);
}
export function closeCodexAppServerSessions(): void {
  generation += 1;
  for (const lifecycle of backends.values()) lifecycle.close();
  sessions.clear(); backends.clear(); preparing.clear(); preparingTargets.clear(); sessionVersions.clear();
  // Persistent bindings and uncertain submissions intentionally survive Bridge shutdown.
}
