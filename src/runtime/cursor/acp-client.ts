import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpClient, AcpRpcError, type AcpMessage } from '../acp/client.js';

export type CursorAcpMessage = AcpMessage;

export interface CursorAcpClientOptions {
  executable?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export class CursorAcpRpcError extends AcpRpcError {
  constructor(code: number, message: string, data?: unknown) {
    super(code, message, data, 'Cursor ACP');
  }
}

export function resolveCursorAcpExecutable(): string {
  const configured = process.env.CURSOR_AGENT_EXECUTABLE || process.env.CODELARK_CURSOR_EXECUTABLE;
  if (configured?.trim()) return configured.trim();
  const local = path.join(os.homedir(), '.local', 'bin', 'agent');
  return fs.existsSync(local) ? local : 'agent';
}

/** This client owns only the process it starts. It never attaches to or signals a TUI. */
export class CursorAcpClient extends AcpClient {
  static override async start(options: CursorAcpClientOptions): Promise<CursorAcpClient> {
    return await AcpClient.start({
      executable: options.executable || resolveCursorAcpExecutable(),
      args: options.args || ['acp'],
      cwd: options.cwd,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs,
      label: 'Cursor ACP',
    }, (code, message, data) => new CursorAcpRpcError(code, message, data)) as CursorAcpClient;
  }
}
