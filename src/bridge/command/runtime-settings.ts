import fs from 'node:fs';

import { isCliOnlyCodexModel, readConfiguredCodexModel } from '../../runtime/codex/models.js';
import {
  parseClaudeReasoningEffort,
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
} from '../../runtime/options.js';
import { createConfigService } from '../../configuration/service.js';
import { parseSandboxMode, type RuntimeSandboxMode } from '../../runtime/options.js';
import * as router from '../session/channel-router.js';
import {
  normalizeReasoningEffort,
} from './aliases.js';
import {
  buildCommandFields,
  formatReasoningEffort,
  minimalReasoningWebSearchWarning,
} from './presentation.js';
import {
  formatDisplayedModel,
  getAvailableModelChoicesText,
  getSelectableCodexModel,
  hasSessionCodexNetworkAccessOverride,
  hasSessionCodexSandboxOverride,
  resolveDisplayedModel,
  resolveClaudeRuntimeConfig,
  resolveEffectiveCodexProvider,
  resolveEffectiveNetworkAccess,
  resolveEffectiveReasoningEffort,
  resolveEffectiveSandboxMode,
  resolveKimiRuntimeConfig,
  resolveCursorRuntimeConfig,
  resolveSessionWorkingDirectoryPath,
} from '../session/support.js';
import type { BridgeSession, BridgeStore } from '../../domain/index.js';
import { parseMode } from '../../shared/security/validators.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeModel,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';
import { getGlobalCodexModel } from '../session/global-config.js';
import type { ChannelChat, InboundMessage } from '../../domain/index.js';
import {
  buildRuntimeSwitchWhileRunningResponse,
  createRuntimeSessionForChat,
  formatSessionCodexProvider,
  formatSessionMode,
  formatSessionRuntimeMode,
  isTuiProviderSession,
  mappedRuntimeSessionId,
  scheduleMirrorSubscriptionsBestEffort,
  resolveLocalCodexThreadId,
  sessionHasActiveRuntimeTurn,
  type RuntimeName,
} from './runtime-session.js';
import type { RuntimeSettingsCommandDeps } from './runtime-bootstrap.js';

export {
  bootstrapCodexThreadLocally,
  bootstrapCodexThreadWithSdk,
  _testOnlyRuntimeSettings,
  type BootstrapCodexThreadParams,
  type RuntimeSettingsCommandDeps,
} from './runtime-bootstrap.js';
export { handleProviderCommand } from './provider-settings.js';
export {
  formatSessionCodexProvider,
  formatSessionClaudeProvider,
  formatSessionMode,
  resolveLocalCodexThreadId,
} from './runtime-session.js';

const MODE_OPTIONS_TEXT = '可选：`normal`（普通执行，默认） `yolo`（YOLO模式：允许 agent 无需审批绕过沙箱）。';
const RUNTIME_OPTIONS_TEXT = '可选：`codex`（OpenAI Codex，默认） `claude`（Claude Code） `kimi`（Kimi Code） `cursor`（Cursor Agent）。`/provider` 选择使用何种方式运行 agent，不切换 runtime。';
const REASONING_OPTIONS_TEXT = '可选：`1=minimal` `2=low` `3=medium` `4=high` `5=xhigh`';
const CLAUDE_REASONING_OPTIONS_TEXT = '可选：`1=low` `2=medium` `3=high` `4=xhigh` `5=max`；`m` 等同于 `max`，`minimal` 会映射为 Claude Code `low`。';
const SANDBOX_OPTIONS_TEXT = '可选：`read-only` `workspace-write` `danger-full-access` `default`（回到全局默认）';
const NETWORK_OPTIONS_TEXT = '可选：`on`/`true` 开启网络，`off`/`false` 关闭网络，`default` 回到全局默认。';
const CLAUDE_PTY_RUNTIME_UPDATE_NOTE = '已保存为当前会话的 Claude Code 启动配置；如果 Claude Code pty 已经启动，不会向运行中的 TUI 注入切换命令，下一条普通消息会按新参数启动或重启 Claude Code pty。';
const CODEX_RUNTIME_UPDATE_NOTE = '修改从下一轮 Codex 请求开始生效；正在运行的任务请先 `/stop` 后重发。';

function codexRuntimeUpdateNotes(
  session: BridgeSession | null | undefined,
  binding?: ChannelChat | null,
  notes: string[] = [],
): string[] {
  const result = [...notes, CODEX_RUNTIME_UPDATE_NOTE];
  if (!isTuiProviderSession(session, binding)) return result;
  const provider = resolveEffectiveCodexProvider(session, binding);
  result.push(
    '当前是 Codex TUI Provider：配置已保存到当前会话，但不会影响已经启动的 Codex TUI 终端。',
    provider === 'tmux'
      ? '请先 `/stop`，再发送 `/p tmux` 重启 Codex TUI；新设置会在重启后的后续请求中生效。'
      : '请先 `/stop`，再发送 `/provider pty` 重启 Codex pty Provider；新设置会在重启后的后续请求中生效。',
  );
  return result;
}

