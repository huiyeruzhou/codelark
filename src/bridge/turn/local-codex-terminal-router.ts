import type { BridgeMirrorRecord } from '../../runtime/contracts.js';
import type { TurnCoordinator } from './turn-coordinator.js';
import type { BridgeTurnRuntime, BridgeTurnTerminalRecord } from './turn-types.js';

export interface RuntimeRecordRouteResult {
  claimed: BridgeMirrorRecord[];
  unclaimed: BridgeMirrorRecord[];
  terminalClaimed: boolean;
}

export type CodexRecordRouteResult = RuntimeRecordRouteResult;

function isTerminalRecord(record: BridgeMirrorRecord): boolean {
  return record.type === 'task_complete' || record.type === 'task_aborted';
}

function toTerminalRecord(
  sessionId: string,
  runtime: BridgeTurnRuntime,
  threadId: string,
  record: BridgeMirrorRecord,
): BridgeTurnTerminalRecord {
  return {
    runtime,
    sessionId,
    threadId,
    codexThreadId: runtime === 'codex' ? threadId : '',
    turnId: record.turnId,
    text: record.content,
    outcome: record.isError === true
      ? 'failed'
      : record.type === 'task_aborted'
        ? 'aborted'
        : 'completed',
    timestamp: record.timestamp,
  };
}

export async function routeRuntimeRecords(
  sessionId: string,
  runtime: BridgeTurnRuntime,
  threadId: string,
  records: BridgeMirrorRecord[],
  coordinator: Pick<TurnCoordinator, 'claimRuntimeTerminal'>,
): Promise<RuntimeRecordRouteResult> {
  let terminalRecord: BridgeMirrorRecord | null = null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!isTerminalRecord(records[index])) continue;
    terminalRecord = records[index];
    break;
  }

  if (!terminalRecord) {
    return {
      claimed: [],
      unclaimed: records,
      terminalClaimed: false,
    };
  }

  const claim = await coordinator.claimRuntimeTerminal(
    toTerminalRecord(sessionId, runtime, threadId, terminalRecord),
  );
  if (!claim.claimed) {
    return {
      claimed: [],
      unclaimed: records,
      terminalClaimed: false,
    };
  }

  const claimedTurnId = terminalRecord.turnId;
  const claimed = claimedTurnId
    ? records.filter((record) => record.turnId === claimedTurnId)
    : [terminalRecord];
  const claimedSet = new Set(claimed.map((record) => record.signature));

  return {
    claimed,
    unclaimed: records.filter((record) => !claimedSet.has(record.signature)),
    terminalClaimed: true,
  };
}

export async function routeCodexRecords(
  sessionId: string,
  codexThreadId: string,
  records: BridgeMirrorRecord[],
  coordinator: Pick<TurnCoordinator, 'claimCodexTerminal'>,
): Promise<CodexRecordRouteResult> {
  return routeRuntimeRecords(
    sessionId,
    'codex',
    codexThreadId,
    records,
    {
      claimRuntimeTerminal: (terminal) => coordinator.claimCodexTerminal(terminal),
    },
  );
}
