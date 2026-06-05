export interface ExternalTerminalFinalization {
  outcome: 'completed' | 'failed' | 'aborted';
  detail?: string;
  finalText?: string;
}

export type InteractiveProcessRaceResult<T> = {
  kind: 'process';
  result: T;
} | {
  kind: 'external';
  terminal: ExternalTerminalFinalization;
};

export interface CreateExternalTerminalFinalizationControllerParams {
  abortSignal: AbortSignal;
  hasCodexThread(): boolean;
  isCurrentTask(): boolean;
  isAborted(): boolean;
  abortTask(): void;
  finalizationTimeoutMs?: number;
}

export interface ExternalTerminalFinalizationController {
  readonly current: ExternalTerminalFinalization | null;
  expectCodexTerminalFinal(): void;
  finalize(
    outcome: ExternalTerminalFinalization['outcome'],
    detail?: string,
    finalText?: string,
  ): Promise<boolean>;
  raceProcess<T>(processPromise: Promise<T>): Promise<InteractiveProcessRaceResult<T>>;
  markProcessSettled(): void;
  waitAfterProcess(): Promise<ExternalTerminalFinalization | null>;
  settleCompletion(finalized: boolean): void;
}

export function createExternalTerminalFinalizationController(
  params: CreateExternalTerminalFinalizationControllerParams,
): ExternalTerminalFinalizationController {
  let current: ExternalTerminalFinalization | null = null;
  let codexTerminalFinalExpected = false;
  let processResultSettled = false;
  let completionSettled = false;
  let resolveTerminal: ((request: ExternalTerminalFinalization) => void) | null = null;
  let resolveCompletion: ((finalized: boolean) => void) | null = null;

  const terminalPromise = new Promise<ExternalTerminalFinalization>((resolve) => {
    resolveTerminal = resolve;
  });
  const completionPromise = new Promise<boolean>((resolve) => {
    resolveCompletion = resolve;
  });

  const controller: ExternalTerminalFinalizationController = {
    get current() {
      return current;
    },
    expectCodexTerminalFinal() {
      codexTerminalFinalExpected = true;
    },
    async finalize(outcome, detail, finalText) {
      if (current) return completionPromise;
      if (!params.isCurrentTask()) return false;
      current = { outcome, detail, finalText };
      resolveTerminal?.(current);
      if (!processResultSettled && !params.isAborted()) {
        params.abortTask();
      }
      return completionPromise;
    },
    async raceProcess<T>(processPromise: Promise<T>): Promise<InteractiveProcessRaceResult<T>> {
      try {
        return await Promise.race([
          processPromise.then((result) => ({ kind: 'process' as const, result })),
          terminalPromise.then((terminal) => ({ kind: 'external' as const, terminal })),
        ]);
      } catch (error) {
        if (!current) throw error;
        return { kind: 'external', terminal: current };
      }
    },
    markProcessSettled() {
      processResultSettled = true;
    },
    async waitAfterProcess() {
      if (current) return current;
      const timeoutMs = Math.max(0, params.finalizationTimeoutMs ?? 0);
      if (!params.hasCodexThread() || !codexTerminalFinalExpected || timeoutMs <= 0) return null;
      if (params.isAborted()) return null;

      return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (terminal: ExternalTerminalFinalization | null) => {
          if (settled) return;
          settled = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          params.abortSignal.removeEventListener('abort', onAbort);
          resolve(terminal);
        };
        const onAbort = () => finish(null);

        timer = setTimeout(() => finish(null), timeoutMs);
        params.abortSignal.addEventListener('abort', onAbort, { once: true });
        terminalPromise.then((terminal) => {
          finish(terminal);
        }, () => {
          finish(null);
        });
      });
    },
    settleCompletion(finalized) {
      if (!current || completionSettled) return;
      completionSettled = true;
      resolveCompletion?.(finalized);
    },
  };

  return controller;
}
