import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  configV2ToPayload,
  readUiHomeConfig,
  saveUiConfigPayload,
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
    json(response, 200, configV2ToPayload(readUiHomeConfig()));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/config') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    json(response, 200, { ok: true, config: configV2ToPayload(saveUiConfigPayload(payload)) });
    return true;
  }

  return false;
}