function codexRuntimeUpdateTitle(
  session: BridgeSession | null | undefined,
  binding: ChannelChat | null | undefined,
  baseTitle: string,
): string {
  if (!isTuiProviderSession(session, binding)) return baseTitle;
  const provider = resolveEffectiveCodexProvider(session, binding);
  return `${baseTitle}，请输入/p ${provider}重启生效`;
}

function codexReasoningToClaudeEffort(
  reasoning: CodexReasoningEffort,
): ClaudeReasoningEffort {
  if (reasoning === 'minimal') return 'low';
  return reasoning;
}

function parseClaudeReasoningCommandArg(raw: string): ClaudeReasoningEffort | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'minimal') return 'low';
  return parseClaudeReasoningEffort(normalized);
}

function setSessionCodexReasoningToml(sessionId: string, reasoningEffort: CodexReasoningEffort): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { codex: { reasoningEffort } } },
  );
}

function clearSessionCodexReasoningToml(sessionId: string): void {
  createConfigService({ migrate: false }).unset(
    { kind: 'session', sessionId },
    'runtime.codex.reasoningEffort',
  );
}

function setSessionClaudeReasoningToml(
  sessionId: string,
  reasoningEffort: ClaudeReasoningEffort,
): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { claude: { reasoningEffort } } },
  );
}

function clearSessionClaudeReasoningToml(sessionId: string): void {
  createConfigService({ migrate: false }).unset(
    { kind: 'session', sessionId },
    'runtime.claude.reasoningEffort',
  );
}

function setSessionCodexSandboxToml(sessionId: string, sandboxMode: RuntimeSandboxMode): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { codex: { sandboxMode } } },
  );
}

function clearSessionCodexSandboxToml(sessionId: string): void {
  createConfigService({ migrate: false }).unset(
    { kind: 'session', sessionId },
    'runtime.codex.sandboxMode',
  );
}

function setSessionCodexNetworkAccessToml(sessionId: string, networkAccess: boolean): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { codex: { networkAccess } } },
  );
}

function clearSessionCodexNetworkAccessToml(sessionId: string): void {
  createConfigService({ migrate: false }).unset(
    { kind: 'session', sessionId },
    'runtime.codex.networkAccess',
  );
}

function setSessionCodexYoloModeToml(sessionId: string, mode: 'normal' | 'yolo'): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { codex: { yoloMode: mode === 'yolo' ? 'on' : 'off' } } },
  );
}

function setSessionClaudeYoloModeToml(sessionId: string, mode: 'normal' | 'yolo'): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { claude: { yoloMode: mode === 'yolo' ? 'on' : 'off' } } },
  );
}

function setSessionCodexModelToml(sessionId: string, model: string): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { codex: { model } } },
  );
}

function clearSessionCodexModelToml(sessionId: string): void {
  createConfigService({ migrate: false }).unset(
    { kind: 'session', sessionId },
    'runtime.codex.model',
  );
}

function setSessionClaudeModelToml(sessionId: string, model: string): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { claude: { model } } },
  );
}

function clearSessionClaudeModelToml(sessionId: string): void {
  createConfigService({ migrate: false }).unset(
    { kind: 'session', sessionId },
    'runtime.claude.model',
  );
}

function setSessionKimiModelToml(sessionId: string, model: string): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { kimi: { model } } },
  );
}

function setSessionCursorModelToml(sessionId: string, model: string): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { cursor: { model } } },
  );
}

function clearSessionCursorModelToml(sessionId: string): void {
  createConfigService({ migrate: false }).unset(
    { kind: 'session', sessionId },
    'runtime.cursor.model',
  );
}

function setSessionCursorForceToml(sessionId: string, force: boolean): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { runtime: { cursor: { force } } },
  );
}

function clearSessionKimiModelToml(sessionId: string): void {
  createConfigService({ migrate: false }).unset(
    { kind: 'session', sessionId },
    'runtime.kimi.model',
  );
}

function setSessionWorkspaceToml(sessionId: string, workspace: string): void {
  createConfigService({ migrate: false }).set(
    { kind: 'session', sessionId },
    { session: { workspace } },
  );
}

