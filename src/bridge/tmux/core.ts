import { spawn } from 'node:child_process';

export interface TmuxCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TmuxSessionInfo {
  name: string;
  windows: string;
  attached: string;
  created: string;
  activity: string;
}

export type TmuxArgv = [string, ...string[]];

export type TmuxSendAction =
  | { type: 'literal'; text: string }
  | { type: 'key'; key: string };

export interface TmuxSessionExistsResult {
  exists: boolean;
  command: string;
}

export interface TmuxListSessionsResult {
  sessions: TmuxSessionInfo[];
  command: string;
}

export interface TmuxCapturePaneResult {
  screen: string;
  command: string;
}

export interface TmuxSendActionsResult {
  commands: string[];
}

export interface TmuxEnsureSessionResult {
  existed: boolean;
  command?: string;
  commands: string[];
}

export interface TmuxStartDetachedSessionParams {
  name: string;
  cwd?: string;
  command?: string | string[];
  recreate?: boolean;
}

export interface TmuxCore {
  hasSession(name: string): Promise<TmuxSessionExistsResult>;
  killSession(name: string, options?: { ignoreMissing?: boolean }): Promise<string>;
  listSessions(): Promise<TmuxListSessionsResult>;
  ensureDetachedSession(params: TmuxStartDetachedSessionParams): Promise<TmuxEnsureSessionResult>;
  capturePane(target: string, lines: number): Promise<TmuxCapturePaneResult>;
  sendActions(target: string, actions: TmuxSendAction[], options?: { delayMs?: number }): Promise<TmuxSendActionsResult>;
  sendInterrupt(target: string): Promise<string>;
  injectPromptIntoPane(targetPane: string, prompt: string): Promise<TmuxSendActionsResult>;
  /** Enable tmux's extended key protocol for TUIs that distinguish Enter from newline. */
  ensureExtendedKeys?(): Promise<string>;
  commandPreview(args: readonly string[]): string;
}

