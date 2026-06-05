import type { IncomingMessage, ServerResponse } from 'node:http';

import { UiSessionApplication } from '../application/session.js';
import type { JsonFileStore } from '../../storage/json-store.js';

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

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function createSessionApplication(createStore: () => JsonFileStore): UiSessionApplication {
  return new UiSessionApplication(createStore());
}

export async function handleUiSessionRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  createStore: () => JsonFileStore;
}): Promise<boolean> {
  const { request, response, url, createStore } = options;

  if (request.method === 'GET' && url.pathname === '/api/codex-sessions') {
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? parsePositiveInt(limitParam, 10) : undefined;
    json(response, 200, createSessionApplication(createStore).listSessions(limit));
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/session-history') {
    const bridgeSessionId = asString(url.searchParams.get('bridgeSessionId'));
    const codexThreadId = asString(url.searchParams.get('codexThreadId'));
    const claudeSessionId = asString(url.searchParams.get('claudeSessionId'));
    const claudeCwd = asString(url.searchParams.get('claudeCwd'));
    if (!bridgeSessionId && !codexThreadId && !(claudeSessionId && claudeCwd)) {
      json(response, 400, { error: 'bridgeSessionId、codexThreadId 或 claudeSessionId+claudeCwd 不能为空。' });
      return true;
    }

    try {
      json(response, 200, createSessionApplication(createStore).getHistory({
        bridgeSessionId,
        codexThreadId,
        claudeSessionId,
        claudeCwd,
      }));
    } catch (error) {
      json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/session-config') {
    const bridgeSessionId = asString(url.searchParams.get('bridgeSessionId'));
    if (!bridgeSessionId) {
      json(response, 400, { error: 'bridgeSessionId 不能为空。' });
      return true;
    }

    try {
      json(response, 200, { ok: true, config: createSessionApplication(createStore).getConfig(bridgeSessionId) });
    } catch (error) {
      json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/sessions/import-codex-thread') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const codexThreadId = asString(payload.codexThreadId);
    if (!codexThreadId) {
      json(response, 400, { error: 'codexThreadId 不能为空。' });
      return true;
    }

    try {
      json(response, 200, {
        ok: true,
        ...createSessionApplication(createStore).importCodexThread(codexThreadId),
      });
    } catch (error) {
      json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/sessions/import-claude-thread') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const claudeSessionId = asString(payload.claudeSessionId);
    const claudeCwd = asString(payload.claudeCwd);
    if (!claudeSessionId || !claudeCwd) {
      json(response, 400, { error: 'claudeSessionId 和 claudeCwd 不能为空。' });
      return true;
    }

    try {
      json(response, 200, {
        ok: true,
        ...createSessionApplication(createStore).importClaudeThread(claudeSessionId, claudeCwd),
      });
    } catch (error) {
      json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/sessions/rename') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const bridgeSessionId = asString(payload.bridgeSessionId);
    const codexThreadId = asString(payload.codexThreadId);
    const claudeSessionId = asString(payload.claudeSessionId);
    const claudeCwd = asString(payload.claudeCwd);
    if (!bridgeSessionId && !codexThreadId && !(claudeSessionId && claudeCwd)) {
      json(response, 400, { error: 'bridgeSessionId、codexThreadId 或 claudeSessionId+claudeCwd 不能为空。' });
      return true;
    }

    try {
      const name = typeof payload.name === 'string' ? payload.name.trim() || undefined : undefined;
      const config = createSessionApplication(createStore).renameSession({
        bridgeSessionId,
        codexThreadId,
        claudeSessionId,
        claudeCwd,
      }, name);
      json(response, 200, { ok: true, config });
    } catch (error) {
      json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/session-config') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const bridgeSessionId = asString(payload.bridgeSessionId);
    if (!bridgeSessionId) {
      json(response, 400, { error: 'bridgeSessionId 不能为空。' });
      return true;
    }

    try {
      const config = createSessionApplication(createStore).updateConfig(bridgeSessionId, payload);
      json(response, 200, { ok: true, config });
    } catch (error) {
      json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/sessions/delete') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const bridgeSessionId = asString(payload.bridgeSessionId);
    const codexThreadId = asString(payload.codexThreadId);
    const claudeSessionId = asString(payload.claudeSessionId);
    const claudeCwd = asString(payload.claudeCwd);
    if (!bridgeSessionId && !codexThreadId && !(claudeSessionId && claudeCwd)) {
      json(response, 400, { error: 'bridgeSessionId、codexThreadId 或 claudeSessionId+claudeCwd 不能为空。' });
      return true;
    }

    try {
      json(response, 200, {
        ok: true,
        ...createSessionApplication(createStore).deleteSession({
          bridgeSessionId,
          codexThreadId,
          claudeSessionId,
          claudeCwd,
        }),
      });
    } catch (error) {
      json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
