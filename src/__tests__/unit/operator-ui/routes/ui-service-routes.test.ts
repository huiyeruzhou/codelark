import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleUiServiceRoute } from '../../../../operator-ui/routes/service.js';

function createResponse(): ServerResponse & { body: string; statusCodeWritten?: number } {
  return {
    body: '',
    writeHead(statusCode: number) {
      this.statusCodeWritten = statusCode;
      return this;
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') this.body += chunk;
      else if (chunk instanceof Uint8Array) this.body += Buffer.from(chunk).toString('utf-8');
      return this;
    },
  } as ServerResponse & { body: string; statusCodeWritten?: number };
}

const statusContext = {
  home: '/tmp/clk-test-home',
  startedAt: '2026-05-30T00:00:00.000Z',
  timeZone: 'Asia/Shanghai',
  getUiAccess: () => ({ local: true }),
  getWeixinAccountsPayload: () => [],
};

describe('handleUiServiceRoute', () => {
  it('handles owned service routes and ignores routes owned by other UI modules', async () => {
    const response = createResponse();
    const handled = await handleUiServiceRoute({
      request: { method: 'GET' } as IncomingMessage,
      response,
      url: new URL('http://localhost/api/logs?lines=20'),
      statusContext,
    });

    assert.equal(handled, true);
    assert.equal(response.statusCodeWritten, 200);
    assert.deepEqual(JSON.parse(response.body), { logs: '' });

    const configResponse = createResponse();
    const configHandled = await handleUiServiceRoute({
      request: { method: 'GET' } as IncomingMessage,
      response: configResponse,
      url: new URL('http://localhost/api/config'),
      statusContext,
    });

    assert.equal(configHandled, false);
    assert.equal(configResponse.body, '');
  });
});
