import { AsyncLocalStorage } from 'node:async_hooks';

export type RuntimeTmuxInputRuntime = 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode';

export type RuntimeTmuxTurnState = 'unknown' | 'idle' | 'active';
export type RuntimeTmuxSteerOperation = 'none' | 'explicit';

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
  turnState: RuntimeTmuxTurnState;
  turnStateReason: string;
  turnStateChangedAtMs: number;
  lastSteerOperation?: RuntimeTmuxSteerOperation;
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
const generations = new Map<string, number>();
const inputOwner = new AsyncLocalStorage<{ key: string; generation: number }>();
const mutations = new Map<string, Promise<unknown>>();

/** Keep nested readiness, send and polling state writes owned by the same instance. */
export function withRuntimeTmuxInputOwner<T>(
  runtime: RuntimeTmuxInputRuntime,
  sessionName: string,
  run: () => T,
  options: { restart?: boolean } = {},
): T {
  const key = stateKey(runtime, sessionName);
  const generation = (generations.get(key) || 0) + (options.restart ? 1 : 0);
  // Invalidate old streams synchronously, before restart's first asynchronous probe.
  if (options.restart) generations.set(key, generation);
  return inputOwner.run({ key, generation }, run);
}

function isCurrentInputOwner(runtime: RuntimeTmuxInputRuntime, sessionName: string): boolean {
  const owner = inputOwner.getStore();
  const key = stateKey(runtime, sessionName);
  return !owner || owner.key !== key || owner.generation === (generations.get(key) || 0);
}

export function assertRuntimeTmuxInputOwner(runtime: RuntimeTmuxInputRuntime, sessionName: string): void {
  if (!isCurrentInputOwner(runtime, sessionName)) throw new Error(`${runtime} tmux instance was replaced by an explicit restart`);
}

/** Serialize only process creation/deletion, never a turn or its terminal event. */
export async function mutateRuntimeTmuxSession<T>(
  runtime: RuntimeTmuxInputRuntime,
  sessionName: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = stateKey(runtime, sessionName);
  const previous = mutations.get(key);
  const operation = (async () => {
    await previous?.catch(() => {});
    assertRuntimeTmuxInputOwner(runtime, sessionName);
    return run();
  })();
  mutations.set(key, operation);
  try { return await operation; }
  finally { if (mutations.get(key) === operation) mutations.delete(key); }
}

export interface RuntimeTmuxSelectionLifecycleResult {
  choice: string | null;
  commands: string[];
}

