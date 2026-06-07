import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { CODELARK_HOME } from '../configuration/paths.js';
import { createConfigService } from '../configuration/service.js';
import type { ConfigV2 } from '../configuration/schema.js';
import { exportRuntimeSettings } from '../runtime/config-projections.js';
import {
  getUiServerUrl,
  writeUiServerStatus,
} from '../local-service/manager.js';
import { JsonFileStore } from '../storage/json-store.js';
import { renderUiShellHtml } from './shell.js';
import {
  buildUiAccessInfo,
  getUiAuthState,
  handleUiAuthRoute,
  rejectUnauthorizedUiApiRequest,
} from './routes/auth.js';
import { handleUiChannelRoute } from './routes/channel.js';
import { handleUiConfigRoute } from './routes/config.js';
import { handleUiBindingRoute } from './routes/binding.js';
import { handleUiSessionRoute } from './routes/session.js';
import { handleUiServiceRoute } from './routes/service.js';
import { buildUiBindingsPayload } from './application/chat-display.js';
import { readUiHomeConfig } from './application/config.js';

let port = 4781;
const serverStartTime = new Date().toISOString();
const LOG_PREFIX = '[CodeLark]';

function parsePreferredPort(): number {
  const raw = Number(process.env.CODELARK_UI_PORT || '4781');
  if (!Number.isInteger(raw) || raw <= 0 || raw > 65535) return 4781;
  return raw;
}

async function canListen(portToCheck: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(portToCheck, '0.0.0.0', () => {
      probe.close(() => resolve(true));
    });
  });
}

async function resolveUiPort(preferredPort: number): Promise<number> {
  const end = Math.min(preferredPort + 20, 65535);
  for (let candidate = preferredPort; candidate <= end; candidate += 1) {
    if (await canListen(candidate)) return candidate;
  }

  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const address = probe.address();
      const dynamicPort = typeof address === 'object' && address ? address.port : preferredPort;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(dynamicPort);
      });
    });
  });
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function createUiStore(): JsonFileStore {
  const config = createConfigService({ codelarkHome: CODELARK_HOME }).snapshot().config;
  return new JsonFileStore(exportRuntimeSettings(config));
}

function loadUiConfig(): ConfigV2 {
  return readUiHomeConfig();
}

const server = http.createServer(async (request, response) => {
  try {
    const currentUrl = getUiServerUrl(port);
    const url = new URL(request.url || '/', currentUrl);
    const config = loadUiConfig();
    const auth = getUiAuthState(request, config);

    if (await handleUiAuthRoute({
      request,
      response,
      url,
      config,
      currentUrl,
      auth,
      renderHomeHtml: renderUiShellHtml,
    })) return;

    if (rejectUnauthorizedUiApiRequest({ response, config, auth })) return;

    if (await handleUiSessionRoute({
      request,
      response,
      url,
      createStore: createUiStore,
    })) {
      return;
    }

    if (await handleUiBindingRoute({
      request,
      response,
      url,
      createStore: createUiStore,
      readConfig: loadUiConfig,
      buildBindingsPayload: buildUiBindingsPayload,
    })) return;

    if (await handleUiServiceRoute({
      request,
      response,
      url,
      statusContext: {
        home: CODELARK_HOME,
        startedAt: serverStartTime,
        getUiAccess: () => buildUiAccessInfo({
          currentPort: port,
          localUrl: currentUrl,
          config,
          request,
        }),
      },
    })) return;

    if (await handleUiConfigRoute({ request, response, url })) return;

    if (await handleUiChannelRoute({
      request,
      response,
      url,
      createStore: createUiStore,
      buildBindingsPayload: (store, config) => buildUiBindingsPayload(store as JsonFileStore, config),
    })) return;

    text(response, 404, 'Not found');
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

async function startServer(): Promise<void> {
  port = await resolveUiPort(parsePreferredPort());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  writeUiServerStatus({
    running: true,
    pid: process.pid,
    port,
    startedAt: serverStartTime,
  });
  console.log(`${LOG_PREFIX} UI server ready at ${getUiServerUrl(port)}`);
}

const cleanup = () => {
  writeUiServerStatus({
    running: false,
    pid: process.pid,
    port,
    startedAt: serverStartTime,
  });
  server.close(() => process.exit(0));
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

startServer().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`${LOG_PREFIX} Failed to start UI server:`, message);
  writeUiServerStatus({
    running: false,
    pid: process.pid,
    port,
    startedAt: serverStartTime,
  });
  process.exit(1);
});
