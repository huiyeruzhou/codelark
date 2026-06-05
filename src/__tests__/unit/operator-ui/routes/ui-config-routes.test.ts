import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleUiConfigRoute } from '../../../../operator-ui/routes/config.js';
import { mergeConfig } from '../../../../operator-ui/application/config.js';
import type { Config } from '../../../../configuration/index.js';

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

const baseConfig: Config = {
  runtime: 'codex',
  defaultMode: 'normal',
  enabledChannels: [],
  channels: [],
};

describe('Ui config application', () => {
  it('preserves the current default model when an unknown model is submitted', () => {
    const merged = mergeConfig(
      { ...baseConfig, defaultModel: 'gpt-5.4', defaultProvider: 'tmux', claudeExecutable: 'claude' },
      { defaultModel: 'unknown-model', historyMessageLimit: 999, claudeExecutable: 'ccr' },
    );

    assert.equal(merged.defaultModel, 'gpt-5.4');
    assert.equal(merged.defaultProvider, 'tmux');
    assert.equal(merged.claudeExecutable, 'ccr');
    assert.equal(merged.historyMessageLimit, 20);
  });

  it('creates a UI access token when LAN access is enabled', () => {
    const merged = mergeConfig(baseConfig, { uiAllowLan: true });
    assert.equal(merged.uiAllowLan, true);
    assert.equal(typeof merged.uiAccessToken, 'string');
    assert.ok(merged.uiAccessToken?.length);
  });
});

describe('handleUiConfigRoute', () => {
  it('handles config reads', async () => {
    const response = createResponse();
    const handled = await handleUiConfigRoute({
      request: { method: 'GET' } as IncomingMessage,
      response,
      url: new URL('http://localhost/api/config'),
    });

    assert.equal(handled, true);
    assert.equal(response.statusCodeWritten, 200);
    const body = JSON.parse(response.body) as { runtime?: string; availableModels?: unknown[] };
    assert.equal(body.runtime, 'codex');
    assert.ok(Array.isArray(body.availableModels));
  });

  it('ignores routes owned by other UI modules', async () => {
    const response = createResponse();
    const handled = await handleUiConfigRoute({
      request: { method: 'GET' } as IncomingMessage,
      response,
      url: new URL('http://localhost/api/status'),
    });

    assert.equal(handled, false);
    assert.equal(response.body, '');
  });
});
