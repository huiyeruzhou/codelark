import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

import {
  checkUiConfigPayload,
  readUiConfigPayload,
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

function configErrorBody(error: unknown): { ok: false; error: string; issues?: Array<{ path: string; message: string }> } {
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      error: '配置字段不合法。',
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  return {
    ok: false,
    error: error instanceof Error ? error.message : '配置字段不合法。',
  };
}

export async function handleUiConfigRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}): Promise<boolean> {
  const { request, response, url } = options;

  if (request.method === 'GET' && url.pathname === '/api/config') {
    json(response, 200, readUiConfigPayload());
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/config') {
    try {
      const payload = await readJsonBody<Record<string, unknown>>(request);
      json(response, 200, { ok: true, config: saveUiConfigPayload(payload) });
    } catch (error) {
      json(response, 400, configErrorBody(error));
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/config/check') {
    try {
      const payload = await readJsonBody<Record<string, unknown>>(request);
      checkUiConfigPayload(payload);
      json(response, 200, { ok: true });
    } catch (error) {
      json(response, 400, configErrorBody(error));
    }
    return true;
  }

  return false;
}
