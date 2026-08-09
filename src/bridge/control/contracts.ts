import type { ManualInputTargetSelector, OutboundPlatformMessage } from '../../domain/index.js';
import type { ConditionMonitorTask } from '../automation/condition-monitors.js';

export interface DiscoveredBridgeSession {
  codelarkHome: string;
  internalChatId: string;
  platformChatId: string;
  bridgeSessionId: string;
  chatName: string;
  agentName: string;
  channelType: string;
  runtime: string;
  runtimeStatus: string;
  cwd?: string;
  updatedAt?: string;
}

export interface AgentMessageSource {
  codelarkHome: string;
  internalChatId: string;
  platformChatId: string;
  bridgeSessionId: string;
  chatName: string;
  botName: string;
}

export interface ManualInputRequest {
  targetInternalChatId: string;
  text: string;
  source: AgentMessageSource;
  idempotencyKey?: string;
}

export interface AgentSendInstruction {
  target: string | ManualInputTargetSelector;
  text: string;
  codelarkHome?: string;
  idempotencyKey?: string;
}

export interface AgentInputRequest {
  sourceInternalChatId: string;
  target: string | ManualInputTargetSelector;
  text: string;
  codelarkHome?: string;
  idempotencyKey?: string;
}

export interface PlatformMessageRequest {
  targetInternalChatId: string;
  platformMessage: OutboundPlatformMessage;
  idempotencyKey?: string;
}

export interface CreateConditionMonitorRequest {
  ownerInternalChatId: string;
  ownerBridgeSessionId: string;
  label?: string;
  scriptPath: string;
  pythonExecutable: string;
  intervalSeconds: number;
  timeoutSeconds: number;
}

export interface ConditionMonitorControlHandlers {
  create(request: CreateConditionMonitorRequest): ConditionMonitorTask;
  list(ownerInternalChatId?: string): ConditionMonitorTask[];
  cancel(taskId: string): ConditionMonitorTask | null;
}
