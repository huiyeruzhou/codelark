/**
 * Daemon entry point for CodeLark.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { initBridgeContext } from '../bridge/host/context.js';
import * as bridgeManager from '../bridge/host/manager.js';
// Side-effect import to trigger adapter self-registration
import '../channels/feishu/adapter.js';

import type { LLMProvider } from '../runtime/contracts.js';
import { CODELARK_HOME } from '../configuration/paths.js';
import { createConfigService } from '../configuration/service.js';
import { JsonFileStore } from '../storage/json-store.js';
import { PendingPermissions } from '../runtime/permission-gateway.js';
import type { CodexProviderChoice } from '../runtime/codex/routing-provider.js';
import { setupLogger } from '../shared/logger.js';
import { releaseBridgeInstanceLock, tryAcquireBridgeInstanceLock } from '../local-service/instance-lock.js';
import { runStartupStorageMigrations } from '../storage/migrations.js';

const RUNTIME_DIR = path.join(CODELARK_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');
const LOG_PREFIX = '[CodeLark]';
const PROXY_ENV_KEYS = [
  'NODE_OPTIONS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'WSS_PROXY',
  'WS_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
  'wss_proxy',
  'ws_proxy',
];

async function resolveProvider(
  pendingPerms: PendingPermissions,
  defaultProvider?: CodexProviderChoice,
): Promise<LLMProvider> {
  const { CodexRoutingProvider } = await import('../runtime/codex/routing-provider.js');
  return new CodexRoutingProvider(pendingPerms, defaultProvider);
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  adapters?: ReturnType<typeof bridgeManager.getStatus>['adapters'];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Merge with existing status to preserve fields like lastExitReason
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

function getRunningChannels(): string[] {
  return bridgeManager.getStatus().adapters.map((adapter) => adapter.channelType).sort();
}

function getAdapterStatuses(): ReturnType<typeof bridgeManager.getStatus>['adapters'] {
  return bridgeManager.getStatus().adapters;
}

function maskEnvValue(key: string, value: string): string {
  if (!value) return '<empty>';
  if (!key.toLowerCase().includes('proxy')) return value;
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<set>';
  }
}

function formatProxyEnvSnapshot(env: NodeJS.ProcessEnv = process.env): string {
  const parts = PROXY_ENV_KEYS
    .filter((key) => env[key] !== undefined)
    .map((key) => `${key}=${maskEnvValue(key, env[key] || '')}`);
  return parts.length > 0 ? parts.join(', ') : '<none>';
}

async function main(): Promise<void> {
  const lockState = tryAcquireBridgeInstanceLock();
  if (!lockState.acquired) {
    const holderPid = lockState.holderPid;
    writeStatus({
      running: true,
      ...(Number.isFinite(holderPid) && holderPid ? { pid: holderPid } : {}),
    });
    console.log(
      `${LOG_PREFIX} Another bridge daemon is already running${holderPid ? ` (PID: ${holderPid})` : ''}. Exiting duplicate launcher.`,
    );
    process.exit(0);
  }

  let instanceLockHeld = true;
  const releaseInstanceLock = () => {
    if (!instanceLockHeld) return;
    releaseBridgeInstanceLock(undefined, process.pid);
    instanceLockHeld = false;
  };

  runStartupStorageMigrations();
  const configService = createConfigService({ codelarkHome: CODELARK_HOME });
  const config = configService.snapshot().config;
  const settings = configService.projectRuntimeSettings(config);
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`${LOG_PREFIX} Starting bridge (run_id: ${runId})`);
  console.log(`${LOG_PREFIX} Proxy env snapshot: ${formatProxyEnvSnapshot()}`);

  const store = new JsonFileStore(settings, { dynamicSettings: true });
  const pendingPerms = new PendingPermissions();
  const defaultCodexProvider = config.runtime.codex.provider || undefined;
  const llm = await resolveProvider(pendingPerms, defaultCodexProvider as CodexProviderChoice | undefined);
  console.log(`${LOG_PREFIX} Runtime: ${config.runtime.agent}`);
  console.log(`${LOG_PREFIX} Default Codex provider: ${defaultCodexProvider || 'auto'}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        // Write authoritative PID from the actual process (not shell $!)
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        const channels = getRunningChannels();
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels,
          adapters: getAdapterStatuses(),
        });
        console.log(`${LOG_PREFIX} Bridge started (PID: ${process.pid}, channels: ${channels.join(', ')})`);
      },
      onBridgeAdaptersChanged: (channels) => {
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          channels,
          adapters: getAdapterStatuses(),
        });
        console.log(`${LOG_PREFIX} Active channels updated: ${channels.join(', ') || 'none'}`);
      },
      onBridgeStop: () => {
        releaseInstanceLock();
        writeStatus({ running: false, channels: [], adapters: [] });
        console.log(`${LOG_PREFIX} Bridge stopped`);
      },
    },
  });

  await bridgeManager.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`${LOG_PREFIX} Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await bridgeManager.stop();
    releaseInstanceLock();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error(`${LOG_PREFIX} unhandledRejection:`, reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error(`${LOG_PREFIX} uncaughtException:`, err.stack || err.message);
    releaseInstanceLock();
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`${LOG_PREFIX} beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    releaseInstanceLock();
    console.log(`${LOG_PREFIX} exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal error:`, err instanceof Error ? err.stack || err.message : err);
  releaseBridgeInstanceLock(undefined, process.pid);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
