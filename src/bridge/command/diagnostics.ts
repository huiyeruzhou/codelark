import fs from 'node:fs';
import path from 'node:path';

import { createConfigService } from '../../configuration/service.js';
import { listBindingsForChat } from '../session/registry.js';
import {
  buildCommandFields,
  formatCommandPath,
  formatHistoryRole,
  formatMirrorStatus,
  formatReasoningEffort,
  formatRuntimeStatus,
  formatStoredMessageContent,
  truncateHistoryContent,
} from './presentation.js';
import {
  buildHealthCommandResponse,
  buildHealthListResponse,
} from './diagnostics-presentation.js';
import { enqueueBridgeNotice, enqueueResponse } from '../../channels/delivery/feedback.js';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { BridgeSession, BridgeStore } from '../../domain/index.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';
import { sanitizeInput } from '../../shared/security/validators.js';
import type { CommandThreadDisplay } from './thread-display.js';
import { getCodexThreadId } from '../turn/turn-classifier.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeSessionId,
  getSessionCodexTitle,
  getSessionKimiSessionId,
  getSessionWorkingDirectory,
} from '../../domain/session-runtime.js';
import type { ChannelChat, InboundMessage, OutboundAttachment, OutboundRichCard } from '../../domain/index.js';
import {
  buildLargeFileUploadConfirmationCard,
  clearPendingLargeFileUpload,
  consumePendingLargeFileUpload,
  formatLargeFileUploadSize,
  LARGE_FILE_UPLOAD_THRESHOLD_BYTES,
  registerPendingLargeFileUpload,
} from './file-upload-confirmations.js';
import {
  expandHomePath,
  formatDisplayedModel,
  getCodexSessionByThreadIdSafe,
  getHistoryMessageLimit,
  resolveClaudeRuntimeConfig,
  resolveDisplayedModel,
  resolveEffectiveNetworkAccess,
  resolveEffectiveReasoningEffort,
  resolveEffectiveSandboxMode,
  resolveKimiRuntimeConfig,
} from '../session/support.js';
import type { RuntimeAgent } from '../../domain/session.js';
import {
  formatNetworkAccess,
  formatSessionCodexProvider,
  formatSessionMode,
  resolveLocalCodexThreadId,
} from './runtime-settings.js';
import { getGlobalCodexModel } from '../session/global-config.js';
import { stripLegacySessionPrefix } from '../session/display/session-title.js';
import { resolveSessionTranscriptFile } from '../session/transcript-source.js';
import { buildCommandCallbackData, buildThreadCardUpdateKey } from './callbacks.js';
import {
  runtimeSettingDefinitions,
  settingFormLabel,
  settingFormInput,
  settingFormSelect,
} from './global-settings.js';
import { readConfiguredCodexModel } from '../../runtime/codex/models.js';

function parseHistoryLimitArg(raw: string): number | null {
  const token = raw.trim();
  if (!/^\d+$/.test(token)) return null;
  const parsed = Number(token);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) return null;
  return parsed;
}

function buildHistoryUsage(): string {
  return [
    '用法：/his [msg|raw] [1-20] | /his json | /his limit <1-20>',
    '示例：',
    '- /his',
    '- /his 5',
    '- /his msg 12',
    '- /his raw 5',
    '- /his json',
    '- /his limit 12',
  ].join('\n');
}

function currentTag(value: string, color: 'green' | 'blue' | 'yellow' | 'red' | 'grey' | 'orange' = 'green'): string {
  return `<text_tag color='${color}'>${value}</text_tag>`;
}

function currentThreadTagValue(threadId: string): string {
  return threadId.length > 18 ? `${threadId.slice(0, 8)}...${threadId.slice(-6)}` : threadId;
}

function formatHistoryLimitLabel(limit: number, configuredLimit: number): string {
  return limit === configuredLimit ? `配置 ${configuredLimit}` : `本次 ${limit}（配置 ${configuredLimit}）`;
}

