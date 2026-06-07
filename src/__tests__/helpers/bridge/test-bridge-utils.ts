import fs from 'node:fs';
import path from 'node:path';
import { JsonFileStore } from '../../../storage/json-store.js';
import { CONFIG_PATH, CONFIG_JSON_PATH, CODELARK_HOME } from '../../../configuration/paths.js';
import { initBridgeContext } from '../../../bridge/host/context.js';
import { BaseChannelAdapter } from '../../../channels/contracts.js';
import type { CreateGroupChatOptions, CreatedGroupChat } from '../../../channels/contracts.js';
import type { ChannelAddress, InboundMessage, OutboundMessage, PermissionGateway, SendResult } from '../../../domain/index.js';
import type { LifecycleHooks, LLMProvider, StreamChatParams } from '../../../runtime/contracts.js';

export const BRIDGE_TEST_DATA_DIR = path.join(CODELARK_HOME, 'data');

export function makeBridgeSettings(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
    ['bridge_channel_instances_json', JSON.stringify([
      { id: 'feishu', provider: 'feishu', enabled: true, alias: '飞书', config: {} },
    ])],
    ...Object.entries(overrides),
  ]);
}

export const noopLlm: LLMProvider = {
  streamChat(_params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  },
};

export const noopPermissions: PermissionGateway = {
  resolvePendingPermission: () => false,
};

export const noopLifecycle: LifecycleHooks = {};

export function resetBridgeTestState(options: { cleanCodexHome?: boolean } = {}): void {
  fs.rmSync(BRIDGE_TEST_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(CODELARK_HOME, 'config.toml'), { force: true });
  fs.rmSync(path.join(CODELARK_HOME, 'config'), { recursive: true, force: true });
  fs.rmSync(CONFIG_PATH, { force: true });
  fs.rmSync(CONFIG_JSON_PATH, { force: true });

  if (!options.cleanCodexHome || !process.env.CODEX_HOME) return;

  fs.rmSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true, force: true });
  fs.rmSync(path.join(process.env.CODEX_HOME, 'archived_sessions'), { recursive: true, force: true });
  fs.rmSync(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), { force: true });
}

export function initBridgeTestContext(options: {
  settings?: Map<string, string>;
  dynamicSettings?: boolean;
  llm?: LLMProvider;
  permissions?: PermissionGateway;
  lifecycle?: LifecycleHooks;
} = {}): JsonFileStore {
  const store = new JsonFileStore(
    options.settings || makeBridgeSettings(),
    { dynamicSettings: options.dynamicSettings === true },
  );
  initBridgeContext({
    store,
    llm: options.llm || noopLlm,
    permissions: options.permissions || noopPermissions,
    lifecycle: options.lifecycle || noopLifecycle,
  });
  return store;
}

export interface CodexSessionJsonlFixtureOptions {
  threadId: string;
  workDir: string;
  datePath?: [string, string, string];
  lines?: unknown[];
}

export function writeCodexSessionJsonlFixture(
  options: CodexSessionJsonlFixtureOptions,
): { sessionPath: string; rawJsonl: string } {
  const datePath = options.datePath || ['2026', '05', '28'];
  const sessionDir = path.join(process.env.CODEX_HOME!, 'sessions', ...datePath);
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionPath = path.join(sessionDir, `rollout-${options.threadId}.jsonl`);
  const lines = options.lines || [
    {
      timestamp: '2026-05-28T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: options.threadId,
        timestamp: '2026-05-28T00:00:00.000Z',
        cwd: options.workDir,
        originator: 'Codex CLI',
      },
    },
    {
      timestamp: '2026-05-28T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Codex 用户消息' },
    },
    {
      timestamp: '2026-05-28T00:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Codex 助手回复' },
    },
  ];
  const rawJsonl = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  fs.writeFileSync(sessionPath, rawJsonl, 'utf-8');

  return { sessionPath, rawJsonl };
}

export class RecordingAdapter extends BaseChannelAdapter {
  readonly channelType: string;
  readonly provider: string;
  readonly sent: OutboundMessage[] = [];
  readonly createdGroups: CreatedGroupChat[] = [];
  readonly renamedGroups: Array<{ chatId: string; name: string }> = [];

  constructor(options: { channelType?: string; provider?: string } = {}) {
    super();
    this.channelType = options.channelType || 'feishu';
    this.provider = options.provider || 'feishu';
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true; }
  async consumeOne(): Promise<InboundMessage | null> { return null; }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    return { ok: true, messageId: `reply-${this.sent.length}` };
  }

  async createGroupChat(options: CreateGroupChatOptions): Promise<CreatedGroupChat> {
    const group: CreatedGroupChat = {
      chatId: `chat-created-${this.createdGroups.length + 1}`,
      chatKind: 'group',
      name: options.name,
    };
    this.createdGroups.push(group);
    return group;
  }

  async renameGroupChat(chatId: string, name: string): Promise<CreatedGroupChat> {
    const renamed = { chatId, name };
    this.renamedGroups.push(renamed);
    return { chatId, chatKind: 'group', name };
  }
}

export function inboundMessage(
  address: ChannelAddress,
  text: string,
  messageId = `incoming-${Date.now()}`,
): InboundMessage {
  return {
    address,
    text,
    messageId,
    timestamp: Date.now(),
  };
}
