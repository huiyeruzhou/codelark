import type { CodexReasoningEffort } from '../../runtime/options.js';
import type { RuntimeProviderChoice } from '../../domain/session.js';
import { isRuntimeProviderChoice } from '../../domain/session-runtime.js';

export const MODE_OPTIONS_TEXT = '可选：`normal`（普通执行，默认） `yolo`（YOLO模式：允许 agent 无需审批绕过沙箱）。';
export const RUNTIME_OPTIONS_TEXT = '可选：`codex`（OpenAI Codex，默认） `claude`（Claude Code） `kimi`（Kimi Code） `cursor`（Cursor Agent）。`/provider` 选择使用何种方式运行 agent，不切换 runtime。';
export const CODEX_PROVIDER_OPTIONS_TEXT = '可选：`sdk`（默认 SDK 路径） `pty`（跨平台 Codex TUI 路径） `tmux`（可 attach 的 Codex TUI/tmux 路径）';
export const CLAUDE_PROVIDER_OPTIONS_TEXT = '可选：`tmux`（可 attach 的 Claude Code TUI/tmux 路径，默认） `pty`（Claude Code TUI/mirror 路径） `sdk`（Claude Agent SDK 原生事件路径）';
export const REASONING_OPTIONS_TEXT = '可选：`1=minimal` `2=low` `3=medium` `4=high` `5=xhigh` `6=max` `7=ultra`';
export const SANDBOX_OPTIONS_TEXT = '可选：`read-only` `workspace-write` `danger-full-access` `default`（回到全局默认）';
export const NETWORK_OPTIONS_TEXT = '可选：`on`/`true` 开启网络，`off`/`false` 关闭网络，`default` 回到全局默认。';
export const UI_DETAIL_OPTIONS_TEXT = '可选：`on` 显示工具输入输出，`off` 只显示工具名、状态和正文；兼容 `/ui detail on|off`。';
export const CLAUDE_PTY_RUNTIME_UPDATE_NOTE = '已保存为当前 BridgeSession 的 Claude Code 启动配置；如果 Claude Code TUI 已经启动，不会向运行中的 TUI 注入切换命令，下一条普通消息会按新参数启动或重启 Claude Code TUI。';

function parseUiDetailArg(raw: string): boolean | null {
  const token = raw.trim().toLowerCase();
  if (!token) return null;
  if (token === 'on' || token === 'true' || token === '1' || token === 'yes' || token === 'detail' || token === 'details' || token === 'verbose') {
    return true;
  }
  if (token === 'off' || token === 'false' || token === '0' || token === 'no' || token === 'compact' || token === 'brief') {
    return false;
  }
  return null;
}

export function formatUiDetailMode(enabled: boolean): string {
  return enabled ? '显示工具输入输出' : '只显示工具名、状态和正文';
}

export function codexReasoningToClaudeEffort(
  reasoning: CodexReasoningEffort,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (reasoning === 'minimal') return 'low';
  if (reasoning === 'ultra') return 'max';
  return reasoning;
}

export function parseUiArgs(raw: string): { action: 'show' } | { action: 'set-details'; enabled: boolean } | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { action: 'show' };

  // Compatibility for the short-lived /tools on|off command: /tools resolves
  // here with only the on/off token as args.
  if (parts.length === 1) {
    const direct = parseUiDetailArg(parts[0]);
    if (direct !== null) return { action: 'set-details', enabled: direct };
  }

  const topic = parts[0]?.toLowerCase();
  if (
    topic === 'detail'
    || topic === 'details'
    || topic === 'tool'
    || topic === 'tools'
    || topic === 'sdk'
  ) {
    const enabled = parseUiDetailArg(parts.slice(1).join(' '));
    return enabled === null ? null : { action: 'set-details', enabled };
  }

  return null;
}

export function parseNetworkAccessArg(raw: string): boolean | 'default' | null {
  const token = raw.trim().toLowerCase();
  if (!token) return null;
  if (token === 'default') return 'default';
  if (token === 'on' || token === 'true' || token === '1') {
    return true;
  }
  if (token === 'off' || token === 'false' || token === '0') {
    return false;
  }
  return null;
}

export function formatNetworkAccess(enabled: boolean): string {
  return enabled ? 'enabled' : 'disabled';
}

export function parseRuntimeProviderArg(raw: string): RuntimeProviderChoice | null {
  const token = raw.trim().toLowerCase();
  return isRuntimeProviderChoice(token) ? token : null;
}

export const parseCodexProviderArg = parseRuntimeProviderArg;
export const parseClaudeProviderArg = parseRuntimeProviderArg;

export function formatTmuxProviderUnavailable(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/ENOENT|not found|cannot find|没有找到/i.test(message)) return null;
  return process.platform === 'win32'
    ? '没有找到 tmux 兼容命令。Windows 上请安装 psmux 并确认兼容的 `tmux` 命令在 PATH 中；也可以先使用 `/provider pty`。'
    : '没有找到 `tmux` 命令。请先安装 tmux 并确认它在 PATH 中；也可以先使用 `/provider pty`。';
}