function runtimeLabel(runtime: RuntimeAgent): string {
  if (runtime === 'claude') return 'Claude Code';
  if (runtime === 'kimi') return 'Kimi Code';
  return 'Codex';
}

function runtimeIdentityFieldName(runtime: RuntimeAgent): string {
  if (runtime === 'claude') return 'claude_session_id';
  if (runtime === 'kimi') return 'kimi_session_id';
  return 'codex_thread_id';
}

function runtimeIdentityMissingLabel(runtime: RuntimeAgent): string {
  if (runtime === 'claude' || runtime === 'kimi') return `${runtimeLabel(runtime)} session id 未绑定`;
  return 'Codex thread id 未绑定';
}

function currentRuntimeFieldLabel(runtime: RuntimeAgent, settingKey: string): string {
  const definition = runtimeSettingDefinitions(runtime, { sessionWritableOnly: true })
    .find((entry) => entry.key === settingKey);
  return definition ? settingFormLabel(definition) : settingKey;
}

function currentRuntimeFields(
  runtime: RuntimeAgent,
  binding: ChannelChat,
  session: BridgeSession,
): Array<[string, string]> {
  if (runtime === 'kimi') {
    const kimiConfig = resolveKimiRuntimeConfig(session, binding);
    return [
      [currentRuntimeFieldLabel('kimi', 'kimiDefaultModel'), kimiConfig.model || 'default'],
      [currentRuntimeFieldLabel('kimi', 'kimiProvider'), kimiConfig.provider],
    ];
  }
  if (runtime === 'claude') {
    const claudeConfig = resolveClaudeRuntimeConfig(session, binding);
    const yoloMode = createConfigService({ migrate: false })
      .get<'off' | 'on' | 'yolo'>('runtime.claude.yoloMode', { kind: 'session', sessionId: session.id });
    return [
      [currentRuntimeFieldLabel('claude', 'claudeDefaultModel'), claudeConfig.model || 'default'],
      [currentRuntimeFieldLabel('claude', 'claudeMode'), yoloMode === 'on' || yoloMode === 'yolo' ? 'yolo' : 'normal'],
      [currentRuntimeFieldLabel('claude', 'claudeProvider'), claudeConfig.provider || 'tmux'],
      [currentRuntimeFieldLabel('claude', 'claudeReasoningEffort'), claudeConfig.reasoningEffort || 'default'],
      [currentRuntimeFieldLabel('claude', 'claudeIdleTimeoutMinutes'), `${claudeConfig.idleTimeoutMinutes ?? 0}`],
    ];
  }

  const currentModel = resolveDisplayedModel(
    binding,
    session,
    getGlobalCodexModel(),
    readConfiguredCodexModel(),
  );
  return [
    [currentRuntimeFieldLabel('codex', 'defaultModel'), formatDisplayedModel(currentModel)],
    [currentRuntimeFieldLabel('codex', 'defaultMode'), formatSessionMode(binding, session)],
    [currentRuntimeFieldLabel('codex', 'defaultProvider'), formatSessionCodexProvider(session, binding)],
    [currentRuntimeFieldLabel('codex', 'codexSandboxMode'), resolveEffectiveSandboxMode(session, binding)],
    [currentRuntimeFieldLabel('codex', 'codexNetworkAccess'), formatNetworkAccess(resolveEffectiveNetworkAccess(session, binding))],
    [currentRuntimeFieldLabel('codex', 'codexReasoningEffort'), formatReasoningEffort(resolveEffectiveReasoningEffort(session, binding))],
  ];
}

export interface DiagnosticsCommandDeps {
  diagnoseSessionHealth(sessionId: string): Promise<import('../health/runtime.js').SessionHealthDiagnosis | null>;
  diagnoseAllActiveSessions(): Promise<import('../health/runtime.js').SessionHealthDiagnosis[]>;
}