function quoteShellArg(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function tmuxCommandPreview(args: readonly string[]): string {
  return ['tmux', ...args].map(quoteShellArg).join(' ');
}

function captureTmuxArgv(target: string, lines: number): TmuxArgv {
  return ['capture-pane', '-t', target, '-p', '-S', lines === 0 ? '0' : `-${lines}`];
}

function paneHeightTmuxArgv(target: string): TmuxArgv {
  return ['display-message', '-p', '-t', target, '#{pane_height}'];
}

function parsePaneHeight(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function captureStartOffset(lines: number, paneHeight: number): number {
  return Math.max(lines - paneHeight, 0);
}

function trimCapturedScreen(screen: string, lines: number): string {
  const trimmed = screen.replace(/\s+$/g, '');
  if (!trimmed) return '';
  return trimmed.split(/\r?\n/).slice(-lines).join('\n');
}

function buildNewSessionArgs(params: TmuxStartDetachedSessionParams): string[] {
  const args: string[] = ['new-session', '-d', '-s', params.name];
  if (params.cwd) args.push('-c', params.cwd);
  if (params.command) {
    args.push('--', ...(Array.isArray(params.command) ? params.command : [params.command]));
  }
  return args;
}

function runCommand(command: string, args: string[], stdin?: string): Promise<TmuxCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

function tmuxSendActionArgv(target: string, action: TmuxSendAction): TmuxArgv {
  if (action.type === 'literal') {
    if (action.text.startsWith('-')) {
      return ['send-keys', '-t', target, '-l', '--', action.text];
    }
    return ['send-keys', '-t', target, '-l', action.text];
  }
  return ['send-keys', '-t', target, action.key];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PASTE_LITERAL_THRESHOLD = 512;
const PASTE_CHUNK_SIZE = 512;
const PASTE_CHUNK_DELAY_MS = 75;

function splitTextChunks(text: string, chunkSize = PASTE_CHUNK_SIZE): string[] {
  if (!text) return [];
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < chars.length; offset += chunkSize) {
    chunks.push(chars.slice(offset, offset + chunkSize).join(''));
  }
  return chunks;
}

class TmuxCliCore implements TmuxCore {
  constructor(
    private readonly executable = 'tmux',
    private readonly prefixArgs: string[] = [],
  ) {}

  private runCommand(args: string[], stdin?: string): Promise<TmuxCommandResult> {
    return runCommand(this.executable, [...this.prefixArgs, ...args], stdin);
  }

  private async runTmux(args: string[], stdin?: string): Promise<TmuxCommandResult> {
    const result = await this.runCommand(args, stdin);
    if (result.code !== 0) {
      throw new Error((result.stderr || result.stdout || `tmux ${args[0] || ''} failed`).trim());
    }
    return result;
  }

  commandPreview(args: readonly string[]): string {
    return tmuxCommandPreview(args);
  }

  async ensureExtendedKeys(): Promise<string> {
    const args: TmuxArgv = ['set-option', '-g', 'extended-keys', 'on'];
    await this.runTmux(args);
    return tmuxCommandPreview(args);
  }

  async hasSession(name: string): Promise<TmuxSessionExistsResult> {
    const args: TmuxArgv = ['has-session', '-t', name];
    const result = await this.runCommand(args);
    return { exists: result.code === 0, command: tmuxCommandPreview(args) };
  }

  async killSession(name: string, options: { ignoreMissing?: boolean } = {}): Promise<string> {
    const args: TmuxArgv = ['kill-session', '-t', name];
    const result = await this.runCommand(args);
    if (result.code !== 0 && !(options.ignoreMissing && /can't find session/i.test(result.stderr))) {
      throw new Error((result.stderr || result.stdout || 'tmux kill-session failed').trim());
    }
    return tmuxCommandPreview(args);
  }

  async listSessions(): Promise<TmuxListSessionsResult> {
    const args: TmuxArgv = [
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}',
    ];
    const result = await this.runCommand(args);
    if (result.code !== 0) {
      if (/no server running|failed to connect/i.test(result.stderr || result.stdout)) {
        return { sessions: [], command: tmuxCommandPreview(args) };
      }
      throw new Error((result.stderr || result.stdout || 'tmux list-sessions failed').trim());
    }
    const sessions = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name = '', windows = '', attached = '', created = '', activity = ''] = line.split('\t');
        return { name, windows, attached, created, activity };
      })
      .filter((session) => session.name);
    return { sessions, command: tmuxCommandPreview(args) };
  }

  async ensureDetachedSession(params: TmuxStartDetachedSessionParams): Promise<TmuxEnsureSessionResult> {
    const exists = await this.hasSession(params.name);
    const commands = [exists.command];
    if (exists.exists && params.recreate) {
      commands.push(await this.killSession(params.name));
    }
    if (!exists.exists || params.recreate) {
      const args = buildNewSessionArgs(params);
      await this.runTmux(args);
      const command = tmuxCommandPreview(args);
      commands.push(command);
      return { existed: exists.exists, command, commands };
    }
    return { existed: exists.exists, commands };
  }

  async capturePane(target: string, lines: number): Promise<TmuxCapturePaneResult> {
    const heightArgs = paneHeightTmuxArgv(target);
    const heightResult = await this.runTmux(heightArgs);
    const startOffset = captureStartOffset(lines, parsePaneHeight(heightResult.stdout));
    const args = captureTmuxArgv(target, startOffset);
    const result = await this.runTmux(args);
    return {
      screen: trimCapturedScreen(result.stdout, lines),
      command: [tmuxCommandPreview(heightArgs), tmuxCommandPreview(args)].join('\n'),
    };
  }

  async sendActions(
    target: string,
    actions: TmuxSendAction[],
    options: { delayMs?: number } = {},
  ): Promise<TmuxSendActionsResult> {
    const commands: string[] = [];
    for (const [index, action] of actions.entries()) {
      if (action.type === 'literal' && Array.from(action.text).length > PASTE_LITERAL_THRESHOLD) {
        commands.push(...(await this.pasteLiteralChunks(target, action.text)));
      } else {
        const args = tmuxSendActionArgv(target, action);
        await this.runTmux(args);
        commands.push(tmuxCommandPreview(args));
      }
      if (options.delayMs !== undefined && index < actions.length - 1) {
        await sleep(options.delayMs);
      }
    }
    return { commands };
  }

  private async pasteLiteralChunks(target: string, text: string, bufferName?: string): Promise<string[]> {
    const commands: string[] = [];
    const name = bufferName || `clk-paste-${process.pid}-${Date.now()}`;
    for (const rawChunk of splitTextChunks(text)) {
      const leadingWhitespace = rawChunk.match(/^\s+/u)?.[0] || '';
      const chunk = rawChunk.slice(leadingWhitespace.length);
      if (leadingWhitespace) {
        const leadingArgs: TmuxArgv = ['send-keys', '-t', target, '-l', leadingWhitespace];
        await this.runTmux(leadingArgs);
        commands.push(tmuxCommandPreview(leadingArgs));
      }
      if (chunk) {
        const loadArgs: TmuxArgv = ['load-buffer', '-b', name, '-'];
        await this.runTmux(loadArgs, chunk);
        commands.push(tmuxCommandPreview(loadArgs));
        const pasteArgs: TmuxArgv = ['paste-buffer', '-d', '-p', '-b', name, '-t', target];
        await this.runTmux(pasteArgs);
        commands.push(tmuxCommandPreview(pasteArgs));
      }
      const endArgs: TmuxArgv = ['send-keys', '-t', target, 'End'];
      await this.runTmux(endArgs);
      commands.push(tmuxCommandPreview(endArgs));
      await sleep(PASTE_CHUNK_DELAY_MS);
    }
    return commands;
  }

  async sendInterrupt(target: string): Promise<string> {
    const result = await this.sendActions(target, [{ type: 'key', key: 'C-c' }]);
    return result.commands[0] || tmuxCommandPreview(['send-keys', '-t', target, 'C-c']);
  }

  async injectPromptIntoPane(targetPane: string, prompt: string): Promise<TmuxSendActionsResult> {
    const commands: string[] = [];
    const bufferName = `clk-prompt-${process.pid}-${Date.now()}`;
    const lines = prompt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] || '';
      if (line) {
        if (Array.from(line).length > PASTE_LITERAL_THRESHOLD) {
          commands.push(...(await this.pasteLiteralChunks(targetPane, line, bufferName)));
        } else {
          const loadArgs: TmuxArgv = ['load-buffer', '-b', bufferName, '-'];
          await this.runTmux(loadArgs, line);
          commands.push(tmuxCommandPreview(loadArgs));
          const pasteArgs: TmuxArgv = ['paste-buffer', '-d', '-p', '-b', bufferName, '-t', targetPane];
          await this.runTmux(pasteArgs);
          commands.push(tmuxCommandPreview(pasteArgs));
        }
      }
      if (i < lines.length - 1) {
        const newline = await this.sendActions(targetPane, [{ type: 'key', key: 'M-Enter' }]);
        commands.push(...newline.commands);
      }
    }
    const submit = await this.sendActions(targetPane, [{ type: 'key', key: 'Enter' }]);
    commands.push(...submit.commands);
    return { commands };
  }
}

