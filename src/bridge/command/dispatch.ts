import {
  resolveCommandAlias,
} from './aliases.js';
import { getBridgeContext } from '../host/context.js';
import { deliverBridgeNotice } from '../../channels/delivery/feedback.js';
import * as router from '../session/channel-router.js';
import type { BaseChannelAdapter, StructuredStreamingUiActionButton } from '../../channels/contracts.js';
import type { ChannelAddress, ChannelChat, InboundMessage, OutboundRichCard } from '../../domain/index.js';
import { isDangerousInput } from '../../shared/security/validators.js';
import {
  getFeedbackParseMode,
} from '../../channels/adapter-runtime/channel-runtime.js';
import {
  getWorkspaceRoot,
} from '../session/support.js';
import {
  handleCatCommand,
  buildCurrentCommandRichCard,
  handleCurrentCommand,
  handleFileCommand,
  handleHealthCommand,
  handleHistoryCommand,
} from './diagnostics.js';
import {
  handlePermissionCommand,
  handleStopCommand,
} from './control.js';
import { buildHelpCommandResponse } from './help.js';
import {
  buildStartCommandResponse,
  handleLocalRuntimeSessionsCommand,
  handleClearSessionCommand,
  handleNewSessionCommand,
  handleThreadBindingCommand,
  handleThreadSwitchCommand,
} from './session-thread.js';
import {
  handleChangeDirectoryCommand,
  handleModeCommand,
  handleModelCommand,
  handleNetworkCommand,
  handleProviderCommand,
  handleReasoningCommand,
  handleRuntimeCommand,
  handleSandboxCommand,
  handleUiCommand,
} from './runtime-settings.js';
import { handleRequireAtCommand } from './require-at.js';
import {
  buildSettingsFields,
  buildSetCommandRichCard,
  handleSetCommand,
  handleSetFormCommand,
  runtimeSettingDefinitions,
  setCommandSelectedGroup,
  type SettingDefinition,
} from './global-settings.js';
import { buildGlobalStatusResponse } from './status.js';
import {
  CommandThreadDisplay,
  type ThreadCardScope,
} from './thread-display.js';
import {
  buildNewSessionFormCard,
} from './presentation.js';
import {
  getThreadTableMessageRecord,
  persistAndPinLatestThreadTableMessage,
  saveThreadTableMessageRecord,
} from './thread-table-message-pins.js';
import { createConfigService } from '../../configuration/service.js';
import { getSessionActiveRuntime, getSessionWorkingDirectory } from '../../domain/session-runtime.js';
import {
  handleAutoCommand,
} from './auto.js';
import { clearPendingClearConfirmation } from './clear-confirmations.js';
import {
  handleHotUpdateCommand,
  startHotUpdateLogMonitor,
  type HotUpdateRunner,
} from './hot-update.js';
import { saveStartupNoticeTarget } from '../host/startup-notice-target.js';
import {
  type ShellCommandRunner,
} from './shell.js';
import type { AutoTaskCardAction } from './callbacks.js';
import {
  handleTerminalDispatchCommand,
  isTerminalRawInputCommand,
} from './dispatch-terminal.js';
import { validateThreadName } from '../session/command-use-cases/args.js';

const PROVIDER_TMUX_LOADING_REACTION = 'Typing';

function extractCardActionFormValue(raw: unknown): Record<string, unknown> | null {
  const root = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
  const event = root.event && typeof root.event === 'object' ? root.event as Record<string, any> : root;
  const action = event.action && typeof event.action === 'object' ? event.action as Record<string, any> : {};
  const formValue = action.form_value;
  return formValue && typeof formValue === 'object' ? formValue as Record<string, unknown> : null;
}