function buildHistoryMessagesText(
  messages: Array<{ role: string; content: string }>,
  options: {
    title: string;
    source: string;
    limit: number;
    configuredLimit: number;
    markdown: boolean;
    assistantRoleLabel: string;
  },
): string {
  const header = buildCommandFields(
    '最近对话（msg）',
    [
      ['标题', options.title],
      ['来源', options.source],
      ['返回条数', `${messages.length} / ${formatHistoryLimitLabel(options.limit, options.configuredLimit)}`],
    ],
    ['`/his raw 5` 查看指定条数的解析文本；`/his json` 直接发送原始 session JSONL 文件；`/his limit 12` 修改默认返回条数。'],
    options.markdown,
  );

  const body = messages.map((message, index) => {
    const role = formatHistoryRole(message.role, options.assistantRoleLabel);
    const content = truncateHistoryContent(formatStoredMessageContent(message.content));
    if (options.markdown) {
      return `### ${index + 1}. ${role}\n\n${buildFencedCodeBlock(content, 'text')}`;
    }
    return `${index + 1}. ${role}\n${content}`;
  }).join('\n\n');

  return [header, body].join('\n\n').trim();
}

function buildHistoryMessagesRichCard(
  messages: Array<{ role: string; content: string }>,
  options: {
    title: string;
    source: string;
    limit: number;
    configuredLimit: number;
    assistantRoleLabel: string;
  },
): OutboundRichCard {
  return {
    title: '最近对话',
    subtitle: '`/his raw 5` 查看指定条数的解析文本；`/his json` 发送原始 session JSONL；`/his limit 12` 修改默认返回条数。',
    template: 'blue',
    sections: [
      {
        title: '概览',
        fields: [
          ['标题', options.title],
          ['来源', options.source],
          ['返回条数', `${messages.length} / ${formatHistoryLimitLabel(options.limit, options.configuredLimit)}`],
        ],
      },
      ...messages.map((message, index) => ({
        title: `${index + 1}. ${formatHistoryRole(message.role, options.assistantRoleLabel)}`,
        markdown: truncateHistoryContent(formatStoredMessageContent(message.content), 1600),
      })),
    ],
    maxSections: Math.max(1, messages.length + 1),
  };
}

function filterHistoryMessagesForRuntime(
  messages: Array<{ role: string; content: string }>,
  runtime: RuntimeAgent | undefined,
): Array<{ role: string; content: string }> {
  if (runtime !== 'claude' && runtime !== 'kimi') return messages;
  return messages.filter((message) => message.role !== 'user');
}

export async function handleHealthCommand(options: {
  args: string;
  binding: ChannelChat | null;
  deps: DiagnosticsCommandDeps;
  markdown: boolean;
}): Promise<string> {
  const args = options.args.trim();
  if (args === 'all') {
    const diagnoses = await options.deps.diagnoseAllActiveSessions();
    return diagnoses.length > 0
      ? buildHealthListResponse(diagnoses, options.markdown)
      : '当前没有检测到运行中的会话。';
  }

  const explicitTargetSessionId = args;
  const targetSessionId = explicitTargetSessionId || options.binding?.bridgeSessionId;
  if (!targetSessionId) {
    return '当前聊天还没有绑定会话。先发送消息创建会话，或先用 `/t 1` 接管本地会话。';
  }
  const diagnosis = await options.deps.diagnoseSessionHealth(targetSessionId);
  if (!diagnosis) {
    return `没有找到会话 ${targetSessionId}。`;
  }
  return buildHealthCommandResponse(
    explicitTargetSessionId ? '指定会话健康检查' : '当前会话健康检查',
    diagnosis,
    options.markdown,
  );
}