export function createTmuxCliCore(options: { executable?: string; prefixArgs?: string[] } = {}): TmuxCore {
  return new TmuxCliCore(options.executable, options.prefixArgs);
}

let activeTmuxCore: TmuxCore = createTmuxCliCore();

export const tmuxCore: TmuxCore = {
  commandPreview: (args) => activeTmuxCore.commandPreview(args),
  ensureExtendedKeys: () => activeTmuxCore.ensureExtendedKeys?.() || Promise.resolve(''),
  hasSession: (name) => activeTmuxCore.hasSession(name),
  killSession: (name, options) => activeTmuxCore.killSession(name, options),
  listSessions: () => activeTmuxCore.listSessions(),
  ensureDetachedSession: (params) => activeTmuxCore.ensureDetachedSession(params),
  capturePane: (target, lines) => activeTmuxCore.capturePane(target, lines),
  sendActions: (target, actions, options) => activeTmuxCore.sendActions(target, actions, options),
  sendInterrupt: (target) => activeTmuxCore.sendInterrupt(target),
  injectPromptIntoPane: (targetPane, prompt) => activeTmuxCore.injectPromptIntoPane(targetPane, prompt),
};

export const _testOnlyTmuxCore = {
  replace(core: TmuxCore): void {
    activeTmuxCore = core;
  },
  reset(): void {
    activeTmuxCore = createTmuxCliCore();
  },
};
