import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  getBridgeAutostartStatus,
  getBridgeLogs,
  getBridgeStatus,
  getPackageRoot,
  getUiServerStatus,
  installCodexIntegration,
  isCodexIntegrationInstalled,
  restartBridge,
  startBridge,
  stopBridge,
} from '../../local-service/manager.js';

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function handleUiServiceRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  statusContext: {
    home: string;
    startedAt: string;
    timeZone: string;
    getUiAccess(): unknown;
  };
}): Promise<boolean> {
  const { request, response, url, statusContext } = options;

  if (request.method === 'GET' && url.pathname === '/api/status') {
    json(response, 200, {
      bridge: getBridgeStatus(),
      autostart: await getBridgeAutostartStatus(),
      ui: getUiServerStatus(),
      uiAccess: statusContext.getUiAccess(),
      home: statusContext.home,
      packageRoot: getPackageRoot(),
      codexIntegrationInstalled: isCodexIntegrationInstalled(),
      startedAt: statusContext.startedAt,
      timeZone: statusContext.timeZone,
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/install-codex-integration') {
    const result = await installCodexIntegration();
    json(response, 200, result);
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/bridge/start') {
    const status = await startBridge();
    json(response, 200, { ok: true, status });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/bridge/stop') {
    const status = await stopBridge();
    json(response, 200, { ok: true, status });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/bridge/restart') {
    const status = await restartBridge();
    json(response, 200, { ok: true, status });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/logs') {
    const lines = Number(url.searchParams.get('lines') || '200');
    json(response, 200, { logs: getBridgeLogs(lines) });
    return true;
  }

  return false;
}
