import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ConfigV2 } from '../../configuration/schema.js';
import type { JsonFileStore } from '../../storage/json-store.js';
import { UiBindingApplication } from '../application/binding.js';

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

function createBindingApplication(createStore: () => JsonFileStore): { app: UiBindingApplication; store: JsonFileStore } {
  const store = createStore();
  return { app: new UiBindingApplication(store), store };
}

export async function handleUiBindingRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  createStore: () => JsonFileStore;
  readConfig: () => ConfigV2;
  buildBindingsPayload: (store: JsonFileStore, config: ConfigV2) => Promise<unknown>;
}): Promise<boolean> {
  const { request, response, url, createStore, readConfig, buildBindingsPayload } = options;

  if (request.method === 'GET' && url.pathname === '/api/bindings') {
    const store = createStore();
    json(response, 200, await buildBindingsPayload(store, readConfig()));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/bindings/update') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const bindingId = asString(payload.bindingId);
    const bridgeSessionId = asString(payload.bridgeSessionId);
    const codexThreadId = asString(payload.codexThreadId);
    const claudeSessionId = asString(payload.claudeSessionId);
    const claudeCwd = asString(payload.claudeCwd);
    const kimiSessionId = asString(payload.kimiSessionId);
    const kimiCwd = asString(payload.kimiCwd);
    const cursorSessionId = asString(payload.cursorSessionId);
    const cursorCwd = asString(payload.cursorCwd);
    const zcodeSessionId = asString(payload.zcodeSessionId);
    const zcodeCwd = asString(payload.zcodeCwd);
    if (!bindingId || (!bridgeSessionId && !codexThreadId && !(claudeSessionId && claudeCwd) && !(kimiSessionId && kimiCwd) && !(cursorSessionId && cursorCwd) && !(zcodeSessionId && zcodeCwd))) {
      json(response, 400, { error: 'bindingId 以及 bridgeSessionId、codexThreadId 或本地 runtime sessionId+cwd 不能为空。' });
      return true;
    }

    const { app, store } = createBindingApplication(createStore);
    const updated = app.switchBindingTarget({ bindingId, bridgeSessionId, codexThreadId, claudeSessionId, claudeCwd, kimiSessionId, kimiCwd, cursorSessionId, cursorCwd, zcodeSessionId, zcodeCwd });
    json(response, 200, {
      ok: true,
      updated,
      ...(await buildBindingsPayload(store, readConfig()) as Record<string, unknown>),
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/channel-default-targets/update') {
    json(response, 410, { error: '通道级“下一条新聊天”入口已停用。请先让目标聊天建立独立会话，再修改该聊天的绑定。' });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/channel-default-targets/delete') {
    json(response, 410, { error: '通道级“下一条新聊天”入口已停用，升级时会自动清理遗留入口。' });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/bindings/delete') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const bindingId = asString(payload.bindingId);
    if (!bindingId) {
      json(response, 400, { error: 'bindingId 不能为空。' });
      return true;
    }

    const { app, store } = createBindingApplication(createStore);
    app.removeBinding(bindingId);
    json(response, 200, {
      ok: true,
      ...(await buildBindingsPayload(store, readConfig()) as Record<string, unknown>),
    });
    return true;
  }

  return false;
}
