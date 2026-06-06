import type { IncomingMessage, ServerResponse } from 'node:http';

import { configV2ToLegacyConfig, legacyConfigToConfigPatch } from '../../configuration/legacy.js';
import { createConfigService } from '../../configuration/service.js';
import {
  configToPayload,
  mergeConfig,
} from '../application/config.js';

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

export async function handleUiConfigRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}): Promise<boolean> {
  const { request, response, url } = options;

  if (request.method === 'GET' && url.pathname === '/api/config') {
    const service = createConfigService({ migrate: false });
    json(response, 200, configToPayload(configV2ToLegacyConfig(service.snapshot().config)));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/config') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const service = createConfigService({ migrate: false });
    const config = mergeConfig(configV2ToLegacyConfig(service.snapshot().config), payload);
    service.replace({ kind: 'home' }, legacyConfigToConfigPatch(config));
    json(response, 200, { ok: true, config: configToPayload(configV2ToLegacyConfig(service.snapshot().config)) });
    return true;
  }

  return false;
}
