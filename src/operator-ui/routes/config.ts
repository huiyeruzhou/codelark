import type { IncomingMessage, ServerResponse } from 'node:http';

import { createConfigService } from '../../configuration/service.js';
import {
  configV2ToPayload,
  mergeConfigV2HomePatch,
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
    json(response, 200, configV2ToPayload(service.snapshot().config));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/config') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const service = createConfigService({ migrate: false });
    service.replace({ kind: 'home' }, mergeConfigV2HomePatch(service.snapshot().config, payload));
    json(response, 200, { ok: true, config: configV2ToPayload(service.snapshot().config) });
    return true;
  }

  return false;
}
