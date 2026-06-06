import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  findChannelInstance,
  type ChannelInstance,
  type Config,
} from '../../configuration/index.js';
import { configV2ToLegacyConfig, legacyConfigToConfigPatch } from '../../configuration/legacy.js';
import { createConfigService } from '../../configuration/service.js';
import {
  channelToPayload,
  configToPayload,
} from '../application/config.js';
import {
  deleteChannelInstance,
  mergeChannelInstance,
  validateFeishuCredentials,
} from '../application/channel.js';

interface UiChannelRouteStore {
  listChannelChats(channelId: string): unknown[];
  updateChannelChat(id: string, data: {
    channelProvider?: string;
    channelAlias?: string;
  }): unknown;
  getChannelDefaultTarget(channelId: string): { bridgeSessionId: string } | null;
  upsertChannelDefaultTarget(data: {
    channelType: string;
    channelProvider: string;
    channelAlias: string;
    bridgeSessionId: string;
  }): unknown;
  deleteChannelDefaultTarget(channelId: string): unknown;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  return raw ? JSON.parse(raw) as T : {} as T;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function syncBindingChannelMeta(store: UiChannelRouteStore, channel: ChannelInstance): void {
  for (const binding of store.listChannelChats(channel.id) as Array<{ id: string }>) {
    store.updateChannelChat(binding.id, {
      channelProvider: channel.provider,
      channelAlias: channel.alias,
    });
  }
  const channelDefault = store.getChannelDefaultTarget(channel.id);
  if (channelDefault) {
    store.upsertChannelDefaultTarget({
      channelType: channel.id,
      channelProvider: channel.provider,
      channelAlias: channel.alias,
      bridgeSessionId: channelDefault.bridgeSessionId,
    });
  }
}

function readHomeTomlConfig(): Config {
  return configV2ToLegacyConfig(createConfigService({ migrate: false }).snapshot().config);
}

function replaceHomeTomlConfig(config: Config): void {
  createConfigService({ migrate: false }).replace({ kind: 'home' }, legacyConfigToConfigPatch(config));
}

export async function handleUiChannelRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  createStore: () => UiChannelRouteStore;
  readConfig?: () => Config;
  writeConfig?: (config: Config) => void;
  buildBindingsPayload: (store: UiChannelRouteStore, config: Config) => Promise<Record<string, unknown>>;
}): Promise<boolean> {
  const {
    request,
    response,
    url,
    createStore,
    readConfig = readHomeTomlConfig,
    writeConfig = replaceHomeTomlConfig,
    buildBindingsPayload,
  } = options;

  if (request.method === 'POST' && url.pathname === '/api/channels/save') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const current = readConfig();
    const merged = mergeChannelInstance(payload, current);
    writeConfig(merged.config);
    const store = createStore();
    syncBindingChannelMeta(store, merged.channel);
    const latest = readConfig();
    json(response, 200, {
      ok: true,
      channel: channelToPayload(merged.channel),
      config: configToPayload(latest),
      ...(await buildBindingsPayload(store, latest)),
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/channels/delete') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const channelId = asString(payload.channelId);
    if (!channelId) {
      json(response, 400, { error: 'channelId 不能为空。' });
      return true;
    }

    const store = createStore();
    const bindings = store.listChannelChats(channelId);
    if (bindings.length > 0) {
      json(response, 400, { error: '该通道仍有聊天绑定，请先解绑后再删除。' });
      return true;
    }

    const next = deleteChannelInstance(readConfig(), channelId);
    writeConfig(next);
    store.deleteChannelDefaultTarget(channelId);
    const latest = readConfig();
    json(response, 200, {
      ok: true,
      config: configToPayload(latest),
      ...(await buildBindingsPayload(store, latest)),
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/channels/test') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const channelId = asString(payload.channelId);
    if (!channelId) {
      json(response, 400, { error: 'channelId 不能为空。' });
      return true;
    }
    const channel = findChannelInstance(channelId, readConfig());
    if (!channel) {
      json(response, 404, { error: '指定的通道不存在。' });
      return true;
    }

    if (channel.provider === 'feishu') {
      json(response, 200, await validateFeishuCredentials(channel));
      return true;
    }

    json(response, 400, { error: '不支持的通道提供方。' });
    return true;
  }

  return false;
}