export function handleCurrentCommand(options: {
  msg: InboundMessage;
  binding: ChannelChat | null;
  store: BridgeStore;
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
  previewRuntime?: RuntimeAgent;
}): string {
  const binding = options.binding;
  if (!binding) {
    return buildCommandFields(
      '当前会话',
      [],
      ['当前聊天还没有绑定会话。可先发送 `/t` 查看本地会话，再用 `/t 1` 接管；或发送 `/new proj1` / `/new 绝对路径` 创建项目会话。'],
      options.markdown,
    );
  }

  const session = resolveCurrentCardSession(options.store, binding, options.previewRuntime);
  if (!session) {
    return buildCommandFields(
      '当前会话',
      [
        ['Session', binding.bridgeSessionId],
        ['codex-thread-id', '-'],
        ['目录', '-'],
      ],
      ['当前聊天绑定的会话已经不存在。可用 `/t` 接管本地会话，或用 `/new proj1` / `/new 绝对路径` 创建新会话。'],
      options.markdown,
    );
  }

  const activeRuntime = options.previewRuntime || getSessionActiveRuntime(session) || 'codex';
  const displayBinding = binding.bridgeSessionId === session.id ? binding : { ...binding, bridgeSessionId: session.id };
  const codexThreadId = getCodexThreadId(session, binding);
  const claudeSessionId = getSessionClaudeSessionId(session) || '';
  const localCodexThreadId = resolveLocalCodexThreadId(session, binding, 'current command');
  const kimiSessionId = getSessionKimiSessionId(session) || '';
  const localRuntimeThreadId = activeRuntime === 'kimi'
    ? kimiSessionId
    : activeRuntime === 'claude' ? claudeSessionId : localCodexThreadId;
  const threadInfo = options.threadDisplay.binding(displayBinding);
  const codexTitle = getSessionCodexTitle(session)
    || (codexThreadId ? getCodexSessionByThreadIdSafe(codexThreadId, 'current codex title')?.title : '')
    || '';
  const sessionName = session.name?.trim() ? stripLegacySessionPrefix(session.name) : '';
  const chatBindingCount = listBindingsForChat(options.store, options.msg.address.channelType, options.msg.address.chatId).length;
  const sessionKind = session?.session_type === 'draft'
    ? '临时草稿线程'
    : '普通会话';
  const runtimeFields = currentRuntimeFields(activeRuntime, binding, session);
  return buildCommandFields(
    options.previewRuntime ? `当前会话（配置 ${runtimeLabel(activeRuntime)}）` : '当前会话',
    [
      ['标题', threadInfo.title],
      ['name', sessionName || '-'],
      ['runtime', runtimeLabel(activeRuntime)],
      ...(activeRuntime === 'kimi'
        ? [
          ['kimi_session_id', kimiSessionId || '-'] as [string, string],
        ]
        : activeRuntime === 'claude'
        ? [
          ['claude_session_id', claudeSessionId || '-'] as [string, string],
        ]
        : [
          ['codex_title', codexTitle || '-'] as [string, string],
          ['codex-thread-id', codexThreadId || '-'] as [string, string],
        ]),
      ['当前 binding', options.threadDisplay.bindingShortId(displayBinding)],
      ['聊天绑定数', `${chatBindingCount}`],
      ['目录', formatCommandPath(getSessionWorkingDirectory(session))],
      ...runtimeFields,
      ['类型', sessionKind],
      ['运行状态', formatRuntimeStatus(session)],
      ['共享镜像', formatMirrorStatus(session)],
    ],
    [
      localRuntimeThreadId
        ? `当前聊天已绑定到一条共享 ${runtimeLabel(activeRuntime)} 会话，直接发送消息即可继续。`
        : session?.session_type === 'draft'
          ? '当前聊天正在使用临时草稿线程（等同 `/t 0`）。可直接发送消息，或用 `/t` / `/new proj1` / `/new 绝对路径` 切换到正式会话。'
          : '当前聊天正在使用 IM 会话。可直接发送消息继续；如需接管本地会话，可先发送 `/t`，再用 `/t 1` 接管。',
      '发送 `/t` 可查看全局本地会话表；绿色表示当前聊天绑定，灰色表示其他聊天已绑定。',
    ],
    options.markdown,
  );
}

