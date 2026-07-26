import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

import { getSessionIndexPath } from '../../../runtime/codex/session-index/paths.js';

const execFileAsync = promisify(execFile);

export interface RecordedResponsesRequest {
  method: string;
  url: string;
  body: unknown;
  rawBody: string;
}

export interface LocalResponsesProxy {
  baseUrl: string;
  requests: RecordedResponsesRequest[];
  close(): Promise<void>;
}

function quoteCmdArgument(value: string): string {
  if (!value) return '""';
  return `"${value.replace(/(["^&|<>])/gu, '^$1')}"`;
}

export async function execRuntimeCommand(command: string, args: string[]) {
  if (process.platform !== 'win32') return execFileAsync(command, args);
  const commandLine = [command, ...args].map(quoteCmdArgument).join(' ');
  return execFileAsync(
    process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
    ['/d', '/s', '/c', commandLine],
    { windowsHide: true },
  );
}

export function removeRuntimeTestDirectory(directory: string): void {
  fs.rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    await execRuntimeCommand(command, args);
    return true;
  } catch {
    return false;
  }
}

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return condition();
}

function removeLineFromJsonl(filePath: string, predicate: (value: unknown, raw: string) => boolean): void {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      kept.push(line);
      continue;
    }
    if (!predicate(parsed, line)) kept.push(line);
  }
  fs.writeFileSync(filePath, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf-8');
}

export function cleanupCodexThreadArtifacts(threadId: string, filePath: string): void {
  if (filePath) {
    fs.rmSync(filePath, { force: true });
  }
  removeLineFromJsonl(getSessionIndexPath(), (value, raw) => {
    if (raw.includes(threadId)) return true;
    return typeof value === 'object'
      && value !== null
      && (value as { id?: unknown }).id === threadId;
  });
}

export function seedCodexApiKeyAuth(codexHome: string, apiKey: string): void {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    auth_mode: 'apikey',
    OPENAI_API_KEY: apiKey,
  }, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

function createResponsesEventStreamPayload(model: string, responseText: string): string {
  const now = Math.floor(Date.now() / 1000);
  const responseId = `resp_clk_${now}`;
  const itemId = `msg_clk_${now}`;
  const events: Array<[string, unknown]> = [
    ['response.created', {
      type: 'response.created',
      response: { id: responseId, object: 'response', created_at: now, status: 'in_progress', model, output: [] },
    }],
    ['response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    }],
    ['response.content_part.added', {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    }],
    ['response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: responseText,
    }],
    ['response.output_text.done', {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: responseText,
    }],
    ['response.content_part.done', {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: responseText },
    }],
    ['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: responseText }],
      },
    }],
    ['response.completed', {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        created_at: now,
        status: 'completed',
        model,
        output: [{
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: responseText }],
        }],
        usage: {
          input_tokens: 1,
          output_tokens: 4,
          total_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    }],
  ];
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('') + 'data: [DONE]\n\n';
}

