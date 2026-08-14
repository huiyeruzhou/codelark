export type OperatorRuntime = 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode';

export interface RuntimeStatusProjection {
  tone: 'running' | 'queued' | 'attention' | 'idle' | 'available' | 'missing';
  state: string;
  sessions: Array<Record<string, unknown>>;
  bindings: Array<Record<string, unknown>>;
  latest: string;
  config: { provider: string; model: string };
}

export const projectRuntimeStatusBrowserSource = String.raw`function projectRuntimeStatus(
  runtime,
  allSessions = [],
  allBindings = [],
  globalConfig = {}
) {
  const sessions = allSessions.filter((session) => session.runtime === runtime);
  const bindings = allBindings.filter((binding) => binding.currentRuntime === runtime);
  const uniqueSessionCount = (items) => new Set(
    items.map((binding) => binding.currentSessionId).filter(Boolean),
  ).size;
  const running = uniqueSessionCount(bindings.filter((binding) => binding.runtimeStatus === 'running'));
  const queued = uniqueSessionCount(bindings.filter((binding) => binding.runtimeStatus === 'queued'));
  const stale = uniqueSessionCount(bindings.filter((binding) => binding.mirrorStatus === 'stale'));
  const latest = sessions
    .map((session) => session.lastEventAt)
    .filter(Boolean)
    .map(String)
    .sort((left, right) => right.localeCompare(left))[0] || '';

  let config;
  if (runtime === 'claude') {
    config = {
      provider: String(globalConfig.claudeProvider || 'auto'),
      model: String(globalConfig.claudeDefaultModel || '跟随 Claude Code'),
    };
  } else if (runtime === 'kimi') {
    config = {
      provider: String(globalConfig.kimiProvider || 'tmux'),
      model: String(globalConfig.kimiDefaultModel || '跟随 Kimi Code'),
    };
  } else if (runtime === 'cursor') {
    config = {
      provider: String(globalConfig.cursorProvider || 'tmux'),
      model: String(globalConfig.cursorDefaultModel || '跟随 Cursor Agent'),
    };
  } else if (runtime === 'zcode') {
    config = {
      provider: String(globalConfig.zcodeProvider || 'tmux'),
      model: String(globalConfig.zcodeDefaultModel || '跟随 ZCode'),
    };
  } else {
    const inheritedProvider = globalConfig.defaultProviderInherited === true;
    const effectiveProvider = String(
      globalConfig.defaultProvider || globalConfig.defaultProviderDefaultValue || 'tmux',
    );
    config = {
      provider: inheritedProvider ? effectiveProvider + '（跟随默认）' : effectiveProvider,
      model: String(globalConfig.defaultModel || globalConfig.codexDefaultModel || '跟随 Codex'),
    };
  }

  const common = { sessions, bindings, latest, config };
  if (running > 0) return { ...common, tone: 'running', state: '运行中 ' + running };
  if (queued > 0) return { ...common, tone: 'queued', state: '排队中 ' + queued };
  if (stale > 0) return { ...common, tone: 'attention', state: '待恢复 ' + stale };
  if (bindings.length > 0) return { ...common, tone: 'idle', state: '空闲' };
  if (sessions.length > 0) return { ...common, tone: 'available', state: '可接管' };
  return { ...common, tone: 'missing', state: '未发现会话' };
}`;

type ProjectRuntimeStatus = (
  runtime: OperatorRuntime,
  allSessions?: Array<Record<string, unknown>>,
  allBindings?: Array<Record<string, unknown>>,
  globalConfig?: Record<string, unknown>,
) => RuntimeStatusProjection;

export const projectRuntimeStatus = Function(
  `"use strict"; return (${projectRuntimeStatusBrowserSource});`,
)() as ProjectRuntimeStatus;
