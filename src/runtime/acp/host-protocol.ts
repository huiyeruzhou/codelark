import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODELARK_HOME } from '../../configuration/paths.js';
import type { StreamingCardHandle } from '../../domain/progress.js';

export const ACP_HOST_PROTOCOL_VERSION = 1;

export type AcpRuntimeKind = 'cursor' | 'doubao';

export type AcpSessionState =
  | 'starting'
  | 'ready'
  | 'running'
  | 'waiting_permission'
  | 'cancelling'
  | 'closed'
  | 'failed';

export type AcpTurnStatus =
  | 'running'
  | 'waiting_permission'
  | 'cancelling'
  | 'completed'
  | 'aborted'
  | 'failed';

export interface AcpCardCheckpoint extends StreamingCardHandle {
  channelType: string;
  chatId: string;
  streamKey: string;
}

export interface AcpTurnMeta {
  runtime: AcpRuntimeKind;
  bridgeSessionId: string;
  channelType?: string;
  chatId?: string;
  requestMessageId?: string;
  userText?: string;
  model?: string;
  cwd?: string;
  cursorForce?: boolean;
  doubaoMode?: string;
  card?: AcpCardCheckpoint;
}

export interface AcpPendingServerRequest {
  requestId: string | number;
  method: string;
  params: Record<string, unknown>;
  seq: number;
}

export type AcpTurnEvent =
  | {
    seq: number;
    ts: number;
    kind: 'session_update';
    params: Record<string, unknown>;
  }
  | {
    seq: number;
    ts: number;
    kind: 'server_request';
    requestId: string | number;
    method: string;
    params: Record<string, unknown>;
  }
  | {
    seq: number;
    ts: number;
    kind: 'server_request_resolved';
    requestId: string | number;
  }
  | {
    seq: number;
    ts: number;
    kind: 'turn_end';
    status: 'completed' | 'aborted' | 'failed';
    stopReason?: string;
    error?: string;
    nativeSessionId?: string;
  };

export interface AcpTurnSnapshot {
  turnId: string;
  sessionKey: string;
  runtime: AcpRuntimeKind;
  bridgeSessionId: string;
  nativeSessionId?: string;
  status: AcpTurnStatus;
  stopReason?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  lastSeq: number;
  acked: boolean;
  meta: AcpTurnMeta;
  pendingRequests: AcpPendingServerRequest[];
}

export interface AcpSessionSnapshot {
  sessionKey: string;
  runtime: AcpRuntimeKind;
  bridgeSessionId: string;
  nativeSessionId?: string;
  cwd: string;
  state: AcpSessionState;
  connected: boolean;
  activeTurnId?: string;
  configOptions: Array<Record<string, unknown>>;
  modes?: Record<string, unknown>;
  disposalError?: string;
}

export interface AcpHostHelloResult {
  pid: number;
  protocolVersion: number;
  codeHash: string;
  startedAt: number;
  sessionCount: number;
  activeTurnCount: number;
  unackedTurnCount: number;
}

export interface AcpSessionEnsureParams {
  sessionKey: string;
  runtime: AcpRuntimeKind;
  bridgeSessionId: string;
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  stdinPipe?: boolean;
  requestTimeoutMs?: number;
  label: string;
  fingerprint: string;
  initializeParams: Record<string, unknown>;
  authenticateParams?: Record<string, unknown>;
  nativeSessionId?: string;
  requireLoadCapability?: boolean;
  loadUnsupportedMessage?: string;
  duplicateNativeMessage?: string;
  missingNativeIdMessage?: string;
  mcpServers?: unknown[];
}

export interface AcpSessionEnsureResult {
  reused: boolean;
  session: AcpSessionSnapshot;
}

export interface AcpSessionRpcParams {
  sessionKey: string;
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

export interface AcpSessionRpcResult {
  result: unknown;
  session: AcpSessionSnapshot;
}

export interface AcpTurnStartParams {
  sessionKey: string;
  turnId?: string;
  prompt: unknown[];
  meta: AcpTurnMeta;
}

export interface AcpTurnStartResult {
  turn: AcpTurnSnapshot;
}

export interface AcpTurnSubscribeParams {
  turnId: string;
  afterSeq?: number;
}

export interface AcpTurnSubscribeResult {
  turn: AcpTurnSnapshot;
}

export interface AcpTurnRespondParams {
  turnId: string;
  requestId: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface AcpTurnCancelParams {
  turnId?: string;
  sessionKey?: string;
  cancelTimeoutMs?: number;
}

export interface AcpTurnUpdateMetaParams {
  turnId: string;
  card?: AcpCardCheckpoint;
  metaPatch?: Partial<Omit<AcpTurnMeta, 'runtime' | 'bridgeSessionId'>>;
}

export interface AcpHostRequestEnvelope {
  id: number;
  method: string;
  params?: unknown;
}

export interface AcpHostResponseEnvelope {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpHostPushEnvelope {
  event: 'turn/event' | 'session/state';
  turnId?: string;
  item?: AcpTurnEvent;
  session?: AcpSessionSnapshot;
}

export function makeAcpSessionKey(runtime: AcpRuntimeKind, bridgeSessionId: string): string {
  return `${runtime}:${bridgeSessionId}`;
}

function canonicalPath(value: string): string {
  let existing = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Stable socket/pipe path per CODELARK_HOME; survives Bridge restarts. */
export function acpHostEndpoint(home = CODELARK_HOME, platform = process.platform): string {
  const identity = canonicalPath(home);
  const hash = createHash('sha256')
    .update(platform === 'win32' ? identity.toLowerCase() : identity)
    .digest('hex')
    .slice(0, 24);
  if (platform === 'win32') {
    return `\\\\.\\pipe\\codelark-acp-${hash}`;
  }
  return path.join('/tmp', `codelark-acp-${hash}`, 'host.sock');
}

export function acpHostStateFile(home = CODELARK_HOME): string {
  return path.join(home, 'runtime', 'acp-host.json');
}

export function isAcpTurnActiveStatus(status: AcpTurnStatus): boolean {
  return status === 'running' || status === 'waiting_permission' || status === 'cancelling';
}
