/**
 * Detached Persistent ACP Host Daemon.
 *
 * Hosts live `cursor-agent acp` and `doubao acp serve` child processes across
 * CodeLark bridge restarts and hot updates so active ACP turns never get killed
 * and can be re-attached seamlessly with exact event sequence replay.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CODELARK_HOME } from '../configuration/paths.js';
import { acpHostEndpoint, acpHostStateFile } from '../runtime/acp/host-protocol.js';
import { startAcpHostServer } from '../runtime/acp/host-server.js';
import { applyStandardLarkCliEnv } from '../shared/lark-cli-env.js';

function writeHostState(filePath: string, payload: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {
    // Best effort metadata file.
  }
}

function removeHostState(filePath: string): void {
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { pid?: number };
    if (existing.pid === process.pid) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

async function main(): Promise<void> {
  applyStandardLarkCliEnv();
  // Never die when the launching bridge or terminal exits.
  process.on('SIGHUP', () => {});

  const home = process.env.CODELARK_HOME || CODELARK_HOME;
  const socketPath = process.env.CODELARK_ACP_HOST_SOCKET?.trim() || acpHostEndpoint(home);
  const codeHash = process.env.CODELARK_ACP_HOST_CODE_HASH?.trim() || 'dev';
  const statePath = acpHostStateFile(home);

  let exiting = false;
  const server = await startAcpHostServer({
    socketPath,
    codeHash,
    onShutdownRequested: () => {
      removeHostState(statePath);
      process.exit(0);
    },
  });

  writeHostState(statePath, {
    pid: process.pid,
    socketPath: server.socketPath,
    codeHash,
    startedAt: new Date(server.startedAt).toISOString(),
  });

  const handleSignal = (signal: string) => {
    if (exiting) return;
    exiting = true;
    void server.close(true).finally(() => {
      removeHostState(statePath);
      process.exit(signal === 'SIGINT' ? 130 : 0);
    });
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('uncaughtException', (error) => {
    console.error('[acp-host] Uncaught exception:', error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[acp-host] Unhandled rejection:', reason);
  });
}

main().catch((error) => {
  console.error('[acp-host] Fatal startup error:', error);
  process.exit(1);
});
