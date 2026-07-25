export type RuntimeTmuxInputRuntime = 'codex' | 'claude' | 'kimi';

export type RuntimeTmuxInputStateKind =
  | 'idle'
  | 'checking_tmux'
  | 'checking_session'
  | 'starting_session'
  | 'starting_tmux'
  | 'waiting_selection'
  | 'running'
  | 'sending'
  | 'failed'
  | 'stopped';

export interface RuntimeTmuxInputState {
  runtime: RuntimeTmuxInputRuntime;
  sessionName: string;
  state: RuntimeTmuxInputStateKind;
  previousState?: RuntimeTmuxInputStateKind;
  reason: string;
  changedAtMs: number;
  runningSinceMs?: number;
  error?: string;
}

export interface RuntimeTmuxInputTransition {
  runtime: RuntimeTmuxInputRuntime;
  sessionName: string;
  from: RuntimeTmuxInputStateKind;
  to: RuntimeTmuxInputStateKind;
  reason: string;
  changedAtMs: number;
  error?: string;
}

export interface RuntimeTmuxExistenceResult {
  exists: boolean;
  command?: string;
}

export interface RuntimeTmuxInputInspection {
  exists: boolean;
  needsReadiness: boolean;
  command?: string;
  state: RuntimeTmuxInputState;
}

const states = new Map<string, RuntimeTmuxInputState>();

function stateKey(runtime: RuntimeTmuxInputRuntime, sessionName: string): string {
  return `${runtime}:${sessionName}`;
}

function initialState(runtime: RuntimeTmuxInputRuntime, sessionName: string): RuntimeTmuxInputState {
  return {
    runtime,
    sessionName,
    state: 'idle',
    reason: 'runtime tmux input lifecycle has not been inspected yet',
    changedAtMs: Date.now(),
  };
}

export function getRuntimeTmuxInputState(
  runtime: RuntimeTmuxInputRuntime,
  sessionName: string,
): RuntimeTmuxInputState {
  return states.get(stateKey(runtime, sessionName)) || initialState(runtime, sessionName);
}

export function transitionRuntimeTmuxInputState(
  runtime: RuntimeTmuxInputRuntime,
  sessionName: string,
  next: RuntimeTmuxInputStateKind,
  reason: string,
  options: {
    error?: string;
    onTransition?: (transition: RuntimeTmuxInputTransition) => void;
  } = {},
): RuntimeTmuxInputState {
  const current = getRuntimeTmuxInputState(runtime, sessionName);
  const changedAtMs = Date.now();
  const keepsEstablishedRuntime = next === 'checking_tmux'
    || next === 'checking_session'
    || next === 'waiting_selection'
    || next === 'running'
    || next === 'sending';
  const runningSinceMs = next === 'running'
    ? current.runningSinceMs || changedAtMs
    : keepsEstablishedRuntime
      ? current.runningSinceMs
      : undefined;
  const nextState: RuntimeTmuxInputState = {
    runtime,
    sessionName,
    state: next,
    previousState: current.state,
    reason,
    changedAtMs,
    ...(runningSinceMs ? { runningSinceMs } : {}),
    ...(options.error ? { error: options.error } : {}),
  };
  states.set(stateKey(runtime, sessionName), nextState);
  if (current.state !== next) {
    options.onTransition?.({
      runtime,
      sessionName,
      from: current.state,
      to: next,
      reason,
      changedAtMs,
      ...(options.error ? { error: options.error } : {}),
    });
  }
  return nextState;
}

/**
 * Checks only whether the provider-owned tmux process still exists. A known
 * running lifecycle is reusable without capturing the pane or looking for a
 * prompt cursor. Cold or failed lifecycles must pass readiness once.
 */
export async function inspectRuntimeTmuxInput(
  params: {
    runtime: RuntimeTmuxInputRuntime;
    sessionName: string;
    hasSession: () => Promise<RuntimeTmuxExistenceResult>;
  },
): Promise<RuntimeTmuxInputInspection> {
  const before = getRuntimeTmuxInputState(params.runtime, params.sessionName);
  const reusable = before.state === 'running' || before.state === 'sending';
  transitionRuntimeTmuxInputState(
    params.runtime,
    params.sessionName,
    'checking_tmux',
    'checking whether the provider-owned tmux session still exists',
  );
  try {
    const existence = await params.hasSession();
    if (!existence.exists) {
      const state = transitionRuntimeTmuxInputState(
        params.runtime,
        params.sessionName,
        'stopped',
        'provider-owned tmux session is missing',
      );
      return { ...existence, needsReadiness: true, state };
    }
    if (reusable) {
      const state = transitionRuntimeTmuxInputState(
        params.runtime,
        params.sessionName,
        'running',
        'known running tmux session still exists; prompt probe skipped',
      );
      return { ...existence, needsReadiness: false, state };
    }
    const state = transitionRuntimeTmuxInputState(
      params.runtime,
      params.sessionName,
      'checking_session',
      'tmux exists but its runtime readiness has not been established in this process',
    );
    return { ...existence, needsReadiness: true, state };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    transitionRuntimeTmuxInputState(
      params.runtime,
      params.sessionName,
      'failed',
      'tmux existence check failed',
      { error: message },
    );
    throw error;
  }
}

export async function sendRuntimeTmuxInput<T>(params: {
  runtime: RuntimeTmuxInputRuntime;
  sessionName: string;
  send: () => Promise<T>;
}): Promise<T> {
  const current = getRuntimeTmuxInputState(params.runtime, params.sessionName);
  if (current.state !== 'running') {
    throw new Error(
      `${params.runtime} tmux input lifecycle ${params.sessionName} is ${current.state}; expected running before send`,
    );
  }
  transitionRuntimeTmuxInputState(
    params.runtime,
    params.sessionName,
    'sending',
    'sending input to the established runtime tmux session',
  );
  try {
    const result = await params.send();
    transitionRuntimeTmuxInputState(
      params.runtime,
      params.sessionName,
      'running',
      'input was sent; runtime tmux session remains established',
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    transitionRuntimeTmuxInputState(
      params.runtime,
      params.sessionName,
      'failed',
      'sending input to runtime tmux failed',
      { error: message },
    );
    throw error;
  }
}

export function resetRuntimeTmuxInputStatesForTests(): void {
  states.clear();
}
