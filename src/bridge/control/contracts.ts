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
}

export interface AgentSendInstruction {
  target: string | ManualInputTargetSelector;
  text: string;
  codelarkHome?: string;
}
import type { ManualInputTargetSelector } from '../../domain/index.js';