export function buildCurrentCommandRichCard(options: {
  msg: InboundMessage;
  binding: ChannelChat | null;
  store: BridgeStore;
  threadDisplay: CommandThreadDisplay;
  previewRuntime?: RuntimeAgent;
}): OutboundRichCard | undefined {
  const binding = options.binding;
  if (!binding) return undefined;
  const session = resolveCurrentCardSession(options.store, binding, options.previewRuntime);
  if (!session) return undefined;

  const activeRuntime = options.previewRuntime || getSessionActiveRuntime(session) || 'codex';
  const runtimeDisplayLabel = runtimeLabel(activeRuntime);
  const displayBinding = binding.bridgeSessionId === session.id ? binding : { ...binding, bridgeSessionId: session.id };
  const codexThreadId = getCodexThreadId(session, binding);
  const claudeSessionId = getSessionClaudeSessionId(session) || '';
  const kimiSessionId = getSessionKimiSessionId(session) || '';
  const runtimeThreadId = activeRuntime === 'kimi' ? kimiSessionId : activeRuntime === 'claude' ? claudeSessionId : codexThreadId;
  const threadInfo = options.threadDisplay.binding(displayBinding);
  const codexTitle = getSessionCodexTitle(session)
    || (codexThreadId ? getCodexSessionByThreadIdSafe(codexThreadId, 'current card codex title')?.title : '')
    || '';
  const sessionName = session.name?.trim() ? stripLegacySessionPrefix(session.name) : '';
  const runtimeConfig = createConfigService({ migrate: false }).snapshot({ kind: 'session', sessionId: session.id }).config;
  const runtimeDefinitions = runtimeSettingDefinitions(activeRuntime, { sessionWritableOnly: true });
  const formSelects = runtimeDefinitions
    .filter((definition) => definition.control === 'select')
    .map((definition) => settingFormSelect(definition, runtimeConfig));
  const runtimeInputs = runtimeDefinitions
    .filter((definition) => definition.control === 'input')
    .map((definition) => settingFormInput(definition, runtimeConfig));
  const statusColor = session.runtime_status === 'running' || session.runtime_status === 'queued' ? 'yellow' : 'green';
  const mirrorColor = session.mirror_status === 'watching' ? 'blue' : 'grey';
  const sessionKind = session.session_type === 'draft' ? '临时草稿线程' : '普通会话';
  const runtimeSelect: NonNullable<OutboundRichCard['selects']>[number] = {
    id: 'cur_runtime',
    placeholder: 'runtime',
    selectedCallbackData: buildCommandCallbackData(`/current-runtime ${activeRuntime}`),
	    options: [
	      { text: 'Codex', callbackData: buildCommandCallbackData('/current-runtime codex') },
	      { text: 'Claude Code', callbackData: buildCommandCallbackData('/current-runtime claude') },
	      { text: 'Kimi Code', callbackData: buildCommandCallbackData('/current-runtime kimi') },
	    ],
	  };
  return {
    title: `${runtimeDisplayLabel} ${activeRuntime === 'codex' ? codexTitle || threadInfo.title : threadInfo.title}`,
    subtitle: runtimeThreadId
      ? `${runtimeIdentityFieldName(activeRuntime)}: ${runtimeThreadId}`
      : runtimeIdentityMissingLabel(activeRuntime),
    template: 'green',
    updateKey: buildThreadCardUpdateKey('current', options.msg.address.channelType, options.msg.address.chatId),
    updateTtlMs: null,
    tags: [activeRuntime, runtimeThreadId ? currentThreadTagValue(runtimeThreadId) : 'no-thread'],
    tagColor: 'green',
    selects: [runtimeSelect],
    sections: [{
      fields: [
        ['类型', currentTag(sessionKind)],
        ['运行状态', currentTag(formatRuntimeStatus(session), statusColor)],
        ['共享镜像', currentTag(formatMirrorStatus(session), mirrorColor)],
      ],
    }],
    form: {
      optionElementId: 'clk_current_option',
      inputElementId: 'clk_name',
      inputLabel: '会话名',
      inputPlaceholder: '等同 /t rename；留空表示不修改',
      inputDefaultValue: sessionName,
      layout: 'two_column',
      controlBar: {
        actions: [
          { text: '刷新', callbackData: buildCommandCallbackData('/current') },
        ],
      },
      selects: formSelects,
      extraInputs: [
        {
          elementId: 'clk_cwd',
          label: '工作目录 (session.workspace)',
          placeholder: '等同 /cd；留空表示不修改',
          defaultValue: getSessionWorkingDirectory(session) || '',
        },
        ...runtimeInputs,
      ],
      submitText: '保存',
      submitCallbackData: buildCommandCallbackData(`/current-config ${activeRuntime}`),
      options: [],
    },
    footer: [
      `当前 agent：${currentTag(runtimeDisplayLabel, 'orange')}`,
      '顶部 runtime 下拉会立即切换运行时并刷新卡片；配置栏保存后只更新当前 runtime 的配置项。',
    ],
  };
}

