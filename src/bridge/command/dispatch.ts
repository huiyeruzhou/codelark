import fs from 'node:fs';
import {
  resolveCommandAlias,
} from './aliases.js';
import { getBridgeContext } from '../host/context.js';
import { deliverBridgeNotice, enqueueBridgeNotice } from '../../channels/delivery/feedback.js';
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
import { handleStopCommand } from './control.js';
import { buildHelpCommandResponse } from './help.js';
import {
  buildStartCommandResponse,
  handleLocalRuntimeSessionsCommand,
  handleClearSessionCommand,
  handleNewSessionCommand,
  handleThreadBindingCommand,
  handleThreadSwitchCommand,
  type SessionCommandBackgroundEffect,
} from './session-thread.js';
import {
  handleChangeDirectoryCommand,
  handleModeCommand,
  handleYoloCommand,
  handleModelCommandRequest,
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
  currentSessionCommonSettingDefinitions,
  currentSessionSettingDefinitions,
  handleSetCommand,
  handleSetFormCommand,
  SESSION_CONFIG_INHERIT_VALUE,
  setCommandSelectedGroup,
  settingConfigPath,
  settingFormName,
  type CurrentSessionConfigSection,
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
import { mergePatch } from '../../configuration/merge.js';
import type { ConfigPatch } from '../../configuration/schema.js';
import type { ConfigPath } from '../../configuration/fields.js';
import { resolveEffectiveRuntimeProvider, resolveSessionWorkingDirectoryPath } from '../session/support.js';
import { getSessionActiveRuntime, getSessionWorkingDirectory } from '../../domain/session-runtime.js';
import { listCursorAvailableModels } from '../../runtime/cursor/models.js';
import {
  attachCursorDesktopModelNotice,
  attachCursorModelPickerControls,
  CURSOR_DESKTOP_MODEL_CONTROL_NOTICE,
  extractCursorModelPageArg,
  sessionCursorModelOverride,
} from './cursor-model-picker.js';
import { resolveCursorCapabilities } from '../session/cursor-transport.js';
import {
  handleEveryCommand,
} from './every.js';
import {
  buildThenFormCommandResult,
  handleThenCommand,
} from './then.js';
import {
  buildEveryTaskFormCard,
} from './presentation/every.js';
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
import type { EveryTaskCardAction, ThenTaskCardAction } from './callbacks.js';
import { EVERY_TASK_FORM_COMMAND, parseCommandCallbackData } from './callbacks.js';
import {
  handleTerminalDispatchCommand,
  isTerminalRawInputCommand,
} from './dispatch-terminal.js';
import { validateThreadName } from '../session/command-use-cases/args.js';
import { requestCodexTuiSelectionViaPermissionBroker } from './codex-tui-selection.js';
import { cancelCodexDesktopRestart, consumeCodexDesktopRestart } from './codex-desktop-restart-confirmation.js';
import { restartCodexDesktop } from '../../runtime/codex/desktop-restart.js';

function describeReactionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractCardActionFormValue(raw: unknown): Record<string, unknown> | null {
  const root = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
  const event = root.event && typeof root.event === 'object' ? root.event as Record<string, any> : root;
  const action = event.action && typeof event.action === 'object' ? event.action as Record<string, any> : {};
  const formValue = action.form_value;
  return formValue && typeof formValue === 'object' ? formValue as Record<string, unknown> : null;
}

function extractCardActionMessageId(raw: unknown): string {
  const root = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
  const event = root.event && typeof root.event === 'object' ? root.event as Record<string, any> : root;
  const context = event.context && typeof event.context === 'object' ? event.context as Record<string, any> : {};
  const action = event.action && typeof event.action === 'object' ? event.action as Record<string, any> : {};
  const candidates = [
    context.open_message_id,
    context.message_id,
    event.open_message_id,
    event.message_id,
    root.open_message_id,
    root.message_id,
    action.open_message_id,
    action.message_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function fallbackThreadCardScopeForCallback(msg: InboundMessage): ThreadCardScope | undefined {
  const callbackData = typeof msg.callbackData === 'string' ? msg.callbackData : '';
  const parsed = callbackData ? parseCommandCallbackData(callbackData) : undefined;
  const commandText = parsed && 'commandText' in parsed ? parsed.commandText : '';
  if (commandText.startsWith('/current')) return 'current';
  if (commandText.startsWith('/set')) return 'set';
  if (commandText.startsWith('/every')) return 'every';
  if (commandText.startsWith('/then')) return 'then';
  return undefined;
}

function richCardUpdateMessageIdForCommand(msg: InboundMessage): string | undefined {
  const explicit = msg.callbackMessageId?.trim();
  if (explicit) return explicit;
  const extracted = extractCardActionMessageId(msg.raw);
  if (extracted) return extracted;
  const scope = fallbackThreadCardScopeForCallback(msg);
  if (!scope) return undefined;
  return getThreadTableMessageRecord(msg.address, scope)?.messageId || undefined;
}

function normalizeFormString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface BridgeCommandDispatchDeps {
  getActiveTask(sessionId: string): { abortController: AbortController } | undefined;
  forceStopSession?(sessionId: string, detail?: string): Promise<boolean>;
  cancelQueuedSessionMessages?(sessionId: string): void;
  recordInteractiveHealthEnd?(sessionId: string, outcome: 'completed' | 'failed' | 'aborted', detail?: string): void;
  cancelRuntimeWaits?(sessionId: string): void;
  reconcileMirrorSubscriptions?(): Promise<void>;
  bootstrapCodexThread?: import('./runtime-settings.js').RuntimeSettingsCommandDeps['bootstrapCodexThread'];
  restartKimiTmuxSession?: import('./runtime-settings.js').RuntimeSettingsCommandDeps['restartKimiTmuxSession'];
  restartCursorTmuxSession?: import('./runtime-settings.js').RuntimeSettingsCommandDeps['restartCursorTmuxSession'];
  restartZcodeTmuxSession?: import('./runtime-settings.js').RuntimeSettingsCommandDeps['restartZcodeTmuxSession'];
  diagnoseSessionHealth(sessionId: string): Promise<import('../health/runtime.js').SessionHealthDiagnosis | null>;
  diagnoseAllActiveSessions(): Promise<import('../health/runtime.js').SessionHealthDiagnosis[]>;
  scopedBinding?: ChannelChat | null;
  threadCardRefreshScope?: ThreadCardScope | null;
  threadCardSelectedId?: string | null;
  selectedEveryTaskId?: string | null;
  selectedEveryTaskAction?: EveryTaskCardAction | null;
  selectedThenTaskId?: string | null;
  selectedThenTaskAction?: ThenTaskCardAction | null;
  startEveryTask?(taskId: string): void;
  stopEveryTask?(taskId: string): void;
  startThenTask?(taskId: string): void;
  stopThenTask?(taskId: string): void;
  onBindingRemoved?(binding: ChannelChat): void;
  hotUpdateRunner?: HotUpdateRunner;
  hotUpdateCwd?: string;
  hotUpdateEnv?: NodeJS.ProcessEnv;
  hotUpdateLogRefreshIntervalMs?: number;
  shellRunner?: ShellCommandRunner;
  restartCodexDesktop?: typeof restartCodexDesktop;
  tmuxProviderAutoForward?: boolean;
  onTmuxProviderAutoForwarded?: () => Promise<void> | void;
  dispatchPostCommandMessage?(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<void>;
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
  const richCard = await buildCurrentCommandRichCardWithCursorModels({
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

async function buildCurrentCommandRichCardWithCursorModels(
  options: Parameters<typeof buildCurrentCommandRichCard>[0],
  requestedPage?: number,
): Promise<OutboundRichCard | undefined> {
  const card = buildCurrentCommandRichCard(options);
  if (!card || !options.binding) return card;
  const session = options.store.getSession(options.binding.bridgeSessionId);
  if (!session) return card;
  const section = options.configSection || options.previewRuntime || getSessionActiveRuntime(session) || 'codex';
  if (section !== 'cursor') return card;
  if (resolveCursorCapabilities(session).modelCatalog === 'unavailable') return attachCursorDesktopModelNotice(card);
  try {
    const models = await listCursorAvailableModels();
    return attachCursorModelPickerControls({
      card,
      models,
      target: 'session',
      selectedSlug: sessionCursorModelOverride(session.id),
      requestedPage,
      pageCommand: (page) => `/current-runtime cursor --cursor-model-page=${page}`,
      scopeSessionId: session.id,
      configuredLabel: '当前会话配置',
      controlIdPrefix: 'current_cursor',
    }).card;
  } catch (error) {
    return {
      ...card,
      sections: [...card.sections, { fields: [['Cursor 模型列表', '读取失败；仍可在下方手工填写 model slug']] }],
      footer: [...(card.footer || []), `Cursor 模型列表读取失败：${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function buildSetCommandRichCardWithCursorModels(
  selectedGroup: Parameters<typeof buildSetCommandRichCard>[0],
  address: ChannelAddress,
  requestedPage?: number,
): Promise<OutboundRichCard> {
  const card = buildSetCommandRichCard(selectedGroup, address);
  if (selectedGroup !== 'runtime.cursor') return card;
  try {
    const models = await listCursorAvailableModels();
    const configured = createConfigService({ migrate: false }).snapshot({ kind: 'global' }).config.runtime.cursor.model.trim() || undefined;
    return attachCursorModelPickerControls({
      card,
      models,
      target: 'global',
      selectedSlug: configured,
      requestedPage,
      pageCommand: (page) => `/set --group runtime.cursor --cursor-model-page=${page}`,
      configuredLabel: '全局默认配置',
      controlIdPrefix: 'set_cursor',
    }).card;
  } catch (error) {
    return {
      ...card,
      sections: [...card.sections, { fields: [['Cursor 模型列表', '读取失败；仍可在下方手工填写 model slug']] }],
      footer: [...(card.footer || []), `Cursor 模型列表读取失败：${error instanceof Error ? error.message : String(error)}`],
    };
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

function currentSettingFormValue(formValue: Record<string, unknown>, definition: SettingDefinition): string | undefined {
  const settingKey = definition.key;
  const keys = [
    settingFormName(definition),
    settingKey,
    ...(CURRENT_SETTING_LEGACY_FORM_KEYS[settingKey] || []),
  ];
  for (const key of keys) {
    const rawValue = formValue[key];
    if (typeof rawValue === 'string') {
      const normalized = rawValue.trim();
      return normalized === SESSION_CONFIG_INHERIT_VALUE ? '' : normalized;
    }
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

function scheduleCommandBackgroundEffect(
  effect: SessionCommandBackgroundEffect,
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
): void {
  void effect.run().catch((error) => {
    console.warn('[bridge-command] Background command effect failed:', {
      context: effect.context,
      error: describeReactionError(error),
    });
    enqueueBridgeNotice(adapter, address, `${effect.failureNotice}\n\n${describeReactionError(error)}`, {
      audit: true,
    });
  });
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
}): Promise<{ response: string; richCard?: OutboundRichCard; backgroundEffects?: SessionCommandBackgroundEffect[] }> {
  const binding = options.binding || router.resolve(options.msg.address);
  const session = options.store.getSession(binding.bridgeSessionId);
  if (!session) return { response: '当前会话不存在，无法保存配置。' };
  const formValue = extractCardActionFormValue(options.msg.raw);
  if (!formValue) return { response: '没有读取到卡片表单内容，请刷新 `/current` 后重试。' };

  const activeRuntime = getSessionActiveRuntime(session) || 'codex';
  const submittedSection = parseCurrentConfigSectionArg(options.args) || activeRuntime;
  const cursorModelConfiguration = submittedSection === 'cursor'
    ? resolveCursorCapabilities(session).modelConfiguration : undefined;
  const responses: string[] = [];
  const backgroundEffects: SessionCommandBackgroundEffect[] = [];
  const service = createConfigService({ migrate: false });
  const scope = { kind: 'session' as const, sessionId: session.id };
  let currentConfig = service.snapshot(scope).config;
  const patch: ConfigPatch = {};
  const unsetPaths: ConfigPath[] = [];
  const updatedSettings: SettingDefinition[] = [];
  const fallbackSettings: SettingDefinition[] = [];

  const name = submittedSection === 'common' ? normalizeFormString(formValue.clk_name || formValue.name) : '';
  if (name && name !== (session.name || '').trim()) {
    const parsed = validateThreadName(name);
    if (!parsed.ok) return { response: parsed.message };
  }
  const cwd = submittedSection === 'common' ? normalizeFormString(formValue.clk_cwd || formValue.cwd) : '';
  if (cwd && cwd !== getSessionWorkingDirectory(session)) {
    const resolved = resolveSessionWorkingDirectoryPath(cwd, getSessionWorkingDirectory(session));
    if (!resolved.ok) return { response: `配置未保存：${resolved.message}` };
    try {
      if (!fs.statSync(resolved.workDir).isDirectory()) return { response: '配置未保存：目标不是目录。' };
    } catch (error) {
      return { response: `配置未保存：${formatCurrentConfigWriteError(error)}` };
    }
    patch.session = { workspace: resolved.workDir };
    responses.push(`工作目录: ${resolved.workDir}`);
  }

  const definitions = submittedSection === 'common'
    ? currentSessionCommonSettingDefinitions() : currentSessionSettingDefinitions(submittedSection);
  for (const definition of definitions) {
    const rawValue = currentSettingFormValue(formValue, definition);
    if (rawValue === undefined) continue;
    const configPath = settingConfigPath(definition);
    if (cursorModelConfiguration === 'external'
      && (configPath === 'runtime.cursor.model' || configPath === 'runtime.cursor.reasoningEffort')) {
      const currentValue = definition.read(currentConfig);
      const changesValue = rawValue
        ? rawValue !== (currentValue === '-' || currentValue === 'auto' ? '' : currentValue)
        : service.resolve(configPath, scope).source === 'session';
      if (changesValue) return { response: `配置未保存：${CURSOR_DESKTOP_MODEL_CONTROL_NOTICE}` };
    }
    if (!rawValue) {
      if (service.resolve(configPath, scope).source === 'session') {
        unsetPaths.push(configPath);
        fallbackSettings.push(definition);
      }
      continue;
    }
    const currentValue = definition.read(currentConfig);
    if (rawValue === (currentValue === '-' || currentValue === 'auto' ? '' : currentValue)) continue;
    const written = definition.write(rawValue, currentConfig);
    if (!written.ok) return { response: `配置未保存：${definition.tomlPath} ${written.message}\n\n用法：${definition.usage}` };
    mergePatch(patch, written.patch);
    mergePatch(currentConfig, written.patch);
    updatedSettings.push(definition);
  }
  try {
    if (Object.keys(patch).length || unsetPaths.length) service.update(scope, patch, unsetPaths);
  } catch (error) {
    return { response: `配置未保存：${formatCurrentConfigWriteError(error)}` };
  }
  currentConfig = service.snapshot(scope).config;
  if (name && name !== (session.name || '').trim()) {
    options.threadDisplay.renameBinding(binding, name);
    responses.push(`name: ${name}`);
    if (binding.chatKind === 'group' && options.adapter.renameGroupChat) {
      backgroundEffects.push({
        context: `rename group chat ${binding.chatId}`,
        failureNotice: `当前会话标题已保存，但群聊名称同步失败。可稍后重试。`,
        run: async () => { await options.adapter.renameGroupChat!(binding.chatId, name); },
      });
    }
  }
  const refreshedBinding = options.store.getChannelChat(options.msg.address.channelType, options.msg.address.chatId) || binding;
  return {
    response: responses.length > 0 || updatedSettings.length > 0 || fallbackSettings.length > 0
      ? [
          '已保存当前会话配置；当前任务继续使用原配置。',
          session.runtime?.codex?.appServerEndpoint ? '新配置从下一次由 IM 发起的新轮次开始生效。'
            : resolveEffectiveRuntimeProvider(session, binding).provider === 'tmux'
              ? '已启动的旧 TUI 需通过 `/p tmux` 确认结束并重启后采用新配置。' : '新配置从下一次执行开始生效。',
          ...responses,
          ...(updatedSettings.length > 0 ? [buildSettingsFields(currentConfig, updatedSettings).map(([label, value]) => `${label}: ${value}`).join('\n')] : []),
          ...(fallbackSettings.length > 0 ? [
            '已回退上层配置：\n'
              + buildSettingsFields(currentConfig, fallbackSettings).map(([label, value]) => `${label}: ${value}`).join('\n'),
          ] : []),
        ].filter(Boolean).join('\n\n')
      : '没有检测到需要保存的配置变更。',
    richCard: await buildCurrentCommandRichCardWithCursorModels({
      msg: options.msg,
      binding: refreshedBinding,
      store: options.store,
      threadDisplay: options.threadDisplay,
      configSection: submittedSection,
    }),
    backgroundEffects,
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
  const cursorPage = extractCursorModelPageArg(options.args);
  if (cursorPage.invalid) return { response: 'Cursor 模型分页参数无效，请重新打开配置卡。' };
  const section = parseCurrentConfigSectionArg(cursorPage.args);
  if (!section) {
    return { response: '请选择有效配置分栏：common、codex、claude、kimi、cursor 或 zcode。' };
  }

  const session = options.store.getSession(binding.bridgeSessionId);
  if (!session) return { response: '当前会话不存在，无法切换 runtime。' };

  return {
    response: `已打开 ${section === 'common' ? '通用' : section} 配置。`,
    richCard: await buildCurrentCommandRichCardWithCursorModels({
      msg: options.msg, binding, store: options.store,
      threadDisplay: options.threadDisplay, configSection: section,
    }, cursorPage.page),
  };
}

function parseCurrentRuntimeArg(args: string): 'codex' | 'claude' | 'kimi' | 'cursor' | 'zcode' | undefined {
  const section = parseCurrentConfigSectionArg(args);
  return section === 'common' ? undefined : section;
}

function parseCurrentConfigSectionArg(args: string): CurrentSessionConfigSection | undefined {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const runtime = parts[0] === 'runtime' ? parts[1] : parts[0];
  return runtime === 'common' || runtime === 'codex' || runtime === 'claude' || runtime === 'kimi' || runtime === 'cursor' || runtime === 'zcode'
    ? runtime
    : undefined;
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
    enqueueBridgeNotice(adapter, msg.address, '命令被拒绝：检测到无效输入。', {
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
  let postDeliveryCurrentAddress: ChannelAddress | undefined;
  let postDeliveryUserMessages: InboundMessage[] = [];
  const backgroundEffects: SessionCommandBackgroundEffect[] = [];
  const currentBinding = deps.scopedBinding || store.getChannelChat(msg.address.channelType, msg.address.chatId);
  const commandBinding = currentBinding;

  switch (command) {
    case '/start':
      response = buildStartCommandResponse();
      break;

    case '/new': {
      if (!args.trim() && !msg.address.cloudDocument) {
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
        postDeliveryUserMessages = (result.postDeliveryUserMessages || []).map((postDeliveryUserMessage) => ({
          address: postDeliveryUserMessage.address,
          text: postDeliveryUserMessage.text,
          messageId: postDeliveryUserMessage.messageId,
          timestamp: Date.now(),
        }));
        backgroundEffects.push(...(result.backgroundEffects || []));
      }
      break;
    }

    case '/new-form':
      response = '创建群聊会话：如果没有看到表单，请直接发送 `/new <名称> <目录>`。';
      responseRichCard = buildNewSessionFormCard(commandBinding
        ? getSessionWorkingDirectory(store.getSession(commandBinding.bridgeSessionId)) || ''
        : getWorkspaceRoot());
      break;

    case EVERY_TASK_FORM_COMMAND:
      response = '新建 /every：如果没有看到表单，请直接发送 `/every <数字><s|m|h|d> <prompt>`。';
      responseRichCard = buildEveryTaskFormCard();
      break;

    case '/then-form': {
      const result = buildThenFormCommandResult();
      response = result.response;
      responseRichCard = result.richCard;
      break;
    }

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
      backgroundEffects.push(...(result.backgroundEffects || []));
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
      backgroundEffects.push(...(result.backgroundEffects || []));
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

    case '/yolo':
    case '/mode': {
      response = (command === '/yolo' ? handleYoloCommand : handleModeCommand)({
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
      const isTmuxProviderStart = /^tmux(?:\s|$)/i.test(args.trim());
      const result = await handleProviderCommand({
        msg,
        args,
        currentBinding,
        store,
        deps: {
          ...deps,
          getActiveTask: deps.getActiveTask,
          notifyBackgroundOperation: async (message: string, noticeOptions?: { force?: boolean }) => {
            if (isTmuxProviderStart && noticeOptions?.force !== true) {
              return;
            }
            enqueueBridgeNotice(adapter, msg.address, message, {
              replyToMessageId: msg.messageId,
              audit: false,
            });
          },
          requestCodexTuiSelection: async (selectionPrompt, requestOptions) => {
            return requestCodexTuiSelectionViaPermissionBroker({
              adapter,
              msg,
              selectionPrompt,
              sessionId: requestOptions.sessionId,
              requestScope: 'provider-startup',
              reasonContext: 'during /p tmux startup',
              replyToMessageId: requestOptions.replyToMessageId,
            });
          },
        },
        markdown: responseParseMode === 'Markdown',
      });
      response = result.response;
      responseRichCard = result.richCard;
      break;
    }

    case '/codex-desktop-restart': {
      const cancelId = args.match(/^--cancel=([0-9a-f-]+)$/i)?.[1];
      if (cancelId) {
        response = cancelCodexDesktopRestart(cancelId)
          ? '已取消重启，Codex Desktop 和当前会话均未改变。'
          : '这个重启按钮已失效或已使用。';
        break;
      }
      const confirmId = args.match(/^--confirm=([0-9a-f-]+)$/i)?.[1];
      const session = currentBinding ? store.getSession(currentBinding.bridgeSessionId) : null;
      const pending = confirmId && currentBinding && session
        ? consumeCodexDesktopRestart(confirmId, currentBinding, session)
        : undefined;
      if (!pending) {
        response = '这个重启按钮已失效、已使用，或当前聊天已切换会话。';
        break;
      }
      let restarted: Awaited<ReturnType<typeof restartCodexDesktop>>;
      try {
        restarted = await (deps.restartCodexDesktop || restartCodexDesktop)();
      } catch (error) {
        response = `Codex Desktop 自动重启失败；未重试原输入。\n\n${describeReactionError(error)}`;
        break;
      }
      response = pending.retryText
        ? `Codex Desktop 已通过共享 app-server 环境重启。正在自动重试原输入。\n\n${restarted.output}`
        : `Codex Desktop 已通过共享 app-server 环境重启。请重新发送含附件的输入。\n\n${restarted.output}`;
      if (pending.retryText) {
        postDeliveryUserMessages.push({
          address: msg.address,
          text: pending.retryText,
          contextText: pending.retryContextText,
          messageId: `codex-desktop-retry:${confirmId}`,
          timestamp: Date.now(),
        });
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
      const cursorPage = extractCursorModelPageArg(args);
      if (cursorPage.invalid) {
        response = 'Cursor 模型分页参数无效，请重新发送 `/set --group runtime.cursor`。';
        break;
      }
      const setArgs = cursorPage.args;
      const formValue = extractCardActionFormValue(msg.raw);
      if (formValue) {
        const result = handleSetFormCommand({
          args: setArgs,
          formValue,
          markdown: responseParseMode === 'Markdown',
          address: msg.address,
        });
        response = result.response;
        responseRichCard = result.richCard
          ? await buildSetCommandRichCardWithCursorModels(setCommandSelectedGroup(setArgs), msg.address, cursorPage.page)
          : undefined;
        setConfigCard = true;
      } else {
        response = handleSetCommand({
          args: setArgs,
          markdown: responseParseMode === 'Markdown',
        });
        if (!setArgs.trim() || setArgs.trim().startsWith('--group')) {
          responseRichCard = await buildSetCommandRichCardWithCursorModels(
            setCommandSelectedGroup(setArgs),
            msg.address,
            cursorPage.page,
          );
          setConfigCard = true;
        }
      }
      break;
    }

    case '/model': {
      const result = await handleModelCommandRequest({
        msg,
        args,
        currentBinding,
        store,
        markdown: responseParseMode === 'Markdown',
      });
      response = result.response;
      responseRichCard = result.richCard;
      break;
    }

    case '/every': {
      const session = commandBinding ? store.getSession(commandBinding.bridgeSessionId) : null;
      const formValue = extractCardActionFormValue(msg.raw);
      const result = handleEveryCommand({
        msg,
        args,
        formValue,
        session,
        store,
        deps: {
          selectedEveryTaskId: deps.selectedEveryTaskId,
          selectedEveryTaskAction: deps.selectedEveryTaskAction,
          startEveryTask: deps.startEveryTask,
          stopEveryTask: deps.stopEveryTask,
        },
        markdown: responseParseMode === 'Markdown',
      });
      response = result.response;
      responseRichCard = result.richCard;
      threadTableCardScope = result.threadTableCardScope;
      break;
    }

    case '/then': {
      const session = commandBinding ? store.getSession(commandBinding.bridgeSessionId) : null;
      const formValue = extractCardActionFormValue(msg.raw);
      const result = handleThenCommand({
        msg,
        args,
        formValue,
        session,
        store,
        deps: {
          startThenTask: deps.startThenTask,
          stopThenTask: deps.stopThenTask,
          isSessionActive: (sessionId) => Boolean(deps.getActiveTask(sessionId)),
          selectedThenTaskId: deps.selectedThenTaskId,
          selectedThenTaskAction: deps.selectedThenTaskAction,
        },
        markdown: responseParseMode === 'Markdown',
      });
      response = result.response;
      responseRichCard = result.richCard;
      threadTableCardScope = result.threadTableCardScope;
      if (result.startTaskId) {
        afterDelivery = () => {
          deps.startThenTask?.(result.startTaskId!);
        };
      }
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
      const cursorPage = extractCursorModelPageArg(args);
      if (cursorPage.invalid) {
        response = 'Cursor 模型分页参数无效，请重新发送 `/current cursor`。';
        break;
      }
      const configSection = parseCurrentConfigSectionArg(cursorPage.args);
      const previewRuntime = configSection === 'common' ? undefined : configSection;
      response = handleCurrentCommand({
        msg,
        binding: commandBinding,
        store,
        threadDisplay,
        markdown: responseParseMode === 'Markdown',
        previewRuntime,
      });
      responseRichCard = await buildCurrentCommandRichCardWithCursorModels({
        msg,
        binding: commandBinding,
        store,
        threadDisplay,
        previewRuntime,
        configSection,
      }, cursorPage.page);
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
      backgroundEffects.push(...(result.backgroundEffects || []));
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

    case '/help':
      responseParseMode = getFeedbackParseMode(adapter.channelType);
      response = buildHelpCommandResponse();
      break;

    default:
      response = [
        `未知命令：${rawCommand}`,
        '发送 /h 或 /help 查看可用命令。',
        `如果要把 slash 命令发送给 Agent，请在开头多写一个 \`/\`，例如 \`/${rawCommand}\` 会发送 \`${rawCommand}\`。`,
      ].join('\n');
  }

  if (response) {
    const richCardUpdateMessageId = richCardUpdateMessageIdForCommand(msg);
    const delivery = enqueueBridgeNotice(adapter, responseAddress, response, {
      replyToMessageId: responseAddress.channelType === msg.address.channelType && responseAddress.chatId === msg.address.chatId
        ? msg.messageId
        : undefined,
      audit: auditResponse,
      richCard: responseRichCard,
      richCardUpdateMessageId,
    });
    void delivery.completion.then(async (result) => {
      if (!result.ok) return;
      const threadCardMessageId = richCardUpdateMessageId || result.messageId;
      if (setConfigCard && threadCardMessageId) {
        saveThreadTableMessageRecord(responseAddress, 'set', threadCardMessageId);
      } else if (threadTableCardScope && threadCardMessageId) {
        await persistAndPinLatestThreadTableMessage(adapter, responseAddress, threadTableCardScope, threadCardMessageId);
      }
      if (afterDelivery) {
        await afterDelivery(result.messageId);
      }
      if (postDeliveryCurrentAddress) {
        await deliverCurrentCommandAfterNewSession({
          adapter,
          address: postDeliveryCurrentAddress,
          store,
          threadDisplay,
          markdown: responseParseMode === 'Markdown',
        });
      }
      for (const postDeliveryUserMessage of postDeliveryUserMessages) {
        await deps.dispatchPostCommandMessage?.(adapter, postDeliveryUserMessage);
      }
    }).catch((error) => {
      console.warn('[bridge-command] Post-delivery command work failed:', describeReactionError(error));
    });
  }

  for (const effect of backgroundEffects) {
    scheduleCommandBackgroundEffect(effect, adapter, msg.address);
  }
}
