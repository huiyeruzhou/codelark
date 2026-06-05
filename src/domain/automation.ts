import type { ChannelAddress } from './channel.js';

export type AutoTaskStatus = 'running' | 'completed' | 'failed';

export interface AutoTask {
  id: string;
  kind?: 'script' | 'interval';
  bridgeSessionId: string;
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  chatUserId?: string;
  chatDisplayName?: string;
  scriptPath?: string;
  prompt?: string;
  intervalSeconds?: number;
  createdAt: string;
  updatedAt: string;
  triggeredCount: number;
  lastTriggeredAt?: string;
  times: number;
  status: AutoTaskStatus;
  lastError?: string;
}

export interface CreateAutoTaskInput {
  bridgeSessionId: string;
  address: ChannelAddress;
  scriptPath: string;
  times: number;
}

export interface CreateIntervalAutoTaskInput {
  bridgeSessionId: string;
  address: ChannelAddress;
  prompt: string;
  intervalSeconds: number;
}

export interface AutoSkillOperationResult {
  targetDir: string;
  method: 'copy' | 'removed' | 'missing' | 'existing';
}