function resolveCurrentCardSession(
  store: BridgeStore,
  binding: ChannelChat,
  previewRuntime?: RuntimeAgent,
): BridgeSession | undefined {
  const session = store.getSession(binding.bridgeSessionId);
  if (!session || !previewRuntime) return session || undefined;
  const currentRuntime = getSessionActiveRuntime(session) || 'codex';
  if (previewRuntime === currentRuntime) return session;
  const mappedSessionId = binding.runtimeBridgeSessionIds?.[previewRuntime];
  return mappedSessionId ? store.getSession(mappedSessionId) || session || undefined : session || undefined;
}

export async function handleHistoryCommand(options: {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  args: string;
  binding: ChannelChat | null;
  store: BridgeStore;
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
  richCard?: (card: OutboundRichCard) => void;
}): Promise<string> {
  const historyParts = options.args.trim().split(/\s+/).filter(Boolean);
  const historyArg = (historyParts[0] || '').toLowerCase();

  if (historyArg === 'limit' || historyArg === 'n') {
    const nextLimit = parseHistoryLimitArg(historyParts[1] || '');
    if (!nextLimit || historyParts.length > 2) {
      return [
        '用法：/his limit <1-20>',
        '示例：/his limit 12',
        `当前配置：${getHistoryMessageLimit()}`,
      ].join('\n');
    }
    try {
      createConfigService({ migrate: false }).set({ kind: 'home' }, {
        channels: [{
          id: 'feishu-default',
          config: {
            historyMessageLimit: nextLimit,
          },
        }],
      });
      return `已将 /his msg 返回条数限制设置为 ${nextLimit}，配置已保存到 ~/.codelark/config.toml。`;
    } catch (error) {
      return `修改失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const configuredLimit = getHistoryMessageLimit();
  let historyView: 'msg' | 'raw' | 'json' | 'file' = 'msg';
  let limit = configuredLimit;

  if (!historyArg) {
    historyView = 'msg';
  } else if (historyArg === 'msg' || historyArg === 'raw') {
    historyView = historyArg;
    if (historyParts.length > 2) return buildHistoryUsage();
    if (historyParts[1]) {
      const temporaryLimit = parseHistoryLimitArg(historyParts[1]);
      if (!temporaryLimit) return buildHistoryUsage();
      limit = temporaryLimit;
    }
  } else if (historyArg === 'json' || historyArg === 'file') {
    if (historyParts.length > 1) return buildHistoryUsage();
    historyView = historyArg;
  } else {
    const shorthandLimit = parseHistoryLimitArg(historyArg);
    if (!shorthandLimit || historyParts.length > 1) return buildHistoryUsage();
    historyView = 'msg';
    limit = shorthandLimit;
  }

  if (!options.binding) {
    return '当前聊天还没有绑定会话。先发送消息创建会话，或先用 `/t 1` 接管本地会话。';
  }

  const session = options.store.getSession(options.binding.bridgeSessionId);
  const sessionTranscript = resolveSessionTranscriptFile(session, options.binding);

  if (historyView === 'json' || historyView === 'file') {
    if (!sessionTranscript) {
      return '当前会话没有可直接发送的 session JSONL 文件。只有已落盘到 Codex、Claude Code 或 Kimi Code session 文件的线程才能使用 `/his json`。';
    }
    const attachment: OutboundAttachment = {
      kind: 'file',
      path: sessionTranscript.transcript.filePath,
      name: sessionTranscript.transcript.fileName,
    };
    enqueueResponse(
      options.adapter,
      options.msg.address,
      '',
      options.binding.bridgeSessionId,
      options.msg.messageId,
      [attachment],
    );
    return '';
  }

  const transcriptMessages = sessionTranscript
    ? sessionTranscript.source.readMessages(sessionTranscript.transcript, limit)
    : [];
  const { messages: storedMessages } = options.store.getMessages(options.binding.bridgeSessionId, { limit });
  const messages = filterHistoryMessagesForRuntime(
    transcriptMessages.length > 0 ? transcriptMessages : storedMessages,
    sessionTranscript?.transcript.runtime || getSessionActiveRuntime(session),
  );
  if (messages.length === 0) {
    return '当前会话还没有历史消息。';
  }
  const threadTitle = options.threadDisplay.binding(options.binding).title;
  const messageSource = transcriptMessages.length > 0
    ? sessionTranscript?.transcript.sourceLabel || 'session JSONL'
    : 'Bridge 缓存';
  const assistantRoleLabel = resolveHistoryAssistantRoleLabel(sessionTranscript?.transcript.runtime, session);

  if (historyView === 'msg') {
    options.richCard?.(buildHistoryMessagesRichCard(messages, {
      title: threadTitle,
      source: messageSource,
      limit,
      configuredLimit,
      assistantRoleLabel,
    }));
    return buildHistoryMessagesText(messages, {
      title: threadTitle,
      source: messageSource,
      limit,
      configuredLimit,
      markdown: options.markdown,
      assistantRoleLabel,
    });
  }

  const header = buildCommandFields(
    '最近对话（解析文本）',
    [
      ['标题', threadTitle],
      ['来源', messageSource],
      ['返回条数', `${messages.length} / ${formatHistoryLimitLabel(limit, configuredLimit)}`],
    ],
    [],
    options.markdown,
  );
  const body = messages.map((message, index) => {
    const role = formatHistoryRole(message.role, assistantRoleLabel);
    if (options.markdown) {
      return `${index + 1}. **${role}**\n\n${truncateHistoryContent(formatStoredMessageContent(message.content))}`;
    }
    return `${index + 1}. ${role}\n${truncateHistoryContent(formatStoredMessageContent(message.content))}`;
  }).join('\n\n');
  return [header, body].join('\n\n').trim();
}

function resolveHistoryAssistantRoleLabel(
  transcriptRuntime: RuntimeAgent | undefined,
  session: BridgeSession | null,
): string {
  const runtime = transcriptRuntime || getSessionActiveRuntime(session) || 'codex';
  return runtimeLabel(runtime);
}

export function handleCatCommand(options: {
  args: string;
  binding: ChannelChat;
  session?: BridgeSession | null;
  markdown: boolean;
}): string {
  const parts = options.args.split(/\s+/).filter(Boolean);
  const rawPath = parts[0] || '';
  if (!rawPath) {
    return '用法：/cat <path> [start_line] [end_line]\n示例：/cat README.md 1 200';
  }
  const expandedPath = expandHomePath(rawPath);
  const hasAbs = path.isAbsolute(expandedPath) || path.win32.isAbsolute(expandedPath);
  const workDir = getSessionWorkingDirectory(options.session) || '';
  if (!hasAbs && !workDir) {
    return '当前会话没有工作目录，请使用绝对路径。';
  }
  const resolvedPath = hasAbs ? expandedPath : path.resolve(workDir, expandedPath);
  let startLine = 1;
  let endLine = 200;
  const maybeStart = parts[1];
  const maybeEnd = parts[2];
  if (maybeStart && /^\d+$/.test(maybeStart) && maybeEnd && /^\d+$/.test(maybeEnd)) {
    startLine = Math.max(1, parseInt(maybeStart, 10));
    endLine = Math.max(startLine, parseInt(maybeEnd, 10));
  } else if (maybeStart && /^\d+$/.test(maybeStart)) {
    endLine = Math.max(1, parseInt(maybeStart, 10));
  }
  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return '目标不是文件。';
    }
    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const slice = lines.slice(startLine - 1, endLine);
    const slicedText = slice.join('\n');
    const { text: safeText, truncated } = sanitizeInput(slicedText, 12_000);
    const suffix = truncated || lines.length > endLine ? '\n\n（内容过长已截断）' : '';
    return options.markdown
      ? `**${path.basename(resolvedPath)}**\n\n${buildFencedCodeBlock(safeText, 'text')}${suffix}`
      : `${path.basename(resolvedPath)}\n\n${safeText}${suffix}`;
  } catch (error) {
    return `读取文件失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function handleFileCommand(options: {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  args: string;
  binding: ChannelChat;
  session?: BridgeSession | null;
}): Promise<string> {
  const rawPath = options.args.trim();
  const confirmMatch = rawPath.match(/^--confirm-large\s+(\S+)$/);
  if (confirmMatch) {
    if (!options.adapter.startLargeFileUpload) {
      return '当前通道暂不支持大文件后台上传。';
    }
    const pending = consumePendingLargeFileUpload(options.msg.address, confirmMatch[1] || '');
    if (!pending) {
      return '大文件上传确认已过期或已处理，请重新发送 /file。';
    }
    const result = options.adapter.startLargeFileUpload(
      options.msg.address,
      pending.attachment,
      { replyToMessageId: options.msg.messageId },
    );
    return result.ok
      ? `已开始后台上传：${pending.attachment.name || path.basename(pending.attachment.path)}。上传完成后会把链接发到当前聊天。`
      : `启动大文件上传失败：${result.error || '未知错误'}`;
  }

  const cancelMatch = rawPath.match(/^--cancel-large\s+(\S+)$/);
  if (cancelMatch) {
    const cleared = clearPendingLargeFileUpload(options.msg.address, cancelMatch[1] || '');
    return cleared ? '已取消大文件上传。' : '大文件上传确认已过期或已处理。';
  }

  if (!rawPath) {
    return '用法：/file <path>\n示例：/file report.txt';
  }
  const expandedPath = expandHomePath(rawPath);
  const hasAbs = path.isAbsolute(expandedPath) || path.win32.isAbsolute(expandedPath);
  const workDir = getSessionWorkingDirectory(options.session) || '';
  if (!hasAbs && !workDir) {
    return '当前会话没有工作目录，请使用绝对路径。';
  }
  const resolvedPath = hasAbs ? expandedPath : path.resolve(workDir, expandedPath);
  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return '目标不是文件。';
    }
    const attachment: OutboundAttachment = {
      kind: 'file',
      path: resolvedPath,
      name: path.basename(resolvedPath),
    };
    if (stat.size > LARGE_FILE_UPLOAD_THRESHOLD_BYTES) {
      const id = registerPendingLargeFileUpload(options.msg.address, attachment, stat.size);
      enqueueBridgeNotice(
        options.adapter,
        options.msg.address,
        `文件 ${path.basename(resolvedPath)} 超过 20 MB，需要确认后上传到飞书云空间并发送链接。`,
        {
          richCard: buildLargeFileUploadConfirmationCard({
          id,
          attachment,
          size: stat.size,
          }),
          replyToMessageId: options.msg.messageId,
        },
      );
      return `文件较大（${formatLargeFileUploadSize(stat.size)}），已发送确认卡片。确认前不会上传。`;
    }
    enqueueResponse(
      options.adapter,
      options.msg.address,
      '',
      options.binding.bridgeSessionId,
      options.msg.messageId,
      [attachment],
    );
    return `已发送文件：${path.basename(resolvedPath)}`;
  } catch (error) {
    return `读取文件失败：${error instanceof Error ? error.message : String(error)}`;
  }
}