function parseNetworkAccessArg(raw: string): boolean | 'default' | null {
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

export function handleReasoningCommand(options: {
  args: string;
  binding: ChannelChat | null;
  store: BridgeStore;
  markdown: boolean;
}): string {
  if (!options.binding) {
    return '当前聊天还没有绑定会话。先发送消息创建会话，或先用 `/t 1` 接管本地会话。';
  }
  const session = options.store.getSession(options.binding.bridgeSessionId);
  if (!session) {
    return '当前会话不存在。';
  }
  const activeRuntime = getSessionActiveRuntime(session) || 'codex';
  if (!options.args) {
    if (activeRuntime === 'kimi' || activeRuntime === 'cursor') {
      const label = activeRuntime === 'cursor' ? 'Cursor Agent' : 'Kimi Code';
      return buildCommandFields(
        `${label} 不支持 Bridge 思考级别设置`,
        [['Runtime', activeRuntime]],
        [`${label} 的思考内容来自 CLI 事件；\`/reasoning\` 只适用于 Codex 和 Claude Code runtime。`],
        options.markdown,
      );
    }
    if (activeRuntime === 'claude') {
      const claudeConfig = resolveClaudeRuntimeConfig(session, options.binding);
      return buildCommandFields(
        '当前 Claude Code 思考级别',
        [['级别', claudeConfig.reasoningEffort || 'default']],
        [CLAUDE_REASONING_OPTIONS_TEXT, '发送 `/r max` 或 `/r high` 可保存给后续 Claude Code pty/tmux 启动。'],
        options.markdown,
      );
    }
    return buildCommandFields(
      '当前思考级别',
      [['级别', formatReasoningEffort(resolveEffectiveReasoningEffort(session, options.binding))]],
      [REASONING_OPTIONS_TEXT, '发送 `/r 4` 或 `/r high` 可切换。'],
      options.markdown,
    );
  }
  if (options.args.trim().toLowerCase() === 'default' || options.args.trim().toLowerCase() === 'reset') {
    if (activeRuntime === 'kimi' || activeRuntime === 'cursor') {
      return buildCommandFields(
        `${activeRuntime === 'cursor' ? 'Cursor Agent' : 'Kimi Code'} 不支持 Bridge 思考级别设置`,
        [['Runtime', activeRuntime]],
        ['没有写入 Codex 或 Claude Code reasoning 配置。'],
        options.markdown,
      );
    }
    if (activeRuntime === 'claude') {
      clearSessionClaudeReasoningToml(session.id);
      return buildCommandFields(
        '已恢复默认 Claude Code 思考级别',
        [['级别', 'default']],
        ['后续启动 Claude Code pty 时不再传 `--effort`，使用 Claude Code 默认值。', CLAUDE_PTY_RUNTIME_UPDATE_NOTE],
        options.markdown,
      );
    }
    clearSessionCodexReasoningToml(session.id);
    return buildCommandFields(
      '已恢复默认思考级别',
      [['级别', formatReasoningEffort(resolveEffectiveReasoningEffort(options.store.getSession(session.id)))]],
      ['当前 BridgeSession 已清除 Codex reasoning 覆盖值，后续请求会跟随全局 Codex 默认值。', CODEX_RUNTIME_UPDATE_NOTE],
      options.markdown,
    );
  }
  const reasoning = normalizeReasoningEffort(options.args);
  const claudeReasoning = activeRuntime === 'claude'
    ? parseClaudeReasoningCommandArg(options.args)
    : undefined;
  if (activeRuntime === 'kimi' || activeRuntime === 'cursor') {
    return buildCommandFields(
      `${activeRuntime === 'cursor' ? 'Cursor Agent' : 'Kimi Code'} 不支持 Bridge 思考级别设置`,
      [['Runtime', activeRuntime]],
      ['没有写入 Codex 或 Claude Code reasoning 配置。'],
      options.markdown,
    );
  }
  if (!reasoning && !claudeReasoning) {
    return buildCommandFields(
      '思考级别用法',
      [['命令', activeRuntime === 'claude' ? '`/reasoning low|medium|high|xhigh|max|m`' : '`/reasoning minimal|low|medium|high|xhigh`']],
      ['Codex 也支持：`/reasoning 1|2|3|4|5`', activeRuntime === 'claude' ? CLAUDE_REASONING_OPTIONS_TEXT : REASONING_OPTIONS_TEXT],
      options.markdown,
    );
  }
  if (activeRuntime === 'claude') {
    const effort = claudeReasoning || codexReasoningToClaudeEffort(reasoning as CodexReasoningEffort);
    setSessionClaudeReasoningToml(session.id, effort);
    return buildCommandFields(
      '已更新 Claude Code 思考级别',
      [['级别', effort]],
      [`后续启动 Claude Code pty 时会传入 \`--effort ${effort}\`。`, CLAUDE_PTY_RUNTIME_UPDATE_NOTE],
      options.markdown,
    );
  }
  const codexReasoning = reasoning as CodexReasoningEffort;
  setSessionCodexReasoningToml(session.id, codexReasoning);
  const notes = [REASONING_OPTIONS_TEXT];
  const warning = minimalReasoningWebSearchWarning(codexReasoning);
  if (warning) notes.push(warning);
  const updateNotes = codexRuntimeUpdateNotes(session, options.binding, notes);
  return buildCommandFields(
    '已更新思考级别',
    [['级别', formatReasoningEffort(codexReasoning)]],
    updateNotes,
    options.markdown,
  );
}

export function handleModeCommand(options: {
  msg: InboundMessage;
  args: string;
  currentBinding: ChannelChat | null;
  store: BridgeStore;
  markdown: boolean;
}): string {
  const binding = options.currentBinding || router.resolve(options.msg.address);
  const session = options.store.getSession(binding.bridgeSessionId);
  const activeRuntime = getSessionActiveRuntime(session) || 'codex';
  const mode = formatSessionRuntimeMode(binding, session);
  if (activeRuntime === 'kimi') {
    return buildCommandFields(
      'Kimi Code 模式固定',
      [['Runtime', 'kimi'], ['Provider', 'tmux']],
      ['Kimi Code 当前通过 `kimi -y` 的 tmux 路径运行，`/mode` 不会写入 Codex 或 Claude 配置。'],
      options.markdown,
    );
  }
  if (activeRuntime === 'cursor') {
    if (!options.args) {
      const cursorConfig = resolveCursorRuntimeConfig(session, binding);
      return buildCommandFields(
        '当前 Cursor Agent 模式',
        [['Runtime', 'cursor'], ['模式', cursorConfig.force ? 'yolo' : 'normal'], ['Provider', 'tmux']],
        [MODE_OPTIONS_TEXT, '发送 `/mode normal` 或 `/mode yolo` 切换；修改从下一次 Cursor tmux 启动开始生效。'],
        options.markdown,
      );
    }
    const requestedMode = parseMode(options.args);
    if (!requestedMode) {
      return buildCommandFields('模式用法', [['命令', '`/mode normal|yolo`']], [MODE_OPTIONS_TEXT], options.markdown);
    }
    setSessionCursorForceToml(session!.id, requestedMode === 'yolo');
    return buildCommandFields(
      '已切换 Cursor Agent 模式',
      [['模式', requestedMode], ['Provider', 'tmux']],
      ['后续 Cursor tmux 启动会按此设置决定是否传 `--force`。'],
      options.markdown,
    );
  }
  if (!options.args) {
    return buildCommandFields(
      '当前模式',
      [
        ['模式', mode],
        ['Runtime', activeRuntime],
        activeRuntime === 'claude'
          ? ['YOLO模式', mode]
          : ['Provider', formatSessionCodexProvider(session, binding)],
      ],
      [MODE_OPTIONS_TEXT, '发送 `/m normal` 或 `/m yolo` 切换；完整命令是 `/mode normal|yolo`。'],
      options.markdown,
    );
  }
  const requestedMode = parseMode(options.args);
  if (!requestedMode) {
    return buildCommandFields(
      '模式用法',
      [['命令', '`/mode normal|yolo`']],
      [MODE_OPTIONS_TEXT],
      options.markdown,
    );
  }
  if (activeRuntime === 'claude') {
    if (session) {
      setSessionClaudeYoloModeToml(session.id, requestedMode);
    }
    return buildCommandFields(
      '已切换 Claude Code 模式',
      [
        ['模式', requestedMode],
        ['YOLO模式', requestedMode],
      ],
      [
        requestedMode === 'yolo'
          ? '后续启动 Claude Code 时允许 agent 无需审批绕过沙箱。'
          : '后续启动 Claude Code 时使用普通审批模式。',
        CLAUDE_PTY_RUNTIME_UPDATE_NOTE,
      ],
      options.markdown,
    );
  }
  if (session) {
    setSessionCodexYoloModeToml(session.id, requestedMode);
  }
  return buildCommandFields(
    codexRuntimeUpdateTitle(session, binding, '已切换模式'),
    [
      ['模式', requestedMode],
      ['Provider', formatSessionCodexProvider(session, binding)],
    ],
    codexRuntimeUpdateNotes(session, binding, [MODE_OPTIONS_TEXT]),
    options.markdown,
  );
}

export function handleChangeDirectoryCommand(options: {
  msg: InboundMessage;
  args: string;
  currentBinding: ChannelChat | null;
  store: BridgeStore;
  markdown: boolean;
}): string {
  const binding = options.currentBinding || router.resolve(options.msg.address);
  const session = options.store.getSession(binding.bridgeSessionId);
  if (!session) {
    return '当前会话不存在，无法切换工作目录。';
  }
  const currentDirectory = getSessionWorkingDirectory(session);
  if (!options.args.trim()) {
    return buildCommandFields(
      '当前工作目录',
      [['目录', currentDirectory || '-']],
      ['发送 `/cd <path>` 可替换当前会话工作目录；支持绝对路径、相对路径和 `~`。'],
      options.markdown,
    );
  }
  const resolved = resolveSessionWorkingDirectoryPath(options.args, currentDirectory);
  if (!resolved.ok) {
    return buildCommandFields(
      '切换目录失败',
      [
        ['输入', options.args],
        ['当前目录', currentDirectory || '-'],
      ],
      [resolved.message],
      options.markdown,
    );
  }
  try {
    const stat = fs.statSync(resolved.workDir);
    if (!stat.isDirectory()) {
      return `切换目录失败：目标不是目录：${resolved.workDir}`;
    }
  } catch (error) {
    return `切换目录失败：${error instanceof Error ? error.message : String(error)}`;
  }
  setSessionWorkspaceToml(session.id, resolved.workDir);
  return buildCommandFields(
    '已切换工作目录',
    [
      ['原目录', currentDirectory || '-'],
      ['新目录', resolved.workDir],
    ],
    ['后续 `/shell`、`/cat`、`/file` 和模型执行会使用新的工作目录。'],
    options.markdown,
  );
}

export function handleRuntimeCommand(options: {
  msg: InboundMessage;
  args: string;
  currentBinding: ChannelChat | null;
  store: BridgeStore;
  deps?: RuntimeSettingsCommandDeps;
  markdown: boolean;
}): string {
  const binding = options.currentBinding || router.resolve(options.msg.address);
  const session = options.store.getSession(binding.bridgeSessionId);
  if (!session) {
    return '当前会话不存在，无法切换 runtime。';
  }
  const requested = options.args.trim().toLowerCase();
  const currentRuntime = getSessionActiveRuntime(session) || 'codex';
  if (!requested) {
    return buildCommandFields(
      '当前 Runtime',
      [['Runtime', currentRuntime]],
      [RUNTIME_OPTIONS_TEXT],
      options.markdown,
    );
  }
  if (requested !== 'codex' && requested !== 'claude' && requested !== 'kimi' && requested !== 'cursor') {
    return buildCommandFields(
      'Runtime 用法',
      [['命令', '`/runtime codex|claude|kimi|cursor`']],
      [RUNTIME_OPTIONS_TEXT],
      options.markdown,
    );
  }
  if (requested === currentRuntime) {
    const label = requested === 'claude' ? 'Claude Code' : requested === 'kimi' ? 'Kimi Code' : requested === 'cursor' ? 'Cursor Agent' : 'Codex';
    return buildCommandFields(
      'Runtime 未变化',
      [['Runtime', currentRuntime]],
      [`当前聊天已经绑定 ${label} BridgeSession。`],
      options.markdown,
    );
  }
  if (sessionHasActiveRuntimeTurn(options.deps, session)) {
    return buildRuntimeSwitchWhileRunningResponse({
      commandLabel: '`/runtime`',
      runtime: currentRuntime,
      markdown: options.markdown,
    });
  }

  const targetRuntime = requested as RuntimeName;
  let nextSession = mappedRuntimeSessionId(options.store, binding, targetRuntime)
    ? options.store.getSession(mappedRuntimeSessionId(options.store, binding, targetRuntime)!)
    : null;
  let createdNewSession = false;
  if (!nextSession) {
    nextSession = createRuntimeSessionForChat({
      store: options.store,
      runtime: targetRuntime,
      baseSession: session,
      chatId: options.msg.address.chatId,
      binding,
    });
    createdNewSession = true;
  }
  const runtimeBridgeSessionIds = {
    ...binding.runtimeBridgeSessionIds,
    [currentRuntime]: session.id,
    [targetRuntime]: nextSession.id,
  };
  options.store.updateChannelChat(binding.id, {
    bridgeSessionId: nextSession.id,
    runtimeBridgeSessionIds,
  });
  scheduleMirrorSubscriptionsBestEffort(options.deps || {}, `runtime ${requested} switch`);
  return buildCommandFields(
    createdNewSession ? '已创建并切换 Runtime' : '已切换 Runtime',
    [
      ['Runtime', requested],
      ['原 BridgeSession', session.id],
      ['新 BridgeSession', nextSession.id],
      ['目录', getSessionWorkingDirectory(nextSession) || '-'],
    ],
    [`当前聊天已切到独立 ${requested === 'claude' ? 'Claude Code' : requested === 'kimi' ? 'Kimi Code' : requested === 'cursor' ? 'Cursor Agent' : 'Codex'} BridgeSession；其它 runtime 会话不会参与后续 turn。再次使用 \`/runtime codex|claude|kimi|cursor\` 会切回本聊天记住的对应 BridgeSession。`],
    options.markdown,
  );
}

export function handleSandboxCommand(options: {
  msg: InboundMessage;
  args: string;
  currentBinding: ChannelChat | null;
  store: BridgeStore;
  markdown: boolean;
}): string {
  const binding = options.currentBinding || router.resolve(options.msg.address);
  const session = options.store.getSession(binding.bridgeSessionId);
  if (!session) {
    return '当前会话不存在。';
  }
  const activeRuntime = getSessionActiveRuntime(session);
  if (activeRuntime === 'claude' || activeRuntime === 'kimi' || activeRuntime === 'cursor') {
    const label = activeRuntime === 'kimi' ? 'Kimi Code' : activeRuntime === 'cursor' ? 'Cursor Agent' : 'Claude Code';
    return buildCommandFields(
      `${label} 不支持 Bridge 沙箱设置`,
      [['Runtime', activeRuntime]],
      ['`/sandbox` 只适用于 Codex runtime。'],
      options.markdown,
    );
  }
  if (!options.args) {
    return buildCommandFields(
      '当前 Codex 沙箱',
      [
        ['沙箱', resolveEffectiveSandboxMode(session, binding)],
        ['来源', hasSessionCodexSandboxOverride(session) ? '当前会话' : '全局默认'],
      ],
      [SANDBOX_OPTIONS_TEXT, '发送 `/sandbox workspace-write` 可切换；修改从下一轮 Codex 请求开始生效。'],
      options.markdown,
    );
  }
  const requestedSandbox = options.args.trim().toLowerCase();
  if (requestedSandbox === 'default' || requestedSandbox === 'reset') {
    clearSessionCodexSandboxToml(session.id);
    return buildCommandFields(
      '已恢复默认 Codex 沙箱',
      [['沙箱', resolveEffectiveSandboxMode(options.store.getSession(session.id), binding)]],
      codexRuntimeUpdateNotes(options.store.getSession(session.id), binding, ['当前会话将继续使用 Web 配置里的全局默认值。']),
      options.markdown,
    );
  }
  const sandboxMode = parseSandboxMode(requestedSandbox);
  if (!sandboxMode) {
    return buildCommandFields(
      'Codex 沙箱用法',
      [['命令', '`/sandbox read-only|workspace-write|danger-full-access|default`']],
      [SANDBOX_OPTIONS_TEXT],
      options.markdown,
    );
  }
  setSessionCodexSandboxToml(session.id, sandboxMode);
  return buildCommandFields(
    '已更新 Codex 沙箱',
    [['沙箱', sandboxMode]],
    codexRuntimeUpdateNotes(options.store.getSession(session.id), binding),
    options.markdown,
  );
}

export function handleNetworkCommand(options: {
  msg: InboundMessage;
  args: string;
  currentBinding: ChannelChat | null;
  store: BridgeStore;
  markdown: boolean;
}): string {
  const binding = options.currentBinding || router.resolve(options.msg.address);
  const session = options.store.getSession(binding.bridgeSessionId);
  if (!session) {
    return '当前会话不存在。';
  }
  const activeRuntime = getSessionActiveRuntime(session);
  if (activeRuntime === 'claude' || activeRuntime === 'kimi' || activeRuntime === 'cursor') {
    const label = activeRuntime === 'kimi' ? 'Kimi Code' : activeRuntime === 'cursor' ? 'Cursor Agent' : 'Claude Code';
    return buildCommandFields(
      `${label} 不支持 Bridge 网络开关`,
      [['Runtime', activeRuntime]],
      ['`/network` 只适用于 Codex runtime 的 sandbox network_access。'],
      options.markdown,
    );
  }
  if (!options.args) {
    return buildCommandFields(
      '当前 Codex 网络',
      [
        ['网络', formatNetworkAccess(resolveEffectiveNetworkAccess(session, binding))],
        ['来源', hasSessionCodexNetworkAccessOverride(session) ? '当前会话' : '全局默认'],
      ],
      [NETWORK_OPTIONS_TEXT, '这个开关会传给 `sandbox_workspace_write.network_access`；下一轮 Codex 请求生效。'],
      options.markdown,
    );
  }
  const networkAccess = parseNetworkAccessArg(options.args);
  if (networkAccess === null) {
    return buildCommandFields(
      'Codex 网络用法',
      [['命令', '`/network on|off|default`']],
      [NETWORK_OPTIONS_TEXT],
      options.markdown,
    );
  }
  if (networkAccess === 'default') {
    clearSessionCodexNetworkAccessToml(session.id);
    return buildCommandFields(
      '已恢复默认 Codex 网络',
      [['网络', formatNetworkAccess(resolveEffectiveNetworkAccess(options.store.getSession(session.id), binding))]],
      codexRuntimeUpdateNotes(options.store.getSession(session.id), binding, ['当前会话将继续使用 Web 配置里的全局默认值。']),
      options.markdown,
    );
  }
  setSessionCodexNetworkAccessToml(session.id, networkAccess);
  return buildCommandFields(
    '已更新 Codex 网络',
    [['网络', formatNetworkAccess(networkAccess)]],
    codexRuntimeUpdateNotes(options.store.getSession(session.id), binding),
    options.markdown,
  );
}

export function handleUiCommand(options: {
  args: string;
  markdown: boolean;
}): string {
  return buildCommandFields(
    options.args.trim() ? 'UI 显示设置已简化' : 'UI 显示设置',
    [['工具详情', '始终显示']],
    ['工具输入输出显示开关已移除；SDK、mirror 和卡片渲染会统一保留工具详情。'],
    options.markdown,
  );
}

export function handleModelCommand(options: {
  msg: InboundMessage;
  args: string;
  currentBinding: ChannelChat | null;
  store: BridgeStore;
  markdown: boolean;
}): string {
  const binding = options.currentBinding || router.resolve(options.msg.address);
  const session = options.store.getSession(binding.bridgeSessionId);
  if (!session) {
    return '当前会话不存在。';
  }
  const activeRuntime = getSessionActiveRuntime(session) || 'codex';
  if (activeRuntime === 'claude') {
    if (!options.args) {
      const currentModel = getSessionClaudeModel(session) || resolveClaudeRuntimeConfig(session, binding).model || 'default';
      return buildCommandFields(
        '当前 Claude Code 模型',
        [['模型', currentModel]],
        [
          '发送 `/model sonnet`、`/model opus` 或完整 Claude 模型名可切换；发送 `/model default` 可回退到全局 Claude 默认模型。',
          '模型切换保存为后续 Claude Code pty 启动参数；不会向运行中的 TUI 注入模型切换命令。',
        ],
        options.markdown,
      );
    }

    const requestedModel = options.args.trim();
    if (!requestedModel) {
      return buildCommandFields(
        'Claude Code 模型用法',
        [['命令', '`/model sonnet|opus|<claude-model>`']],
        ['发送 `/model default` 可回退到全局 Claude 默认模型。'],
        options.markdown,
      );
    }
    if (requestedModel === 'default') {
      clearSessionClaudeModelToml(session.id);
      const updated = options.store.getSession(session.id);
      return buildCommandFields(
        '已恢复默认 Claude Code 模型',
        [['模型', resolveClaudeRuntimeConfig(updated, binding).model || 'default']],
        ['后续启动 Claude Code pty 时会跟随全局 Claude 默认模型。', CLAUDE_PTY_RUNTIME_UPDATE_NOTE],
        options.markdown,
      );
    }

    setSessionClaudeModelToml(session.id, requestedModel);
    return buildCommandFields(
      '已更新 Claude Code 模型',
      [['模型', requestedModel]],
      [`后续启动 Claude Code pty 时会传入 \`--model ${requestedModel}\`。`, CLAUDE_PTY_RUNTIME_UPDATE_NOTE],
      options.markdown,
    );
  }
  if (activeRuntime === 'kimi') {
    if (!options.args) {
      const currentModel = resolveKimiRuntimeConfig(session, binding).model || 'default';
      return buildCommandFields(
        '当前 Kimi Code 模型',
        [['模型', currentModel]],
        [
          '发送 `/model <kimi-model>` 可切换；发送 `/model default` 可回退到全局 Kimi 默认模型。',
          '模型切换保存为后续 Kimi Code tmux 启动参数；不会向运行中的 TUI 注入模型切换命令。',
        ],
        options.markdown,
      );
    }

    const requestedModel = options.args.trim();
    if (!requestedModel) {
      return buildCommandFields(
        'Kimi Code 模型用法',
        [['命令', '`/model <kimi-model>`']],
        ['发送 `/model default` 可回退到全局 Kimi 默认模型。'],
        options.markdown,
      );
    }
    if (requestedModel === 'default') {
      clearSessionKimiModelToml(session.id);
      const updated = options.store.getSession(session.id);
      return buildCommandFields(
        '已恢复默认 Kimi Code 模型',
        [['模型', resolveKimiRuntimeConfig(updated, binding).model || 'default']],
        ['后续启动 Kimi Code tmux 时会跟随全局 Kimi 默认模型。'],
        options.markdown,
      );
    }

    setSessionKimiModelToml(session.id, requestedModel);
    return buildCommandFields(
      '已更新 Kimi Code 模型',
      [['模型', requestedModel]],
      [`后续启动 Kimi Code tmux 时会传入 \`--model ${requestedModel}\`。`],
      options.markdown,
    );
  }
  if (activeRuntime === 'cursor') {
    if (!options.args) {
      const currentModel = resolveCursorRuntimeConfig(session, binding).model || 'default';
      return buildCommandFields(
        '当前 Cursor Agent 模型',
        [['模型', currentModel]],
        ['发送 `/model <cursor-model>` 可切换；发送 `/model default` 可回退到 Cursor 默认模型。'],
        options.markdown,
      );
    }
    const requestedModel = options.args.trim();
    if (requestedModel === 'default') {
      clearSessionCursorModelToml(session.id);
      return buildCommandFields(
        '已恢复默认 Cursor Agent 模型',
        [['模型', resolveCursorRuntimeConfig(options.store.getSession(session.id), binding).model || 'default']],
        ['后续 Cursor tmux 启动不再显式传 `--model`。'],
        options.markdown,
      );
    }
    setSessionCursorModelToml(session.id, requestedModel);
    return buildCommandFields(
      '已更新 Cursor Agent 模型',
      [['模型', requestedModel]],
      [`后续 Cursor tmux 启动会传入 \`--model ${requestedModel}\`。`],
      options.markdown,
    );
  }

  if (!options.args) {
    const codexThreadId = resolveLocalCodexThreadId(session, binding, 'model command');
    const currentModel = resolveDisplayedModel(
      binding,
      session,
      getGlobalCodexModel(),
      readConfiguredCodexModel(),
    );
    return buildCommandFields(
      '当前模型',
      [['模型', formatDisplayedModel(currentModel)]],
      [
        getAvailableModelChoicesText(),
        codexThreadId
          ? '当前是共享Codex thread，只支持查看模型；如需切换，请先用 `/new` 新建一个 IM 会话线程。'
          : '发送 `/model gpt-5.4` 可切换；发送 `/model default` 可回退到默认模型。',
        '模型切换只影响后续从 IM 发起的 Codex CLI 请求。',
      ],
      options.markdown,
    );
  }

  if (resolveLocalCodexThreadId(session, binding, 'model command update')) {
    return '当前是共享Codex thread，不支持直接切换模型。请先用 `/new` 新建一个线程，再执行 `/model ...`。';
  }

  const requestedModel = options.args.trim();
  if (requestedModel === 'default') {
    clearSessionCodexModelToml(session.id);
    const updatedBinding = router.resolve(options.msg.address);
    const updatedSession = options.store.getSession(updatedBinding.bridgeSessionId);
    const currentModel = resolveDisplayedModel(
      updatedBinding,
      updatedSession,
      getGlobalCodexModel(),
      readConfiguredCodexModel(),
    );
    return buildCommandFields(
      '已恢复默认模型',
      [['模型', formatDisplayedModel(currentModel)]],
      codexRuntimeUpdateNotes(updatedSession, updatedBinding, ['后续从 IM 发起的 Codex CLI 请求会跟随默认模型。']),
      options.markdown,
    );
  }

  const selectedModel = getSelectableCodexModel(requestedModel);
  if (!selectedModel) {
    return buildCommandFields(
      '模型用法',
      [['命令', '`/model <slug>`']],
      [
        getAvailableModelChoicesText(),
        '发送 `/model default` 可回退到默认模型。',
      ],
      options.markdown,
    );
  }

  setSessionCodexModelToml(session.id, selectedModel.slug);
  return buildCommandFields(
    '已更新模型',
    [['模型', formatDisplayedModel(selectedModel.slug)]],
    [
      '后续从 IM 发起的 Codex CLI 请求会使用这个模型。',
      ...codexRuntimeUpdateNotes(options.store.getSession(session.id), binding),
      ...(isCliOnlyCodexModel(selectedModel)
        ? ['这是仅 IM/CLI 模型，只能在 IM -> Codex CLI 调用中使用，Codex Native 不支持。']
        : []),
    ],
    options.markdown,
  );
}