const selectionLifecycles = new Map<string, {
  promise: Promise<RuntimeTmuxSelectionLifecycleResult>;
}>();
const RUNTIME_TMUX_SELECTION_LIFECYCLE_GRACE_MS = 2_000;

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
    turnState: 'unknown',
    turnStateReason: 'runtime turn activity has not been inspected yet',
    turnStateChangedAtMs: Date.now(),
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
    lastSteerOperation?: RuntimeTmuxSteerOperation;
    onTransition?: (transition: RuntimeTmuxInputTransition) => void;
  } = {},
): RuntimeTmuxInputState {
  const current = getRuntimeTmuxInputState(runtime, sessionName);
  if (!isCurrentInputOwner(runtime, sessionName)) return current;
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
    turnState: keepsEstablishedRuntime ? current.turnState : 'unknown',
    turnStateReason: keepsEstablishedRuntime
      ? current.turnStateReason
      : 'runtime lifecycle is not established; turn activity is unknown',
    turnStateChangedAtMs: keepsEstablishedRuntime ? current.turnStateChangedAtMs : changedAtMs,
    ...(runningSinceMs ? { runningSinceMs } : {}),
    ...(options.lastSteerOperation
      ? { lastSteerOperation: options.lastSteerOperation }
      : current.lastSteerOperation
        ? { lastSteerOperation: current.lastSteerOperation }
        : {}),
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

export function setRuntimeTmuxTurnState(
  runtime: RuntimeTmuxInputRuntime,
  sessionName: string,
  turnState: RuntimeTmuxTurnState,
  reason: string,
): RuntimeTmuxInputState {
  const current = getRuntimeTmuxInputState(runtime, sessionName);
  if (!isCurrentInputOwner(runtime, sessionName)) return current;
  const nextState: RuntimeTmuxInputState = {
    ...current,
    turnState,
    turnStateReason: reason,
    turnStateChangedAtMs: Date.now(),
  };
  states.set(stateKey(runtime, sessionName), nextState);
  return nextState;
}

/** Require a fresh readiness pass after an interrupt may have changed the TUI screen. */
export function invalidateRuntimeTmuxInputReadiness(
  runtime: RuntimeTmuxInputRuntime,
  sessionName: string,
  reason: string,
): RuntimeTmuxInputState {
  return transitionRuntimeTmuxInputState(runtime, sessionName, 'checking_session', reason);
}

/**
 * Codex, Claude, Cursor and ZCode accept a new prompt as their natural steering
 * operation. Kimi needs an additional Ctrl-S only when a turn was already
 * active before this input was submitted.
 */
export function resolveRuntimeTmuxSteerOperation(
  runtime: RuntimeTmuxInputRuntime,
  sessionName: string,
): RuntimeTmuxSteerOperation {
  const state = getRuntimeTmuxInputState(runtime, sessionName);
  return runtime === 'kimi' && state.turnState === 'active' ? 'explicit' : 'none';
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
  assertRuntimeTmuxInputOwner(params.runtime, params.sessionName);
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
    assertRuntimeTmuxInputOwner(params.runtime, params.sessionName);
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
  steer?: () => Promise<void>;
}): Promise<T> {
  assertRuntimeTmuxInputOwner(params.runtime, params.sessionName);
  const current = getRuntimeTmuxInputState(params.runtime, params.sessionName);
  if (current.state !== 'running') {
    throw new Error(
      `${params.runtime} tmux input lifecycle ${params.sessionName} is ${current.state}; expected running before send`,
    );
  }
  const steerOperation = resolveRuntimeTmuxSteerOperation(params.runtime, params.sessionName);
  transitionRuntimeTmuxInputState(
    params.runtime,
    params.sessionName,
    'sending',
    'sending input to the established runtime tmux session',
    { lastSteerOperation: steerOperation },
  );
  try {
    const result = await params.send();
    assertRuntimeTmuxInputOwner(params.runtime, params.sessionName);
    if (steerOperation === 'explicit') {
      if (!params.steer) {
        throw new Error(`${params.runtime} tmux input requires an explicit steer operation`);
      }
      await params.steer();
    }
    transitionRuntimeTmuxInputState(
      params.runtime,
      params.sessionName,
      'running',
      steerOperation === 'explicit'
        ? 'input and explicit steer were sent; runtime tmux session remains established'
        : 'input was sent; runtime-native steering needs no extra operation',
      { lastSteerOperation: steerOperation },
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

export async function coordinateRuntimeTmuxSelection(params: {
  runtime: RuntimeTmuxInputRuntime;
  sessionName: string;
  fingerprint: string;
  run: () => Promise<RuntimeTmuxSelectionLifecycleResult>;
}): Promise<{ owner: boolean; result: RuntimeTmuxSelectionLifecycleResult }> {
  const key = `${stateKey(params.runtime, params.sessionName)}\u0000${params.fingerprint}`;
  const existing = selectionLifecycles.get(key);
  if (existing) {
    const result = await existing.promise;
    return { owner: false, result };
  }

  const entry = { promise: params.run() };
  selectionLifecycles.set(key, entry);
  try {
    const result = await entry.promise;
    const cleanupTimer = setTimeout(() => {
      if (selectionLifecycles.get(key) === entry) selectionLifecycles.delete(key);
    }, RUNTIME_TMUX_SELECTION_LIFECYCLE_GRACE_MS);
    cleanupTimer.unref?.();
    return { owner: true, result };
  } catch (error) {
    if (selectionLifecycles.get(key) === entry) selectionLifecycles.delete(key);
    throw error;
  }
}

export function resetRuntimeTmuxInputStatesForTests(): void {
  states.clear();
  generations.clear();
  mutations.clear();
  selectionLifecycles.clear();
}
