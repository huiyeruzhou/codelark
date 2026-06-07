import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';

import type { ConfigV2 } from '../../configuration/schema.js';
import { accessDeniedStyles, loginStyles } from '../assets.js';

const AUTH_COOKIE_NAME = 'clk_ui_auth';

export interface UiAuthState {
  localRequest: boolean;
  authenticated: boolean;
}

export type UiAuthConfig = ConfigV2;

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
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

function timingSafeMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(request: IncomingMessage): Map<string, string> {
  const header = request.headers.cookie;
  if (!header) return new Map();

  return new Map(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        if (separator === -1) return [part, ''];
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function makeAuthCookie(token: string): string {
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

function clearAuthCookie(): string {
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function redirect(response: ServerResponse, location: string, cookie?: string): void {
  const headers: Record<string, string | string[]> = { Location: location };
  if (cookie) headers['Set-Cookie'] = cookie;
  response.writeHead(302, headers);
  response.end();
}

function getRemoteAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress || '';
}

function isLoopbackAddress(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

export function isLocalRequest(request: IncomingMessage): boolean {
  return isLoopbackAddress(getRemoteAddress(request));
}

function getLanUrls(currentPort: number): string[] {
  const interfaces = os.networkInterfaces();
  const urls = new Set<string>();

  for (const records of Object.values(interfaces)) {
    for (const record of records || []) {
      if (!record || record.internal || record.family !== 'IPv4') continue;
      urls.add(`http://${record.address}:${currentPort}`);
    }
  }

  return Array.from(urls).sort();
}

function uiAllowLan(config: UiAuthConfig): boolean {
  return config.bridge.uiAllowLan === true;
}

function uiAccessToken(config: UiAuthConfig): string {
  return config.bridge.uiAccessToken || '';
}

export function isRemoteAuthenticated(request: IncomingMessage, config: UiAuthConfig): boolean {
  if (isLocalRequest(request)) return true;
  if (!uiAllowLan(config)) return false;
  return timingSafeMatch(parseCookies(request).get(AUTH_COOKIE_NAME), uiAccessToken(config));
}

export function getUiAuthState(request: IncomingMessage, config: UiAuthConfig): UiAuthState {
  return {
    localRequest: isLocalRequest(request),
    authenticated: isRemoteAuthenticated(request, config),
  };
}

export function buildUiAccessInfo(options: {
  currentPort: number;
  localUrl: string;
  config: UiAuthConfig;
  request?: IncomingMessage;
}) {
  const { currentPort, localUrl, config, request } = options;
  return {
    allowLan: uiAllowLan(config),
    localUrl,
    lanUrls: getLanUrls(currentPort),
    accessToken: uiAccessToken(config),
    requestIsLocal: request ? isLocalRequest(request) : true,
    authenticated: request ? isRemoteAuthenticated(request, config) : true,
  };
}

export function renderUiLoginHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeLark 登录</title>
    <style>${loginStyles}</style>
  </head>
  <body>
    <section class="auth-card">
      <h1>访问 CodeLark</h1>
      <p>当前工作台已开启局域网访问。请输入访问 token，验证通过后才能查看和修改配置。</p>
      <form id="loginForm">
        <label>
          访问 token
          <input id="token" name="token" autocomplete="off" spellcheck="false" />
        </label>
        <button type="submit">登录</button>
      </form>
      <div class="message" id="message"></div>
    </section>
    <script>
      const form = document.getElementById('loginForm');
      const message = document.getElementById('message');
      const tokenInput = document.getElementById('token');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        message.className = 'message';
        message.textContent = '';

        try {
          const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenInput.value }),
          });
          const text = await response.text();
          const data = text ? JSON.parse(text) : {};
          if (!response.ok) {
            throw new Error(data.error || '登录失败');
          }
          window.location.href = '/';
        } catch (error) {
          message.className = 'message show';
          message.textContent = error instanceof Error ? error.message : String(error);
        }
      });
    </script>
  </body>
</html>`;
}

export function renderUiAccessDeniedHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeLark</title>
    <style>${accessDeniedStyles}</style>
  </head>
  <body>
    <section class="card">
      <h1>当前未开放局域网访问</h1>
      <p>这个 Web 工作台目前只允许本机访问。请先在本机配置页中勾选“允许局域网访问 Web 控制台”。</p>
    </section>
  </body>
</html>`;
}

export async function handleUiAuthRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  config: UiAuthConfig;
  currentUrl: string;
  auth: UiAuthState;
  renderHomeHtml: () => string;
}): Promise<boolean> {
  const {
    request,
    response,
    url,
    config,
    currentUrl,
    auth,
    renderHomeHtml,
  } = options;

  const queryToken = asString(url.searchParams.get('token'));
  if (
    request.method === 'GET'
    && !auth.localRequest
    && uiAllowLan(config)
    && timingSafeMatch(queryToken, uiAccessToken(config))
  ) {
    const redirectUrl = new URL(url.pathname || '/', currentUrl);
    redirect(response, `${redirectUrl.pathname}${redirectUrl.search}`, makeAuthCookie(uiAccessToken(config)));
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/login') {
    if (auth.localRequest || auth.authenticated) {
      redirect(response, '/');
      return true;
    }
    if (!uiAllowLan(config)) {
      html(response, renderUiAccessDeniedHtml());
      return true;
    }
    html(response, renderUiLoginHtml());
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    if (!uiAllowLan(config)) {
      json(response, 403, { error: '当前未开启局域网访问。' });
      return true;
    }
    const payload = await readJsonBody<Record<string, unknown>>(request);
    const token = asString(payload.token);
    if (!timingSafeMatch(token, uiAccessToken(config))) {
      json(response, 401, { error: '访问 token 不正确。' });
      return true;
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': makeAuthCookie(uiAccessToken(config)),
    });
    response.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': clearAuthCookie(),
    });
    response.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/') {
    if (!auth.localRequest) {
      if (!uiAllowLan(config)) {
        html(response, renderUiAccessDeniedHtml());
        return true;
      }
      if (!auth.authenticated) {
        html(response, renderUiLoginHtml());
        return true;
      }
    }
    html(response, renderHomeHtml());
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/ping') {
    json(response, 200, { ok: true });
    return true;
  }

  return false;
}

export function rejectUnauthorizedUiApiRequest(options: {
  response: ServerResponse;
  config: UiAuthConfig;
  auth: UiAuthState;
}): boolean {
  const { response, config, auth } = options;
  if (auth.localRequest) return false;

  if (!uiAllowLan(config)) {
    json(response, 403, { error: '当前未开启局域网访问。' });
    return true;
  }
  if (!auth.authenticated) {
    json(response, 401, { error: '需要先登录并提供访问 token。' });
    return true;
  }

  return false;
}