function normalizeFormString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface BridgeCommandDispatchDeps {
  getActiveTask(sessionId: string): { abortController: AbortController } | undefined;
  forceStopSession?(sessionId: string, detail?: string): Promise<boolean>;
  recordInteractiveHealthEnd?(sessionId: string, outcome: 'completed' | 'failed' | 'aborted', detail?: string): void;
  reconcileMirrorSubscriptions?(): Promise<void>;
  bootstrapCodexThread?: import('./runtime-settings.js').RuntimeSettingsCommandDeps['bootstrapCodexThread'];
  diagnoseSessionHealth(sessionId: string): Promise<import('../health/runtime.js').SessionHealthDiagnosis | null>;
  diagnoseAllActiveSessions(): Promise<import('../health/runtime.js').SessionHealthDiagnosis[]>;
  scopedBinding?: ChannelChat | null;
  threadCardRefreshScope?: ThreadCardScope | null;
  threadCardSelectedId?: string | null;
  selectedAutoTaskId?: string | null;
  selectedAutoTaskAction?: AutoTaskCardAction | null;
  startAutoTask?(taskId: string): void;
  stopAutoTask?(taskId: string): void;
  onBindingRemoved?(binding: ChannelChat): void;
  hotUpdateRunner?: HotUpdateRunner;
  hotUpdateCwd?: string;
  hotUpdateEnv?: NodeJS.ProcessEnv;
  hotUpdateLogRefreshIntervalMs?: number;
  shellRunner?: ShellCommandRunner;
  tmuxProviderAutoForward?: boolean;
  onTmuxProviderAutoForwarded?: () => Promise<void> | void;
}

async function deliverCurrentCommandAfterNewSession(options: {
  adapter: BaseChannelAdapter;
  address: ChannelAddress;
  store: ReturnType<typeof getBridgeContext>['store'];
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
}): Promise<void> {
  const binding = options.store.getChannelChat(options.address.channelType, options.address.chatId);
  const msg = {
    address: options.address,
    text: '/current',
    messageId: `post-new-current:${options.address.channelType}:${options.address.chatId}`,
    timestamp: Date.now(),
  } satisfies InboundMessage;
  const response = handleCurrentCommand({
    msg,
    binding,
    store: options.store,
    threadDisplay: options.threadDisplay,
    markdown: options.markdown,
  });
  const richCard = buildCurrentCommandRichCard({
    msg,
    binding,
    store: options.store,
    threadDisplay: options.threadDisplay,
  });
  const result = await deliverBridgeNotice(options.adapter, options.address, response, {
    audit: true,
    richCard,
  });
  if (result.ok && result.messageId) {
    await persistAndPinLatestThreadTableMessage(options.adapter, options.address, 'current', result.messageId);
  }
}

const CURRENT_SETTING_LEGACY_FORM_KEYS: Record<string, string[]> = {
  defaultModel: ['clk_model', 'model'],
  defaultMode: ['clk_mode', 'mode'],
  defaultProvider: ['clk_provider', 'provider'],
  codexSandboxMode: ['clk_sandbox', 'sandbox'],
  codexNetworkAccess: ['clk_network', 'network'],
  codexReasoningEffort: ['clk_reasoning', 'reasoning'],
  claudeDefaultModel: ['clk_model', 'model'],
  claudeMode: ['clk_mode', 'mode'],
  claudeProvider: ['clk_provider', 'provider'],
  claudeReasoningEffort: ['clk_reasoning', 'reasoning'],
  claudeIdleTimeoutMinutes: ['clk_idle_timeout_minutes', 'idleTimeoutMinutes'],
};

