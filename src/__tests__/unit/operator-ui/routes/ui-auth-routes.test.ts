import '../../../setup/test-setup.js';
import os from 'node:os';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ConfigV2 } from '../../../../configuration/schema.js';
import {
  buildUiAccessInfo,
  getUiAuthState,
  handleUiAuthRoute,
  rejectUnauthorizedUiApiRequest,
} from '../../../../operator-ui/routes/auth.js';

function createResponse(): ServerResponse & {
  body: string;
  headersWritten?: Record<string, string | string[]>;
  statusCodeWritten?: number;
} {
  return {
    body: '',
    writeHead(statusCode: number, headers?: Record<string, string | string[]>) {
      this.statusCodeWritten = statusCode;
      this.headersWritten = headers;
      return this;
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') this.body += chunk;
      else if (chunk instanceof Uint8Array) this.body += Buffer.from(chunk).toString('utf-8');
      return this;
    },
  } as ServerResponse & {
    body: string;
    headersWritten?: Record<string, string | string[]>;
    statusCodeWritten?: number;
  };
}

function createRequest(options: {
  body?: unknown;
  cookie?: string;
  method?: string;
  remoteAddress?: string;
} = {}): IncomingMessage {
  const chunks = options.body === undefined ? [] : [JSON.stringify(options.body)];
  return Object.assign(Readable.from(chunks), {
    method: options.method || 'GET',
    headers: options.cookie ? { cookie: options.cookie } : {},
    socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
  }) as IncomingMessage;
}

function baseConfigV2(overrides: Partial<ConfigV2> = {}): ConfigV2 {
  return {
    schemaVersion: 2,
    session: {
      workspace: '~',
      tmuxCaptureLines: 80,
      tmuxAutoEnter: true,
      tmuxEchoInput: false,
    },
    runtime: {
      agent: 'codex',
      codex: {
        model: '',
        yoloMode: 'off',
        provider: '',
        skipGitRepoCheck: true,
        sandboxMode: 'workspace-write',
        networkAccess: true,
        reasoningEffort: 'medium',
      },
      claude: {
        model: '',
        yoloMode: 'off',
        provider: 'sdk',
        executable: 'claude',
        reasoningEffort: 'medium',
        idleTimeoutMinutes: 0,
      },
      kimi: {
        model: '',
        provider: 'tmux',
      },
      cursor: {
        model: '',
        provider: 'tmux',
        force: false,
      },
      zcode: {
        model: '',
        provider: 'tmux',
        mode: 'build',
      },
    },
    bridge: {
      defaultWorkspace: '~',
      uiAllowLan: true,
      uiAccessToken: 'secret-token',
    },
    channels: [],
    ...overrides,
  };
}

const originalNetworkInterfaces = os.networkInterfaces;

afterEach(() => {
  os.networkInterfaces = originalNetworkInterfaces;
});

