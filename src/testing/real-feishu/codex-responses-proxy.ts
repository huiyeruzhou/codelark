import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export interface ScriptedModelReplyPlan {
  text: string;
  chunks: string[];
  chunkDelayMs: number;
}

export interface LocalCodexResponsesProxy {
  baseUrl: string;
  requests: Array<{ method: string; url: string; rawBody: string }>;
  close(): Promise<void>;
}

export const BASIC_DIALOGUE_MODEL_PROXY_CHUNK_DELAY_MS = 120;

function basicDialogueProviderKeyFromMarker(marker: string): string {
  const suffix = marker.match(/_(CODEX_SDK|CLAUDE_SDK|KIMI_TMUX|CODEX_TMUX|CLAUDE_PTY|CODEX_PTY)$/u)?.[1] || '';
  return suffix.toLowerCase().replace(/_/g, '-');
}

export function basicDialogueProxyReplyPlan(rawBody: string, fallback: string): ScriptedModelReplyPlan {
  const markerMatch = rawBody.match(/\bCODELARK_BASIC_DIALOGUE_[A-Z0-9_]+_(?:CODEX_SDK|CLAUDE_SDK|KIMI_TMUX|CODEX_TMUX|CLAUDE_PTY|CODEX_PTY)\b/u);
  if (!markerMatch) {
    return {
      text: fallback,
      chunks: [fallback],
      chunkDelayMs: BASIC_DIALOGUE_MODEL_PROXY_CHUNK_DELAY_MS,
    };
  }
  const marker = markerMatch[0];
  const providerKey = basicDialogueProviderKeyFromMarker(marker);
  const chunks = rawBody.includes('FOLLOWUP')
    ? [marker, ' FOLLOWUP_ACK\n']
    : [
      `${marker}\n`,
      `provider preload complete: ${providerKey}\n`,
      `${providerKey} partial text\n`,
      `Goal Active: ${providerKey} provider isolation\n`,
      `running representative tool: ${providerKey}\n`,
      'Bash\n',
      'Context: 42%\n',
    ];
  return {
    text: chunks.join(''),
    chunks,
    chunkDelayMs: BASIC_DIALOGUE_MODEL_PROXY_CHUNK_DELAY_MS,
  };
}

function createResponsesEventStreamPayload(model: string, plan: ScriptedModelReplyPlan): string[] {
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
    ...plan.chunks.map((delta): [string, unknown] => ['response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta,
    }]),
    ['response.output_text.done', {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: plan.text,
    }],
    ['response.content_part.done', {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: plan.text },
    }],
    ['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: plan.text }],
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
          content: [{ type: 'output_text', text: plan.text }],
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
    .concat('data: [DONE]\n\n');
}

function writeTimedChunks(
  res: http.ServerResponse,
  chunks: string[],
  delayMs: number,
): void {
  let index = 0;
  const writeNext = () => {
    if (index >= chunks.length) {
      res.end();
      return;
    }
    res.write(chunks[index]);
    index += 1;
    setTimeout(writeNext, delayMs);
  };
  writeNext();
}

export async function startLocalCodexResponsesProxy(responseText: string): Promise<LocalCodexResponsesProxy> {
  const requests: LocalCodexResponsesProxy['requests'] = [];
  const server = http.createServer((req, res) => {
    let rawBody = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method || '', url: req.url || '', rawBody });
      let body: unknown = null;
      if (rawBody) {
        try { body = JSON.parse(rawBody) as unknown; } catch { body = rawBody; }
      }
      if (req.method === 'POST' && req.url?.includes('/responses')) {
        const model = typeof body === 'object'
          && body !== null
          && typeof (body as { model?: unknown }).model === 'string'
          ? (body as { model: string }).model
          : 'gpt-5';
        const plan = basicDialogueProxyReplyPlan(rawBody, responseText);
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        writeTimedChunks(res, createResponsesEventStreamPayload(model, plan), plan.chunkDelayMs);
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
      requests.push({ method: 'WS', url: req.url || '/v1/responses', rawBody });
      let body: unknown = rawBody;
      try { body = JSON.parse(rawBody) as unknown; } catch { /* keep raw */ }
      const model = typeof body === 'object'
        && body !== null
        && typeof (body as { model?: unknown }).model === 'string'
        ? (body as { model: string }).model
        : 'gpt-5';
      const plan = basicDialogueProxyReplyPlan(rawBody, responseText);
      const chunks = createResponsesEventStreamPayload(model, plan);
      chunks.forEach((chunk, index) => {
        const dataLine = chunk.trim().split(/\n/).find((line) => line.startsWith('data: '));
        if (!dataLine) return;
        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (dataLine === 'data: [DONE]') {
            ws.close(1000, 'done');
            return;
          }
          ws.send(dataLine.slice('data: '.length));
        }, index * plan.chunkDelayMs);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Failed to start local Codex Responses proxy.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => {
      wss.close(() => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }),
  };
}