function createChatCompletionsEventStreamPayload(model: string, responseText: string): string {
  const now = Math.floor(Date.now() / 1000);
  const id = `chatcmpl_clk_${now}`;
  const chunks = [
    {
      id,
      object: 'chat.completion.chunk',
      created: now,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created: now,
      model,
      choices: [{ index: 0, delta: { content: responseText }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created: now,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function createAnthropicMessagesEventStreamPayload(model: string, responseText: string): string {
  const messageId = `msg_clk_${Date.now()}`;
  const events: unknown[] = [
    {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: responseText },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: 'message_stop' },
  ];
  return events
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

export async function startLocalResponsesProxy(options: {
  responseText?: string;
  responseDelayMs?: number;
  errorWhenBodyIncludes?: string;
  errorStatus?: number;
  errorBody?: unknown;
} = {}): Promise<LocalResponsesProxy> {
  const responseText = options.responseText ?? 'clk local proxy response';
  const responseDelayMs = Math.max(0, options.responseDelayMs ?? 0);
  const requests: RecordedResponsesRequest[] = [];
  const server = http.createServer((req, res) => {
    let rawBody = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      let body: unknown = null;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody) as unknown;
        } catch {
          body = rawBody;
        }
      }
      const recordedRequest = {
        method: req.method || '',
        url: req.url || '',
        body,
        rawBody,
      };
      requests.push(recordedRequest);

      if (req.method === 'POST' && req.url?.includes('/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }

      if (req.method === 'POST' && /\/messages(?:\?|$)/u.test(req.url || '')) {
        const model = typeof body === 'object'
          && body !== null
          && typeof (body as { model?: unknown }).model === 'string'
          ? (body as { model: string }).model
          : 'claude-sonnet-4-5';
        const wantsStream = typeof body === 'object'
          && body !== null
          && (body as { stream?: unknown }).stream === true;
        void (async () => {
          if (responseDelayMs > 0) await sleep(responseDelayMs);
          if (wantsStream) {
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            });
            res.end(createAnthropicMessagesEventStreamPayload(model, responseText));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: `msg_clk_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'text', text: responseText }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 4 },
          }));
        })();
        return;
      }

      if (req.method === 'POST' && req.url?.includes('/responses')) {
        if (options.errorWhenBodyIncludes && rawBody.includes(options.errorWhenBodyIncludes)) {
          void (async () => {
            if (responseDelayMs > 0) await sleep(responseDelayMs);
            res.writeHead(options.errorStatus ?? 400, { 'content-type': 'application/json' });
            res.end(JSON.stringify(options.errorBody ?? {
              error: { type: 'invalid_request_error', message: 'CODELARK_MOCK_FATAL' },
            }));
          })();
          return;
        }
        const model = typeof body === 'object'
          && body !== null
          && typeof (body as { model?: unknown }).model === 'string'
          ? (body as { model: string }).model
          : 'gpt-5';
        void (async () => {
          if (responseDelayMs > 0) await sleep(responseDelayMs);
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.end(createResponsesEventStreamPayload(model, responseText));
        })();
        return;
      }

      if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
        const model = typeof body === 'object'
          && body !== null
          && typeof (body as { model?: unknown }).model === 'string'
          ? (body as { model: string }).model
          : 'clk-fake-claude';
        const wantsStream = typeof body === 'object'
          && body !== null
          && (body as { stream?: unknown }).stream === true;
        if (wantsStream) {
          void (async () => {
            if (responseDelayMs > 0) await sleep(responseDelayMs);
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            });
            res.end(createChatCompletionsEventStreamPayload(model, responseText));
          })();
          return;
        }
        void (async () => {
          if (responseDelayMs > 0) await sleep(responseDelayMs);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: `chatcmpl_clk_${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: responseText },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
          }));
        })();
        return;
      }

      if (req.method === 'GET' && req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  const wss = new WebSocketServer({ server, path: '/v1/responses' });
  wss.on('connection', (ws, req) => {
    ws.on('message', (data) => {
      const rawBody = data.toString();
      let body: unknown = rawBody;
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        // keep raw body
      }
      requests.push({
        method: 'WS',
        url: req.url || '/v1/responses',
        body,
        rawBody,
      });
      const model = typeof body === 'object'
        && body !== null
        && typeof (body as { model?: unknown }).model === 'string'
        ? (body as { model: string }).model
        : 'gpt-5.4';
      const streamPayload = createResponsesEventStreamPayload(model, responseText)
        .split(/\n\n/)
        .map((chunk) => chunk.trim())
        .filter(Boolean);
      for (const chunk of streamPayload) {
        const dataLine = chunk.split(/\n/).find((line) => line.startsWith('data: '));
        if (!dataLine || dataLine === 'data: [DONE]') continue;
        ws.send(dataLine.slice('data: '.length));
      }
      ws.close(1000, 'done');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close(() => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }),
  };
}