describe('UI auth routes', () => {
  it('exchanges a valid query token for an auth cookie', async () => {
    const request = createRequest({ remoteAddress: '192.168.1.10' });
    const response = createResponse();
    const config = baseConfigV2();
    const auth = getUiAuthState(request, config);

    const handled = await handleUiAuthRoute({
      request,
      response,
      url: new URL('http://localhost/?token=secret-token'),
      config,
      currentUrl: 'http://localhost',
      auth,
      renderHomeHtml: () => '<main>home</main>',
    });

    assert.equal(handled, true);
    assert.equal(response.statusCodeWritten, 302);
    assert.equal(response.headersWritten?.Location, '/');
    assert.match(String(response.headersWritten?.['Set-Cookie'] || ''), /clk_ui_auth=secret-token/);
  });

  it('handles token login and logout APIs', async () => {
    const loginResponse = createResponse();
    const loginRequest = createRequest({
      method: 'POST',
      remoteAddress: '192.168.1.10',
      body: { token: 'secret-token' },
    });
    const config = baseConfigV2();

    const loginHandled = await handleUiAuthRoute({
      request: loginRequest,
      response: loginResponse,
      url: new URL('http://localhost/api/auth/login'),
      config,
      currentUrl: 'http://localhost',
      auth: getUiAuthState(loginRequest, config),
      renderHomeHtml: () => '<main>home</main>',
    });

    assert.equal(loginHandled, true);
    assert.equal(loginResponse.statusCodeWritten, 200);
    assert.match(String(loginResponse.headersWritten?.['Set-Cookie'] || ''), /clk_ui_auth=secret-token/);

    const logoutResponse = createResponse();
    const logoutRequest = createRequest({ method: 'POST', remoteAddress: '192.168.1.10' });
    const logoutHandled = await handleUiAuthRoute({
      request: logoutRequest,
      response: logoutResponse,
      url: new URL('http://localhost/api/auth/logout'),
      config,
      currentUrl: 'http://localhost',
      auth: getUiAuthState(logoutRequest, config),
      renderHomeHtml: () => '<main>home</main>',
    });

    assert.equal(logoutHandled, true);
    assert.equal(logoutResponse.statusCodeWritten, 200);
    assert.match(String(logoutResponse.headersWritten?.['Set-Cookie'] || ''), /Max-Age=0/);
  });

  it('renders login for unauthenticated remote root requests', async () => {
    const request = createRequest({ remoteAddress: '192.168.1.10' });
    const response = createResponse();
    const config = baseConfigV2();

    const handled = await handleUiAuthRoute({
      request,
      response,
      url: new URL('http://localhost/'),
      config,
      currentUrl: 'http://localhost',
      auth: getUiAuthState(request, config),
      renderHomeHtml: () => '<main>home</main>',
    });

    assert.equal(handled, true);
    assert.equal(response.statusCodeWritten, 200);
    assert.match(response.body, /访问 CodeLark/);
    assert.ok(!response.body.includes('<main>home</main>'));
  });

  it('rejects unauthenticated remote API requests after public auth routes', () => {
    const request = createRequest({ remoteAddress: '192.168.1.10' });
    const response = createResponse();
    const config = baseConfigV2();
    const rejected = rejectUnauthorizedUiApiRequest({
      response,
      config,
      auth: getUiAuthState(request, config),
    });

    assert.equal(rejected, true);
    assert.equal(response.statusCodeWritten, 401);
  });

  it('authenticates remote UI requests from v2 bridge config', async () => {
    const request = createRequest({
      remoteAddress: '192.168.1.10',
      cookie: 'clk_ui_auth=secret-token',
    });
    const response = createResponse();
    const config = baseConfigV2();

    const auth = getUiAuthState(request, config);
    const handled = await handleUiAuthRoute({
      request,
      response,
      url: new URL('http://localhost/'),
      config,
      currentUrl: 'http://localhost',
      auth,
      renderHomeHtml: () => '<main>home</main>',
    });

    assert.equal(auth.authenticated, true);
    assert.equal(handled, true);
    assert.equal(response.statusCodeWritten, 200);
    assert.equal(response.body, '<main>home</main>');
  });

  it('builds UI access info from auth state and local URLs', () => {
    os.networkInterfaces = () => ({
      eth0: [{
        address: '192.168.1.20',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: false,
        cidr: '192.168.1.20/24',
      }],
      lo: [{
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      }],
    });

    const request = createRequest({
      remoteAddress: '192.168.1.10',
      cookie: 'clk_ui_auth=secret-token',
    });
    const info = buildUiAccessInfo({
      currentPort: 4781,
      localUrl: 'http://127.0.0.1:4781',
      config: baseConfigV2(),
      request,
    });

    assert.equal(info.allowLan, true);
    assert.equal(info.localUrl, 'http://127.0.0.1:4781');
    assert.deepEqual(info.lanUrls, ['http://192.168.1.20:4781']);
    assert.equal(info.requestIsLocal, false);
    assert.equal(info.authenticated, true);
  });
});
