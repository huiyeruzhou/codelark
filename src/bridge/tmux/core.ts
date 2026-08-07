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

export interface TmuxSendActionsOptions {
  delayMs?: number;
  forcePasteLiterals?: boolean;
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
  sendActions(target: string, actions: TmuxSendAction[], options?: TmuxSendActionsOptions): Promise<TmuxSendActionsResult>;
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

function tmuxCommandPreview(
  args: readonly string[],
  executable = 'tmux',
  prefixArgs: readonly string[] = [],
): string {
  return [executable, ...prefixArgs, ...args].map(quoteShellArg).join(' ');
}

const TMUX_VERSION_MISMATCH_PATTERN = /(?:server|client) version is too old for (?:client|server)/i;
const TMUX_MISSING_SESSION_PATTERN = /can't find session|no server running|failed to connect to server|error connecting to .*\(no such file or directory\)/i;

function commandErrorText(result: TmuxCommandResult, fallback: string): string {
  return (result.stderr || result.stdout || fallback).trim();
}

export function isTmuxVersionMismatchError(value: string): boolean {
  return TMUX_VERSION_MISMATCH_PATTERN.test(value);
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
const PASTE_BUFFER_RETRY_COUNT = 2;
const PASTE_BUFFER_RETRY_DELAY_MS = 100;
const WINDOWS_LITERAL_CHUNK_SIZE = 64;
const WINDOWS_LITERAL_CHUNK_DELAY_MS = 25;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const SESSION_START_SURVIVAL_DELAY_MS = 50;
const SESSION_START_RETRY_DELAY_MS = 100;

export function usesChunkedTmuxLiteralInput(platform = process.platform): boolean {
  return platform === 'win32';
}

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
  private executable: string;
  private readonly prefixArgs: string[];
  private readonly autoSelectExecutable: boolean;
  private readonly genericCommandPreview: boolean;
  private readonly candidateExecutables: string[] | undefined;
  private readonly chunkedLiteralInput: boolean;
  private executableResolution: Promise<string> | undefined;

  constructor(
    executable?: string,
    prefixArgs: string[] = [],
    candidateExecutables?: string[],
    chunkedLiteralInput = usesChunkedTmuxLiteralInput(),
  ) {
    const configuredExecutable = process.env.CODELARK_TMUX_EXECUTABLE?.trim();
    this.executable = executable || configuredExecutable || 'tmux';
    this.prefixArgs = prefixArgs;
    this.autoSelectExecutable = !executable && !configuredExecutable && prefixArgs.length === 0;
    this.genericCommandPreview = Boolean(executable || prefixArgs.length > 0);
    this.candidateExecutables = candidateExecutables;
    this.chunkedLiteralInput = chunkedLiteralInput;
  }

  private async resolveExecutable(): Promise<string> {
    if (!this.autoSelectExecutable) return this.executable;
    if (this.executableResolution) return this.executableResolution;
    this.executableResolution = this.selectCompatibleExecutable();
    return this.executableResolution;
  }

  private async selectCompatibleExecutable(): Promise<string> {
    const candidates = [...new Set(this.candidateExecutables || [
      this.executable,
      '/usr/local/bin/tmux',
      '/usr/bin/tmux',
      '/bin/tmux',
    ])];
    const incompatibilities: Array<{ executable: string; error: string }> = [];
    const unavailable: Array<{ executable: string; error: string }> = [];
    for (const candidate of candidates) {
      try {
        const panes = await runCommand(candidate, ['list-panes', '-a', '-F', '#{pane_id}']);
        const panesOutput = `${panes.stderr}\n${panes.stdout}`.trim();
        if (isTmuxVersionMismatchError(panesOutput)) {
          incompatibilities.push({ executable: candidate, error: panesOutput });
          continue;
        }
        const paneTarget = panes.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        if (paneTarget) {
          // Some tmux client/server combinations return exit code 0 for capture-pane
          // while reporting their version mismatch only on stderr. Probe the exact
          // operation CodeLark relies on and inspect both streams regardless of code.
          const capture = await runCommand(candidate, ['capture-pane', '-p', '-S', '0', '-t', paneTarget]);
          const captureOutput = `${capture.stderr}\n${capture.stdout}`.trim();
          if (isTmuxVersionMismatchError(captureOutput)) {
            incompatibilities.push({ executable: candidate, error: captureOutput });
            continue;
          }
        }
        this.executable = candidate;
        if (incompatibilities.length > 0) {
          console.warn('[tmux-core] Selected a compatible tmux client for the existing server:', {
            event: 'tmux.client.compatibility_fallback',
            selected_executable: candidate,
            incompatible_clients: incompatibilities,
          });
        }
        return candidate;
      } catch (error) {
        unavailable.push({ executable: candidate, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (incompatibilities.length > 0) {
      const details = incompatibilities
        .map((item) => `${item.executable}: ${item.error}`)
        .join('; ');
      throw new Error(
        `tmux client/server version mismatch: no compatible tmux executable was found. Tried ${details}`,
      );
    }
    const details = unavailable.map((item) => `${item.executable}: ${item.error}`).join('; ');
    throw new Error(`tmux executable was not found or could not be started. Tried ${details}`);
  }

  private async runCommand(args: string[], stdin?: string): Promise<TmuxCommandResult> {
    const executable = await this.resolveExecutable();
    const result = await runCommand(executable, [...this.prefixArgs, ...args], stdin);
    const output = `${result.stderr}\n${result.stdout}`.trim();
    if (isTmuxVersionMismatchError(output)) throw new Error(output);
    return result;
  }

  private async runTmux(args: string[], stdin?: string): Promise<TmuxCommandResult> {
    const result = await this.runCommand(args, stdin);
    if (result.code !== 0) {
      throw new Error((result.stderr || result.stdout || `tmux ${args[0] || ''} failed`).trim());
    }
    return result;
  }

  commandPreview(args: readonly string[]): string {
    return this.command(args);
  }

  private command(args: readonly string[]): string {
    return this.genericCommandPreview
      ? tmuxCommandPreview(args)
      : tmuxCommandPreview(args, this.executable, this.prefixArgs);
  }

  async ensureExtendedKeys(): Promise<string> {
    const args: TmuxArgv = ['set-option', '-g', 'extended-keys', 'on'];
    const result = await this.runCommand(args);
    const command = this.command(args);
    if (result.code === 0) return command;
    const error = commandErrorText(result, 'tmux set-option failed');
    if (/invalid option:\s*extended-keys/i.test(error)) {
      console.warn('[tmux-core] tmux does not support extended-keys; continuing without it:', {
        event: 'tmux.extended_keys.unsupported',
        command,
        error,
      });
      return '';
    }
    throw new Error(error);
  }

  async hasSession(name: string): Promise<TmuxSessionExistsResult> {
    const args: TmuxArgv = ['has-session', '-t', name];
    const result = await this.runCommand(args);
    const command = this.command(args);
    if (result.code === 0) return { exists: true, command };
    const error = commandErrorText(result, 'tmux has-session failed');
    if (!result.stderr.trim() && !result.stdout.trim()) return { exists: false, command };
    if (TMUX_MISSING_SESSION_PATTERN.test(error)) return { exists: false, command };
    throw new Error(error);
  }

  async killSession(name: string, options: { ignoreMissing?: boolean } = {}): Promise<string> {
    const args: TmuxArgv = ['kill-session', '-t', name];
    const result = await this.runCommand(args);
    if (result.code !== 0 && !(options.ignoreMissing && /can't find session/i.test(result.stderr))) {
      throw new Error((result.stderr || result.stdout || 'tmux kill-session failed').trim());
    }
    return this.command(args);
  }

  async listSessions(): Promise<TmuxListSessionsResult> {
    const args: TmuxArgv = [
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}',
    ];
    const result = await this.runCommand(args);
    if (result.code !== 0) {
      if (TMUX_MISSING_SESSION_PATTERN.test(result.stderr || result.stdout)) {
        return { sessions: [], command: this.command(args) };
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
    return { sessions, command: this.command(args) };
  }

  async ensureDetachedSession(params: TmuxStartDetachedSessionParams): Promise<TmuxEnsureSessionResult> {
    const exists = await this.hasSession(params.name);
    const commands = [exists.command];
    if (exists.exists && params.recreate) {
      commands.push(await this.killSession(params.name));
    }
    if (!exists.exists || params.recreate) {
      const args = buildNewSessionArgs(params);
      const command = this.command(args);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await this.runTmux(args);
        commands.push(command);
        await sleep(SESSION_START_SURVIVAL_DELAY_MS);
        const survived = await this.hasSession(params.name);
        commands.push(survived.command);
        if (survived.exists) return { existed: exists.exists, command, commands };
        if (attempt === 0) await sleep(SESSION_START_RETRY_DELAY_MS);
      }
      // Runtime-specific readiness checks own the final diagnostic when the
      // launched process genuinely exits. Returning here preserves their
      // detailed error cards while still repairing the server-shutdown race.
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
      command: [this.command(heightArgs), this.command(args)].join('\n'),
    };
  }

  async sendActions(
    target: string,
    actions: TmuxSendAction[],
    options: TmuxSendActionsOptions = {},
  ): Promise<TmuxSendActionsResult> {
    const commands: string[] = [];
    for (const [index, action] of actions.entries()) {
      if (
        action.type === 'literal'
        && (options.forcePasteLiterals === true || Array.from(action.text).length > PASTE_LITERAL_THRESHOLD)
      ) {
        commands.push(...(this.chunkedLiteralInput
          ? await this.sendChunkedLiteralInput(target, action.text)
          : await this.pasteLiteralChunks(target, action.text)));
      } else {
        const args = tmuxSendActionArgv(target, action);
        await this.runTmux(args);
        commands.push(this.command(args));
      }
      if (options.delayMs !== undefined && index < actions.length - 1) {
        await sleep(options.delayMs);
      }
    }
    return { commands };
  }

  private async sendChunkedLiteralInput(target: string, text: string): Promise<string[]> {
    const commands: string[] = [];
    const bracketLeadingSlash = text.startsWith('/');
    if (bracketLeadingSlash) {
      const startArgs = tmuxSendActionArgv(target, { type: 'literal', text: BRACKETED_PASTE_START });
      await this.runTmux(startArgs);
      commands.push(this.command(startArgs));
    }
    const lines = text.replace(/\r\n?/gu, '\n').split('\n');
    for (const [lineIndex, line] of lines.entries()) {
      for (const chunk of splitTextChunks(line, WINDOWS_LITERAL_CHUNK_SIZE)) {
        const args = tmuxSendActionArgv(target, { type: 'literal', text: chunk });
        await this.runTmux(args);
        commands.push(this.command(args));
        await sleep(WINDOWS_LITERAL_CHUNK_DELAY_MS);
      }
      if (lineIndex < lines.length - 1) {
        const newlineArgs: TmuxArgv = ['send-keys', '-t', target, 'M-Enter'];
        await this.runTmux(newlineArgs);
        commands.push(this.command(newlineArgs));
        await sleep(WINDOWS_LITERAL_CHUNK_DELAY_MS);
      }
    }
    if (bracketLeadingSlash) {
      const endArgs = tmuxSendActionArgv(target, { type: 'literal', text: BRACKETED_PASTE_END });
      await this.runTmux(endArgs);
      commands.push(this.command(endArgs));
    }
    return commands;
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
        commands.push(this.command(leadingArgs));
      }
      if (chunk) {
        const loadArgs: TmuxArgv = ['load-buffer', '-b', name, '-'];
        const pasteArgs: TmuxArgv = ['paste-buffer', '-d', '-p', '-b', name, '-t', target];
        for (let attempt = 0; ; attempt += 1) {
          await this.runTmux(loadArgs, chunk);
          commands.push(this.command(loadArgs));
          if (attempt > 0) {
            await sleep(PASTE_BUFFER_RETRY_DELAY_MS * attempt);
          }
          try {
            await this.runTmux(pasteArgs);
            commands.push(this.command(pasteArgs));
            break;
          } catch (error) {
            if (
              !/\bno buffer\b/i.test(String(error))
              || attempt >= PASTE_BUFFER_RETRY_COUNT
            ) {
              throw error;
            }
          }
        }
      }
      const endArgs: TmuxArgv = ['send-keys', '-t', target, 'End'];
      await this.runTmux(endArgs);
      commands.push(this.command(endArgs));
      await sleep(PASTE_CHUNK_DELAY_MS);
    }
    return commands;
  }

  async sendInterrupt(target: string): Promise<string> {
    const result = await this.sendActions(target, [{ type: 'key', key: 'C-c' }]);
    return result.commands[0] || this.command(['send-keys', '-t', target, 'C-c']);
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
          commands.push(this.command(loadArgs));
          const pasteArgs: TmuxArgv = ['paste-buffer', '-d', '-p', '-b', bufferName, '-t', targetPane];
          await this.runTmux(pasteArgs);
          commands.push(this.command(pasteArgs));
          // tmux returning only guarantees delivery to the pane, not that a
          // slower TUI has consumed the bracketed-paste end marker. Reuse the
          // long-prompt settle delay before a following Enter, especially for
          // Windows psmux/ConPTY where an immediate submit can be swallowed.
          await sleep(PASTE_CHUNK_DELAY_MS);
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

export function createTmuxCliCore(options: {
  executable?: string;
  prefixArgs?: string[];
  /** Test hook for exercising client/server compatibility fallback. */
  candidateExecutables?: string[];
  /** Test hook for exercising Windows psmux chunked literal input. */
  chunkedLiteralInput?: boolean;
} = {}): TmuxCore {
  return new TmuxCliCore(
    options.executable,
    options.prefixArgs,
    options.candidateExecutables,
    options.chunkedLiteralInput,
  );
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