function currentSettingFormValue(formValue: Record<string, unknown>, settingKey: string): string | undefined {
  const keys = [settingKey, ...(CURRENT_SETTING_LEGACY_FORM_KEYS[settingKey] || [])];
  for (const key of keys) {
    const value = normalizeFormString(formValue[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function formatCurrentConfigWriteError(error: unknown): string {
  const issues = error && typeof error === 'object' && Array.isArray((error as { issues?: unknown[] }).issues)
    ? (error as { issues: Array<{ path?: unknown[]; message?: string }> }).issues
    : [];
  if (issues.length > 0) {
    return issues
      .map((issue) => {
        const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message || '配置字段不合法。'}`;
      })
      .join('\n');
  }
  return error instanceof Error ? error.message : '配置字段不合法。';
}

async function handleCurrentConfigFormCommand(options: {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  args: string;
  binding: ChannelChat | null;
  store: ReturnType<typeof getBridgeContext>['store'];
  deps: BridgeCommandDispatchDeps;
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
}): Promise<{ response: string; richCard?: OutboundRichCard }> {
  let binding = options.binding || router.resolve(options.msg.address);
  let session = options.store.getSession(binding.bridgeSessionId);
  if (!session) return { response: '当前会话不存在，无法保存配置。' };

  const formValue = extractCardActionFormValue(options.msg.raw);
  if (!formValue) return { response: '没有读取到卡片表单内容，请刷新 `/current` 后重试。' };

  let activeRuntime = getSessionActiveRuntime(session) || 'codex';
  const submittedRuntime = parseCurrentRuntimeArg(options.args)
    || normalizeRuntimeFormValue(formValue.clk_runtime || formValue.runtime);
  const responses: string[] = [];
  if (submittedRuntime && submittedRuntime !== activeRuntime) {
    responses.push(handleRuntimeCommand({
      msg: options.msg,
      args: submittedRuntime,
      currentBinding: binding,
      store: options.store,
      deps: options.deps,
      markdown: options.markdown,
    }));
    binding = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId) || binding;
    session = options.store.getSession(binding.bridgeSessionId);
    activeRuntime = session ? getSessionActiveRuntime(session) || 'codex' : activeRuntime;
    if (!session) return { response: '当前会话不存在，无法继续保存配置。' };
    if (activeRuntime !== submittedRuntime) {
      return {
        response: responses.join('\n\n'),
        richCard: buildCurrentCommandRichCard({
          msg: options.msg,
          binding,
          store: options.store,
          threadDisplay: options.threadDisplay,
        }),
      };
    }
  }

  const sessionConfigService = createConfigService({ migrate: false });
  const name = normalizeFormString(formValue.clk_name || formValue.name);
  if (name && name !== (session.name || '').trim()) {
    const parsed = validateThreadName(name);
    if (!parsed.ok) return { response: parsed.message };
    options.threadDisplay.renameBinding(binding, parsed.name);
    if (binding.chatKind === 'group' && options.adapter.renameGroupChat) {
      await options.adapter.renameGroupChat(binding.chatId, parsed.name).catch(() => null);
    }
    responses.push(`name: ${parsed.name}`);
  }

  const cwd = normalizeFormString(formValue.clk_cwd || formValue.cwd);
  if (cwd && cwd !== getSessionWorkingDirectory(session)) {
    responses.push(await handleChangeDirectoryCommand({
      msg: options.msg,
      args: cwd,
      currentBinding: binding,
      store: options.store,
      markdown: options.markdown,
    }));
  }

  let currentConfig = sessionConfigService.snapshot({ kind: 'session', sessionId: session.id }).config;
  const updatedSettings: SettingDefinition[] = [];
  for (const definition of runtimeSettingDefinitions(activeRuntime, { sessionWritableOnly: true })) {
    const rawValue = currentSettingFormValue(formValue, definition.key);
    if (rawValue === undefined) continue;
    const currentValue = definition.read(currentConfig);
    const normalizedCurrent = currentValue === '-' || currentValue === 'auto' ? '' : currentValue;
    if (rawValue === normalizedCurrent) continue;
    const written = definition.write(rawValue, currentConfig);
    if (!written.ok) {
      return { response: `${definition.tomlPath} 未更新：${written.message}\n\n用法：${definition.usage}` };
    }
    try {
      sessionConfigService.set({ kind: 'session', sessionId: session.id }, written.patch);
      currentConfig = sessionConfigService.snapshot({ kind: 'session', sessionId: session.id }).config;
      updatedSettings.push(definition);
    } catch (error) {
      return { response: `${definition.tomlPath} 未更新：${formatCurrentConfigWriteError(error)}` };
    }
  }

  const refreshedBinding = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId) || binding;
  return {
    response: responses.length > 0 || updatedSettings.length > 0
      ? [
          '已保存当前会话配置。',
          ...responses,
          ...(updatedSettings.length > 0 ? [buildSettingsFields(currentConfig, updatedSettings).map(([label, value]) => `${label}: ${value}`).join('\n')] : []),
        ].filter(Boolean).join('\n\n')
      : '没有检测到需要保存的配置变更。',
    richCard: buildCurrentCommandRichCard({
      msg: options.msg,
      binding: refreshedBinding,
      store: options.store,
      threadDisplay: options.threadDisplay,
    }),
  };
}

async function handleCurrentRuntimeCommand(options: {
  msg: InboundMessage;
  args: string;
  binding: ChannelChat | null;
  store: ReturnType<typeof getBridgeContext>['store'];
  deps: BridgeCommandDispatchDeps;
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
}): Promise<{ response: string; richCard?: OutboundRichCard }> {
  const binding = options.binding || router.resolve(options.msg.address);
  const runtime = normalizeFormString(options.args);
  if (runtime !== 'codex' && runtime !== 'claude') {
    return { response: '请选择有效 runtime：codex 或 claude。' };
  }

  const session = options.store.getSession(binding.bridgeSessionId);
  if (!session) return { response: '当前会话不存在，无法切换 runtime。' };

  const activeRuntime = getSessionActiveRuntime(session) || 'codex';
  const responses = runtime === activeRuntime
    ? ['runtime 没有变化，已刷新当前会话卡片。']
    : [handleRuntimeCommand({
      msg: options.msg,
      args: runtime,
      currentBinding: binding,
      store: options.store,
      deps: options.deps,
      markdown: options.markdown,
    })];
  const refreshedBinding = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId) || binding;
  return {
    response: responses.join('\n\n'),
    richCard: buildCurrentCommandRichCard({
      msg: options.msg,
      binding: refreshedBinding,
      store: options.store,
      threadDisplay: options.threadDisplay,
    }),
  };
}

function normalizeRuntimeFormValue(value: unknown): 'codex' | 'claude' | undefined {
  const runtime = normalizeFormString(value).toLowerCase();
  return runtime === 'codex' || runtime === 'claude' ? runtime : undefined;
}

function parseCurrentRuntimeArg(args: string): 'codex' | 'claude' | undefined {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const runtime = parts[0] === 'runtime' ? parts[1] : parts[0];
  return runtime === 'codex' || runtime === 'claude' ? runtime : undefined;
}

export async function handleBridgeCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
  deps: BridgeCommandDispatchDeps,
): Promise<void> {
  const { store } = getBridgeContext();
  const threadDisplay = new CommandThreadDisplay(store);

  const trimmedText = text.trim();
  const commandToken = trimmedText.split(/\s+/)[0] || '';
  const rawCommand = commandToken.split('@')[0].toLowerCase();
  const args = trimmedText.slice(commandToken.length).trim();
  const command = resolveCommandAlias(rawCommand, args);

  const dangerCheck = isTerminalRawInputCommand(command)
    ? { dangerous: text.includes('\0') || text.length > 64_000, reason: text.includes('\0') ? 'null byte detected' : 'excessively long input' }
    : isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliverBridgeNotice(adapter, msg.address, '命令被拒绝：检测到无效输入。', {
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';
  let responseAddress = msg.address;
  let responseRichCard: OutboundRichCard | undefined;
  let responseParseMode: 'Markdown' | 'plain' = getFeedbackParseMode(adapter.channelType);
  let auditResponse = true;
  let threadTableCardScope: ThreadCardScope | undefined;
  let setConfigCard = false;
  let afterDelivery: ((messageId?: string) => Promise<void> | void) | undefined;
  let useCurrentThreadCardUpdateFallback = false;
  let postDeliveryCurrentAddress: ChannelAddress | undefined;
  const currentBinding = deps.scopedBinding || store.getChannelChat(msg.address.channelType, msg.address.chatId);
  const shouldApplyDefaultTargetForCommand = !new Set(['/status', '/threads', '/t', '/set']).has(command);
  const commandBinding = !shouldApplyDefaultTargetForCommand
    ? currentBinding
    : currentBinding || (store.getChannelDefaultTarget(msg.address.channelType) ? router.resolve(msg.address) : null);

  switch (command) {
    case '/start':
      response = buildStartCommandResponse();
      break;

    case '/new': {
      if (!args.trim()) {
        response = '创建群聊会话：请输入名称和工作目录。';
        responseRichCard = buildNewSessionFormCard(commandBinding
          ? getSessionWorkingDirectory(store.getSession(commandBinding.bridgeSessionId)) || ''
          : getWorkspaceRoot());
      } else {
        const result = await handleNewSessionCommand({
          adapter,
          msg,
          args,
          commandBinding,
          store,
          deps,
          threadDisplay,
          markdown: responseParseMode === 'Markdown',
        });
        response = result.response;
        responseAddress = result.responseAddress || msg.address;
        responseRichCard = result.richCard;
        threadTableCardScope = result.threadTableCardScope;
        afterDelivery = result.afterDelivery;
        postDeliveryCurrentAddress = result.postDeliveryCurrentAddress;
      }
      break;
    }

    case '/new-form':
      response = '创建群聊会话：如果没有看到表单，请直接发送 `/new <名称> <目录>`。';
      responseRichCard = buildNewSessionFormCard(commandBinding
        ? getSessionWorkingDirectory(store.getSession(commandBinding.bridgeSessionId)) || ''
        : getWorkspaceRoot());
      break;

    case '/clear': {
      const result = await handleClearSessionCommand({
        adapter,
        msg,
        args,
        currentBinding,
        store,
        deps,
        threadDisplay,
        markdown: responseParseMode === 'Markdown',
      });
      response = result.response;
      responseAddress = result.responseAddress || msg.address;
      responseRichCard = result.richCard;
      threadTableCardScope = result.threadTableCardScope;
      break;
    }

    case '/clear-cancel':
      clearPendingClearConfirmation(msg.address);
      response = '已取消 /clear，当前对话保持不变。';
      break;

    case '/t': {
      const firstArg = args.trim().split(/\s+/)[0]?.toLowerCase() || '';
      const bindingSubcommands = new Set(['', 'ls', 'archive', 'rename', 'unbind', 'takeover-cancel']);
      const result = bindingSubcommands.has(firstArg)
        ? await handleThreadBindingCommand({
            adapter,
            msg,
            args,
            store,
            deps,
            threadDisplay,
            markdown: responseParseMode === 'Markdown',
          })
        : await handleThreadSwitchCommand({
            msg,
            args,
            currentBinding,
            commandBinding,
            store,
            deps,
            threadDisplay,
            markdown: responseParseMode === 'Markdown',
          });
      response = result.response;
      responseAddress = result.responseAddress || msg.address;
      responseRichCard = result.richCard;
      threadTableCardScope = result.threadTableCardScope;
      break;
    }

    case '/thread': {
      const result = await handleThreadSwitchCommand({
        msg,
        args,
        currentBinding,
        commandBinding,
        store,
        deps,
        threadDisplay,
        markdown: responseParseMode === 'Markdown',
      });
      response = result.response;
      responseAddress = result.responseAddress || msg.address;
      responseRichCard = result.richCard;
      threadTableCardScope = result.threadTableCardScope;
      break;
    }

    case '/threads': {
      const result = handleLocalRuntimeSessionsCommand({
        msg,
        args,
        threadDisplay,
        markdown: responseParseMode === 'Markdown',
      });
      response = result.response;
      responseRichCard = result.richCard;
      threadTableCardScope = result.threadTableCardScope;
      break;
    }

    case '/tmux':
    case '/tmux-key':
    case '/tmux-switch':
    case '/tmux-attach':
    case '/tmux-new':
    case '/tmux-status':
    case '/tmux-screen':
    case '/tmux-set':
    case '/pty-screen': {
      const result = await handleTerminalDispatchCommand({
        adapter,
        msg,
        command,
        args,
        store,
        currentBinding,
        commandBinding,
        deps,
        markdown: responseParseMode === 'Markdown',
      });
      response = result.response;
      responseRichCard = result.richCard;
      break;
    }

    case '/reasoning': {
      response = handleReasoningCommand({
        args,
        binding: commandBinding,
        store,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/cwd': {
      response = '当前版本已不支持 /cwd。请使用 /new 新建会话，或使用 /t 切换到已有本地会话。';
      break;
    }

    case '/cd': {
      response = handleChangeDirectoryCommand({
        msg,
        args,
        currentBinding,
        store,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/mode': {
      response = handleModeCommand({
        msg,
        args,
        currentBinding,
        store,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/runtime': {
      response = handleRuntimeCommand({
        msg,
        args,
        currentBinding,
        store,
        deps,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/provider': {
      const isTmuxProviderStart = args.trim().toLowerCase() === 'tmux';
      let loadingReactionId: string | null = null;
      if (isTmuxProviderStart && msg.messageId && typeof adapter.addMessageReaction === 'function') {
        loadingReactionId = await adapter.addMessageReaction(msg.messageId, PROVIDER_TMUX_LOADING_REACTION);
      }
      try {
        response = await handleProviderCommand({
          msg,
          args,
          currentBinding,
          store,
          deps: {
            ...deps,
            getActiveTask: deps.getActiveTask,
            notifyBackgroundOperation: async (message: string) => {
              if (isTmuxProviderStart) {
                return;
              }
              await deliverBridgeNotice(adapter, msg.address, message, {
                replyToMessageId: msg.messageId,
                audit: false,
              });
            },
          },
          markdown: responseParseMode === 'Markdown',
        });
      } catch (error) {
        throw error;
      } finally {
        if (loadingReactionId && msg.messageId && typeof adapter.removeMessageReaction === 'function') {
          await adapter.removeMessageReaction(msg.messageId, loadingReactionId, PROVIDER_TMUX_LOADING_REACTION);
        }
      }
      break;
    }

    case '/sandbox': {
      response = handleSandboxCommand({
        msg,
        args,
        currentBinding,
        store,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/network': {
      response = handleNetworkCommand({
        msg,
        args,
        currentBinding,
        store,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/ui': {
      response = handleUiCommand({
        args,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/require-at': {
      response = handleRequireAtCommand({
        msg,
        args,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/set': {
      const formValue = extractCardActionFormValue(msg.raw);
      if (formValue) {
        const result = handleSetFormCommand({
          args,
          formValue,
          markdown: responseParseMode === 'Markdown',
          address: msg.address,
        });
        response = result.response;
        responseRichCard = result.richCard;
        setConfigCard = true;
      } else {
        response = handleSetCommand({
          args,
          markdown: responseParseMode === 'Markdown',
        });
        if (!args.trim() || args.trim().startsWith('--group')) {
          responseRichCard = buildSetCommandRichCard(setCommandSelectedGroup(args), msg.address);
          setConfigCard = true;
        }
      }
      break;
    }

    case '/model': {
      response = handleModelCommand({
        msg,
        args,
        currentBinding,
        store,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/auto':
    case '/auto-script': {
      const session = commandBinding ? store.getSession(commandBinding.bridgeSessionId) : null;
      const result = handleAutoCommand({
        msg,
        args,
        session,
        store,
        deps: {
          selectedAutoTaskId: deps.selectedAutoTaskId,
          selectedAutoTaskAction: deps.selectedAutoTaskAction,
          startAutoTask: deps.startAutoTask,
          stopAutoTask: deps.stopAutoTask,
        },
        markdown: responseParseMode === 'Markdown',
        family: command === '/auto-script' ? 'auto-script' : 'auto',
      });
      response = result.response;
      responseRichCard = result.richCard;
      threadTableCardScope = result.threadTableCardScope;
      break;
    }

    case '/status': {
      auditResponse = false;
      response = buildGlobalStatusResponse(
        store,
        currentBinding,
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/current': {
      auditResponse = false;
      const previewRuntime = parseCurrentRuntimeArg(args);
      useCurrentThreadCardUpdateFallback = !!previewRuntime;
      response = handleCurrentCommand({
        msg,
        binding: commandBinding,
        store,
        threadDisplay,
        markdown: responseParseMode === 'Markdown',
        previewRuntime,
      });
      responseRichCard = buildCurrentCommandRichCard({
        msg,
        binding: commandBinding,
        store,
        threadDisplay,
        previewRuntime,
      });
      threadTableCardScope = responseRichCard ? 'current' : undefined;
      break;
    }

    case '/current-config': {
      auditResponse = false;
      const result = await handleCurrentConfigFormCommand({
        adapter,
        msg,
        args,
        binding: commandBinding,
        store,
        deps,
        threadDisplay,
        markdown: responseParseMode === 'Markdown',
      });
      response = result.response;
      responseRichCard = result.richCard;
      threadTableCardScope = responseRichCard ? 'current' : undefined;
      break;
    }

    case '/current-runtime': {
      auditResponse = false;
      const result = await handleCurrentRuntimeCommand({
        msg,
        args,
        binding: commandBinding,
        store,
        deps,
        threadDisplay,
        markdown: responseParseMode === 'Markdown',
      });
      response = result.response;
      responseRichCard = result.richCard;
      threadTableCardScope = responseRichCard ? 'current' : undefined;
      break;
    }

    case '/health': {
      auditResponse = false;
      response = await handleHealthCommand({
        args,
        binding: commandBinding,
        deps,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/history': {
      response = await handleHistoryCommand({
        adapter,
        msg,
        args,
        binding: commandBinding,
        store,
        threadDisplay,
        markdown: responseParseMode === 'Markdown',
        richCard: (card) => {
          responseRichCard = card;
        },
      });
      break;
    }

    case '/hot-update': {
      const hotUpdateUpdateKey = `hot-update-log:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId}`;
      if (!/\b(?:dry-run|dryrun|--dry-run)\b/i.test(args)) {
        saveStartupNoticeTarget(msg.address, commandBinding?.bridgeSessionId);
      }
      const result = await handleHotUpdateCommand({
        args,
        cwd: deps.hotUpdateCwd,
        env: deps.hotUpdateEnv,
        runner: deps.hotUpdateRunner,
        updateKey: hotUpdateUpdateKey,
      });
      response = result.response;
      responseRichCard = result.richCard;
      if (result.monitor) {
        afterDelivery = (messageId?: string) => {
          startHotUpdateLogMonitor({
            adapter,
            address: msg.address,
            messageId,
            refreshIntervalMs: deps.hotUpdateLogRefreshIntervalMs,
            spec: result.monitor!,
          });
        };
      }
      break;
    }

    case '/shell': {
      const result = await handleTerminalDispatchCommand({
        adapter,
        msg,
        command,
        args,
        store,
        currentBinding,
        commandBinding,
        deps,
        markdown: responseParseMode === 'Markdown',
      });
      response = result.response;
      responseRichCard = result.richCard;
      break;
    }

    case '/cat': {
      const binding = currentBinding || router.resolve(msg.address);
      const session = store.getSession(binding.bridgeSessionId);
      response = handleCatCommand({
        args,
        binding,
        session,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/file': {
      const binding = currentBinding || router.resolve(msg.address);
      const session = store.getSession(binding.bridgeSessionId);
      response = await handleFileCommand({
        adapter,
        msg,
        args,
        binding,
        session,
      });
      break;
    }

    case '/stop': {
      response = await handleStopCommand({
        msg,
        binding: commandBinding,
        store,
        deps,
        threadDisplay,
        markdown: responseParseMode === 'Markdown',
      });
      break;
    }

    case '/perm': {
      response = handlePermissionCommand({
        args,
        chatId: msg.address.chatId,
        currentBinding,
        store,
      });
      break;
    }

    case '/help':
      responseParseMode = getFeedbackParseMode(adapter.channelType);
      response = buildHelpCommandResponse();
      break;

    default:
      response = `未知命令：${rawCommand}\n发送 /h 或 /help 查看可用命令。`;
  }

  if (response) {
    const richCardUpdateMessageId = msg.callbackMessageId
      || (useCurrentThreadCardUpdateFallback && threadTableCardScope === 'current'
        ? getThreadTableMessageRecord(msg.address, 'current')?.messageId
        : setConfigCard
          ? getThreadTableMessageRecord(msg.address, 'set')?.messageId
        : undefined);
    const result = await deliverBridgeNotice(adapter, responseAddress, response, {
      replyToMessageId: responseAddress.channelType === msg.address.channelType && responseAddress.chatId === msg.address.chatId
        ? msg.messageId
        : undefined,
      audit: auditResponse,
      richCard: responseRichCard,
      richCardUpdateMessageId,
    });
    const threadCardMessageId = richCardUpdateMessageId || result.messageId;
    if (result.ok && setConfigCard && threadCardMessageId) {
      saveThreadTableMessageRecord(responseAddress, 'set', threadCardMessageId);
    } else if (result.ok && threadTableCardScope && threadCardMessageId) {
      await persistAndPinLatestThreadTableMessage(adapter, responseAddress, threadTableCardScope, threadCardMessageId);
    }
    if (result.ok && afterDelivery) {
      await afterDelivery(result.messageId);
    }
    if (result.ok && postDeliveryCurrentAddress) {
      await deliverCurrentCommandAfterNewSession({
        adapter,
        address: postDeliveryCurrentAddress,
        store,
        threadDisplay,
        markdown: responseParseMode === 'Markdown',
      });
    }
  }
}
