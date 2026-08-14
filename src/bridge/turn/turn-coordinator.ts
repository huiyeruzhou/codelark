import type { ActiveBridgeTurn, BridgeTurnRuntime, BridgeTurnTerminalRecord } from './turn-types.js';

export interface RuntimeTerminalClaimResult {
  claimed: boolean;
  turn?: ActiveBridgeTurn;
}

export type CodexTerminalClaimResult = RuntimeTerminalClaimResult;

export interface TurnCoordinatorDeps {
  finalizeTerminalTurn?(
    turn: ActiveBridgeTurn,
    terminal: BridgeTurnTerminalRecord,
  ): Promise<boolean> | boolean;
}

export interface TurnCoordinator {
  registerInteractiveTurn(turn: ActiveBridgeTurn): void;
  getActiveTurn(sessionId: string): ActiveBridgeTurn | undefined;
  claimRuntimeTerminal(record: BridgeTurnTerminalRecord): Promise<RuntimeTerminalClaimResult>;
  claimCodexTerminal(record: BridgeTurnTerminalRecord): Promise<CodexTerminalClaimResult>;
  releaseTurn(turnId: string): void;
  releaseSessionTurn(sessionId: string, turnId?: string): void;
  clear(): void;
}

export function createTurnCoordinator(deps: TurnCoordinatorDeps = {}): TurnCoordinator {
  const activeTurnsBySession = new Map<string, ActiveBridgeTurn>();

  function registerInteractiveTurn(turn: ActiveBridgeTurn): void {
    activeTurnsBySession.set(turn.sessionId, turn);
  }

  function getActiveTurn(sessionId: string): ActiveBridgeTurn | undefined {
    return activeTurnsBySession.get(sessionId);
  }

  function runtimeOf(record: BridgeTurnTerminalRecord): BridgeTurnRuntime {
    return record.runtime === 'claude' || record.runtime === 'kimi' || record.runtime === 'cursor' || record.runtime === 'zcode' ? record.runtime : 'codex';
  }

  function turnRuntime(turn: ActiveBridgeTurn): BridgeTurnRuntime {
    return turn.runtime === 'claude' || turn.runtime === 'kimi' || turn.runtime === 'cursor' || turn.runtime === 'zcode' ? turn.runtime : 'codex';
  }

  function turnAcceptsTerminal(turn: ActiveBridgeTurn, terminal: BridgeTurnTerminalRecord): boolean {
    const terminalRuntime = runtimeOf(terminal);
    if (terminalRuntime === 'codex') {
      if (turn.finalSource !== 'codex_task_complete') return false;
      if (turn.codexThreadId && turn.codexThreadId !== terminal.codexThreadId) return false;
      return true;
    }

    if (turnRuntime(turn) !== terminalRuntime) return false;
    if (terminalRuntime === 'claude' && turn.finalSource !== 'claude_task_complete') return false;
    if (terminalRuntime === 'kimi' && turn.finalSource !== 'kimi_task_complete') return false;
    if (terminalRuntime === 'cursor' && turn.finalSource !== 'cursor_task_complete') return false;
    if (terminalRuntime === 'zcode' && turn.finalSource !== 'zcode_task_complete') return false;
    const terminalThreadId = terminal.threadId || terminal.codexThreadId;
    if (turn.runtimeThreadId && terminalThreadId && turn.runtimeThreadId !== terminalThreadId) {
      return false;
    }
    return true;
  }

  async function claimRuntimeTerminal(
    terminal: BridgeTurnTerminalRecord,
  ): Promise<RuntimeTerminalClaimResult> {
    const turn = activeTurnsBySession.get(terminal.sessionId);
    if (!turn || !turnAcceptsTerminal(turn, terminal)) {
      return { claimed: false };
    }

    const finalized = await deps.finalizeTerminalTurn?.(turn, terminal);
    return finalized ? { claimed: true, turn } : { claimed: false, turn };
  }

  async function claimCodexTerminal(
    terminal: BridgeTurnTerminalRecord,
  ): Promise<CodexTerminalClaimResult> {
    return claimRuntimeTerminal({ ...terminal, runtime: 'codex' });
  }

  function releaseTurn(turnId: string): void {
    for (const [sessionId, turn] of activeTurnsBySession) {
      if (turn.id !== turnId) continue;
      activeTurnsBySession.delete(sessionId);
      return;
    }
  }

  function releaseSessionTurn(sessionId: string, turnId?: string): void {
    const turn = activeTurnsBySession.get(sessionId);
    if (!turn) return;
    if (turnId && turn.id !== turnId) return;
    activeTurnsBySession.delete(sessionId);
  }

  function clear(): void {
    activeTurnsBySession.clear();
  }

  return {
    registerInteractiveTurn,
    getActiveTurn,
    claimRuntimeTerminal,
    claimCodexTerminal,
    releaseTurn,
    releaseSessionTurn,
    clear,
  };
}
