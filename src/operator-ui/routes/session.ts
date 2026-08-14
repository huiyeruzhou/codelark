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
    const kimiSessionId = asString(url.searchParams.get('kimiSessionId'));
    const kimiCwd = asString(url.searchParams.get('kimiCwd'));
    const cursorSessionId = asString(url.searchParams.get('cursorSessionId'));
    const cursorCwd = asString(url.searchParams.get('cursorCwd'));
    const zcodeSessionId = asString(url.searchParams.get('zcodeSessionId'));
    const zcodeCwd = asString(url.searchParams.get('zcodeCwd'));
    if (!bridgeSessionId && !codexThreadId && !(claudeSessionId && claudeCwd) && !(kimiSessionId && kimiCwd) && !(cursorSessionId && cursorCwd) && !(zcodeSessionId && zcodeCwd)) {
      json(response, 400, { error: 'bridgeSessionId、codexThreadId 或本地 runtime sessionId+cwd 不能为空。' });
      return true;
    }

    try {
      json(response, 200, createSessionApplication(createStore).getHistory({
        bridgeSessionId,
        codexThreadId,
        claudeSessionId,
        claudeCwd,
        kimiSessionId,
        kimiCwd,
        cursorSessionId,
        cursorCwd,
        zcodeSessionId,
        zcodeCwd,
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

  if (request.method === 'POST' && url.pathname === '/api/sessions/import-kimi-thread') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const kimiSessionId = asString(payload.kimiSessionId);
    const kimiCwd = asString(payload.kimiCwd);
    if (!kimiSessionId || !kimiCwd) {
      json(response, 400, { error: 'kimiSessionId 和 kimiCwd 不能为空。' });
      return true;
    }

    try {
      json(response, 200, {
        ok: true,
        ...createSessionApplication(createStore).importKimiThread(kimiSessionId, kimiCwd),
      });
    } catch (error) {
      json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/sessions/import-cursor-thread') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const cursorSessionId = asString(payload.cursorSessionId);
    const cursorCwd = asString(payload.cursorCwd);
    if (!cursorSessionId || !cursorCwd) {
      json(response, 400, { error: 'cursorSessionId 和 cursorCwd 不能为空。' });
      return true;
    }

    try {
      json(response, 200, {
        ok: true,
        ...createSessionApplication(createStore).importCursorThread(cursorSessionId, cursorCwd),
      });
    } catch (error) {
      json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/sessions/import-zcode-thread') {
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const zcodeSessionId = asString(payload.zcodeSessionId);
    const zcodeCwd = asString(payload.zcodeCwd);
    if (!zcodeSessionId || !zcodeCwd) {
      json(response, 400, { error: 'zcodeSessionId 和 zcodeCwd 不能为空。' });
      return true;
    }
    try {
      json(response, 200, {
        ok: true,
        ...createSessionApplication(createStore).importZcodeThread(zcodeSessionId, zcodeCwd),
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
    const kimiSessionId = asString(payload.kimiSessionId);
    const kimiCwd = asString(payload.kimiCwd);
    const cursorSessionId = asString(payload.cursorSessionId);
    const cursorCwd = asString(payload.cursorCwd);
    const zcodeSessionId = asString(payload.zcodeSessionId);
    const zcodeCwd = asString(payload.zcodeCwd);
    if (!bridgeSessionId && !codexThreadId && !(claudeSessionId && claudeCwd) && !(kimiSessionId && kimiCwd) && !(cursorSessionId && cursorCwd) && !(zcodeSessionId && zcodeCwd)) {
      json(response, 400, { error: 'bridgeSessionId、codexThreadId 或本地 runtime sessionId+cwd 不能为空。' });
      return true;
    }

    try {
      const name = typeof payload.name === 'string' ? payload.name.trim() || undefined : undefined;
      const config = createSessionApplication(createStore).renameSession({
        bridgeSessionId,
        codexThreadId,
        claudeSessionId,
        claudeCwd,
        kimiSessionId,
        kimiCwd,
        cursorSessionId,
        cursorCwd,
        zcodeSessionId,
        zcodeCwd,
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
    const kimiSessionId = asString(payload.kimiSessionId);
    const kimiCwd = asString(payload.kimiCwd);
    const cursorSessionId = asString(payload.cursorSessionId);
    const cursorCwd = asString(payload.cursorCwd);
    const zcodeSessionId = asString(payload.zcodeSessionId);
    const zcodeCwd = asString(payload.zcodeCwd);
    if (!bridgeSessionId && !codexThreadId && !(claudeSessionId && claudeCwd) && !(kimiSessionId && kimiCwd) && !(cursorSessionId && cursorCwd) && !(zcodeSessionId && zcodeCwd)) {
      json(response, 400, { error: 'bridgeSessionId、codexThreadId 或本地 runtime sessionId+cwd 不能为空。' });
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
          kimiSessionId,
          kimiCwd,
          cursorSessionId,
          cursorCwd,
          zcodeSessionId,
          zcodeCwd,
        }),
      });
    } catch (error) {
      json(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
