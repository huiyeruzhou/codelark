#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

import type { FeishuSite } from '../src/channels/types.js';
import { feishuSiteToApiBaseUrl } from '../src/channels/feishu/site.js';
import { createConfigService } from '../src/configuration/service.js';
import { DEFAULT_WORKSPACE_ROOT } from '../src/configuration/paths.js';
import type { ClaudeExecutable } from '../src/runtime/options.js';
import type { ConfigPatch } from '../src/configuration/schema.js';
import {
  basicDialogueStreamCardCheckpointIssues,
  collectRealE2eDump,
} from '../src/bridge/diagnostics/real-e2e-dump.js';

const execFileAsync = promisify(execFile);

type RuntimeName = 'codex' | 'claude';
type ProviderName = 'sdk' | 'pty' | 'tmux';

const COMMAND_RESPONSE_TIMEOUT_MS = 15_000;
const FILTERED_MESSAGE_OBSERVE_MS = 6_000;
const TEST_CHAT_REGISTRY_PATH = process.env.CODELARK_REAL_FEISHU_TEST_CHAT_REGISTRY_PATH
  || path.join(os.tmpdir(), 'codelark-real-feishu-e2e-chats.json');
const BASIC_DIALOGUE_MODEL_PROXY_CHUNK_DELAY_MS = 120;

function defaultRealFeishuTestEnvFile(): string {
  const codelarkHome = process.env.CODELARK_HOME || path.join(os.homedir(), '.codelark');
  return path.join(codelarkHome, 'real-feishu-e2e', 'test.env');
}

interface CliOptions {
  dryRun: boolean;
  dumpOnly: boolean;
  listScenarios: boolean;
  stopTestBridge: boolean;
  launchBridge: boolean;
  createChat: boolean;
  fakeCcr: boolean;
  scriptedBasicDialogue: boolean;
  keepGroup: boolean;
  keepCodelarkHome: boolean;
  allowConcurrentApp: boolean;
  testEnvFile: string;
  runId: string;
  channelType: string;
  channelAlias: string;
  runtime: RuntimeName;
  provider: ProviderName;
  runRoot: string;
  codelarkHome: string;
  runtimeHome: string;
  codexHome: string;
  claudeHome: string;
  claudeExecutable: ClaudeExecutable;
  testFeishuAppId: string;
  testFeishuAppSecret: string;
  testBotOpenId: string;
  testUserOpenId: string;
  testUserAccessToken: string;
  feishuSite: FeishuSite;
  larkProfile: string;
  scenario: string;
  commands: string[];
  sourceChatId: string;
  chatId: string;
  workDir: string;
  message: string;
  codexModel: string;
  timeoutMs: number;
  pollMs: number;
  outputPath: string;
  fakeCcrResponseText: string;
  fakeCcrProxyBaseUrl?: string;
  fakeCcrPort?: number;
  codexProxyBaseUrl?: string;
}

interface AppLock {
  path: string;
  fd: number;
}

interface RuntimeEnvironmentPlan {
  runtimeHome: string;
  codexHome: string;
  claudeHome: string;
  claudeExecutable: ClaudeExecutable;
  larkCliConfigSource: 'test-env-app' | 'not-needed' | 'missing';
  codexAuthSource: 'env-api-key' | 'host-auth-copy' | 'missing';
  claudeAuthSource: 'host-config-copy' | 'missing';
  ccrConfigSource: 'fake-backend-json' | 'host-config-copy' | 'not-needed' | 'missing';
  fakeCcrProxyBaseUrl?: string;
  fakeCcrPort?: number;
  ccrPort?: number;
  codexProxyBaseUrl?: string;
}

interface LocalFakeCcrBackend {
  baseUrl: string;
  requests: Array<{ method: string; url: string; rawBody: string }>;
  close(): Promise<void>;
}

interface LocalCodexResponsesProxy {
  baseUrl: string;
  requests: Array<{ method: string; url: string; rawBody: string }>;
  close(): Promise<void>;
}

interface CodexProxyRequestSummary {
  method: string;
  url: string;
  model?: string;
  reasoningEffort?: string;
  hasBootstrapPrompt: boolean;
}

interface CodexProxyModelAudit {
  requestedModel: string;
  actualModels: string[];
  exactMatch: boolean;
  hasModelField: boolean;
  hasReasoningLow: boolean;
  hasBootstrapPrompt: boolean;
}

interface ScriptedModelReplyPlan {
  text: string;
  chunks: string[];
  chunkDelayMs: number;
}

interface LarkCliUserAuthorizationStatus {
  appId: string;
  userOpenId: string;
  userAvailable: boolean;
  userVerified: boolean;
  userStatus: string;
  tokenStatus: string;
  scopes: Set<string>;
}

interface CreatedChatCleanupResult {
  chatId: string;
  attempted: boolean;
  deleted: boolean;
  retained: boolean;
  reason?: string;
  error?: string;
  attempts?: CreatedChatCleanupAttempt[];
}

interface CreatedDocumentCleanupResult {
  fileToken: string;
  fileType: 'docx';
  attempted: boolean;
  deleted: boolean;
  retained: boolean;
  reason?: string;
  error?: string;
}

interface CreatedChatCleanupAttempt {
  method: 'lark-cli-user' | 'test-app-user-openapi' | 'test-bot-openapi';
  attempted: boolean;
  deleted: boolean;
  error?: string;
}

interface ScenarioCreatedChatInfo {
  command: string;
  chatId: string;
  requestedName: string;
  actualName?: string;
  ok: boolean;
  detail: string;
}

interface DocAsChatScenarioResult {
  runId: string;
  document: {
    fileType: 'docx';
    token: string;
    url?: string;
    marker: string;
  };
  comment: {
    commentId: string;
    replyId?: string;
  };
  createdGroup: {
    chatId: string;
    name: string;
  };
  binding: unknown;
  userVisibleGroupInfo: unknown;
  userVisibleGroupMembers: unknown;
  contextAssertion: {
    expectedFileType: 'docx';
    expectedFileToken: string;
    expectedMarker: string;
    passed: boolean;
    messages: unknown;
  };
}

interface TestChatRegistryRecord {
  chatId: string;
  runId: string;
  groupName?: string;
  scenario?: string;
  runtime?: RuntimeName;
  provider?: ProviderName;
  codelarkHome?: string;
  runRoot?: string;
  testAppId?: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'deleted' | 'retained';
  keepGroup?: boolean;
  cleanup?: CreatedChatCleanupResult;
}

interface MessageObservation {
  label: string;
  chatId?: string;
  sentText: string;
  sentMessageId: string;
  expectation: 'bot-reply' | 'bot-reply-after-queued-send' | 'no-bot-reply' | 'mirror-stream-evidence' | 'append-input-delivered-no-direct-reply';
  ok: boolean;
  check: 'feishu-reply_to' | 'feishu-reply_to-queued-prompt' | 'feishu-reply_to-queued-followup' | 'feishu-mirror-stream' | 'feishu-append-input-no-direct-reply';
  expectedText?: string;
  expectedTexts?: string[];
  expectedForbiddenTexts?: string[];
  expectedReplyMessageTypes?: string[];
  expectedReplyContentKeys?: string[];
  feishuMessages: unknown;
}

interface CommandReplyExpectation {
  command: string;
  expectedTexts: string[];
  expectedForbiddenTexts?: string[];
  expectedReplyMessageTypes: string[];
  expectedReplyContentKeys: string[];
  observationMode?: 'reply_to' | 'mirror-stream-evidence';
  replyTimeoutMs: number;
  reason: string;
}

interface ReplyExpectation {
  texts: string[];
  forbiddenTexts: string[];
  messageTypes: string[];
  contentKeys: string[];
}

interface ScenarioDefinition {
  name: string;
  testNamePrefix: string;
  description: string;
  unitCoverage: string[];
  e2eCoverage: string[];
  providerCoverage: 'runtime-parameterized' | 'runtime-neutral' | 'representative-provider' | 'cross-provider-suite';
  coverageTier: 'mandatory-suite' | 'representative-suite' | 'legacy-transitional-evidence' | 'runtime-smoke-evidence' | 'runtime-compressed-command-check' | 'runtime-neutral-check';
  providerSequence?: string[];
  requiresRuntimeOutput?: boolean;
  buildCommands: (options: CliOptions) => string[];
}

const BASIC_DIALOGUE_SDK_MIRROR_SUPPRESSION_GRACE_MS = 10_000;
const BASIC_DIALOGUE_QUEUED_FOLLOWUP_DELAY_MS = 250;

const BASIC_DIALOGUE_PROVIDER_SEQUENCE = [
  'codex-sdk',
  'claude-sdk',
  'codex-tmux',
  'claude-pty',
  'codex-pty',
];
const BASIC_DIALOGUE_APPEND_INPUT_PROVIDER_KEYS = [
  'codex-tmux',
  'claude-pty',
  'codex-pty',
];

const SCENARIOS: ScenarioDefinition[] = [
  {
    name: 'message-only',
    testNamePrefix: 'real-feishu::message-only',
    description: '只发送 runtime/provider seed 和最终用户 prompt；需要额外准备状态时使用 --commands。',
    unitCoverage: [
      'unit::bridge-command-e2e::plain-message',
      'unit::interactive-turn-runner::runtime-turn',
      'unit::delivery-pipeline::response-delivery',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-message',
      'e2e::feishu-event-receive',
      'e2e::runtime-response',
      'e2e::feishu-outbound-response',
    ],
    providerCoverage: 'runtime-parameterized',
    coverageTier: 'runtime-smoke-evidence',
    buildCommands: (options) => [...options.commands, ...buildRuntimeProviderCommands(options)],
  },
  {
    name: 'runtime-message',
    testNamePrefix: 'real-feishu::runtime-message',
    description: '先通过飞书切换到指定 runtime，再发送真实用户 prompt。',
    unitCoverage: [
      'unit::command-dispatch::runtime-command',
      'unit::interactive-runtime::runtime-selection',
      'unit::bridge-adapter-runtime::runtime-routing',
      'unit::interactive-turn-runner::runtime-turn',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::runtime-switch',
      'e2e::lark-cli-user-message',
      'e2e::runtime-response',
      'e2e::runtime-identity-bound',
    ],
    providerCoverage: 'runtime-parameterized',
    coverageTier: 'runtime-smoke-evidence',
    buildCommands: (options) => [...options.commands, ...buildRuntimeProviderCommands(options)],
  },
  {
    name: 'basic-dialogue-suite',
    testNamePrefix: 'real-feishu::basic-dialogue-suite',
    description: '同一会话中按 codex-sdk -> claude-sdk -> codex-tmux -> claude-pty -> codex-pty 切换，覆盖基本对话、工具/权限/goal/context/stop 和 SDK mirror 抑制。',
    unitCoverage: [
      'unit::interactive-turn-runner::basic-dialogue-session-simulator',
      'unit::interactive-turn-runner::controlled-tool-context-stream-card',
      'unit::interactive-turn-runner::stop-interrupted-stream',
      'unit::mirror-suppression::sdk-terminal-grace',
      'unit::command-dispatch::runtime-provider-switch',
    ],
    e2eCoverage: [
      'e2e::same-chat-cross-provider-sequence',
      'e2e::provider-preload-status',
      'e2e::permission-callback-roundtrip',
      'e2e::representative-tool-call',
      'e2e::queued-or-appended-followup',
      'e2e::stream-card-context-and-goal',
      'e2e::stop-interrupted-state',
      'e2e::sdk-mirror-suppression-grace',
    ],
    providerCoverage: 'cross-provider-suite',
    coverageTier: 'mandatory-suite',
    providerSequence: BASIC_DIALOGUE_PROVIDER_SEQUENCE,
    buildCommands: (options) => [
      ...options.commands,
      ...buildBasicDialogueSuiteCommands(options),
    ],
  },
  {
    name: 'command-state',
    testNamePrefix: 'real-feishu::command-state',
    description: '覆盖配置命令、当前会话命令、/every 定时输入状态，然后发送 runtime prompt。',
    unitCoverage: [
      'unit::command-dispatch::status-and-settings',
      'unit::command-dispatch::require-at',
      'unit::runtime-options::provider-settings',
      'unit::session-runtime::current-session-state',
      'unit::bridge-command-e2e::auto-task-state',
      'unit::interactive-turn-runner::runtime-turn',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::require-at-off',
      'e2e::runtime-switch',
      'e2e::session-state-commands',
      'e2e::every-task-create-list-remove',
      'e2e::runtime-response',
    ],
    providerCoverage: 'runtime-parameterized',
    coverageTier: 'runtime-compressed-command-check',
    buildCommands: (options) => [
      ...options.commands,
      '/status',
      '/require-at off',
      ...buildRuntimeProviderCommands(options),
      '/current',
      '/model',
      '/mode',
      '/provider',
      '/sandbox',
      '/network',
      '/reasoning',
      `/every 1h e2e seed ${options.runId}`,
      '/every',
      '/every no 1',
    ],
  },
  {
    name: 'session-management',
    testNamePrefix: 'real-feishu::session-management',
    description: '覆盖帮助、全局配置、/new、/cd、/current、/check、/t 列表/分页/解绑/归档，发送 runtime prompt 后再用 /his 验证历史。',
    unitCoverage: [
      'unit::help-command::slash-command-groups',
      'unit::command-dispatch::global-settings',
      'unit::command-dispatch::new-session',
      'unit::command-dispatch::cd-command',
      'unit::command-dispatch::health-diagnostics',
      'unit::command-dispatch::thread-list-unbind-archive',
      'unit::bridge-command-e2e::history-commands',
      'unit::interactive-turn-runner::runtime-turn',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::help-command-response',
      'e2e::global-settings-response',
      'e2e::new-session-binding',
      'e2e::session-working-directory-update',
      'e2e::health-diagnostics-response',
      'e2e::thread-list-card-response',
      'e2e::thread-list-limit-response',
      'e2e::thread-unbind-temporary-session',
      'e2e::thread-archive-current-runtime-session',
      'e2e::history-command-response',
      'e2e::runtime-response',
    ],
    providerCoverage: 'runtime-parameterized',
    coverageTier: 'runtime-compressed-command-check',
    buildCommands: (options) => [
      ...options.commands,
      ...buildRuntimeProviderCommands(options),
      '/help',
      '/set',
      `/set claudeProvider ${options.runtime === 'claude' ? options.provider : 'pty'}`,
      `/new mgmt-${options.runId} ${options.workDir}`,
      ...buildRuntimeProviderCommands(options),
      `/cd ${options.workDir}`,
      '/current',
      '/check',
      '/t',
      '/t n 50',
      '/t unbind',
      options.message,
      '/his 5',
      '/t archive',
    ],
  },
  {
    name: 'history-boundaries',
    testNamePrefix: 'real-feishu::history-boundaries',
    description: '覆盖 final chat 后的 /his raw、/his limit、默认 /his 和临时 /his msg 条数。',
    unitCoverage: [
      'unit::bridge-command-e2e::history-commands',
      'unit::bridge-command-e2e::history-raw-limit',
      'unit::bridge-command-e2e::history-jsonl-precedence',
      'unit::command-dispatch::claude-history-jsonl',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::history-raw-response',
      'e2e::history-limit-update',
      'e2e::history-default-limit-response',
      'e2e::history-temporary-limit-response',
      'e2e::runtime-response',
    ],
    providerCoverage: 'runtime-parameterized',
    coverageTier: 'legacy-transitional-evidence',
    buildCommands: (options) => [
      ...options.commands,
      ...buildRuntimeProviderCommands(options),
      `/new history-${options.runId} ${options.workDir}`,
      ...buildRuntimeProviderCommands(options),
      `/cd ${options.workDir}`,
      scenarioFinalMessage(options),
      '/his raw 1',
      '/his limit 3',
      '/his',
      '/his msg 1',
    ],
  },
  {
    name: 'history-attachments',
    testNamePrefix: 'real-feishu::history-attachments',
    description: '覆盖 /his json 和 /his file 通过飞书文件消息返回原始 session JSONL。',
    unitCoverage: [
      'unit::bridge-command-e2e::history-json-attachment',
      'unit::command-dispatch::claude-history-jsonl',
      'unit::delivery-pipeline::attachment-delivery',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::history-json-file-reply',
      'e2e::history-file-alias-reply',
      'e2e::feishu-file-message-reply_to',
    ],
    providerCoverage: 'runtime-parameterized',
    coverageTier: 'legacy-transitional-evidence',
    buildCommands: (options) => [
      ...options.commands,
      ...buildRuntimeProviderCommands(options),
      `/new histfile-${options.runId} ${options.workDir}`,
      ...buildRuntimeProviderCommands(options),
      `/cd ${options.workDir}`,
      scenarioFinalMessage(options),
      '/his json',
      '/his file',
    ],
  },
  {
    name: 'history-empty-isolation',
    testNamePrefix: 'real-feishu::history-empty-isolation',
    description: '覆盖新会话空历史提示，并验证新群不会读到前一个群的历史 marker。',
    unitCoverage: [
      'unit::bridge-command-e2e::history-commands',
      'unit::store::session-message-isolation',
      'unit::command-dispatch::new-session',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::new-session-binding',
      'e2e::history-empty-response',
      'e2e::history-cross-chat-isolation',
      'e2e::runtime-response',
    ],
    providerCoverage: 'runtime-parameterized',
    coverageTier: 'legacy-transitional-evidence',
    buildCommands: (options) => [
      ...options.commands,
      ...buildRuntimeProviderCommands(options),
      `/new histiso-a-${options.runId} ${options.workDir}`,
      ...buildRuntimeProviderCommands(options),
      `/cd ${options.workDir}`,
      scenarioFinalMessage(options),
      `/new histiso-b-${options.runId} ${options.workDir}`,
      '/his',
      '/his raw 1',
      '/his msg 1',
    ],
  },
  {
    name: 'history-long-truncation',
    testNamePrefix: 'real-feishu::history-long-truncation',
    description: '覆盖长历史消息在 /his raw 和 /his msg 中被截断，且尾部 marker 不泄露。',
    unitCoverage: [
      'unit::bridge-command-e2e::history-long-truncation',
      'unit::bridge-command-e2e::history-commands',
      'unit::command-dispatch::claude-history-jsonl',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::history-long-raw-truncation',
      'e2e::history-long-card-truncation',
      'e2e::history-forbidden-tail-marker',
      'e2e::runtime-response',
    ],
    providerCoverage: 'runtime-parameterized',
    coverageTier: 'legacy-transitional-evidence',
    buildCommands: (options) => [
      ...options.commands,
      ...buildRuntimeProviderCommands(options),
      `/new histlong-${options.runId} ${options.workDir}`,
      ...buildRuntimeProviderCommands(options),
      `/cd ${options.workDir}`,
      scenarioFinalMessage(options),
      '/his raw 2',
      '/his msg 2',
    ],
  },
  {
    name: 'history-suite',
    testNamePrefix: 'real-feishu::history-suite',
    description: '把 /his 默认/raw/msg/limit/json/file、长截断和跨群空历史隔离合并为一个功能簇。',
    unitCoverage: [
      'unit::bridge-command-e2e::history-commands',
      'unit::bridge-command-e2e::history-raw-limit',
      'unit::bridge-command-e2e::history-json-attachment',
      'unit::bridge-command-e2e::history-long-truncation',
      'unit::store::session-message-isolation',
      'unit::command-dispatch::claude-history-jsonl',
    ],
    e2eCoverage: [
      'e2e::history-suite-short-marker',
      'e2e::history-raw-response',
      'e2e::history-limit-update',
      'e2e::history-json-file-reply',
      'e2e::feishu-file-message-reply_to',
      'e2e::history-long-raw-truncation',
      'e2e::history-forbidden-tail-marker',
      'e2e::history-empty-response',
      'e2e::history-cross-chat-isolation',
      'e2e::runtime-response',
    ],
    providerCoverage: 'representative-provider',
    coverageTier: 'representative-suite',
    buildCommands: (options) => [
      ...options.commands,
      ...buildRuntimeProviderCommands(options),
      `/new histsuite-a-${options.runId} ${options.workDir}`,
      ...buildRuntimeProviderCommands(options),
      `/cd ${options.workDir}`,
      historySuiteShortPrompt(options),
      '/his raw 1',
      '/his limit 3',
      '/his',
      '/his msg 1',
      '/his json',
      '/his file',
      historySuiteLongPrompt(options),
      '/his raw 2',
      '/his msg 2',
      `/new histsuite-b-${options.runId} ${options.workDir}`,
      '/his',
      '/his raw 1',
      '/his msg 1',
    ],
  },
  {
    name: 'require-at-toggle',
    testNamePrefix: 'real-feishu::require-at-toggle',
    description: '把 /require-at 行为从主非 mention runtime 路径中拆出来单独验证。',
    unitCoverage: [
      'unit::command-dispatch::require-at',
      'unit::feishu-adapter::mention-filter',
      'unit::bridge-command-e2e::require-at-state',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::require-at-on',
      'e2e::require-at-off',
      'e2e::non-mention-group-message-policy',
    ],
    providerCoverage: 'runtime-neutral',
    coverageTier: 'runtime-neutral-check',
    requiresRuntimeOutput: false,
    buildCommands: (options) => [...options.commands],
  },
  {
    name: 'card-forms',
    testNamePrefix: 'real-feishu::card-forms',
    description: '覆盖命令 rich card 表单在飞书客户端以 interactive reply_to 返回。',
    unitCoverage: [
      'unit::bridge-command-e2e::new-session-form-card',
      'unit::feishu-adapter::rich-card-form',
      'unit::delivery-pipeline::question-form-card',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::feishu-interactive-card-reply_to',
      'e2e::cardkit-form-fields',
      'e2e::card-submit-callback-prefix',
    ],
    providerCoverage: 'runtime-neutral',
    coverageTier: 'runtime-neutral-check',
    requiresRuntimeOutput: false,
    buildCommands: (options) => [...options.commands, '/new'],
  },
  {
    name: 'agent-question-forms',
    testNamePrefix: 'real-feishu::agent-question-forms',
    description: '覆盖模型输出 <clk-ask> 后，question form 在飞书客户端以 interactive reply_to 返回。',
    unitCoverage: [
      'unit::outbound-artifacts::question-forms',
      'unit::delivery-pipeline::question-form-card',
      'unit::feishu-adapter-card-e2e::sdk-clk-ask-form',
      'unit::feishu-adapter-card-e2e::mirror-clk-ask-form',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-message',
      'e2e::runtime-response',
      'e2e::feishu-interactive-card-reply_to',
      'e2e::agent-question-form-fields',
      'e2e::agent-question-callback-prefix',
    ],
    providerCoverage: 'runtime-parameterized',
    coverageTier: 'representative-suite',
    buildCommands: (options) => [
      ...options.commands,
      ...buildRuntimeProviderCommands(options),
      scenarioFinalMessage(options),
    ],
  },
  {
    name: 'markdown-rendering',
    testNamePrefix: 'real-feishu::markdown-rendering',
    description: '覆盖模型最终回复中的 markdown 表格和 fenced code block 在飞书原始消息中保留。',
    unitCoverage: [
      'unit::plain-markdown::tables-and-code-blocks',
      'unit::feishu-markdown::card-markdown-elements',
      'unit::delivery-pipeline::final-response-delivery',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-message',
      'e2e::runtime-response',
      'e2e::feishu-markdown-table',
      'e2e::feishu-markdown-fenced-code',
      'e2e::feishu-outbound-response',
    ],
    providerCoverage: 'runtime-parameterized',
    coverageTier: 'representative-suite',
    buildCommands: (options) => [
      ...options.commands,
      ...buildRuntimeProviderCommands(options),
      scenarioFinalMessage(options),
    ],
  },
  {
    name: 'doc-as-chat-from-scratch',
    testNamePrefix: 'real-feishu::doc-as-chat-from-scratch',
    description: '从零创建云文档，用户身份结构化 @ bot 评论触发 /new，验证 user 身份可读新群、后续群聊回复包含绑定文档 file_type/file_token/marker，并清理群聊和文档。',
    unitCoverage: [
      'unit::feishu-adapter::cloud-document-comment-new-command',
      'unit::command-dispatch::cloud-document-new-group',
      'unit::bridge-manager::cloud-document-chat-context',
      'unit::mirror-subscription-registry::skip-cloud-document-virtual-chat',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-doc-create',
      'e2e::lark-cli-user-structured-comment-mention',
      'e2e::drive-comment-event-receive',
      'e2e::cloud-document-user-created-group',
      'e2e::lark-cli-user-chat-read',
      'e2e::doc-as-chat-context-file-token-marker',
      'e2e::cloud-document-comment-granularity',
      'e2e::scenario-created-chat-cleanup',
      'e2e::created-document-cleanup',
    ],
    providerCoverage: 'representative-provider',
    coverageTier: 'representative-suite',
    buildCommands: () => [],
  },
];

function scenarioRequiresRuntimeOutput(options: CliOptions): boolean {
  return getScenarioDefinition(options.scenario).requiresRuntimeOutput !== false;
}

function buildRuntimeProviderCommands(options: CliOptions): string[] {
  const providerCoverage = getScenarioDefinition(options.scenario).providerCoverage;
  if (providerCoverage !== 'runtime-parameterized' && providerCoverage !== 'representative-provider') return [];
  return [
    `/runtime ${options.runtime}`,
    `/p ${options.provider}`,
  ];
}

function parseRuntimeProviderKey(key: string): { runtime: RuntimeName; provider: ProviderName } {
  const [runtimePart, providerPart] = key.split('-');
  const runtime: RuntimeName = runtimePart === 'claude' ? 'claude' : 'codex';
  return {
    runtime,
    provider: normalizeProviderForRuntime(runtime, providerPart || ''),
  };
}

function basicDialogueMarker(options: CliOptions, providerKey: string): string {
  return `CODELARK_BASIC_DIALOGUE_${runIdToken(options.runId)}_${runIdToken(providerKey)}`;
}

function basicDialoguePrompt(options: CliOptions, providerKey: string): string {
  const marker = basicDialogueMarker(options, providerKey);
  return [
    `请模拟 basic dialogue ${providerKey} 阶段，只回复这个 marker：${marker}`,
    '同时在本阶段测试脚本里应覆盖 provider preload、代表性工具调用、context/goal 状态和权限/更新提示回传。',
  ].join('\n');
}

function basicDialogueFollowupPrompt(options: CliOptions, providerKey: string): string {
  return `追加输入 ${providerKey} ${basicDialogueMarker(options, providerKey)} FOLLOWUP`;
}

function buildBasicDialogueSuiteCommands(options: CliOptions): string[] {
  const commands: string[] = [];
  for (const providerKey of BASIC_DIALOGUE_PROVIDER_SEQUENCE) {
    commands.push(...basicDialoguePhaseCommands(options, providerKey));
  }
  return commands;
}

function basicDialoguePhaseCommands(options: CliOptions, providerKey: string): string[] {
  const { runtime, provider } = parseRuntimeProviderKey(providerKey);
  const includesFollowup = providerKey === 'codex-sdk'
    || (options.scriptedBasicDialogue && isBasicDialogueAppendInputPhase(providerKey));
  return [
    `/runtime ${runtime}`,
    `/p ${provider}`,
    basicDialoguePrompt(options, providerKey),
    ...(includesFollowup ? [basicDialogueFollowupPrompt(options, providerKey)] : []),
    ...(providerKey === 'codex-pty' ? ['/stop'] : []),
  ];
}

function basicDialoguePhaseForCommandIndex(options: CliOptions, commandIndex: number): string {
  let cursor = 0;
  for (const providerKey of BASIC_DIALOGUE_PROVIDER_SEQUENCE) {
    const phaseCommands = basicDialoguePhaseCommands(options, providerKey);
    if (commandIndex >= cursor && commandIndex < cursor + phaseCommands.length) return providerKey;
    cursor += phaseCommands.length;
  }
  return '';
}

function basicDialoguePhaseForPrompt(options: CliOptions, text: string): string {
  return BASIC_DIALOGUE_PROVIDER_SEQUENCE.find((providerKey) => text === basicDialoguePrompt(options, providerKey)) || '';
}

function basicDialoguePhaseForFollowup(options: CliOptions, text: string): string {
  return BASIC_DIALOGUE_PROVIDER_SEQUENCE.find((providerKey) => text === basicDialogueFollowupPrompt(options, providerKey)) || '';
}

function isBasicDialogueAppendInputPhase(providerKey: string): boolean {
  return BASIC_DIALOGUE_APPEND_INPUT_PROVIDER_KEYS.includes(providerKey);
}

function basicDialogueSuitePlan(options: CliOptions): Record<string, unknown> {
  return {
    scriptedBridgeModel: false,
    proxyBackedProviders: options.scriptedBasicDialogue,
    providerBypassInjected: false,
    codexResponsesProxy: options.scriptedBasicDialogue,
    ccrProxy: options.scriptedBasicDialogue || options.fakeCcr,
    modelProxyChunkDelayMs: BASIC_DIALOGUE_MODEL_PROXY_CHUNK_DELAY_MS,
    modelProxyBoundary: 'codex-responses-and-ccr-chat-completions',
    sdkMirrorSuppressionObservationWindowMs: BASIC_DIALOGUE_SDK_MIRROR_SUPPRESSION_GRACE_MS,
    queuedFollowupDelayMs: BASIC_DIALOGUE_QUEUED_FOLLOWUP_DELAY_MS,
    queuedFollowupProviderKeys: ['codex-sdk'],
    appendInputProviderKeys: BASIC_DIALOGUE_APPEND_INPUT_PROVIDER_KEYS,
    followupSemantics: {
      codexSdk: 'queue-in-after-tool-turn',
      claudeSdk: 'no-runtime-append-channel',
      terminalAndClaude: options.scriptedBasicDialogue
        ? 'append-input-message-delivered-no-direct-reply'
        : 'append-input-planned-not-yet-gated',
    },
    phases: BASIC_DIALOGUE_PROVIDER_SEQUENCE.map((providerKey) => {
      const { runtime, provider } = parseRuntimeProviderKey(providerKey);
      const isSdk = providerKey.endsWith('-sdk');
      return {
        providerKey,
        runtime,
        provider,
        runtimeCommand: `/runtime ${runtime}`,
        providerCommand: `/p ${provider}`,
        marker: basicDialogueMarker(options, providerKey),
        prompt: basicDialoguePrompt(options, providerKey),
        modelProxyChunks: basicDialogueProxyReplyPlan(basicDialoguePrompt(options, providerKey), options.fakeCcrResponseText).chunks,
        outputObservationMode: options.scriptedBasicDialogue
          ? 'scripted-interactive-stream-card'
          : isSdk
          ? 'direct-im-reply_to'
          : 'mirror-stream-evidence',
        followupInputSemantics: providerKey === 'codex-sdk'
          ? 'queue-in-after-tool-turn'
          : isBasicDialogueAppendInputPhase(providerKey)
            ? options.scriptedBasicDialogue
              ? 'append-input-message-delivered-no-direct-reply'
              : 'append-input-planned-not-yet-gated'
            : 'no-runtime-append-channel',
        ...(providerKey === 'codex-sdk' || (options.scriptedBasicDialogue && isBasicDialogueAppendInputPhase(providerKey))
          ? {
            followupCommand: basicDialogueFollowupPrompt(options, providerKey),
          }
          : {}),
        ...(providerKey === 'codex-sdk'
          ? {
            mirrorSuppressionObservationWindowMs: BASIC_DIALOGUE_SDK_MIRROR_SUPPRESSION_GRACE_MS,
          }
          : {}),
        ...(providerKey === 'codex-pty' ? { stopCommand: '/stop' } : {}),
        ...(isBasicDialogueAppendInputPhase(providerKey)
          ? {
            appendInputGate: options.scriptedBasicDialogue
              ? 'message-delivered-no-direct-reply'
              : 'planned-not-yet-gated',
          }
          : {}),
      };
    }),
  };
}

function valueArg(args: string[], name: string, fallback = ''): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1] || fallback;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eqIndex = trimmed.indexOf('=');
  if (eqIndex <= 0) return null;
  const key = trimmed.slice(0, eqIndex).trim();
  let value = trimmed.slice(eqIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadRealFeishuTestEnvFile(argv: string[]): string {
  const explicitEnvFile = valueArg(argv, '--test-env-file', '');
  const envFile = explicitEnvFile || defaultRealFeishuTestEnvFile();
  const resolved = path.resolve(envFile);
  let content = '';
  try {
    content = fs.readFileSync(resolved, 'utf-8');
  } catch (error) {
    if (!explicitEnvFile) return '';
    throw new Error(`Unable to read real Feishu E2E test env file: ${resolved}`);
  }
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (!parsed.key.startsWith('CODELARK_REAL_FEISHU_TEST_')) continue;
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
  return resolved;
}

function parseOptions(argv: string[]): CliOptions {
  const runId = valueArg(argv, '--run-id', `clk-real-${Date.now()}`);
  const runtimeArg = valueArg(argv, '--runtime', 'claude');
  const runtime = runtimeArg === 'codex' ? 'codex' : 'claude';
  const scenario = valueArg(argv, '--scenario', 'runtime-message');
  const provider = normalizeProviderForRuntime(
    runtime,
    valueArg(argv, '--provider', ''),
  );
  const runRoot = valueArg(
    argv,
    '--run-root',
    path.join(os.tmpdir(), `clk-real-feishu-${runId}`),
  );
  const codelarkHome = valueArg(
    argv,
    '--clk-home',
    path.join(runRoot, 'codelark-home'),
  );
  const runtimeHome = valueArg(
    argv,
    '--runtime-home',
    path.join(runRoot, 'runtime-home'),
  );
  const codexHome = valueArg(
    argv,
    '--codex-home',
    path.join(runRoot, 'codex-home'),
  );
  const claudeHome = valueArg(
    argv,
    '--claude-home',
    runtimeHome,
  );
  const claudeExecutableArg = valueArg(
    argv,
    '--claude-executable',
    'ccr',
  );
  const siteArg = valueArg(argv, '--feishu-site', process.env.CODELARK_REAL_FEISHU_TEST_SITE || 'feishu');
  return {
    dryRun: hasFlag(argv, '--dry-run'),
    dumpOnly: hasFlag(argv, '--dump-only'),
    listScenarios: hasFlag(argv, '--list-scenarios'),
    stopTestBridge: hasFlag(argv, '--stop-test-bridge'),
    launchBridge: hasFlag(argv, '--launch-bridge'),
    createChat: hasFlag(argv, '--create-chat'),
    fakeCcr: hasFlag(argv, '--fake-ccr'),
    scriptedBasicDialogue: hasFlag(argv, '--scripted-basic-dialogue'),
    keepGroup: hasFlag(argv, '--keep-group'),
    keepCodelarkHome: hasFlag(argv, '--keep-clk-home'),
    allowConcurrentApp: hasFlag(argv, '--allow-concurrent-app'),
    testEnvFile: valueArg(argv, '--test-env-file', defaultRealFeishuTestEnvFile()),
    runId,
    channelType: valueArg(argv, '--channel-type', 'feishu-env'),
    channelAlias: valueArg(argv, '--channel-alias', 'Real Feishu E2E'),
    runtime,
    provider,
    runRoot,
    codelarkHome,
    runtimeHome,
    codexHome,
    claudeHome,
    claudeExecutable: claudeExecutableArg === 'claude' ? 'claude' : 'ccr',
    testFeishuAppId: valueArg(argv, '--test-feishu-app-id', process.env.CODELARK_REAL_FEISHU_TEST_APP_ID || ''),
    testFeishuAppSecret: valueArg(argv, '--test-feishu-app-secret', process.env.CODELARK_REAL_FEISHU_TEST_APP_SECRET || ''),
    testBotOpenId: valueArg(argv, '--test-bot-open-id', process.env.CODELARK_REAL_FEISHU_TEST_BOT_OPEN_ID || ''),
    testUserOpenId: valueArg(argv, '--test-user-open-id', process.env.CODELARK_REAL_FEISHU_TEST_USER_OPEN_ID || ''),
    testUserAccessToken: valueArg(argv, '--test-user-access-token', process.env.CODELARK_REAL_FEISHU_TEST_USER_ACCESS_TOKEN || ''),
    feishuSite: siteArg === 'lark' ? 'lark' : 'feishu',
    larkProfile: valueArg(argv, '--lark-profile', ''),
    scenario,
    commands: parseCommandList(valueArg(argv, '--commands', '')),
    sourceChatId: valueArg(argv, '--source-chat-id', ''),
    chatId: valueArg(argv, '--chat-id', ''),
    workDir: valueArg(argv, '--workdir', DEFAULT_WORKSPACE_ROOT),
    message: valueArg(argv, '--message', `real feishu e2e ${runId}`),
    codexModel: valueArg(argv, '--codex-model', process.env.CODELARK_REAL_FEISHU_CODEX_MODEL || 'gpt-5.5'),
    timeoutMs: parsePositiveInt(valueArg(argv, '--timeout-ms'), 120_000),
    pollMs: parsePositiveInt(valueArg(argv, '--poll-ms'), 2_000),
    outputPath: valueArg(argv, '--output', ''),
    fakeCcrResponseText: valueArg(argv, '--fake-ccr-response', defaultFakeCcrResponseText(runId, scenario)),
  };
}

function normalizeProviderForRuntime(runtime: RuntimeName, raw: string): ProviderName {
  const provider = raw.trim().toLowerCase();
  if (!provider) return runtime === 'claude' ? 'pty' : 'pty';
  if (runtime === 'codex') {
    if (provider === 'sdk' || provider === 'pty' || provider === 'tmux') return provider;
    throw new Error(`Invalid Codex provider "${raw}". Expected sdk, pty, or tmux.`);
  }
  if (provider === 'sdk' || provider === 'pty') return provider;
  throw new Error(`Invalid Claude provider "${raw}". Expected pty or sdk.`);
}

function printUsage(): void {
  process.stdout.write([
    'Usage:',
    '  CODELARK_REAL_FEISHU_E2E=1 node --import tsx scripts/real-feishu-e2e.ts --launch-bridge --create-chat [options]',
    '',
    'Options:',
    '  --dry-run                 Print planned lark-cli commands without sending messages',
    '  --dump-only               Only collect bridge dump state',
    '  --list-scenarios          Print scenario names and coverage metadata as JSON',
    '  --stop-test-bridge        Stop a previous isolated real Feishu E2E bridge for --run-root/--clk-home',
    '  --launch-bridge           Start a test-only bridge child process with an isolated CODELARK_HOME',
    '  --allow-concurrent-app    Skip same-app bridge lock; unsafe only when launching another bridge for the same app',
    `  --test-env-file <path>     Load CODELARK_REAL_FEISHU_TEST_* values from a private test env file; default ${defaultRealFeishuTestEnvFile()}`,
    '  --create-chat             Create a new Feishu group and invite the test/live bridge bot',
    '  --fake-ccr                Run true ccr/Claude Code against a local fake OpenAI-compatible backend',
    '  --fake-ccr-response <txt> Expected fake backend response text',
    '  --scripted-basic-dialogue Run basic-dialogue through isolated Codex Responses/CCR proxies, not direct provider injection',
    '  --keep-clk-home           Keep the temporary CODELARK_HOME after the run; default cleans it',
    '  --run-root <path>          Parent directory for ccr/codex/codelark test homes; default /tmp/clk-real-feishu-<run-id>',
    '  --clk-home <path>          CODELARK_HOME for the launched/dumped test bridge',
    '  --runtime-home <path>      HOME for the launched bridge child; default <clk-home>/runtime-home',
    '  --codex-home <path>        CODEX_HOME for the launched bridge child; default <clk-home>/codex-home',
    '  --claude-home <path>       CODELARK_CLAUDE_HOME for Claude JSONL mirror; default runtime home',
    '  --claude-executable <cmd>  ccr|claude for Claude runtime; default ccr',
    '  --test-feishu-app-id <cli_>     Test Feishu app id; env CODELARK_REAL_FEISHU_TEST_APP_ID is preferred',
    '  --test-feishu-app-secret <sec>  Test Feishu app secret; prefer --test-env-file or CODELARK_REAL_FEISHU_TEST_APP_SECRET to avoid shell/npm echo',
    '  --test-user-open-id <ou_>       Optional lark-cli user open_id; enables test-bot-owned group creation and cleanup',
    '  --test-user-access-token <u-...> Optional current bridge app user access token for deleting user-owned test groups',
    '  --feishu-site <site>       feishu|lark, default feishu',
    '  --lark-profile <name>      Optional lark-cli profile for user identity',
    '  --test-bot-open-id <ou_>        Optional bot open_id for structured cloud document mention comments',
    '  --scenario <name>          runtime-message|basic-dialogue-suite|command-state|session-management|history-boundaries|history-attachments|history-empty-isolation|history-long-truncation|history-suite|card-forms|agent-question-forms|markdown-rendering|doc-as-chat-from-scratch|message-only|require-at-toggle',
    '  --commands <list>          Extra commands to run before the final message; JSON array or ;; separated',
    '  --source-chat-id <oc_>     Existing p2p/group chat where /new will be sent',
    '  --chat-id <oc_>            Existing real test group; skips /new creation',
    '  --runtime <claude|codex>   Runtime to validate after group creation',
    '  --provider <name>          Codex: sdk|pty|tmux; Claude: pty|sdk. Default pty.',
    '  --channel-type <id>        Bridge channel type, default feishu-env',
    '  --workdir <path>           Working directory for /new',
    '  --message <text>           Test message to send as user',
    '  --run-id <id>              Unique run id included in group name/message',
    '  --output <path>            Write final dump JSON to a file',
    '',
  ].join('\n'));
}

function parseCommandList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) throw new Error('--commands JSON must be an array of strings.');
    return parsed.map((item) => String(item).trim()).filter(Boolean);
  }
  return trimmed.split(';;').map((item) => item.trim()).filter(Boolean);
}

function getScenarioDefinition(name: string): ScenarioDefinition {
  const scenario = SCENARIOS.find((item) => item.name === name);
  if (!scenario) {
    throw new Error(`Unknown scenario "${name}". Available scenarios: ${SCENARIOS.map((item) => item.name).join(', ')}`);
  }
  return scenario;
}

function providerMatrixForScenario(scenario: ScenarioDefinition): string[] {
  if (scenario.providerCoverage === 'runtime-parameterized') {
    return [
      `${scenario.testNamePrefix}::codex-sdk`,
      `${scenario.testNamePrefix}::codex-pty`,
      `${scenario.testNamePrefix}::codex-tmux`,
      `${scenario.testNamePrefix}::claude-pty`,
      `${scenario.testNamePrefix}::claude-sdk`,
    ];
  }
  if (scenario.providerCoverage === 'representative-provider') {
    return [`${scenario.testNamePrefix}::codex-tmux`];
  }
  if (scenario.providerCoverage === 'cross-provider-suite') {
    return [`${scenario.testNamePrefix}::cross-provider`];
  }
  return [];
}

function scenarioCoverage(options: CliOptions): Record<string, unknown> {
  const scenario = getScenarioDefinition(options.scenario);
  const runtimeTestName = scenario.providerCoverage === 'cross-provider-suite'
    ? `${scenario.testNamePrefix}::cross-provider`
    : scenario.providerCoverage === 'runtime-parameterized'
    || scenario.providerCoverage === 'representative-provider'
    ? `${scenario.testNamePrefix}::${options.runtime}-${options.provider}`
    : `${scenario.testNamePrefix}::${options.runtime}`;
  const matrix = providerMatrixForScenario(scenario);
  return {
    scenario: scenario.name,
    testName: runtimeTestName,
    runtime: options.runtime,
    provider: options.provider,
    providerCoverage: scenario.providerCoverage,
    coverageTier: scenario.coverageTier,
    ...(scenario.providerSequence ? { providerSequence: scenario.providerSequence } : {}),
    ...(scenario.name === 'basic-dialogue-suite' ? { basicDialogueSuite: basicDialogueSuitePlan(options) } : {}),
    dualProviderCompanion: matrix.find((name) => (
      options.runtime === 'codex'
        ? name.endsWith('::claude-pty')
        : name.endsWith('::codex-pty')
    )) || null,
    matrix,
    matrixCompanions: matrix.filter((name) => name !== runtimeTestName),
    unitCoverage: scenario.unitCoverage,
    e2eCoverage: scenario.e2eCoverage,
    coverageNotes: [
      scenario.providerCoverage === 'runtime-parameterized'
        ? '该场景需要覆盖 codex-sdk、codex-pty、codex-tmux、claude-pty、claude-sdk 五条路径，才能形成完整 runtime/provider 矩阵证据。'
        : scenario.providerCoverage === 'representative-provider'
        ? '该功能簇场景默认只要求代表 provider 路径；provider smoke matrix 负责完整 runtime/provider 健康检查。'
        : scenario.providerCoverage === 'cross-provider-suite'
        ? '该场景在同一会话中按固定 runtime/provider 顺序切换，用一条长对话验证 provider 独立性和无污染。'
        : '该场景验证与具体 runtime provider 无关的 bridge 行为。',
      scenario.coverageTier === 'mandatory-suite'
        ? 'mandatory-suite：最高优先级真实飞书集成测试，必须优先维护。'
        : scenario.coverageTier === 'representative-suite'
        ? 'representative-suite：使用代表 provider 汇总高信息量用户流程，不按 feature × provider 全矩阵扩张。'
        : scenario.coverageTier === 'legacy-transitional-evidence'
        ? 'legacy/transitional evidence：保留历史报告和局部回归价值，但不再作为后续补齐 full matrix 的主线。'
        : scenario.coverageTier === 'runtime-compressed-command-check'
        ? 'runtime-compressed command check：后续命令类覆盖应按 Codex/Claude runtime 压缩，只有 tmux 命令族额外覆盖 codex-tmux。'
        : scenario.coverageTier === 'runtime-smoke-evidence'
        ? 'runtime-smoke evidence：用于 provider path 健康检查，不替代 high-value feature suite。'
        : 'runtime-neutral check：验证与 provider 无关的飞书可见行为。',
      '场景名刻意与 unit::<suite>::<behavior> 覆盖引用呼应，便于失败后映射回本地测试。',
    ],
  };
}

function listScenarioMetadata(): unknown[] {
  return SCENARIOS.map((scenario) => ({
    scenario: scenario.name,
    testNamePattern: scenario.providerCoverage === 'cross-provider-suite'
      ? `${scenario.testNamePrefix}::cross-provider`
      : scenario.providerCoverage === 'runtime-parameterized'
      || scenario.providerCoverage === 'representative-provider'
      ? `${scenario.testNamePrefix}::<runtime>-<provider>`
      : `${scenario.testNamePrefix}::<runtime>`,
    description: scenario.description,
    providerCoverage: scenario.providerCoverage,
    coverageTier: scenario.coverageTier,
    ...(scenario.providerSequence ? { providerSequence: scenario.providerSequence } : {}),
    providerMatrix: providerMatrixForScenario(scenario),
    unitCoverage: scenario.unitCoverage,
    e2eCoverage: scenario.e2eCoverage,
  }));
}

function requireRealGuard(options: CliOptions): void {
  if (options.dryRun || options.dumpOnly || options.listScenarios || options.stopTestBridge) return;
  if (process.env.CODELARK_REAL_FEISHU_E2E !== '1') {
    throw new Error('Refusing to send real Feishu messages without CODELARK_REAL_FEISHU_E2E=1. Use --dry-run to inspect commands.');
  }
  if (usesFakeCcrBackend(options) && !options.launchBridge) {
    throw new Error([
      'Refusing to use fake CCR/basic-dialogue proxy mode without --launch-bridge.',
      'The fake CCR backend and .claude-code-router config are only injected into an isolated bridge launched by this harness.',
      'When driving an already running live bridge with --clk-home, that bridge will keep using its existing Claude executable and CCR config.',
      'Use --launch-bridge with test Feishu app credentials, or omit --fake-ccr and verify the live bridge is already externally configured for CCR.',
    ].join(' '));
  }
  if (options.scriptedBasicDialogue && !options.launchBridge) {
    throw new Error([
      'Refusing to use --scripted-basic-dialogue without --launch-bridge.',
      'The deterministic basic-dialogue proxies are injected into the isolated bridge child through HOME/CODEX_HOME/CCR proxy environment.',
      'When driving an already running live bridge with --clk-home, that bridge will keep using its existing runtime providers.',
    ].join(' '));
  }
  if (options.launchBridge && (!options.testFeishuAppId || !options.testFeishuAppSecret)) {
    throw new Error('Set CODELARK_REAL_FEISHU_TEST_APP_ID and CODELARK_REAL_FEISHU_TEST_APP_SECRET, or pass --test-feishu-app-id/--test-feishu-app-secret.');
  }
}

function validateScriptedBasicDialogueOptions(options: CliOptions): void {
  if (!options.scriptedBasicDialogue) return;
  if (options.scenario !== 'basic-dialogue-suite') {
    throw new Error('--scripted-basic-dialogue is only valid with --scenario basic-dialogue-suite.');
  }
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function stopPreviousTestBridge(options: CliOptions): Promise<Record<string, unknown>> {
  const codelarkHome = path.resolve(options.codelarkHome);
  const runRoot = path.resolve(options.runRoot);
  if (!path.basename(runRoot).startsWith('clk-real-feishu-') || !isPathInside(runRoot, codelarkHome)) {
    throw new Error([
      'Refusing to stop a bridge outside a real Feishu E2E run root.',
      `run_root=${runRoot}`,
      `clk_home=${codelarkHome}`,
      'Pass the exact --run-root/--clk-home for an isolated test run. This command never stops the normal live bridge.',
    ].join('\n'));
  }

  const status = readJsonIfExists<{ running?: boolean; pid?: number; channels?: string[] }>(
    path.join(codelarkHome, 'runtime', 'status.json'),
    {},
  );
  if (!status.pid || !isPidAlive(status.pid)) {
    const removedAppLocks = cleanupStaleAppLocksForCodelarkHome(codelarkHome);
    const removedTmuxSessions = await cleanupTestTmuxSessions(options);
    await cleanupTemporaryRunRoot(options);
    return {
      stopped: false,
      reason: 'no live test bridge pid found',
      runRoot,
      codelarkHome,
      removedAppLocks,
      removedTmuxSessions,
    };
  }

  process.kill(status.pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isPidAlive(status.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (isPidAlive(status.pid)) {
    process.kill(status.pid, 'SIGKILL');
  }
  const removedAppLocks = cleanupStaleAppLocksForCodelarkHome(codelarkHome);
  const removedTmuxSessions = await cleanupTestTmuxSessions(options);
  await cleanupTemporaryRunRoot(options);
  return {
    stopped: true,
    pid: status.pid,
    channels: status.channels || [],
    runRoot,
    codelarkHome,
    cleanedRunRoot: !options.keepCodelarkHome,
    removedAppLocks,
    removedTmuxSessions,
  };
}

function defaultCodelarkHome(): string {
  return process.env.CODELARK_HOME || path.join(os.homedir(), '.codelark');
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listConfiguredFeishuAppIds(codelarkHome: string): string[] {
  const config = createConfigService({ codelarkHome, env: {} }).snapshot().config;
  const appIds = new Set<string>();
  for (const channel of config.channels) {
    if (channel.provider !== 'feishu') continue;
    if (channel.enabled === false) continue;
    const appId = channel.config?.appId?.trim();
    if (appId) appIds.add(appId);
  }
  return [...appIds];
}

function inferConfiguredFeishuAppId(codelarkHome: string): string {
  const appIds = listConfiguredFeishuAppIds(codelarkHome);
  return appIds.length === 1 ? appIds[0] : '';
}

async function resolveLarkAuthAppId(options: CliOptions): Promise<string> {
  try {
    const stdout = await runLarkCli([
      'auth',
      'status',
      '--verify',
    ], options);
    const auth = findAuthStatusInJson(JSON.parse(stdout || '{}'));
    return auth.appId;
  } catch (error) {
    process.stderr.write(`[real-feishu-e2e] Failed to auto-detect lark-cli app id: ${error instanceof Error ? error.message : String(error)}\n`);
    return '';
  }
}

async function resolveEffectiveTestFeishuAppId(options: CliOptions): Promise<void> {
  if (options.testFeishuAppId) return;
  const configured = inferConfiguredFeishuAppId(options.codelarkHome);
  if (configured) {
    options.testFeishuAppId = configured;
    process.stderr.write(`[real-feishu-e2e] Inferred Feishu bot app id from ${options.codelarkHome} for chat creation and bot-message checks.\n`);
    return;
  }
  if (options.dryRun) return;
  const authAppId = await resolveLarkAuthAppId(options);
  if (authAppId) {
    options.testFeishuAppId = authAppId;
    process.stderr.write('[real-feishu-e2e] Inferred Feishu bot app id from lark-cli auth status for chat creation and bot-message checks.\n');
  }
}

function assertNoLiveBridgeUsingSameApp(options: CliOptions): void {
  if (options.dryRun || options.dumpOnly || !options.launchBridge || options.allowConcurrentApp) return;
  const liveCodelarkHome = defaultCodelarkHome();
  if (path.resolve(liveCodelarkHome) === path.resolve(options.codelarkHome)) return;
  if (!listConfiguredFeishuAppIds(liveCodelarkHome).includes(options.testFeishuAppId)) return;

  const status = readJsonIfExists<{ running?: boolean; pid?: number; channels?: string[] }>(
    path.join(liveCodelarkHome, 'runtime', 'status.json'),
    {},
  );
  if (!status.running || !isPidAlive(status.pid)) return;

  throw new Error([
    `Refusing to launch a second bridge for Feishu test app ${options.testFeishuAppId}.`,
    `live_clk_home=${liveCodelarkHome}`,
    `live_pid=${status.pid}`,
    `live_channels=${(status.channels || []).join(',') || '-'}`,
    `test_clk_home=${options.codelarkHome}`,
    'lark-cli user messages are safe; this guard only prevents two bridge long-connection clients from using the same app.',
    'Use the separate test Feishu app, stop/switch the live bridge first, or pass --allow-concurrent-app only if you accept random event delivery.',
  ].join('\n'));
}

function acquireAppLock(options: CliOptions): AppLock | null {
  if (options.dryRun || options.dumpOnly || !options.launchBridge || options.allowConcurrentApp) return null;
  const hash = crypto.createHash('sha256').update(`${options.feishuSite}:${options.testFeishuAppId}`).digest('hex').slice(0, 16);
  const lockPath = path.join(os.tmpdir(), `clk-real-feishu-app-${hash}.lock`);
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      appId: options.testFeishuAppId,
      codelarkHome: options.codelarkHome,
      runId: options.runId,
      createdAt: new Date().toISOString(),
    }, null, 2));
    return { path: lockPath, fd };
  } catch (error) {
    const existing = readJsonIfExists<{ pid?: number; codelarkHome?: string; runId?: string; createdAt?: string }>(lockPath, {});
    throw new Error([
      `Another real Feishu E2E bridge appears to be using the same test app (${options.testFeishuAppId}).`,
      `lock=${lockPath}`,
      `holder_pid=${existing.pid ?? '-'}`,
      `holder_run=${existing.runId ?? '-'}`,
      `holder_clk_home=${existing.codelarkHome ?? '-'}`,
      'Stop the other test or pass --allow-concurrent-app only if you accept random event delivery.',
    ].join('\n'));
  }
}

function cleanupStaleAppLocksForCodelarkHome(codelarkHome: string): string[] {
  const removed: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return removed;
  }
  const normalizedCodelarkHome = path.resolve(codelarkHome);
  for (const entry of entries) {
    if (!entry.startsWith('clk-real-feishu-app-') || !entry.endsWith('.lock')) continue;
    const lockPath = path.join(os.tmpdir(), entry);
    const lock = readJsonIfExists<{ pid?: number; codelarkHome?: string }>(lockPath, {});
    if (path.resolve(lock.codelarkHome || '') !== normalizedCodelarkHome) continue;
    if (isPidAlive(lock.pid)) continue;
    try {
      fs.rmSync(lockPath, { force: true });
      removed.push(lockPath);
    } catch {
      // Non-fatal; a concurrent cleanup may have removed it first.
    }
  }
  return removed;
}

function releaseAppLock(lock: AppLock | null): void {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch { /* ignore */ }
  try { fs.rmSync(lock.path, { force: true }); } catch { /* ignore */ }
}

async function cleanupTestTmuxSessions(options: CliOptions): Promise<string[]> {
  if (options.keepCodelarkHome || options.dumpOnly || options.dryRun) return [];
  const normalizedRunRoot = path.resolve(options.runRoot);
  const normalizedCodelarkHome = path.resolve(options.codelarkHome);
  if (!normalizedRunRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)) return [];
  if (!path.basename(normalizedRunRoot).startsWith('clk-real-feishu-')) return [];
  if (!isPathInside(normalizedRunRoot, normalizedCodelarkHome)) return [];

  const rawSessions = readJsonIfExists<unknown>(path.join(normalizedCodelarkHome, 'data', 'sessions.json'), {});
  const sessions = rawSessions && typeof rawSessions === 'object' && !Array.isArray(rawSessions)
    ? rawSessions as Record<string, Record<string, unknown>>
    : {};
  const tmuxSessionNames = new Set(Object.values(sessions)
    .map((session) => {
      const runtime = session.runtime as { general?: { tmuxSessionName?: unknown } } | undefined;
      const name = runtime?.general?.tmuxSessionName;
      return typeof name === 'string' && name.trim().startsWith('codex_') ? name.trim() : '';
    })
    .filter(Boolean));

  const scanFiles = [
    path.join(normalizedCodelarkHome, 'logs', 'bridge.log'),
    path.join(normalizedCodelarkHome, 'data', 'audit.json'),
    path.join(normalizedCodelarkHome, 'data', 'messages.json'),
    path.join(normalizedCodelarkHome, 'data', 'sessions.json'),
  ];
  for (const filePath of scanFiles) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    for (const match of content.matchAll(/\bcodex_[0-9a-f-]{20,}\b/g)) {
      tmuxSessionNames.add(match[0]);
    }
  }

  const removed: string[] = [];
  for (const sessionName of Array.from(tmuxSessionNames).sort()) {
    try {
      await execFileAsync('tmux', ['kill-session', '-t', sessionName], {
        env: sanitizedChildEnv(),
        timeout: 5_000,
      });
      removed.push(sessionName);
    } catch {
      // Missing tmux or already-closed sessions are fine for cleanup.
    }
  }
  return removed;
}

async function cleanupTemporaryRunRoot(options: CliOptions): Promise<void> {
  if (options.keepCodelarkHome || options.dumpOnly || options.dryRun) return;
  const normalized = path.resolve(options.runRoot);
  if (!normalized.startsWith(path.resolve(os.tmpdir()) + path.sep)) return;
  if (!path.basename(normalized).startsWith('clk-real-feishu-')) return;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    fs.rmSync(normalized, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fs.rmSync(normalized, { recursive: true, force: true });
}

function copyFileIfExists(sourcePath: string, targetPath: string): boolean {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return false;
  if (!fs.statSync(sourcePath).isFile()) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.cpSync(sourcePath, targetPath, { force: false, errorOnExist: true });
  return true;
}

function copyJsonFileIfExists(sourcePath: string, targetPath: string, overrides: Record<string, unknown> = {}): boolean {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return false;
  if (!fs.statSync(sourcePath).isFile()) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf-8')) as Record<string, unknown>;
  fs.writeFileSync(targetPath, `${JSON.stringify({ ...parsed, ...overrides }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  return true;
}

function copyHostClaudeConfig(hostHome: string, runtimeHome: string): boolean {
  const hostClaudeDir = path.join(hostHome, '.claude');
  const targetClaudeDir = path.join(runtimeHome, '.claude');
  let copied = false;
  for (const relativePath of [
    'settings.json',
    'settings.local.json',
    '.credentials.json',
  ]) {
    copied = copyFileIfExists(path.join(hostClaudeDir, relativePath), path.join(targetClaudeDir, relativePath)) || copied;
  }
  return copied;
}

function copyHostCcrConfig(hostHome: string, runtimeHome: string, port?: number): boolean {
  return copyJsonFileIfExists(
    path.join(hostHome, '.claude-code-router', 'config.json'),
    path.join(runtimeHome, '.claude-code-router', 'config.json'),
    port ? { HOST: '127.0.0.1', PORT: port } : {},
  );
}

function writeCodexApiKeyAuth(codexHome: string, apiKey: string): void {
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    auth_mode: 'apikey',
    OPENAI_API_KEY: apiKey,
  }, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

function createChatCompletionChunkPayload(model: string, delta: { role?: string; content?: string }, finishReason: string | null = null): string {
  const now = Math.floor(Date.now() / 1000);
  const id = `chatcmpl_clk_${now}`;
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: now,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function createChatCompletionsEventStreamPayload(model: string, plan: ScriptedModelReplyPlan): string[] {
  const now = Math.floor(Date.now() / 1000);
  const id = `chatcmpl_clk_${now}`;
  return [
    createChatCompletionChunkPayload(model, { role: 'assistant' }),
    ...plan.chunks.map((content) => createChatCompletionChunkPayload(model, { content })),
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: now,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

function createResponsesEventStreamPayload(model: string, plan: ScriptedModelReplyPlan): string[] {
  const now = Math.floor(Date.now() / 1000);
  const responseId = `resp_clk_${now}`;
  const itemId = `msg_clk_${now}`;
  const events: Array<[string, unknown]> = [
    ['response.created', {
      type: 'response.created',
      response: { id: responseId, object: 'response', created_at: now, status: 'in_progress', model, output: [] },
    }],
    ['response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    }],
    ['response.content_part.added', {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    }],
    ...plan.chunks.map((delta): [string, unknown] => ['response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta,
    }]),
    ['response.output_text.done', {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: plan.text,
    }],
    ['response.content_part.done', {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: plan.text },
    }],
    ['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: plan.text }],
      },
    }],
    ['response.completed', {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        created_at: now,
        status: 'completed',
        model,
        output: [{
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: plan.text }],
        }],
        usage: {
          input_tokens: 1,
          output_tokens: 4,
          total_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    }],
  ];
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .concat('data: [DONE]\n\n');
}

function writeTimedChunks(
  res: http.ServerResponse,
  chunks: string[],
  delayMs: number,
): void {
  let index = 0;
  const writeNext = () => {
    if (index >= chunks.length) {
      res.end();
      return;
    }
    res.write(chunks[index]);
    index += 1;
    setTimeout(writeNext, delayMs);
  };
  writeNext();
}

function basicDialogueProviderKeyFromMarker(marker: string): string {
  const suffix = marker.match(/_(CODEX_SDK|CLAUDE_SDK|CODEX_TMUX|CLAUDE_PTY|CODEX_PTY)$/u)?.[1] || '';
  return suffix.toLowerCase().replace(/_/g, '-');
}

function basicDialogueProxyReplyPlan(rawBody: string, fallback: string): ScriptedModelReplyPlan {
  const markerMatch = rawBody.match(/\bCODELARK_BASIC_DIALOGUE_[A-Z0-9_]+_(?:CODEX_SDK|CLAUDE_SDK|CODEX_TMUX|CLAUDE_PTY|CODEX_PTY)\b/u);
  if (!markerMatch) {
    return {
      text: fallback,
      chunks: [fallback],
      chunkDelayMs: BASIC_DIALOGUE_MODEL_PROXY_CHUNK_DELAY_MS,
    };
  }
  const marker = markerMatch[0];
  const providerKey = basicDialogueProviderKeyFromMarker(marker);
  const chunks = rawBody.includes('FOLLOWUP')
    ? [marker, ' FOLLOWUP_ACK']
    : [
      `${marker}\n`,
      `provider preload complete: ${providerKey}\n`,
      `${providerKey} partial text\n`,
      `Goal Active: ${providerKey} provider isolation\n`,
      `running representative tool: ${providerKey}\n`,
      'Bash\n',
      'Context: 42%\n',
    ];
  return {
    text: chunks.join(''),
    chunks,
    chunkDelayMs: BASIC_DIALOGUE_MODEL_PROXY_CHUNK_DELAY_MS,
  };
}

function usesProxyBackedBasicDialogue(options: CliOptions): boolean {
  return options.scriptedBasicDialogue && options.scenario === 'basic-dialogue-suite';
}

function usesFakeCcrBackend(options: CliOptions): boolean {
  return options.fakeCcr || usesProxyBackedBasicDialogue(options);
}

function parseJsonObject(rawBody: string): Record<string, unknown> | null {
  if (!rawBody.trim()) return null;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function codexProxyRequestSummaries(requests: LocalCodexResponsesProxy['requests']): CodexProxyRequestSummary[] {
  return requests
    .filter((request) => request.url.includes('/responses'))
    .map((request) => {
      const body = parseJsonObject(request.rawBody);
      const reasoning = body?.reasoning;
      return {
        method: request.method,
        url: request.url,
        ...(typeof body?.model === 'string' ? { model: body.model } : {}),
        ...(typeof reasoning === 'object'
          && reasoning !== null
          && typeof (reasoning as { effort?: unknown }).effort === 'string'
          ? { reasoningEffort: (reasoning as { effort: string }).effort }
          : {}),
        hasBootstrapPrompt: request.rawBody.includes('Initialize this Codex session and wait for the next instruction.'),
      };
    });
}

function codexProxyModelAudit(options: CliOptions, proxy: LocalCodexResponsesProxy | null): CodexProxyModelAudit {
  const summaries = proxy ? codexProxyRequestSummaries(proxy.requests) : [];
  const actualModels = Array.from(new Set(summaries.flatMap((request) => (
    request.model ? [request.model] : []
  ))));
  return {
    requestedModel: options.codexModel,
    actualModels,
    exactMatch: actualModels.includes(options.codexModel),
    hasModelField: actualModels.length > 0,
    hasReasoningLow: summaries.some((request) => request.reasoningEffort === 'low'),
    hasBootstrapPrompt: summaries.some((request) => request.hasBootstrapPrompt),
  };
}

function codexProxyModelAuditDetail(audit: CodexProxyModelAudit): string {
  const actual = audit.actualModels.length > 0 ? audit.actualModels.join(', ') : '-';
  return [
    `requestedModel=${audit.requestedModel}`,
    `actualModels=${actual}`,
    `exactMatch=${audit.exactMatch ? 'yes' : 'no'}`,
    audit.exactMatch ? 'Codex CLI request model matched the configured model.' : 'Fallback accepted: Codex CLI resolved the configured model to a different request body model; see requestedModel and actualModels.',
  ].join('; ');
}

async function startLocalCodexResponsesProxy(responseText: string): Promise<LocalCodexResponsesProxy> {
  const requests: LocalCodexResponsesProxy['requests'] = [];
  const server = http.createServer((req, res) => {
    let rawBody = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method || '', url: req.url || '', rawBody });
      let body: unknown = null;
      if (rawBody) {
        try { body = JSON.parse(rawBody) as unknown; } catch { body = rawBody; }
      }
      if (req.method === 'POST' && req.url?.includes('/responses')) {
        const model = typeof body === 'object'
          && body !== null
          && typeof (body as { model?: unknown }).model === 'string'
          ? (body as { model: string }).model
          : 'gpt-5';
        const plan = basicDialogueProxyReplyPlan(rawBody, responseText);
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        writeTimedChunks(res, createResponsesEventStreamPayload(model, plan), plan.chunkDelayMs);
        return;
      }
      if (req.method === 'GET' && req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  const wss = new WebSocketServer({ server, path: '/v1/responses' });
  wss.on('connection', (ws, req) => {
    ws.on('message', (data) => {
      const rawBody = data.toString();
      requests.push({ method: 'WS', url: req.url || '/v1/responses', rawBody });
      let body: unknown = rawBody;
      try { body = JSON.parse(rawBody) as unknown; } catch { /* keep raw */ }
      const model = typeof body === 'object'
        && body !== null
        && typeof (body as { model?: unknown }).model === 'string'
        ? (body as { model: string }).model
        : 'gpt-5';
      const plan = basicDialogueProxyReplyPlan(rawBody, responseText);
      const chunks = createResponsesEventStreamPayload(model, plan);
      chunks.forEach((chunk, index) => {
        const dataLine = chunk.trim().split(/\n/).find((line) => line.startsWith('data: '));
        if (!dataLine || dataLine === 'data: [DONE]') return;
        setTimeout(() => ws.send(dataLine.slice('data: '.length)), index * plan.chunkDelayMs);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Failed to start local Codex Responses proxy.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => {
      wss.close(() => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }),
  };
}

async function startLocalFakeCcrBackend(responseText: string): Promise<LocalFakeCcrBackend> {
  const requests: LocalFakeCcrBackend['requests'] = [];
  const server = http.createServer((req, res) => {
    let rawBody = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method || '', url: req.url || '', rawBody });
      let body: unknown = null;
      if (rawBody) {
        try { body = JSON.parse(rawBody) as unknown; } catch { body = rawBody; }
      }
      if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
        const plan = basicDialogueProxyReplyPlan(rawBody, responseText);
        const model = typeof body === 'object'
          && body !== null
          && typeof (body as { model?: unknown }).model === 'string'
          ? (body as { model: string }).model
          : 'clk-fake-claude';
        const wantsStream = typeof body === 'object'
          && body !== null
          && (body as { stream?: unknown }).stream === true;
        if (wantsStream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          writeTimedChunks(res, createChatCompletionsEventStreamPayload(model, plan), plan.chunkDelayMs);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: `chatcmpl_clk_${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: plan.text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
        }));
        return;
      }
      if (req.method === 'GET' && req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'clk-fake-claude', object: 'model' }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Failed to start local fake CCR backend.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function reserveLocalPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Failed to reserve local port.');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function fakeCcrConfigJson(options: CliOptions): string {
  if (!options.fakeCcrProxyBaseUrl || !options.fakeCcrPort) {
    throw new Error('Fake CCR backend was requested but proxy base URL or CCR port was not prepared.');
  }
  return JSON.stringify({
    LOG: false,
    HOST: '127.0.0.1',
    PORT: options.fakeCcrPort,
    API_TIMEOUT_MS: '120000',
    Providers: [{
      name: 'clk-fake',
      api_base_url: `${options.fakeCcrProxyBaseUrl}/chat/completions`,
      api_key: 'clk-fake-key',
      models: ['clk-fake-claude'],
      transformer: { use: ['openrouter'] },
    }],
    Router: {
      default: 'clk-fake,clk-fake-claude',
      background: 'clk-fake,clk-fake-claude',
      think: 'clk-fake,clk-fake-claude',
      longContext: 'clk-fake,clk-fake-claude',
      webSearch: 'clk-fake,clk-fake-claude',
    },
  }, null, 2);
}

function prepareRuntimeEnvironment(options: CliOptions): RuntimeEnvironmentPlan {
  fs.mkdirSync(options.runRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(options.runtimeHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(options.codexHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(options.claudeHome, { recursive: true, mode: 0o700 });

  const larkCliConfigSource = initializeIsolatedLarkCliConfig(options);

  let codexAuthSource: RuntimeEnvironmentPlan['codexAuthSource'] = 'missing';
  const codexApiKey = process.env.CODELARK_CODEX_API_KEY
    || process.env.CODEX_API_KEY
    || process.env.OPENAI_API_KEY
    || '';
  if (usesProxyBackedBasicDialogue(options)) {
    writeCodexApiKeyAuth(options.codexHome, 'clk-local-proxy-key');
    codexAuthSource = 'env-api-key';
  } else if (codexApiKey) {
    writeCodexApiKeyAuth(options.codexHome, codexApiKey);
    codexAuthSource = 'env-api-key';
  } else {
    const hostCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    if (copyFileIfExists(path.join(hostCodexHome, 'auth.json'), path.join(options.codexHome, 'auth.json'))) {
      codexAuthSource = 'host-auth-copy';
    }
    copyFileIfExists(path.join(hostCodexHome, 'config.toml'), path.join(options.codexHome, 'config.toml'));
  }

  const claudeAuthSource: RuntimeEnvironmentPlan['claudeAuthSource'] =
    copyHostClaudeConfig(os.homedir(), options.runtimeHome)
      ? 'host-config-copy'
      : 'missing';

  let ccrConfigSource: RuntimeEnvironmentPlan['ccrConfigSource'] = 'not-needed';
  if (options.claudeExecutable === 'ccr') {
    const ccrDir = path.join(options.runtimeHome, '.claude-code-router');
    if (usesFakeCcrBackend(options)) {
      fs.mkdirSync(ccrDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(ccrDir, 'config.json'), fakeCcrConfigJson(options) + '\n', { encoding: 'utf-8', mode: 0o600 });
      ccrConfigSource = 'fake-backend-json';
    } else {
      ccrConfigSource = copyHostCcrConfig(os.homedir(), options.runtimeHome, options.fakeCcrPort) ? 'host-config-copy' : 'missing';
    }
  }

  return {
    runtimeHome: options.runtimeHome,
    codexHome: options.codexHome,
    claudeHome: options.claudeHome,
    claudeExecutable: options.claudeExecutable,
    larkCliConfigSource,
    codexAuthSource,
    claudeAuthSource,
    ccrConfigSource,
    ...(options.fakeCcrProxyBaseUrl ? { fakeCcrProxyBaseUrl: options.fakeCcrProxyBaseUrl } : {}),
    ...(options.fakeCcrPort ? { fakeCcrPort: options.fakeCcrPort } : {}),
    ...(options.fakeCcrPort ? { ccrPort: options.fakeCcrPort } : {}),
    ...(options.codexProxyBaseUrl ? { codexProxyBaseUrl: options.codexProxyBaseUrl } : {}),
  };
}

function plannedRuntimeEnvironment(options: CliOptions): RuntimeEnvironmentPlan {
  return {
    runtimeHome: options.runtimeHome,
    codexHome: options.codexHome,
    claudeHome: options.claudeHome,
    claudeExecutable: options.claudeExecutable,
    larkCliConfigSource: options.launchBridge ? 'missing' : 'not-needed',
    codexAuthSource: 'missing',
    claudeAuthSource: 'missing',
    ccrConfigSource: options.claudeExecutable === 'ccr' ? 'missing' : 'not-needed',
  };
}

function initializeIsolatedLarkCliConfig(options: CliOptions): RuntimeEnvironmentPlan['larkCliConfigSource'] {
  if (options.dryRun || !options.launchBridge) return 'not-needed';
  if (!options.testFeishuAppId || !options.testFeishuAppSecret) return 'missing';
  fs.mkdirSync(options.runtimeHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(options.runtimeHome, '.local', 'share'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(options.runtimeHome, '.config'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(options.runtimeHome, '.cache'), { recursive: true, mode: 0o700 });
  const larkCliConfigPath = path.join(options.runtimeHome, '.lark-cli', 'config.json');
  const existingConfig = readJsonIfExists<{ apps?: Array<{ appId?: string }> }>(larkCliConfigPath, {});
  if (existingConfig.apps?.some((app) => app.appId === options.testFeishuAppId)) {
    return 'test-env-app';
  }
  execFileSync(
    'npx',
    [
      'lark-cli',
      'config',
      'init',
      '--app-id',
      options.testFeishuAppId,
      '--brand',
      options.feishuSite,
      '--app-secret-stdin',
    ],
    {
      cwd: process.cwd(),
      env: sanitizedChildEnv({
        HOME: options.runtimeHome,
        USERPROFILE: options.runtimeHome,
        XDG_DATA_HOME: path.join(options.runtimeHome, '.local', 'share'),
        XDG_CONFIG_HOME: path.join(options.runtimeHome, '.config'),
        XDG_CACHE_HOME: path.join(options.runtimeHome, '.cache'),
      }),
      input: options.testFeishuAppSecret,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  process.stderr.write(`[real-feishu-e2e] Initialized isolated lark-cli config in HOME=${options.runtimeHome} app=${options.testFeishuAppId}\n`);
  return 'test-env-app';
}

function isolatedLarkCliEnv(options: CliOptions): Record<string, string> {
  if (!options.launchBridge) return {};
  return {
    HOME: options.runtimeHome,
    USERPROFILE: options.runtimeHome,
    XDG_DATA_HOME: path.join(options.runtimeHome, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(options.runtimeHome, '.config'),
    XDG_CACHE_HOME: path.join(options.runtimeHome, '.cache'),
  };
}

function sanitizedChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
}

async function runCommand(command: string, args: string[], options: CliOptions, extraEnv: Record<string, string> = {}): Promise<string> {
  process.stderr.write(`[real-feishu-e2e] $ ${[command, ...args].join(' ')}\n`);
  if (options.dryRun) return '';
  const { stdout, stderr } = await execFileAsync(command, args, {
    env: sanitizedChildEnv(extraEnv),
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr.trim()) process.stderr.write(stderr);
  return stdout;
}

async function runLarkCli(args: string[], options: CliOptions): Promise<string> {
  return runCommand(
    'npx',
    ['lark-cli', ...(options.larkProfile ? ['--profile', options.larkProfile] : []), ...args],
    options,
    isolatedLarkCliEnv(options),
  );
}

async function sendUserText(chatId: string, text: string, options: CliOptions): Promise<string> {
  const idempotencyKey = crypto
    .createHash('sha256')
    .update(`${options.runId}:${chatId}:${text}:${Date.now()}`)
    .digest('hex')
    .slice(0, 32);
  const stdout = await runLarkCli([
    'im',
    '+messages-send',
    '--as',
    'user',
    '--chat-id',
    chatId,
    '--text',
    text,
    '--idempotency-key',
    idempotencyKey,
  ], options);
  if (options.dryRun) return '<sent-message-id>';
  const messageId = findMessageIdInJson(JSON.parse(stdout || '{}'));
  if (!messageId) {
    throw new Error(`lark-cli messages-send returned no message_id: ${stdout.slice(0, 1000)}`);
  }
  return messageId;
}

async function sendUserContent(chatId: string, content: unknown, msgType: string, options: CliOptions): Promise<string> {
  const idempotencyKey = crypto
    .createHash('sha256')
    .update(`${options.runId}:${chatId}:${msgType}:${JSON.stringify(content)}:${Date.now()}`)
    .digest('hex')
    .slice(0, 32);
  const stdout = await runLarkCli([
    'im',
    '+messages-send',
    '--as',
    'user',
    '--chat-id',
    chatId,
    '--msg-type',
    msgType,
    '--content',
    JSON.stringify(content),
    '--idempotency-key',
    idempotencyKey,
  ], options);
  if (options.dryRun) return '<sent-message-id>';
  const messageId = findMessageIdInJson(JSON.parse(stdout || '{}'));
  if (!messageId) {
    throw new Error(`lark-cli messages-send returned no message_id: ${stdout.slice(0, 1000)}`);
  }
  return messageId;
}

async function listChatMessages(chatId: string, options: CliOptions, pageSize = 20): Promise<unknown | null> {
  try {
    const stdout = await runLarkCli([
      'im',
      '+chat-messages-list',
      '--chat-id',
      chatId,
      '--page-size',
      String(pageSize),
      '--format',
      'json',
    ], options);
    return JSON.parse(stdout || '{}');
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function countBotMessagesFromChatMessages(payload: unknown, options: CliOptions): number {
  if (!payload || typeof payload !== 'object') return 0;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return 0;
  const messages = (data as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return 0;
  return messages.filter((message) => {
    if (!message || typeof message !== 'object') return false;
    const sender = (message as { sender?: unknown }).sender;
    if (!sender || typeof sender !== 'object') return false;
    const senderRecord = sender as { id?: unknown; id_type?: unknown; sender_type?: unknown };
    return senderRecord.sender_type === 'app'
      && senderRecord.id_type === 'app_id'
      && senderRecord.id === options.testFeishuAppId;
  }).length;
}

function hasBotReplyToMessage(payload: unknown, sourceMessageId: string, options: CliOptions): boolean {
  return findBotRepliesToMessage(payload, sourceMessageId, options).length > 0;
}

function findBotRepliesToMessage(payload: unknown, sourceMessageId: string, options: CliOptions): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return [];
  const messages = (data as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter((message) => {
    if (!message || typeof message !== 'object') return false;
    const record = message as { sender?: unknown; reply_to?: unknown };
    if (record.reply_to !== sourceMessageId) return false;
    const sender = record.sender;
    if (!sender || typeof sender !== 'object') return false;
    const senderRecord = sender as { id?: unknown; id_type?: unknown; sender_type?: unknown };
    return senderRecord.sender_type === 'app'
      && senderRecord.id_type === 'app_id'
      && senderRecord.id === options.testFeishuAppId;
  });
}

function messageContentContainsKeys(message: unknown, keys: string[]): boolean {
  if (keys.length === 0) return true;
  const content = messageContent(message);
  return keys.every((key) => {
    if (content.includes(key)) return true;
    if (key === 'file_key') {
      return /<file\s+key=["']file_[^"']+["']/u.test(content)
        || /"file_key"\s*:/u.test(content)
        || /\bfile_v\d+_[A-Za-z0-9_-]+/u.test(content);
    }
    return false;
  });
}

function hasBotReplyToMessageMatching(
  payload: unknown,
  sourceMessageId: string,
  expectation: ReplyExpectation,
  options: CliOptions,
): boolean {
  const replies = findBotRepliesToMessage(payload, sourceMessageId, options);
  if (replies.length === 0) return false;
  const requiredTexts = expectation.texts.filter(Boolean);
  const forbiddenTexts = expectation.forbiddenTexts.filter(Boolean);
  const requiredMessageTypes = expectation.messageTypes.filter(Boolean);
  const requiredContentKeys = expectation.contentKeys.filter(Boolean);
  return replies.some((message) => {
    if (requiredMessageTypes.length > 0) {
      const msgType = (message as { msg_type?: unknown; message_type?: unknown }).msg_type
        ?? (message as { message_type?: unknown }).message_type;
      if (!requiredMessageTypes.includes(String(msgType))) return false;
    }
    if (!messageContentContainsKeys(message, requiredContentKeys)) return false;
    const content = messageContent(message);
    if (forbiddenTexts.some((forbiddenText) => content.includes(forbiddenText))) return false;
    if (requiredTexts.length === 0) return true;
    return requiredTexts.every((expectedText) => content.includes(expectedText));
  });
}

function payloadContainsText(payload: unknown, expectedText: string): boolean {
  if (!expectedText) return true;
  try {
    return JSON.stringify(payload).includes(expectedText);
  } catch {
    return false;
  }
}

function botTranscriptContainsText(payload: unknown, expectedText: string, options: CliOptions): boolean {
  if (!expectedText) return true;
  return getFeishuTranscriptMessages(payload).some((message) => (
    isTestBotMessage(message, options) && messageContent(message).includes(expectedText)
  ));
}

function botTranscriptMatchesExpectation(payload: unknown, expectation: ReplyExpectation, options: CliOptions): boolean {
  const requiredTexts = expectation.texts.filter(Boolean);
  const forbiddenTexts = expectation.forbiddenTexts.filter(Boolean);
  const requiredMessageTypes = expectation.messageTypes.filter(Boolean);
  const requiredContentKeys = expectation.contentKeys.filter(Boolean);
  return getFeishuTranscriptMessages(payload).some((message) => {
    if (!isTestBotMessage(message, options)) return false;
    if (requiredMessageTypes.length > 0) {
      const msgType = (message as { msg_type?: unknown; message_type?: unknown }).msg_type
        ?? (message as { message_type?: unknown }).message_type;
      if (!requiredMessageTypes.includes(String(msgType))) return false;
    }
    if (!messageContentContainsKeys(message, requiredContentKeys)) return false;
    const content = messageContent(message);
    if (forbiddenTexts.some((forbiddenText) => content.includes(forbiddenText))) return false;
    return requiredTexts.every((expectedText) => content.includes(expectedText));
  });
}

function findBotMemberInJson(value: unknown, appId: string): { botId: string; botName: string } | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBotMemberInJson(item, appId);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const items = Array.isArray(record.items)
    ? record.items
    : (record.data && typeof record.data === 'object' && Array.isArray((record.data as { items?: unknown }).items))
      ? (record.data as { items: unknown[] }).items
      : null;
  if (items) {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const bot = item as { bot_id?: unknown; bot_name?: unknown; app_id?: unknown };
      if (bot.app_id && bot.app_id !== appId) continue;
      if (typeof bot.bot_id === 'string' && bot.bot_id) {
        return {
          botId: bot.bot_id,
          botName: typeof bot.bot_name === 'string' && bot.bot_name ? bot.bot_name : 'bot',
        };
      }
    }
  }
  return null;
}

async function getTestBotMember(chatId: string, options: CliOptions): Promise<{ botId: string; botName: string }> {
  const stdout = await runLarkCli([
    'im',
    'chat.members',
    'bots',
    '--as',
    'user',
    '--params',
    JSON.stringify({ chat_id: chatId }),
    '--format',
    'json',
  ], options);
  if (options.dryRun) return { botId: '<bot-open-id>', botName: 'bot' };
  const member = findBotMemberInJson(JSON.parse(stdout || '{}'), options.testFeishuAppId);
  if (!member) {
    throw new Error(`Unable to find test bot member in chat ${chatId}: ${stdout.slice(0, 1000)}`);
  }
  return member;
}

async function sendMentionedUserText(chatId: string, text: string, options: CliOptions): Promise<string> {
  const bot = await getTestBotMember(chatId, options);
  return sendUserContent(chatId, {
    text: `<at user_id="${bot.botId}">${bot.botName}</at> ${text}`,
  }, 'text', options);
}

async function fetchTestBotTenantAccessToken(options: CliOptions): Promise<string> {
  const baseUrl = feishuSiteToApiBaseUrl(options.feishuSite);
  const response = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: options.testFeishuAppId,
      app_secret: options.testFeishuAppSecret,
    }),
  });
  const data = await response.json() as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
  };
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(data.msg || `tenant_access_token failed: HTTP ${response.status}`);
  }
  return data.tenant_access_token;
}

function findAuthStatusInJson(value: unknown): { appId: string; userOpenId: string } {
  if (!value || typeof value !== 'object') return { appId: '', userOpenId: '' };
  const appId = typeof (value as { appId?: unknown }).appId === 'string'
    ? (value as { appId: string }).appId
    : '';
  const identities = (value as { identities?: unknown }).identities;
  if (identities && typeof identities === 'object') {
    const user = (identities as { user?: unknown }).user;
    if (user && typeof user === 'object') {
      const openId = (user as { openId?: unknown; open_id?: unknown }).openId
        || (user as { openId?: unknown; open_id?: unknown }).open_id;
      if (typeof openId === 'string' && openId.startsWith('ou_')) return { appId, userOpenId: openId };
    }
  }
  return { appId, userOpenId: '' };
}

function parseLarkCliUserAuthorizationStatus(value: unknown): LarkCliUserAuthorizationStatus {
  const appId = value && typeof value === 'object' && typeof (value as { appId?: unknown }).appId === 'string'
    ? (value as { appId: string }).appId
    : '';
  const identities = value && typeof value === 'object'
    ? (value as { identities?: unknown }).identities
    : null;
  const user = identities && typeof identities === 'object'
    ? (identities as { user?: unknown }).user
    : null;
  if (!user || typeof user !== 'object') {
    return {
      appId,
      userOpenId: '',
      userAvailable: false,
      userVerified: false,
      userStatus: '',
      tokenStatus: '',
      scopes: new Set(),
    };
  }
  const record = user as {
    available?: unknown;
    verified?: unknown;
    openId?: unknown;
    open_id?: unknown;
    status?: unknown;
    tokenStatus?: unknown;
    token_status?: unknown;
    scope?: unknown;
  };
  const scopeText = typeof record.scope === 'string' ? record.scope : '';
  return {
    appId,
    userOpenId: typeof record.openId === 'string'
      ? record.openId
      : typeof record.open_id === 'string'
        ? record.open_id
        : '',
    userAvailable: record.available === true,
    userVerified: record.verified === true,
    userStatus: typeof record.status === 'string' ? record.status : '',
    tokenStatus: typeof record.tokenStatus === 'string'
      ? record.tokenStatus
      : typeof record.token_status === 'string'
        ? record.token_status
        : '',
    scopes: new Set(scopeText.split(/\s+/).map((scope) => scope.trim()).filter(Boolean)),
  };
}

function hasAnyScope(scopes: Set<string>, alternatives: string[]): boolean {
  return alternatives.some((scope) => scopes.has(scope));
}

function missingLarkCliUserScopes(scopes: Set<string>, options: CliOptions): string[] {
  const required: Array<{ label: string; alternatives: string[] }> = [
    {
      label: 'im:chat:read or im:chat',
      alternatives: ['im:chat:read', 'im:chat'],
    },
    {
      label: 'im:message.send_as_user or im:message',
      alternatives: ['im:message.send_as_user', 'im:message'],
    },
    {
      label: 'im:message.group_msg:get_as_user or im:message:readonly or im:message',
      alternatives: ['im:message.group_msg:get_as_user', 'im:message:readonly', 'im:message'],
    },
    {
      label: 'im:message.p2p_msg:get_as_user or im:message:readonly or im:message',
      alternatives: ['im:message.p2p_msg:get_as_user', 'im:message:readonly', 'im:message'],
    },
  ];
  if (options.createChat || options.sourceChatId || options.scenario === 'doc-as-chat-from-scratch') {
    required.push({
      label: 'im:chat:create_by_user or im:chat',
      alternatives: ['im:chat:create_by_user', 'im:chat'],
    });
    if (!options.keepGroup) {
      required.push({
        label: 'im:chat:delete or im:chat',
        alternatives: ['im:chat:delete', 'im:chat'],
      });
    }
  }
  return required
    .filter((item) => !hasAnyScope(scopes, item.alternatives))
    .map((item) => item.label);
}

function larkCliUserAuthorizationHome(options: CliOptions): string {
  if (options.launchBridge) return options.runtimeHome;
  return process.env.HOME || os.homedir();
}

async function assertLarkCliUserAuthorizationPreflight(options: CliOptions): Promise<void> {
  if (options.dryRun || options.dumpOnly || options.listScenarios || options.stopTestBridge) return;
  let stdout = '';
  try {
    stdout = await runLarkCli([
      'auth',
      'status',
      '--verify',
    ], options);
  } catch (error) {
    throw new Error([
      'lark-cli user authorization preflight failed before running real Feishu E2E.',
      `lark_cli_home=${larkCliUserAuthorizationHome(options)}`,
      `reason=${error instanceof Error ? error.message : String(error)}`,
      'Run lark-cli auth login for the same HOME/profile used by this harness before launching the E2E flow.',
    ].join('\n'));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || '{}');
  } catch (error) {
    throw new Error([
      'lark-cli user authorization preflight failed before running real Feishu E2E.',
      `lark_cli_home=${larkCliUserAuthorizationHome(options)}`,
      `reason=auth status returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`,
    ].join('\n'));
  }
  const status = parseLarkCliUserAuthorizationStatus(parsed);
  const missingScopes = missingLarkCliUserScopes(status.scopes, options);
  if (
    !status.userAvailable
    || !status.userVerified
    || !status.userOpenId
    || missingScopes.length > 0
  ) {
    throw new Error([
      'lark-cli user authorization preflight failed before running real Feishu E2E.',
      `lark_cli_home=${larkCliUserAuthorizationHome(options)}`,
      `auth_app=${status.appId || '-'}`,
      `user_open_id=${status.userOpenId || '-'}`,
      `user_status=${status.userStatus || '-'}`,
      `token_status=${status.tokenStatus || '-'}`,
      missingScopes.length > 0 ? `missing_scopes=${missingScopes.join(', ')}` : '',
      'The real Feishu harness sends and reads messages as a user, even when it launches an isolated bridge.',
      'Authorize that exact lark-cli environment first, for example:',
      'lark-cli auth login --scope "im:chat im:chat:read im:chat:create_by_user im:chat:delete im:message im:message.send_as_user im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user"',
    ].filter(Boolean).join('\n'));
  }

  process.stderr.write([
    '[real-feishu-e2e] lark-cli user authorization preflight passed.',
    ` home=${larkCliUserAuthorizationHome(options)}`,
    ` app=${status.appId || '-'}`,
    ` user=${status.userOpenId}`,
    '\n',
  ].join(''));
}

async function resolveTestUserOpenId(options: CliOptions): Promise<string> {
  if (options.testUserOpenId) return options.testUserOpenId;
  try {
    const stdout = await runLarkCli([
      'auth',
      'status',
      '--verify',
    ], options);
    const auth = findAuthStatusInJson(JSON.parse(stdout || '{}'));
    if (auth.appId && auth.appId !== options.testFeishuAppId) {
      process.stderr.write([
        '[real-feishu-e2e] lark-cli user open_id belongs to a different OAuth app; not using it for test-bot-owned chat creation.',
        ` auth_app=${auth.appId}`,
        ` test_app=${options.testFeishuAppId}`,
        ' Set CODELARK_REAL_FEISHU_TEST_USER_OPEN_ID to the user open_id seen by the test app.\n',
      ].join(''));
      return '';
    }
    return auth.userOpenId;
  } catch (error) {
    process.stderr.write(`[real-feishu-e2e] Failed to auto-detect lark-cli user open_id; falling back to user-created group: ${error instanceof Error ? error.message : String(error)}\n`);
    return '';
  }
}

async function createChatWithTestBot(groupName: string, options: CliOptions): Promise<string> {
  const userOpenId = await resolveTestUserOpenId(options);
  if (!userOpenId) throw new Error('No lark-cli user open_id available for test-bot-owned group creation.');
  const baseUrl = feishuSiteToApiBaseUrl(options.feishuSite);
  const token = await fetchTestBotTenantAccessToken(options);
  const response = await fetch(`${baseUrl}/open-apis/im/v1/chats?user_id_type=open_id&set_bot_manager=true`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: groupName,
      chat_mode: 'group',
      chat_type: 'private',
      user_id_list: [userOpenId],
    }),
  });
  const data = await response.json() as {
    code?: number;
    msg?: string;
    data?: unknown;
  };
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `create chat failed: HTTP ${response.status}`);
  }
  const chatId = findChatIdInJson(data);
  if (!chatId) throw new Error(`test bot chat create returned no chat_id: ${JSON.stringify(data).slice(0, 1000)}`);
  return chatId;
}

async function deleteCreatedChatWithTestBot(chatId: string, options: CliOptions): Promise<void> {
  if (!options.testFeishuAppId || !options.testFeishuAppSecret) {
    throw new Error('Missing test Feishu App ID/Secret for bot cleanup fallback.');
  }
  const baseUrl = feishuSiteToApiBaseUrl(options.feishuSite);
  const token = await fetchTestBotTenantAccessToken(options);
  const response = await fetch(`${baseUrl}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await response.json() as { code?: number; msg?: string };
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `delete chat failed: HTTP ${response.status}`);
  }
}

async function fetchChatInfoWithTestBot(chatId: string, options: CliOptions): Promise<{ chatId: string; name?: string; chatMode?: string }> {
  if (!options.testFeishuAppId || !options.testFeishuAppSecret) {
    throw new Error('Missing test Feishu App ID/Secret for chat info lookup.');
  }
  const baseUrl = feishuSiteToApiBaseUrl(options.feishuSite);
  const token = await fetchTestBotTenantAccessToken(options);
  const response = await fetch(`${baseUrl}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}?user_id_type=open_id`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await response.json() as {
    code?: number;
    msg?: string;
    data?: { chat_id?: string; name?: string; chat_mode?: string };
  };
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `get chat failed: HTTP ${response.status}`);
  }
  return {
    chatId: data.data?.chat_id || chatId,
    name: data.data?.name,
    chatMode: data.data?.chat_mode,
  };
}

async function deleteCreatedChatWithTestAppUser(chatId: string, options: CliOptions): Promise<void> {
  if (!options.testUserAccessToken) {
    throw new Error('Missing current bridge app user access token. Set CODELARK_REAL_FEISHU_TEST_USER_ACCESS_TOKEN or --test-user-access-token.');
  }
  const baseUrl = feishuSiteToApiBaseUrl(options.feishuSite);
  const response = await fetch(`${baseUrl}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${options.testUserAccessToken}`,
    },
  });
  const data = await response.json() as { code?: number; msg?: string };
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `delete chat as current bridge app user failed: HTTP ${response.status}`);
  }
}

async function deleteCreatedChat(chatId: string, options: CliOptions): Promise<CreatedChatCleanupResult> {
  if (options.dryRun) {
    return { chatId, attempted: false, deleted: false, retained: true, reason: 'dry-run' };
  }
  if (options.keepGroup) {
    return { chatId, attempted: false, deleted: false, retained: true, reason: 'keep-group' };
  }
  const attempts: CreatedChatCleanupAttempt[] = [];
  try {
    await runLarkCli([
      'api',
      'DELETE',
      `/open-apis/im/v1/chats/${chatId}`,
      '--as',
      'user',
      '--format',
      'json',
    ], options);
    attempts.push({ method: 'lark-cli-user', attempted: true, deleted: true });
    process.stderr.write(`[real-feishu-e2e] Deleted created Feishu test group ${chatId} with lark-cli user\n`);
    return {
      chatId,
      attempted: true,
      deleted: true,
      retained: false,
      reason: 'lark-cli-user-delete-succeeded',
      attempts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    attempts.push({ method: 'lark-cli-user', attempted: true, deleted: false, error: message });
    process.stderr.write(`[real-feishu-e2e] Failed to delete test group ${chatId} with lark-cli user. Trying test App user OpenAPI. ${message}\n`);
  }

  try {
    await deleteCreatedChatWithTestAppUser(chatId, options);
    attempts.push({ method: 'test-app-user-openapi', attempted: true, deleted: true });
    process.stderr.write(`[real-feishu-e2e] Deleted created Feishu test group ${chatId} with current bridge app user OpenAPI\n`);
    return {
      chatId,
      attempted: true,
      deleted: true,
      retained: false,
      reason: 'test-app-user-openapi-delete-succeeded',
      attempts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    attempts.push({ method: 'test-app-user-openapi', attempted: true, deleted: false, error: message });
    process.stderr.write(`[real-feishu-e2e] Failed to delete test group ${chatId} with current bridge app user OpenAPI. Trying test bot OpenAPI. ${message}\n`);
  }

  try {
    await deleteCreatedChatWithTestBot(chatId, options);
    attempts.push({ method: 'test-bot-openapi', attempted: true, deleted: true });
    process.stderr.write(`[real-feishu-e2e] Deleted created Feishu test group ${chatId} with test bot OpenAPI\n`);
    return {
      chatId,
      attempted: true,
      deleted: true,
      retained: false,
      reason: 'test-bot-openapi-delete-succeeded',
      attempts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    attempts.push({ method: 'test-bot-openapi', attempted: true, deleted: false, error: message });
    process.stderr.write([
      `[real-feishu-e2e] Failed to delete created Feishu test group ${chatId} with test bot OpenAPI.`,
      'The current bridge app may need chat delete permission, tenant admin approval, or bot owner/admin permission for this chat.',
      `${message}\n`,
    ].join('\n'));
    await notifyRetainedTestChat(chatId, options, attempts);
    return {
      chatId,
      attempted: true,
      deleted: false,
      retained: true,
      reason: 'delete-failed',
      error: attempts.map((attempt) => `${attempt.method}: ${attempt.error || 'failed'}`).join('\n'),
      attempts,
    };
  }
}

async function notifyRetainedTestChat(
  chatId: string,
  options: CliOptions,
  attempts: CreatedChatCleanupAttempt[],
): Promise<void> {
  try {
    const details = attempts
      .filter((attempt) => attempt.error)
      .map((attempt) => `- ${attempt.method}: ${attempt.error}`)
      .join('\n')
      .slice(0, 1200);
    await sendUserText(chatId, [
      'CodeLark 真实 E2E 测试群自动解散失败。',
      '',
      `请先运行 lark-cli auth login --scope "im:chat im:chat:delete" 重新授权用户身份；如果仍失败，请到 ${bridgeAppAuthUrl(options)} 给当前 bridge app 新增「用户身份」权限：im:chat:delete，或把当前 bridge app 的 user_access_token 写入 CODELARK_REAL_FEISHU_TEST_USER_ACCESS_TOKEN 后再清理本群。`,
      '',
      details ? `失败详情：\n${details}` : '',
    ].filter(Boolean).join('\n'), options);
  } catch (error) {
    process.stderr.write(`[real-feishu-e2e] Failed to notify retained test group ${chatId}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function bridgeAppAuthUrl(options: CliOptions): string {
  return `https://open.feishu.cn/app/${encodeURIComponent(options.testFeishuAppId)}/auth`;
}

function readTestChatRegistry(): TestChatRegistryRecord[] {
  return readJsonIfExists<TestChatRegistryRecord[]>(TEST_CHAT_REGISTRY_PATH, [])
    .filter((record) => record && typeof record.chatId === 'string' && record.chatId);
}

function writeTestChatRegistry(records: TestChatRegistryRecord[]): void {
  fs.mkdirSync(path.dirname(TEST_CHAT_REGISTRY_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TEST_CHAT_REGISTRY_PATH, JSON.stringify(records, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

function upsertTestChatRegistryRecord(next: TestChatRegistryRecord): void {
  const records = readTestChatRegistry();
  const index = records.findIndex((record) => record.chatId === next.chatId);
  if (index >= 0) records[index] = { ...records[index], ...next };
  else records.push(next);
  writeTestChatRegistry(records);
}

function updateTestChatRegistryCleanup(chatId: string, cleanup: CreatedChatCleanupResult, keepGroup: boolean): void {
  const records = readTestChatRegistry();
  const now = new Date().toISOString();
  const index = records.findIndex((record) => record.chatId === chatId);
  const status: TestChatRegistryRecord['status'] = cleanup.deleted ? 'deleted' : 'retained';
  if (index >= 0) {
    records[index] = {
      ...records[index],
      updatedAt: now,
      status,
      keepGroup,
      cleanup,
    };
  } else {
    records.push({
      chatId,
      runId: 'unknown',
      createdAt: now,
      updatedAt: now,
      status,
      keepGroup,
      cleanup,
    });
  }
  writeTestChatRegistry(records);
}

function registerCreatedTestChat(chatId: string, groupName: string, options: CliOptions): void {
  const now = new Date().toISOString();
  upsertTestChatRegistryRecord({
    chatId,
    runId: options.runId,
    groupName,
    scenario: options.scenario,
    runtime: options.runtime,
    provider: options.provider,
    codelarkHome: options.codelarkHome,
    runRoot: options.runRoot,
    testAppId: options.testFeishuAppId,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    keepGroup: options.keepGroup,
  });
}

async function cleanupRegisteredTestChats(options: CliOptions): Promise<CreatedChatCleanupResult[]> {
  if (options.dryRun || options.keepGroup) return [];
  const records = mergeDiscoveredTestChatsIntoRegistry(readTestChatRegistry(), await discoverVisibleTestChats(options), options);
  const cleanupResults: CreatedChatCleanupResult[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.chatId)) continue;
    seen.add(record.chatId);
    if (record.status === 'deleted' || record.status === 'retained') continue;
    if (record.keepGroup) continue;
    if (record.runId === options.runId) continue;
    if (record.chatId === options.chatId || record.chatId === options.sourceChatId) continue;
    if (record.testAppId && record.testAppId !== options.testFeishuAppId) continue;
    const cleanup = await deleteCreatedChat(record.chatId, options);
    cleanupResults.push(cleanup);
    updateTestChatRegistryCleanup(record.chatId, cleanup, false);
  }
  return cleanupResults;
}

function extractVisibleTestChats(value: unknown): Array<{ chatId: string; groupName: string }> {
  if (!value || typeof value !== 'object') return [];
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return [];
  const chats = (data as { chats?: unknown }).chats;
  if (!Array.isArray(chats)) return [];
  return chats.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const chat = item as { chat_id?: unknown; name?: unknown; chat_status?: unknown };
    if (typeof chat.chat_id !== 'string' || !chat.chat_id.startsWith('oc_')) return [];
    if (typeof chat.name !== 'string' || !chat.name.startsWith('clk-real-e2e-')) return [];
    if (chat.chat_status && chat.chat_status !== 'normal') return [];
    return [{ chatId: chat.chat_id, groupName: chat.name }];
  });
}

async function discoverVisibleTestChats(options: CliOptions): Promise<Array<{ chatId: string; groupName: string }>> {
  try {
    const stdout = await runLarkCli([
      'im',
      '+chat-search',
      '--as',
      'user',
      '--query',
      'clk-real-e2e',
      '--disable-search-by-user',
      '--page-size',
      '100',
      '--format',
      'json',
    ], options);
    return extractVisibleTestChats(JSON.parse(stdout || '{}'));
  } catch (error) {
    process.stderr.write(`[real-feishu-e2e] Failed to discover visible test chats for cleanup: ${error instanceof Error ? error.message : String(error)}\n`);
    return [];
  }
}

function mergeDiscoveredTestChatsIntoRegistry(
  records: TestChatRegistryRecord[],
  discovered: Array<{ chatId: string; groupName: string }>,
  options: CliOptions,
): TestChatRegistryRecord[] {
  if (discovered.length === 0) return records;
  const now = new Date().toISOString();
  const byChat = new Map(records.map((record) => [record.chatId, record]));
  for (const chat of discovered) {
    if (byChat.has(chat.chatId)) continue;
    byChat.set(chat.chatId, {
      chatId: chat.chatId,
      runId: 'discovered',
      groupName: chat.groupName,
      scenario: 'discovered-cleanup',
      codelarkHome: options.codelarkHome,
      runRoot: options.runRoot,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      keepGroup: false,
    });
  }
  const merged = [...byChat.values()];
  writeTestChatRegistry(merged);
  return merged;
}

function latestDump(options: CliOptions, chatId?: string) {
  return collectRealE2eDump({
    codelarkHome: options.codelarkHome,
    claudeHome: options.claudeHome,
    channelType: options.channelType,
    chatId: chatId || options.chatId || undefined,
    runId: options.runId,
    logTailBytes: 256_000,
    messageLimit: 100,
    auditLimit: 100,
  });
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  pollMs: number,
  fn: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function findCreatedChatId(options: CliOptions): string | undefined {
  const dump = collectRealE2eDump({
    codelarkHome: options.codelarkHome,
    channelType: options.channelType,
    runId: options.runId,
    logTailBytes: 128_000,
  });
  return dump.binding?.chatKind === 'group' ? dump.binding.chatId : undefined;
}

async function hasResponseEvidence(options: CliOptions, chatId: string): Promise<boolean> {
  return (await countResponseEvidence(options, chatId)) > 0;
}

async function countResponseEvidence(options: CliOptions, chatId: string): Promise<number> {
  const dump = latestDump(options, chatId);
  const localCount = dump.streamKeys.length
    + dump.audit.filter((entry) => entry.direction === 'outbound').length;
  const feishuMessages = await listChatMessages(chatId, options);
  return localCount + countBotMessagesFromChatMessages(feishuMessages, options);
}

function missingRequiredChecks(options: CliOptions, report: ReturnType<typeof latestDump>): string[] {
  const required = new Set(['audit_present']);
  if (scenarioRequiresRuntimeOutput(options)) {
    required.add('binding_found');
    required.add('session_found');
    if (options.provider === 'sdk') {
      required.add('messages_present');
    }
  }
  if (scenarioRequiresRuntimeOutput(options)) {
    required.add('runtime_identity_bound');
  }
  if (
    options.runtime === 'claude'
    && options.provider === 'pty'
    && scenarioRequiresRuntimeOutput(options)
  ) {
    required.add('claude_jsonl_found');
  }
  required.add('unexpected_mirror_absent');
  if (scenarioRequiresRuntimeOutput(options)) {
    required.add('provider_output_path');
  }
  const byName = new Map(report.checks.map((check) => [check.name, check]));
  const missing = [...required].filter((name) => {
    if (name === 'unexpected_mirror_absent') return unexpectedMirrorIssues(options, report).length > 0;
    if (name === 'provider_output_path') return providerOutputPathIssues(options, report).length > 0;
    return byName.get(name)?.ok !== true;
  });
  return missing;
}

function scenarioSpecificChecks(
  options: CliOptions,
  report: ReturnType<typeof latestDump>,
  finalFeishuMessages?: unknown,
): Array<{ name: string; ok: boolean; detail: string }> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [{
    name: 'unexpected_mirror_absent',
    ok: unexpectedMirrorIssues(options, report).length === 0,
    detail: unexpectedMirrorIssues(options, report).join('\n') || 'No unexpected mirror streams for this provider.',
  }];
  if (scenarioRequiresRuntimeOutput(options)) {
    checks.push({
      name: 'provider_output_path',
      ok: providerOutputPathIssues(options, report).length === 0,
      detail: providerOutputPathIssues(options, report).join('\n') || providerOutputPathSummary(options, report),
    });
  }
  if (options.fakeCcr && options.scenario !== 'require-at-toggle') {
    const expectedFakeText = fakeCcrObservedText(options);
    const observed = payloadContainsText(report, expectedFakeText)
      || payloadContainsText(finalFeishuMessages, expectedFakeText);
    checks.push({
      name: 'fake_ccr_response_observed',
      ok: observed,
      detail: observed
        ? 'Expected fake CCR visible response text was observed in runtime dump or Feishu transcript.'
        : 'Expected fake CCR visible response text was not observed.',
      });
  }
  if (options.scenario === 'basic-dialogue-suite' && options.scriptedBasicDialogue) {
    const issues = basicDialogueStreamCardCheckpointIssues(
      report.streamCardCheckpoints || [],
      BASIC_DIALOGUE_PROVIDER_SEQUENCE.map((providerKey) => ({
        providerKey,
        marker: basicDialogueMarker(options, providerKey),
      })),
    );
    checks.push({
      name: 'basic_dialogue_stream_card_checkpoints',
      ok: issues.length === 0,
      detail: issues.length === 0
        ? `Observed scripted stream-card checkpoints for ${BASIC_DIALOGUE_PROVIDER_SEQUENCE.length} provider phases.`
        : issues.join('\n'),
    });
    const appendIssues = basicDialogueAppendInputAuditIssues(report);
    checks.push({
      name: 'basic_dialogue_terminal_append_input_delivered',
      ok: appendIssues.length === 0,
      detail: appendIssues.length === 0
        ? `Observed terminal append input delivery audit entries for ${BASIC_DIALOGUE_APPEND_INPUT_PROVIDER_KEYS.join(', ')}.`
        : appendIssues.join('\n'),
    });
  }
  return checks;
}

function basicDialogueAppendInputAuditIssues(report: ReturnType<typeof latestDump>): string[] {
  return BASIC_DIALOGUE_APPEND_INPUT_PROVIDER_KEYS
    .map((providerKey) => {
      const { runtime, provider } = parseRuntimeProviderKey(providerKey);
      const required = [
        'terminal append input delivered',
        `runtime=${runtime}`,
        `provider=${provider}`,
      ];
      const found = report.audit.some((entry) => {
        const text = JSON.stringify(entry);
        return required.every((needle) => text.includes(needle));
      });
      return found
        ? ''
        : `${providerKey}: no audit entry proved terminal append input delivery.`;
    })
    .filter(Boolean);
}

function unexpectedMirrorIssues(options: CliOptions, report: ReturnType<typeof latestDump>): string[] {
  const mirrorKeys = report.streamKeys.filter((key) => key.startsWith('mirror:'));
  const directKeys = report.streamKeys.filter((key) => key.startsWith('im:'));
  const issues: string[] = [];
  if (options.provider === 'sdk' && mirrorKeys.length > 0) {
    issues.push(`sdk provider produced mirror streams: ${mirrorKeys.join(', ')}`);
  }
  if (options.provider === 'sdk' && directKeys.length > 0 && mirrorKeys.length > 0) {
    issues.push(`sdk provider produced both direct IM streams and mirror streams; direct=${directKeys.join(', ')} mirror=${mirrorKeys.join(', ')}`);
  }
  return issues;
}

function providerOutputPathSummary(options: CliOptions, report: ReturnType<typeof latestDump>): string {
  const mirrorKeys = report.streamKeys.filter((key) => key.startsWith('mirror:'));
  const directKeys = report.streamKeys.filter((key) => key.startsWith('im:'));
  return [
    `${options.runtime}-${options.provider} output path matched expectation.`,
    `direct=${directKeys.length ? directKeys.join(', ') : '[none]'}`,
    `mirror=${mirrorKeys.length ? mirrorKeys.join(', ') : '[none]'}`,
  ].join(' ');
}

function providerOutputPathIssues(options: CliOptions, report: ReturnType<typeof latestDump>): string[] {
  const mirrorKeys = report.streamKeys.filter((key) => key.startsWith('mirror:'));
  const directKeys = report.streamKeys.filter((key) => key.startsWith('im:'));
  if (options.scenario === 'require-at-toggle') return [];

  const issues: string[] = [];
  if (options.provider === 'sdk') {
    if (directKeys.length === 0) {
      issues.push(`sdk provider did not produce a direct IM stream; streamKeys=${report.streamKeys.join(', ') || '[none]'}`);
    }
    if (mirrorKeys.length > 0) {
      issues.push(`sdk provider produced mirror streams: ${mirrorKeys.join(', ')}`);
    }
    return issues;
  }

  if (mirrorKeys.length === 0) {
    issues.push(`${options.runtime}-${options.provider} provider did not produce a mirror stream; streamKeys=${report.streamKeys.join(', ') || '[none]'}`);
  }
  return issues;
}

function countFeishuTranscriptMessages(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  if (Array.isArray(payload)) {
    return payload.reduce((total, item) => total + countFeishuTranscriptMessages(item), 0);
  }
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return 0;
  const messages = (data as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages.length : 0;
}

function getFeishuTranscriptMessages(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) return payload.flatMap((item) => getFeishuTranscriptMessages(item));
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return [];
  const messages = (data as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : [];
}

function messageContent(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown; body?: { content?: unknown } }).content
    ?? (message as { body?: { content?: unknown } }).body?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

function isTestBotMessage(message: unknown, options: CliOptions): boolean {
  if (!message || typeof message !== 'object') return false;
  const sender = (message as { sender?: unknown }).sender;
  if (!sender || typeof sender !== 'object') return false;
  const senderRecord = sender as { id?: unknown; id_type?: unknown; sender_type?: unknown };
  return senderRecord.sender_type === 'app'
    && senderRecord.id_type === 'app_id'
    && senderRecord.id === options.testFeishuAppId;
}

function directReplyToContainsText(
  payload: unknown,
  sourceMessageId: string,
  expectedText: string,
  options: CliOptions,
): boolean {
  return getFeishuTranscriptMessages(payload).some((message) => {
    if (!isTestBotMessage(message, options)) return false;
    if ((message as { reply_to?: unknown }).reply_to !== sourceMessageId) return false;
    const content = messageContent(message);
    if (content.includes('```plain_text')) return false;
    return content.includes(expectedText);
  });
}

function firstCodelarkMarker(text: string): string {
  return text.match(/\bCODELARK_[A-Z0-9_]+\b/u)?.[0] || '';
}

function runIdToken(runId: string): string {
  return runId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
    || 'RUN';
}

function agentQuestionFormMarkerFromRunId(runId: string): string {
  return `CODELARK_AGENT_QUESTION_FORM_${runIdToken(runId)}`;
}

function markdownRenderingMarkerFromRunId(runId: string): string {
  return `CODELARK_MARKDOWN_RENDERING_${runIdToken(runId)}`;
}

function defaultAgentQuestionFormResponse(runId: string): string {
  return [
    agentQuestionFormMarkerFromRunId(runId),
    '<clk-ask>{"question":"请选择发布策略","options":["灰度","全量"],"input":{"label":"补充说明","placeholder":"可留空"},"submitText":"提交","allowTextReply":true}</clk-ask>',
  ].join('\n');
}

function defaultMarkdownRenderingResponse(runId: string): string {
  return [
    markdownRenderingMarkerFromRunId(runId),
    '| 项目 | 状态 |',
    '| --- | --- |',
    '| 表格行 | 通过 |',
    '',
    '```ts',
    'const ctiMarkdown = "ok";',
    '```',
  ].join('\n');
}

function defaultFakeCcrResponseText(runId: string, scenario: string): string {
  if (scenario === 'agent-question-forms') return defaultAgentQuestionFormResponse(runId);
  if (scenario === 'markdown-rendering') return defaultMarkdownRenderingResponse(runId);
  return `CODELARK_FAKE_CCR_REAL_FEISHU_${runId}`;
}

function agentQuestionFormVisibleText(options: CliOptions): string {
  return firstCodelarkMarker(options.fakeCcrResponseText)
    || firstCodelarkMarker(options.message)
    || agentQuestionFormMarkerFromRunId(options.runId);
}

function markdownRenderingVisibleText(options: CliOptions): string {
  return firstCodelarkMarker(options.fakeCcrResponseText)
    || markdownRenderingMarkerFromRunId(options.runId);
}

function fakeCcrObservedText(options: CliOptions): string {
  if (options.scenario === 'agent-question-forms') return agentQuestionFormVisibleText(options);
  if (options.scenario === 'markdown-rendering') return markdownRenderingVisibleText(options);
  return options.fakeCcrResponseText;
}

function historyLongHeadMarker(options: CliOptions): string {
  return firstCodelarkMarker(options.message) || `CODELARK_LONG_HISTORY_HEAD_${runIdToken(options.runId)}`;
}

function historyLongTailMarker(options: CliOptions): string {
  return `CODELARK_LONG_HISTORY_TAIL_${runIdToken(options.runId)}`;
}

function historyLongPrompt(options: CliOptions): string {
  const head = historyLongHeadMarker(options);
  const tail = historyLongTailMarker(options);
  const filler = Array.from({ length: 260 }, (_, index) => `historypad${String(index).padStart(3, '0')}`).join(' ');
  return [
    `${head} Reply exactly with ${head}.`,
    filler,
    tail,
  ].join('\n');
}

function historyBoundariesMarker(options: CliOptions): string {
  return firstCodelarkMarker(options.message) || options.message;
}

function historyBoundariesPrompt(options: CliOptions): string {
  const marker = historyBoundariesMarker(options);
  return `Please reply exactly with this marker and no other text: ${marker}`;
}

function historyAttachmentsMarker(options: CliOptions): string {
  return firstCodelarkMarker(options.message) || options.message;
}

function historyAttachmentsPrompt(options: CliOptions): string {
  const marker = historyAttachmentsMarker(options);
  return `Please reply exactly with this marker and no other text: ${marker}`;
}

function historyEmptyIsolationMarker(options: CliOptions): string {
  return firstCodelarkMarker(options.message) || options.message;
}

function historyEmptyIsolationPrompt(options: CliOptions): string {
  const marker = historyEmptyIsolationMarker(options);
  return `Please reply exactly with this marker and no other text: ${marker}`;
}

function historySuiteShortMarker(options: CliOptions): string {
  return firstCodelarkMarker(options.message) || `CODELARK_HISTORY_SUITE_SHORT_${runIdToken(options.runId)}`;
}

function historySuiteLongHeadMarker(options: CliOptions): string {
  return `CODELARK_HISTORY_SUITE_LONG_HEAD_${runIdToken(options.runId)}`;
}

function historySuiteLongTailMarker(options: CliOptions): string {
  return `CODELARK_HISTORY_SUITE_LONG_TAIL_${runIdToken(options.runId)}`;
}

function historySuiteShortPrompt(options: CliOptions): string {
  const marker = historySuiteShortMarker(options);
  return `Please reply exactly with this marker and no other text: ${marker}`;
}

function historySuiteLongPrompt(options: CliOptions): string {
  const head = historySuiteLongHeadMarker(options);
  const tail = historySuiteLongTailMarker(options);
  const filler = Array.from({ length: 260 }, (_, index) => `suitepad${String(index).padStart(3, '0')}`).join(' ');
  return [
    `${head} Reply exactly with ${head}.`,
    filler,
    tail,
  ].join('\n');
}

function scenarioFinalMessage(options: CliOptions): string {
  if (options.scenario === 'doc-as-chat-from-scratch') {
    return [
      '请读取本群绑定的云文档，只回复三行：',
      'file_type: <绑定文档类型>',
      'file_token: <绑定文档 token>',
      'marker: <文档正文里的 CODELARK_DOC_AS_CHAT marker>',
      '不要从本条消息猜测 marker；如果 bridge 提供的云文档正文上下文不足，请直接说明系统侧缺少文档正文读取能力。',
    ].join('\n');
  }
  if (options.scenario === 'history-boundaries') return historyBoundariesPrompt(options);
  if (options.scenario === 'history-attachments') return historyAttachmentsPrompt(options);
  if (options.scenario === 'history-empty-isolation') return historyEmptyIsolationPrompt(options);
  if (options.scenario === 'history-long-truncation') return historyLongPrompt(options);
  if (options.scenario === 'history-suite') return historySuiteShortPrompt(options);
  if (options.scenario === 'markdown-rendering') {
    return [
      '请严格原样回复下面的 Markdown，不要添加解释：',
      defaultMarkdownRenderingResponse(options.runId),
    ].join('\n');
  }
  return options.message;
}

function expectedFinalResponseText(options: CliOptions): string {
  if (options.fakeCcr) return fakeCcrObservedText(options);
  if (options.scenario === 'history-boundaries') return historyBoundariesMarker(options);
  if (options.scenario === 'history-attachments') return historyAttachmentsMarker(options);
  if (options.scenario === 'history-empty-isolation') return historyEmptyIsolationMarker(options);
  if (options.scenario === 'history-suite') return historySuiteShortMarker(options);
  const marker = firstCodelarkMarker(scenarioFinalMessage(options));
  return marker || '';
}

function expectedRuntimePromptResponseText(options: CliOptions, text: string): string {
  if (options.scenario === 'basic-dialogue-suite') {
    return firstCodelarkMarker(text);
  }
  if (options.scenario === 'history-suite') {
    if (text === historySuiteShortPrompt(options)) return historySuiteShortMarker(options);
    if (text === historySuiteLongPrompt(options)) return historySuiteLongHeadMarker(options);
  }
  return expectedFinalResponseText(options);
}

function basicDialoguePhaseFromLabel(label: string): string {
  return BASIC_DIALOGUE_PROVIDER_SEQUENCE.find((providerKey) => label.includes(providerKey)) || '';
}

function basicDialogueExpectedTexts(options: CliOptions, text: string, label: string): string[] {
  const command = text.trim();
  if (command.startsWith('/runtime ')) return ['Runtime', command.slice('/runtime '.length).trim()];
  if (command.startsWith('/p ')) {
    const phase = basicDialoguePhaseFromLabel(label);
    const runtime = phase.startsWith('claude-') ? 'claude' : 'codex';
    return [
      runtime === 'claude' ? 'Claude Provider' : 'Codex Provider',
      command.slice('/p '.length).trim(),
    ];
  }
  if (BASIC_DIALOGUE_PROVIDER_SEQUENCE.some((providerKey) => text === basicDialoguePrompt(options, providerKey))) {
    return [expectedRuntimePromptResponseText(options, text)].filter(Boolean);
  }
  const followupPhase = basicDialoguePhaseForFollowup(options, text);
  if (followupPhase) {
    if (isBasicDialogueAppendInputPhase(followupPhase)) return [];
    return [`${basicDialogueMarker(options, followupPhase)} FOLLOWUP_ACK`];
  }
  if (command === '/stop') return ['停止'];
  return [];
}

function commandStateExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  if (command === '/status') return ['全局状态', 'Bridge', '当前聊天'];
  if (command === '/require-at off') return ['已更新群聊 @bot 设置', 'off'];
  if (command === `/runtime ${options.runtime}`) return ['Runtime', options.runtime];
  if (command === `/p ${options.provider}`) {
    return [
      options.runtime === 'claude' ? 'Claude Provider' : 'Codex Provider',
      options.provider,
    ];
  }
  if (command === '/current') return ['当前会话'];
  if (command === '/model') {
    return [options.runtime === 'claude' ? '当前 Claude Code 模型' : '当前模型'];
  }
  if (command === '/mode') return ['当前模式', 'Runtime', options.runtime];
  if (command === '/provider') {
    return [options.runtime === 'claude' ? '当前 Claude Provider' : '当前 Codex Provider'];
  }
  if (command === '/sandbox') {
    return [options.runtime === 'claude' ? 'Claude Code 不支持 Bridge 沙箱设置' : '当前 Codex 沙箱'];
  }
  if (command === '/network') {
    return [options.runtime === 'claude' ? 'Claude Code 不支持 Bridge 网络开关' : '当前 Codex 网络'];
  }
  if (command === '/reasoning') {
    return [options.runtime === 'claude' ? '当前 Claude Code 思考级别' : '当前思考级别'];
  }
  if (command === `/every 1h e2e seed ${options.runId}`) {
    return ['已创建 /every 定时输入', `e2e seed ${options.runId}`];
  }
  if (command === '/every') return ['当前聊天 /every 定时输入'];
  if (command === '/every no 1') return ['已取消 /every 定时输入'];
  return [];
}

function sessionManagementExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  if (command === `/runtime ${options.runtime}`) return ['Runtime', options.runtime];
  if (command === `/p ${options.provider}`) {
    return [
      options.runtime === 'claude' ? 'Claude Provider' : 'Codex Provider',
      options.provider,
    ];
  }
  if (command === '/help') return ['命令速览', 'Bridge 控制', 'SessionRuntime 配置'];
  if (command === '/set') return ['全局配置', '[runtime.codex]', 'runtime.codex.provider'];
  if (command === `/set claudeProvider ${options.runtime === 'claude' ? options.provider : 'pty'}`) {
    return ['已更新全局配置', 'runtime.claude.provider', options.runtime === 'claude' ? options.provider : 'pty'];
  }
  if (command === `/new mgmt-${options.runId} ${options.workDir}`) {
    return ['已创建群聊会话', `mgmt-${options.runId}`, options.workDir];
  }
  if (command === `/cd ${options.workDir}`) return ['已切换工作目录', options.workDir];
  if (command === '/current') {
    return ['当前会话', 'runtime', options.runtime === 'claude' ? 'Claude Code' : 'Codex'];
  }
  if (command === '/check') return ['当前会话健康检查'];
  if (command === '/t') return ['本地会话'];
  if (command === '/t n 50') return ['本地会话'];
  if (command === '/t unbind') return ['当前聊天已解绑', '新的临时 BridgeSession'];
  if (command === '/t archive') {
    return [options.runtime === 'claude' ? '已归档本地 Claude Code 会话' : '已归档本地 Codex 会话'];
  }
  return [];
}

function markdownRenderingExpectedTexts(options: CliOptions): string[] {
  const expectedResponse = options.fakeCcr ? options.fakeCcrResponseText : defaultMarkdownRenderingResponse(options.runId);
  return [
    firstCodelarkMarker(expectedResponse) || markdownRenderingMarkerFromRunId(options.runId),
    '| 项目 | 状态 |',
    '| 表格行 | 通过 |',
    '```plain_text',
    'const ctiMarkdown = "ok";',
  ];
}

function runtimeProviderSeedExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  if (command === `/runtime ${options.runtime}`) return ['Runtime', options.runtime];
  if (command === `/p ${options.provider}`) {
    return [
      options.runtime === 'claude' ? 'Claude Provider' : 'Codex Provider',
      options.provider,
    ];
  }
  return [];
}

function historyBoundariesExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  const seedTexts = runtimeProviderSeedExpectedTexts(options, text);
  if (seedTexts.length > 0) return seedTexts;
  if (command === `/new history-${options.runId} ${options.workDir}`) {
    return ['已创建群聊会话', `history-${options.runId}`, options.workDir];
  }
  if (command === `/cd ${options.workDir}`) return ['已切换工作目录', options.workDir];
  return [];
}

function historyEmptyIsolationExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  const seedTexts = runtimeProviderSeedExpectedTexts(options, text);
  if (seedTexts.length > 0) return seedTexts;
  if (command.startsWith(`/new histiso-`)) return ['已创建群聊会话', options.workDir];
  if (command === `/cd ${options.workDir}`) return ['已切换工作目录', options.workDir];
  return [];
}

function historyAttachmentsExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  const seedTexts = runtimeProviderSeedExpectedTexts(options, text);
  if (seedTexts.length > 0) return seedTexts;
  if (command.startsWith(`/new histfile-`)) return ['已创建群聊会话', options.workDir];
  if (command === `/cd ${options.workDir}`) return ['已切换工作目录', options.workDir];
  return [];
}

function historyLongTruncationExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  const seedTexts = runtimeProviderSeedExpectedTexts(options, text);
  if (seedTexts.length > 0) return seedTexts;
  if (command.startsWith(`/new histlong-`)) return ['已创建群聊会话', options.workDir];
  if (command === `/cd ${options.workDir}`) return ['已切换工作目录', options.workDir];
  return [];
}

function historySuiteSetupExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  const seedTexts = runtimeProviderSeedExpectedTexts(options, text);
  if (seedTexts.length > 0) return seedTexts;
  if (command.startsWith(`/new histsuite-`)) return ['已创建群聊会话', options.workDir];
  if (command === `/cd ${options.workDir}`) return ['已切换工作目录', options.workDir];
  return [];
}

function historySuiteForbiddenMarkers(options: CliOptions): string[] {
  return [
    historySuiteShortMarker(options),
    historySuiteLongHeadMarker(options),
    historySuiteLongTailMarker(options),
  ];
}

function expectedReplyForMessage(options: CliOptions, text: string, label: string): ReplyExpectation {
  const empty = { texts: [], forbiddenTexts: [], messageTypes: [], contentKeys: [] };
  if (options.scenario === 'card-forms') {
    const command = text.trim();
    if (command === '/new') {
      return {
        ...empty,
        texts: ['创建群聊会话'],
        messageTypes: ['interactive'],
        contentKeys: ['clk_form', 'clk_input', 'clk_path', 'submit_btn', 'clk-command'],
      };
    }
  }
  if (options.scenario === 'agent-question-forms' && label.includes('final message')) {
    return {
      ...empty,
      messageTypes: ['interactive'],
      contentKeys: ['clk_form', 'clk_choice', 'clk_input', 'submit_btn', 'clk-agent-question'],
    };
  }
  if (options.scenario === 'markdown-rendering') {
    const seedTexts = runtimeProviderSeedExpectedTexts(options, text);
    if (seedTexts.length > 0) return { ...empty, texts: seedTexts };
  }
  if (options.scenario === 'markdown-rendering' && label.includes('final message')) {
    return { ...empty, texts: markdownRenderingExpectedTexts(options) };
  }
  if (options.scenario === 'basic-dialogue-suite') {
    const semanticTexts = basicDialogueExpectedTexts(options, text, label);
    if (semanticTexts.length > 0) return { ...empty, texts: semanticTexts };
  }
  if (label.includes('final message') && options.provider === 'sdk') {
    return { ...empty, texts: [expectedRuntimePromptResponseText(options, text)].filter(Boolean) };
  }
  if (options.scenario === 'command-state') {
    return { ...empty, texts: commandStateExpectedTexts(options, text) };
  }
  if (options.scenario === 'session-management') {
    const semanticTexts = sessionManagementExpectedTexts(options, text);
    if (semanticTexts.length > 0) return { ...empty, texts: semanticTexts };
  }
  if (options.scenario === 'session-management' && text.trim() === '/his 5') {
    return { ...empty, texts: [options.message] };
  }
  if (options.scenario === 'history-boundaries') {
    const command = text.trim();
    const seedTexts = historyBoundariesExpectedTexts(options, text);
    if (seedTexts.length > 0) return { ...empty, texts: seedTexts };
    const finalHistoryMarker = expectedFinalResponseText(options) || options.message;
    if (command === '/his raw 1') {
      return { ...empty, texts: ['最近对话（解析文本）', '返回条数', '本次 1', finalHistoryMarker] };
    }
    if (command === '/his limit 3') {
      return { ...empty, texts: ['已将 /his msg 返回条数限制设置为 3'] };
    }
    if (command === '/his') {
      return { ...empty, texts: ['最近对话', '返回条数', '配置 3', finalHistoryMarker] };
    }
    if (command === '/his msg 1') {
      return { ...empty, texts: ['最近对话', '本次 1', finalHistoryMarker] };
    }
  }
  if (options.scenario === 'history-attachments') {
    const command = text.trim();
    const seedTexts = historyAttachmentsExpectedTexts(options, text);
    if (seedTexts.length > 0) return { ...empty, texts: seedTexts };
    if (command === '/his json' || command === '/his file') {
      return { ...empty, messageTypes: ['file'], contentKeys: ['file_key'] };
    }
  }
  if (options.scenario === 'history-empty-isolation') {
    const command = text.trim();
    const seedTexts = historyEmptyIsolationExpectedTexts(options, text);
    if (seedTexts.length > 0) return { ...empty, texts: seedTexts };
    const previousChatMarkers = [
      expectedFinalResponseText(options),
      options.message,
    ].filter((marker, index, array) => marker && array.indexOf(marker) === index);
    if (command === '/his' || command === '/his raw 1' || command === '/his msg 1') {
      return {
        ...empty,
        texts: ['当前会话还没有历史消息。'],
        forbiddenTexts: previousChatMarkers,
      };
    }
  }
  if (options.scenario === 'history-long-truncation') {
    const command = text.trim();
    const seedTexts = historyLongTruncationExpectedTexts(options, text);
    if (seedTexts.length > 0) return { ...empty, texts: seedTexts };
    const head = historyLongHeadMarker(options);
    const tail = historyLongTailMarker(options);
    if (command === '/his raw 2') {
      return {
        ...empty,
        texts: ['最近对话（解析文本）', '本次 2', head, '...'],
        forbiddenTexts: [tail],
      };
    }
    if (command === '/his msg 2') {
      return {
        ...empty,
        texts: ['最近对话', '本次 2', head, '...'],
        forbiddenTexts: [tail],
      };
    }
  }
  if (options.scenario === 'history-suite') {
    const command = text.trim();
    const seedTexts = historySuiteSetupExpectedTexts(options, text);
    if (seedTexts.length > 0) return { ...empty, texts: seedTexts };
    const shortMarker = historySuiteShortMarker(options);
    if (command === '/his json' || command === '/his file') {
      return { ...empty, messageTypes: ['file'], contentKeys: ['file_key'] };
    }
    if (label.includes('history-suite empty') && (command === '/his' || command === '/his raw 1' || command === '/his msg 1')) {
      return {
        ...empty,
        texts: ['当前会话还没有历史消息。'],
        forbiddenTexts: historySuiteForbiddenMarkers(options),
      };
    }
    if (label.includes('history-suite long')) {
      const head = historySuiteLongHeadMarker(options);
      const tail = historySuiteLongTailMarker(options);
      if (command === '/his raw 2') {
        return {
          ...empty,
          texts: ['最近对话（解析文本）', '本次 2', head, '...'],
          forbiddenTexts: [tail],
        };
      }
      if (command === '/his msg 2') {
        return {
          ...empty,
          texts: ['最近对话', '本次 2', head, '...'],
          forbiddenTexts: [tail],
        };
      }
    }
    if (command === '/his raw 1') {
      return { ...empty, texts: ['最近对话（解析文本）', '返回条数', '本次 1', shortMarker] };
    }
    if (command === '/his limit 3') {
      return { ...empty, texts: ['已将 /his msg 返回条数限制设置为 3'] };
    }
    if (command === '/his') {
      return { ...empty, texts: ['最近对话', '返回条数', '配置 3', shortMarker] };
    }
    if (command === '/his msg 1') {
      return { ...empty, texts: ['最近对话', '本次 1', shortMarker] };
    }
  }
  return empty;
}

function replyTimeoutMsForMessage(options: CliOptions, text: string, label: string): number {
  const command = text.trim();
  if (label.includes('final message')) return options.timeoutMs;
  if (command === '/his' || command.startsWith('/his ')) return options.timeoutMs;
  return Math.min(options.timeoutMs, COMMAND_RESPONSE_TIMEOUT_MS);
}

function isScenarioRuntimePrompt(options: CliOptions, text: string): boolean {
  if (options.scenario === 'basic-dialogue-suite') {
    return Boolean(basicDialoguePhaseForPrompt(options, text));
  }
  if (text === scenarioFinalMessage(options)) return true;
  return options.scenario === 'history-suite' && text === historySuiteLongPrompt(options);
}

function commandLabelForScenario(options: CliOptions, command: string, commandIndex: number): string {
  if (options.scenario === 'basic-dialogue-suite') {
    const providerKey = basicDialoguePhaseForCommandIndex(options, commandIndex);
    if (basicDialoguePhaseForPrompt(options, command)) {
      return `bridge response for final message (basic-dialogue ${providerKey})`;
    }
    const followupPhase = basicDialoguePhaseForFollowup(options, command);
    if (followupPhase) {
      return isBasicDialogueAppendInputPhase(followupPhase)
        ? `append input for basic dialogue ${followupPhase}`
        : `queued follow-up for basic dialogue ${followupPhase}`;
    }
    return `bridge response for basic dialogue ${providerKey} ${command}`;
  }
  if (isScenarioRuntimePrompt(options, command)) {
    if (options.scenario === 'history-suite' && command === historySuiteLongPrompt(options)) {
      return 'bridge response for final message (history-suite long prompt)';
    }
    if (options.scenario === 'history-suite') {
      return 'bridge response for final message (history-suite short prompt)';
    }
    return 'bridge response for final message';
  }
  if (options.scenario === 'history-suite') {
    const commands = buildScenarioCommands(options);
    const bGroupIndex = commands.indexOf(`/new histsuite-b-${options.runId} ${options.workDir}`);
    const longPromptIndex = commands.indexOf(historySuiteLongPrompt(options));
    if (bGroupIndex >= 0 && commandIndex > bGroupIndex) {
      return `bridge response for history-suite empty ${command}`;
    }
    if (longPromptIndex >= 0 && commandIndex > longPromptIndex) {
      return `bridge response for history-suite long ${command}`;
    }
    return `bridge response for history-suite ${command}`;
  }
  return `bridge response for ${command}`;
}

function commandReplyExpectations(options: CliOptions): CommandReplyExpectation[] {
  return buildScenarioCommands(options)
    .map((command, index) => {
      const label = commandLabelForScenario(options, command, index);
      const expectation = expectedReplyForMessage(options, command, label);
      if (
        expectation.texts.length === 0
        && expectation.forbiddenTexts.length === 0
        && expectation.messageTypes.length === 0
        && expectation.contentKeys.length === 0
      ) return null;
      return {
        command,
        expectedTexts: expectation.texts,
        ...(expectation.forbiddenTexts.length > 0 ? { expectedForbiddenTexts: expectation.forbiddenTexts } : {}),
        expectedReplyMessageTypes: expectation.messageTypes,
        expectedReplyContentKeys: expectation.contentKeys,
        ...(options.scenario === 'basic-dialogue-suite'
          ? {
            observationMode: shouldObserveFinalPromptByMirrorEvidence(options, label, expectation)
              ? 'mirror-stream-evidence'
              : 'reply_to',
          }
          : {}),
        replyTimeoutMs: replyTimeoutMsForMessage(options, command, label),
        reason: options.scenario === 'card-forms' && command.trim() === '/new'
          ? 'card form command must reply with a Feishu interactive CardKit form and submit callback_data prefix'
          : options.scenario === 'basic-dialogue-suite' && basicDialoguePhaseForPrompt(options, command)
          ? 'basic dialogue provider phase must produce the expected deterministic model marker without provider contamination'
          : options.scenario === 'basic-dialogue-suite'
          ? 'basic dialogue setup/control message must reach the expected runtime/provider/stop state'
          : options.scenario === 'agent-question-forms' && label.includes('final message')
          ? 'agent question form must reply with a Feishu interactive CardKit form and clk-agent-question callback prefix'
          : options.scenario === 'markdown-rendering' && label.includes('final message')
          ? 'markdown rendering final reply must include the expected marker, table, fenced code block, and language tag'
          : options.scenario === 'markdown-rendering' && runtimeProviderSeedExpectedTexts(options, command).length > 0
          ? 'markdown rendering runtime/provider seed must reach the final selected state before sending the markdown prompt'
          : options.scenario === 'history-boundaries'
            && historyBoundariesExpectedTexts(options, command).length > 0
          ? 'history-boundaries setup command must reach the expected session/provider state before history assertions'
          : options.scenario === 'history-empty-isolation'
            && historyEmptyIsolationExpectedTexts(options, command).length > 0
          ? 'history-empty-isolation setup command must reach the expected session/provider state before isolation assertions'
          : options.scenario === 'history-attachments'
            && historyAttachmentsExpectedTexts(options, command).length > 0
          ? 'history-attachments setup command must reach the expected session/provider state before attachment assertions'
          : options.scenario === 'history-long-truncation'
            && historyLongTruncationExpectedTexts(options, command).length > 0
          ? 'history-long-truncation setup command must reach the expected session/provider state before truncation assertions'
          : options.scenario === 'history-suite'
            && historySuiteSetupExpectedTexts(options, command).length > 0
          ? 'history-suite setup command must reach the expected session/provider state before history assertions'
          : command.trim() === '/his json' || command.trim() === '/his file'
          ? 'history attachment command must reply with a Feishu file message containing a Feishu file key'
          : getScenarioDefinition(options.scenario).name === 'command-state'
          ? 'command-state reply must include the expected command-specific status text'
          : getScenarioDefinition(options.scenario).name === 'session-management' && !command.trim().startsWith('/his') && !isScenarioRuntimePrompt(options, command)
          ? 'session-management command reply must include the expected command-specific status text'
          : command.trim() === '/his 5'
          ? 'history reply must include the final chat marker'
          : command.trim().startsWith('/his')
            && expectation.forbiddenTexts.length > 0
            && options.scenario === 'history-empty-isolation'
            ? 'empty history reply must include the empty-history text and must not contain another chat marker'
          : command.trim().startsWith('/his')
            && expectation.forbiddenTexts.length > 0
            && options.scenario === 'history-long-truncation'
            ? 'long history reply must include the truncated head marker and must not contain the tail marker'
          : command.trim().startsWith('/his')
            && expectation.forbiddenTexts.length > 0
            && options.scenario === 'history-suite'
            && label.includes('history-suite empty')
            ? 'history-suite empty chat reply must include the empty-history text and must not contain A chat markers'
          : command.trim().startsWith('/his')
            && expectation.forbiddenTexts.length > 0
            && options.scenario === 'history-suite'
            && label.includes('history-suite long')
            ? 'history-suite long reply must include the truncated head marker and must not contain the tail marker'
          : command.trim().startsWith('/his')
            ? 'history command reply must include the expected history title, limit, and final chat marker'
          : 'direct final reply must include the expected model marker',
      };
    })
    .filter((item): item is CommandReplyExpectation => item !== null);
}

function extractScenarioCreatedChatIds(observations: MessageObservation[], excludedChatIds: string[] = []): string[] {
  const excluded = new Set(excludedChatIds.filter(Boolean));
  const chatIds = new Set<string>();
  for (const observation of observations) {
    if (!observation.sentText.trim().startsWith('/new')) continue;
    const serialized = JSON.stringify(observation.feishuMessages ?? {});
    for (const match of serialized.matchAll(/\boc_[a-z0-9]+\b/g)) {
      const chatId = match[0];
      if (excluded.has(chatId)) continue;
      chatIds.add(chatId);
    }
  }
  return [...chatIds];
}

function parseNewSessionRequestedName(command: string): string {
  const match = command.trim().match(/^\/new\s+("([^"]+)"|'([^']+)'|(\S+))/);
  return (match?.[2] || match?.[3] || match?.[4] || '').trim();
}

async function inspectScenarioCreatedChats(
  observations: MessageObservation[],
  options: CliOptions,
  excludedChatIds: string[] = [],
): Promise<ScenarioCreatedChatInfo[]> {
  const excluded = new Set(excludedChatIds.filter(Boolean));
  const inspected: ScenarioCreatedChatInfo[] = [];
  const seenChatIds = new Set<string>();
  for (const observation of observations) {
    const requestedName = parseNewSessionRequestedName(observation.sentText);
    if (!requestedName) continue;
    const chatIds = extractScenarioCreatedChatIds([observation], [...excluded, ...seenChatIds]);
    for (const chatId of chatIds) {
      seenChatIds.add(chatId);
      try {
        const info = await fetchChatInfoWithTestBot(chatId, options);
        const actualName = info.name || '';
        inspected.push({
          command: observation.sentText,
          chatId,
          requestedName,
          actualName,
          ok: info.chatMode === 'group' && actualName.includes(requestedName),
          detail: `chat_mode=${info.chatMode || ''} actual_name=${actualName}`,
        });
      } catch (error) {
        inspected.push({
          command: observation.sentText,
          chatId,
          requestedName,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return inspected;
}

async function cleanupScenarioCreatedChats(
  observations: MessageObservation[],
  options: CliOptions,
  excludedChatIds: string[] = [],
): Promise<CreatedChatCleanupResult[]> {
  const chatIds = extractScenarioCreatedChatIds(observations, excludedChatIds);
  const results: CreatedChatCleanupResult[] = [];
  for (const chatId of chatIds) {
    results.push(await deleteCreatedChat(chatId, options));
  }
  return results;
}

function nextScenarioChatIdFromObservation(
  observation: MessageObservation,
  excludedChatIds: string[] = [],
): string | undefined {
  return extractScenarioCreatedChatIds([observation], excludedChatIds)[0];
}

function requiredCheckChatIdForScenario(
  options: CliOptions,
  validationChatId: string,
  runtimeValidationChatId: string,
): string {
  if (options.scenario === 'history-empty-isolation' && runtimeValidationChatId) return runtimeValidationChatId;
  if (options.scenario === 'history-suite' && runtimeValidationChatId) return runtimeValidationChatId;
  return validationChatId;
}

async function listFinalFeishuMessagesForObservations(
  observations: MessageObservation[],
  options: CliOptions,
  fallbackChatId: string,
): Promise<unknown> {
  const chatIds = Array.from(new Set([
    fallbackChatId,
    ...observations.map((observation) => observation.chatId).filter(Boolean),
  ]));
  if (chatIds.length <= 1) return listChatMessages(fallbackChatId, options, 50);
  const transcripts = await Promise.all(chatIds.map(async (chatId) => ({
    chatId,
    messages: await listChatMessages(chatId, options, 50),
  })));
  return {
    ok: transcripts.every((item) => Boolean((item.messages as { ok?: unknown } | null)?.ok ?? item.messages)),
    data: {
      messages: transcripts.flatMap((item) => getFeishuTranscriptMessages(item.messages)),
      total: transcripts.reduce((total, item) => total + countFeishuTranscriptMessages(item.messages), 0),
    },
    transcripts,
  };
}

function automatedSuccessChecks(params: {
  options: CliOptions;
  report: ReturnType<typeof latestDump>;
  messageObservations: MessageObservation[];
  finalFeishuMessages: unknown;
  createdChatCleanup: CreatedChatCleanupResult | null;
  docAsChatScenario?: DocAsChatScenarioResult | null;
  createdDocumentCleanup?: CreatedDocumentCleanupResult | null;
  scenarioCreatedChatInfo: ScenarioCreatedChatInfo[];
  scenarioCreatedChatCleanup: CreatedChatCleanupResult[];
}): Array<{ name: string; ok: boolean; detail: string }> {
  const sentMessageIds = params.messageObservations
    .filter((observation) => !observation.chatId || observation.chatId === params.report.chatId)
    .map((observation) => observation.sentMessageId)
    .filter(Boolean);
  const missingTranscriptIds = sentMessageIds.filter((messageId) => !payloadContainsText(params.finalFeishuMessages, messageId));
  const failedObservations = params.messageObservations.filter((observation) => !observation.ok);
  const transcriptCount = countFeishuTranscriptMessages(params.finalFeishuMessages);
  const cleanupRequired = params.options.createChat && !params.options.keepGroup;
  const cleanupOk = !cleanupRequired || params.createdChatCleanup?.deleted === true;
  const scenarioCreatedChatCleanupOk = params.scenarioCreatedChatCleanup.every((item) => item.deleted === true);
  const scenarioCreatedNameChecksOk = params.scenarioCreatedChatInfo.every((item) => item.ok);
  const coverage = scenarioCoverage(params.options);
  const e2eCoverage = Array.isArray(coverage.e2eCoverage) ? coverage.e2eCoverage : [];
  const testName = typeof coverage.testName === 'string' ? coverage.testName : '';
  const finalObservation = params.messageObservations.find((observation) => observation.label.includes('final message'));
  const finalExpectedText = expectedFinalResponseText(params.options);
  const directMirrorDuplicate = Boolean(
    params.options.provider !== 'sdk'
    && finalObservation?.sentMessageId
    && finalExpectedText
    && directReplyToContainsText(
      params.finalFeishuMessages,
      finalObservation.sentMessageId,
      finalExpectedText,
      params.options,
    ),
  );

  const checks = [
    {
      name: 'message_observations_passed',
      ok: params.messageObservations.length > 0 && failedObservations.length === 0,
      detail: failedObservations.length === 0
        ? `${params.messageObservations.length} message observations passed.`
        : `Failed observations: ${failedObservations.map((observation) => observation.label).join(', ')}`,
    },
    {
      name: 'final_feishu_transcript_present',
      ok: transcriptCount > 0 && missingTranscriptIds.length === 0,
      detail: missingTranscriptIds.length === 0
        ? `${transcriptCount} final Feishu transcript messages captured.`
        : `Final Feishu transcript missing sent message ids: ${missingTranscriptIds.join(', ')}`,
    },
    {
      name: 'coverage_metadata_present',
      ok: Boolean(testName && e2eCoverage.length > 0),
      detail: testName || 'coverage metadata missing',
    },
    {
      name: 'created_chat_cleanup_completed',
      ok: cleanupOk,
      detail: !cleanupRequired
        ? 'No created chat cleanup required.'
        : params.createdChatCleanup
          ? `deleted=${params.createdChatCleanup.deleted} retained=${params.createdChatCleanup.retained} reason=${params.createdChatCleanup.reason || ''}`
          : 'Created chat cleanup was not recorded.',
    },
    {
      name: 'scenario_created_chat_cleanup_completed',
      ok: scenarioCreatedChatCleanupOk,
      detail: params.scenarioCreatedChatCleanup.length === 0
        ? 'No scenario-created /new chats were detected.'
        : params.scenarioCreatedChatCleanup
          .map((item) => `${item.chatId}: deleted=${item.deleted} retained=${item.retained} reason=${item.reason || ''}`)
        .join('; '),
    },
    {
      name: 'scenario_created_chat_names_match_requests',
      ok: scenarioCreatedNameChecksOk,
      detail: params.scenarioCreatedChatInfo.length === 0
        ? 'No scenario-created /new chats were detected.'
        : params.scenarioCreatedChatInfo
          .map((item) => `${item.chatId}: requested=${item.requestedName} actual=${item.actualName || ''} ok=${item.ok} detail=${item.detail}`)
          .join('; '),
    },
    {
      name: 'required_checks_passed',
      ok: missingRequiredChecks(params.options, params.report).length === 0,
      detail: missingRequiredChecks(params.options, params.report).length === 0
        ? 'All required dump/provider checks passed.'
        : `Missing checks: ${missingRequiredChecks(params.options, params.report).join(', ')}`,
    },
  ];

  if (scenarioRequiresRuntimeOutput(params.options) && params.options.provider !== 'sdk') {
    checks.push({
      name: 'mirror_final_not_duplicated_in_direct_reply',
      ok: !directMirrorDuplicate,
      detail: finalExpectedText
        ? directMirrorDuplicate
          ? `Direct reply_to message for final prompt contained mirror final text: ${finalExpectedText}`
          : `Direct reply_to message for final prompt did not contain mirror final text: ${finalExpectedText}`
        : 'No stable expected final marker was configured; duplicate final-text check skipped.',
    });
  }

  if (params.options.scenario === 'doc-as-chat-from-scratch') {
    const docScenario = params.docAsChatScenario;
    const documentCleanupRequired = Boolean(docScenario) && !params.options.keepGroup;
    checks.push({
      name: 'doc_as_chat_context_assertion',
      ok: docScenario?.contextAssertion.passed === true,
      detail: docScenario
        ? `expected file_type=${docScenario.contextAssertion.expectedFileType} file_token=${docScenario.contextAssertion.expectedFileToken} marker=${docScenario.contextAssertion.expectedMarker}`
        : 'doc-as-chat scenario result missing.',
    }, {
      name: 'doc_as_chat_user_group_read',
      ok: Boolean(
        docScenario
          && payloadContainsText(docScenario.userVisibleGroupInfo, docScenario.createdGroup.chatId)
          && !payloadContainsText(docScenario.userVisibleGroupInfo, 'Bot/User can NOT be out of the chat'),
      ),
      detail: docScenario
        ? `user lark-cli group info read for ${docScenario.createdGroup.chatId}`
        : 'doc-as-chat scenario result missing.',
    }, {
      name: 'doc_as_chat_comment_granularity_binding',
      ok: Boolean(
        docScenario
          && payloadContainsText(docScenario.binding, docScenario.document.token)
          && payloadContainsText(docScenario.binding, docScenario.comment.commentId),
      ),
      detail: docScenario
        ? `binding matched file_token=${docScenario.document.token} comment_id=${docScenario.comment.commentId}`
        : 'doc-as-chat scenario result missing.',
    }, {
      name: 'created_document_cleanup_completed',
      ok: !documentCleanupRequired || params.createdDocumentCleanup?.deleted === true,
      detail: !documentCleanupRequired
        ? 'No created document cleanup required.'
        : params.createdDocumentCleanup
          ? `deleted=${params.createdDocumentCleanup.deleted} retained=${params.createdDocumentCleanup.retained} reason=${params.createdDocumentCleanup.reason || ''}`
          : 'Created document cleanup was not recorded.',
    });
  }

  return checks;
}

async function waitForScenarioChecks(options: CliOptions, chatId: string): Promise<ReturnType<typeof latestDump>> {
  return waitFor('required real Feishu E2E checks', options.timeoutMs, options.pollMs, () => {
    const report = latestDump(options, chatId);
    return missingRequiredChecks(options, report).length === 0 ? report : undefined;
  });
}

function writeFailureReport(params: {
  label: string;
  sentText?: string;
  chatId: string;
  options: CliOptions;
  runtimeEnvironment: RuntimeEnvironmentPlan;
  feishuMessages?: unknown;
}): void {
  const dump = latestDump(params.options, params.chatId);
  const failureReport = {
    label: params.label,
    ...(params.sentText ? { sentText: params.sentText } : {}),
    chatId: params.chatId,
    runRoot: params.options.runRoot,
    codelarkHome: params.options.codelarkHome,
    runtimeEnvironment: params.runtimeEnvironment,
    missingChecks: missingRequiredChecks(params.options, dump),
    unexpectedMirror: unexpectedMirrorIssues(params.options, dump),
    ...(params.feishuMessages ? { feishuMessages: params.feishuMessages } : {}),
    dump,
  };
  const reportPath = params.options.outputPath
    ? params.options.outputPath.replace(/\.json$/i, '.failure.json')
    : path.join(os.tmpdir(), `${path.basename(params.options.runRoot)}.failure.json`);
  writeReport(failureReport, reportPath);
}

async function waitForNewResponseEvidence(
  options: CliOptions,
  chatId: string,
  previousCount: number,
  label: string,
): Promise<number> {
  return waitFor(label, options.timeoutMs, options.pollMs, async () => {
    const nextCount = await countResponseEvidence(options, chatId);
    return nextCount > previousCount ? nextCount : undefined;
  });
}

function isEmptyReplyExpectation(expectation: ReplyExpectation): boolean {
  return expectation.texts.length === 0
    && expectation.forbiddenTexts.length === 0
    && expectation.messageTypes.length === 0
    && expectation.contentKeys.length === 0;
}

function shouldObserveFinalPromptByMirrorEvidence(options: CliOptions, label: string, expectation: ReplyExpectation): boolean {
  if (options.scriptedBasicDialogue) return false;
  if (options.scenario === 'basic-dialogue-suite' && label.includes('basic-dialogue')) {
    const phase = basicDialoguePhaseFromLabel(label);
    return Boolean(phase && !phase.endsWith('-sdk'));
  }
  return label.includes('final message')
    && options.provider !== 'sdk'
    && (isEmptyReplyExpectation(expectation) || scenarioCommandsIncludeFinalMessage(options));
}

function finalMessageObservationMode(options: CliOptions): 'reply_to' | 'mirror-stream-evidence' | 'cross-provider-suite' {
  if (options.scenario === 'basic-dialogue-suite') return 'cross-provider-suite';
  const expectation = expectedReplyForMessage(options, scenarioFinalMessage(options), 'bridge response for final message');
  return shouldObserveFinalPromptByMirrorEvidence(options, 'bridge response for final message', expectation)
    ? 'mirror-stream-evidence'
    : 'reply_to';
}

function mirrorStreamCompletedInDump(dump: ReturnType<typeof latestDump>): boolean {
  const logText = dump.logWindow?.text || '';
  if (!logText) return false;
  return dump.streamKeys
    .filter((streamKey) => streamKey.startsWith('mirror:'))
    .some((streamKey) => logText.split(/\r?\n/).some((line) => (
      line.includes(streamKey)
        && (
          /Card finalized: .*status=completed/.test(line)
            || /Final card update payload: .*status:\s*'completed'/.test(line)
        )
    )));
}

async function waitForMirrorStreamCompleted(options: CliOptions, chatId: string, label: string): Promise<void> {
  await waitFor(label, options.timeoutMs, options.pollMs, () => (
    mirrorStreamCompletedInDump(latestDump(options, chatId)) ? true : undefined
  ));
}

async function waitForBotReplyToMessage(
  options: CliOptions,
  chatId: string,
  sourceMessageId: string,
  label: string,
  timeoutMs: number,
  expectation: ReplyExpectation = { texts: [], forbiddenTexts: [], messageTypes: [], contentKeys: [] },
): Promise<unknown> {
  return waitFor(label, timeoutMs, options.pollMs, async () => {
    const messages = await listChatMessages(chatId, options);
    return hasBotReplyToMessageMatching(messages, sourceMessageId, expectation, options)
      ? messages
      : undefined;
  });
}

async function waitForBotTranscriptText(
  options: CliOptions,
  chatId: string,
  expectedText: string,
  label: string,
): Promise<unknown> {
  return waitFor(label, options.timeoutMs, options.pollMs, async () => {
    const messages = await listChatMessages(chatId, options, 50);
    return botTranscriptContainsText(messages, expectedText, options) ? messages : undefined;
  });
}

async function waitForBotTranscriptExpectation(
  options: CliOptions,
  chatId: string,
  expectation: ReplyExpectation,
  label: string,
): Promise<unknown> {
  return waitFor(label, options.timeoutMs, options.pollMs, async () => {
    const messages = await listChatMessages(chatId, options, 50);
    return botTranscriptMatchesExpectation(messages, expectation, options) ? messages : undefined;
  });
}

function writeReport(report: unknown, outputPath: string): void {
  const text = JSON.stringify(report, null, 2) + '\n';
  if (!outputPath) {
    process.stdout.write(text);
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, text, 'utf-8');
  process.stdout.write(`${outputPath}\n`);
}

function writeIsolatedBridgeConfig(options: CliOptions): void {
  fs.mkdirSync(options.codelarkHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(options.workDir, { recursive: true });
  const config: ConfigPatch = {
    schemaVersion: 2,
    session: {
      workspace: options.workDir,
    },
    bridge: {
      defaultWorkspace: options.workDir,
    },
    runtime: {
      agent: options.runtime,
      codex: {
        ...(usesProxyBackedBasicDialogue(options) ? { model: options.codexModel } : {}),
        provider: options.runtime === 'codex' ? options.provider : (process.env.CODELARK_DEFAULT_CODEX_PROVIDER || 'pty'),
        skipGitRepoCheck: true,
        sandboxMode: 'workspace-write',
        networkAccess: true,
        reasoningEffort: usesProxyBackedBasicDialogue(options) ? 'low' : 'medium',
      },
      claude: {
        provider: options.runtime === 'claude' ? options.provider : 'pty',
        executable: options.claudeExecutable,
        permissionMode: process.env.CODELARK_CLAUDE_PERMISSION_MODE || 'default',
        ...(process.env.CODELARK_CLAUDE_DEFAULT_MODEL
          ? { model: process.env.CODELARK_CLAUDE_DEFAULT_MODEL }
          : {}),
      },
    },
    channels: [{
      id: options.channelType,
      alias: options.channelAlias,
      provider: 'feishu',
      enabled: true,
      config: {
        appId: options.testFeishuAppId,
        appSecret: options.testFeishuAppSecret,
        site: options.feishuSite,
        historyMessageLimit: 8,
        streamStatusIdleStartSeconds: 30,
        streamStatusCheckIntervalSeconds: 5,
        streamingEnabled: true,
        feedbackMarkdownEnabled: true,
        requireMention: false,
      },
    }],
  };
  createConfigService({ codelarkHome: options.codelarkHome, env: {}, migrate: false }).replace({ kind: 'home' }, config);
}

function readJsonIfExists<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

async function waitForBridgeStarted(options: CliOptions): Promise<void> {
  const statusPath = path.join(options.codelarkHome, 'runtime', 'status.json');
  await waitFor('test bridge startup', options.timeoutMs, options.pollMs, () => {
    const status = readJsonIfExists<{ running?: boolean; channels?: string[]; adapters?: Array<{ channelType?: string; running?: boolean }> }>(statusPath, {});
    if (!status.running) return undefined;
    if (status.channels?.includes(options.channelType)) return true;
    if (status.adapters?.some((adapter) => adapter.channelType === options.channelType && adapter.running !== false)) return true;
    return undefined;
  });
}

async function stopBridgeChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      resolve();
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch { resolve(); }
  });
}

async function stopFakeCcrRouter(options: CliOptions): Promise<void> {
  if (!usesFakeCcrBackend(options) || options.claudeExecutable !== 'ccr') return;
  try {
    await execFileAsync('ccr', ['stop'], {
      env: sanitizedChildEnv({ HOME: options.runtimeHome }),
      timeout: 10_000,
    });
  } catch {
    // The router may not have started or may already be stopped.
  }
}

async function launchBridgeChild(options: CliOptions, runtimeEnvironment: RuntimeEnvironmentPlan): Promise<ChildProcess | null> {
  if (!options.launchBridge || options.dryRun) return null;
  writeIsolatedBridgeConfig(options);
  process.stderr.write(`[real-feishu-e2e] Launching isolated bridge with CODELARK_HOME=${options.codelarkHome} CODEX_HOME=${options.codexHome} HOME=${options.runtimeHome} claude=${options.claudeExecutable}\n`);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/entrypoints/daemon.ts'],
    {
      cwd: process.cwd(),
      env: sanitizedChildEnv({
        CODELARK_HOME: options.codelarkHome,
        HOME: runtimeEnvironment.runtimeHome,
        USERPROFILE: runtimeEnvironment.runtimeHome,
        XDG_DATA_HOME: path.join(runtimeEnvironment.runtimeHome, '.local', 'share'),
        XDG_CONFIG_HOME: path.join(runtimeEnvironment.runtimeHome, '.config'),
        XDG_CACHE_HOME: path.join(runtimeEnvironment.runtimeHome, '.cache'),
        CODEX_HOME: runtimeEnvironment.codexHome,
        CODELARK_CLAUDE_HOME: runtimeEnvironment.claudeHome,
        CODELARK_CLAUDE_EXECUTABLE: runtimeEnvironment.claudeExecutable,
        CODELARK_CLAUDE_PROVIDER: options.runtime === 'claude' ? options.provider : (process.env.CODELARK_CLAUDE_PROVIDER || 'pty'),
        CODELARK_DEFAULT_CODEX_PROVIDER: options.runtime === 'codex' ? options.provider : (process.env.CODELARK_DEFAULT_CODEX_PROVIDER || 'pty'),
        CODELARK_CODEX_SKIP_GIT_REPO_CHECK: process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK || 'true',
        ...(options.codexProxyBaseUrl
          ? {
            CODELARK_CODEX_BASE_URL: options.codexProxyBaseUrl,
            CODELARK_CODEX_API_KEY: 'clk-local-proxy-key',
            CODEX_API_KEY: 'clk-local-proxy-key',
            OPENAI_API_KEY: 'clk-local-proxy-key',
          }
          : {}),
        ...(options.scriptedBasicDialogue
          ? {
            CODELARK_REAL_FEISHU_E2E_STREAM_CARD_CHECKPOINTS: '1',
          }
          : {}),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk) => process.stderr.write(`[bridge stdout] ${String(chunk)}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[bridge stderr] ${String(chunk)}`));
  child.once('exit', (code, signal) => {
    process.stderr.write(`[real-feishu-e2e] isolated bridge exited code=${code ?? ''} signal=${signal ?? ''}\n`);
  });
  await waitForBridgeStarted(options);
  return child;
}

function findChatIdInJson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findChatIdInJson(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['chat_id', 'chatId']) {
    if (typeof record[key] === 'string' && (record[key] as string).startsWith('oc_')) {
      return record[key] as string;
    }
  }
  for (const item of Object.values(record)) {
    const found = findChatIdInJson(item);
    if (found) return found;
  }
  return undefined;
}

function findMessageIdInJson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMessageIdInJson(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['message_id', 'messageId']) {
    if (typeof record[key] === 'string' && (record[key] as string).startsWith('om_')) {
      return record[key] as string;
    }
  }
  for (const item of Object.values(record)) {
    const found = findMessageIdInJson(item);
    if (found) return found;
  }
  return undefined;
}

function findDocumentIdInJson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDocumentIdInJson(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['document_id', 'documentId', 'file_token', 'fileToken', 'token']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  for (const item of Object.values(record)) {
    const found = findDocumentIdInJson(item);
    if (found) return found;
  }
  return undefined;
}

function findUrlInJson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrlInJson(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['url', 'document_url', 'documentUrl']) {
    if (typeof record[key] === 'string' && /^https?:\/\//.test(record[key])) return record[key] as string;
  }
  for (const item of Object.values(record)) {
    const found = findUrlInJson(item);
    if (found) return found;
  }
  return undefined;
}

function findCommentIdInJson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCommentIdInJson(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['comment_id', 'commentId']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  for (const item of Object.values(record)) {
    const found = findCommentIdInJson(item);
    if (found) return found;
  }
  return undefined;
}

function findReplyIdInJson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findReplyIdInJson(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['reply_id', 'replyId']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  for (const item of Object.values(record)) {
    const found = findReplyIdInJson(item);
    if (found) return found;
  }
  return undefined;
}

function findOpenIdInJson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOpenIdInJson(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['open_id', 'openId', 'bot_open_id', 'botOpenId']) {
    if (typeof record[key] === 'string' && (record[key] as string).startsWith('ou_')) return record[key] as string;
  }
  for (const item of Object.values(record)) {
    const found = findOpenIdInJson(item);
    if (found) return found;
  }
  return undefined;
}

async function createUserChat(options: CliOptions): Promise<{ chatId: string; groupName: string }> {
  const groupName = `clk-real-e2e-${options.runId}`.slice(0, 60);
  if (options.dryRun) return { chatId: '<created-chat-id>', groupName };
  try {
    if (options.testFeishuAppId && options.testFeishuAppSecret) {
      const chatId = await createChatWithTestBot(groupName, options);
      registerCreatedTestChat(chatId, groupName, options);
      return { chatId, groupName };
    }
    throw new Error('missing test App secret for bot-owned chat creation');
  } catch (error) {
    process.stderr.write(`[real-feishu-e2e] Test-bot-owned chat creation failed; falling back to lark-cli user chat create: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (!options.testFeishuAppId) {
    throw new Error('Unable to infer a Feishu bot app id for --create-chat. Pass --test-feishu-app-id, set CODELARK_REAL_FEISHU_TEST_APP_ID, or use --clk-home pointing at a configured live bridge.');
  }
  const stdout = await runLarkCli([
    'im',
    '+chat-create',
    '--as',
    'user',
    '--chat-mode',
    'group',
    '--type',
    'private',
    '--name',
    groupName,
    '--bots',
    options.testFeishuAppId,
    '--format',
    'json',
  ], options);
  const parsed = JSON.parse(stdout || '{}');
  const chatId = findChatIdInJson(parsed);
  if (!chatId) {
    throw new Error(`lark-cli chat create returned no chat_id: ${stdout.slice(0, 1000)}`);
  }
  registerCreatedTestChat(chatId, groupName, options);
  return { chatId, groupName };
}

async function resolveTestBotOpenId(options: CliOptions): Promise<string> {
  if (options.testBotOpenId) return options.testBotOpenId;
  if (!options.testFeishuAppId || !options.testFeishuAppSecret) {
    throw new Error('doc-as-chat-from-scratch requires --test-bot-open-id or test Feishu App ID/Secret so the harness can create a structured mention_user comment.');
  }
  const baseUrl = feishuSiteToApiBaseUrl(options.feishuSite);
  const token = await fetchTestBotTenantAccessToken(options);
  const response = await fetch(`${baseUrl}/open-apis/bot/v3/info`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await response.json() as { code?: number; msg?: string; data?: unknown };
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `bot info lookup failed: HTTP ${response.status}`);
  }
  const openId = findOpenIdInJson(data);
  if (!openId) {
    throw new Error(`bot info lookup returned no bot open_id; pass --test-bot-open-id explicitly. payload=${JSON.stringify(data).slice(0, 1000)}`);
  }
  return openId;
}

async function createDocAsChatDocument(options: CliOptions): Promise<DocAsChatScenarioResult['document']> {
  const marker = `CODELARK_DOC_AS_CHAT_${runIdToken(options.runId)}`;
  if (options.dryRun) {
    return {
      fileType: 'docx',
      token: '<doc-token>',
      url: 'https://example.feishu.cn/docx/<doc-token>',
      marker,
    };
  }
  const markdownDir = path.join(process.cwd(), '.real-feishu-e2e');
  fs.mkdirSync(markdownDir, { recursive: true });
  const markdownPath = path.join(markdownDir, `doc-as-chat-${options.runId}.md`);
  const markdownContentArg = `@${path.relative(process.cwd(), markdownPath)}`;
  fs.writeFileSync(markdownPath, [
    `# CodeLark doc-as-chat E2E ${options.runId}`,
    '',
    `marker: ${marker}`,
    '',
    '这是一份真实飞书 E2E 创建的临时云文档。',
    '测试要求 bot 在群聊后续消息中读取或引用这份文档的 file_type、file_token 和 marker。',
  ].join('\n'), 'utf-8');
  let stdout = '';
  try {
    stdout = await runLarkCli([
      'docs',
      '+create',
      '--api-version',
      'v2',
      '--as',
      'user',
      '--doc-format',
      'markdown',
      '--content',
      markdownContentArg,
    ], options);
  } finally {
    fs.rmSync(markdownPath, { force: true });
  }
  const parsed = JSON.parse(stdout || '{}');
  const token = findDocumentIdInJson(parsed);
  if (!token) throw new Error(`lark-cli docs +create returned no document id: ${stdout.slice(0, 1000)}`);
  return {
    fileType: 'docx',
    token,
    url: findUrlInJson(parsed),
    marker,
  };
}

async function createDocAsChatComment(
  document: DocAsChatScenarioResult['document'],
  groupName: string,
  options: CliOptions,
): Promise<DocAsChatScenarioResult['comment']> {
  if (options.dryRun) {
    return { commentId: '<comment-id>', replyId: '<reply-id>' };
  }
  const botOpenId = await resolveTestBotOpenId(options);
  const payload = {
    file_type: document.fileType,
    reply_elements: [
      { type: 'mention_user', mention_user: botOpenId },
      { type: 'text', text: ` /new ${groupName} ${options.workDir}` },
    ],
  };
  const stdout = await runLarkCli([
    'drive',
    'file.comments',
    'create_v2',
    '--as',
    'user',
    '--params',
    JSON.stringify({ file_token: document.token }),
    '--data',
    JSON.stringify(payload),
  ], options);
  const parsed = JSON.parse(stdout || '{}');
  const commentId = findCommentIdInJson(parsed);
  if (!commentId) throw new Error(`lark-cli comment create returned no comment_id: ${stdout.slice(0, 1000)}`);
  return {
    commentId,
    replyId: findReplyIdInJson(parsed),
  };
}

function findDocAsChatBinding(options: CliOptions, document: DocAsChatScenarioResult['document'], commentId: string): unknown | null {
  const bindingsPath = path.join(options.codelarkHome, 'data', 'channel-chats.json');
  const bindings = readJsonIfExists<unknown>(bindingsPath, []);
  const entries = Array.isArray(bindings)
    ? bindings
    : bindings && typeof bindings === 'object'
      ? Object.values(bindings as Record<string, unknown>)
      : [];
  return entries.find((binding) => {
    if (!binding || typeof binding !== 'object') return false;
    const record = binding as {
      chatId?: unknown;
      cloudDocumentChat?: {
        provider?: unknown;
        fileType?: unknown;
        fileToken?: unknown;
        commentId?: unknown;
      };
    };
    return typeof record.chatId === 'string'
      && record.chatId.startsWith('oc_')
      && record.cloudDocumentChat?.provider === 'feishu'
      && record.cloudDocumentChat.fileType === document.fileType
      && record.cloudDocumentChat.fileToken === document.token
      && record.cloudDocumentChat.commentId === commentId;
  }) || null;
}

async function fetchChatInfoAsLarkCliUser(chatId: string, options: CliOptions): Promise<unknown> {
  try {
    const stdout = await runLarkCli([
      'im',
      'chats',
      'get',
      '--as',
      'user',
      '--params',
      JSON.stringify({ chat_id: chatId }),
      '--format',
      'json',
    ], options);
    return JSON.parse(stdout || '{}');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchChatMembersAsLarkCliUser(chatId: string, options: CliOptions): Promise<unknown> {
  try {
    const stdout = await runLarkCli([
      'im',
      'chat.members',
      'get',
      '--as',
      'user',
      '--params',
      JSON.stringify({ chat_id: chatId }),
      '--format',
      'json',
    ], options);
    return JSON.parse(stdout || '{}');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function deleteCreatedDocument(
  document: DocAsChatScenarioResult['document'],
  options: CliOptions,
): Promise<CreatedDocumentCleanupResult> {
  if (options.dryRun) {
    return { fileToken: document.token, fileType: document.fileType, attempted: false, deleted: false, retained: true, reason: 'dry-run' };
  }
  try {
    await runLarkCli([
      'drive',
      '+delete',
      '--as',
      'user',
      '--file-token',
      document.token,
      '--type',
      document.fileType,
      '--yes',
    ], options);
    return { fileToken: document.token, fileType: document.fileType, attempted: true, deleted: true, retained: false, reason: 'lark-cli-user-delete-succeeded' };
  } catch (error) {
    return {
      fileToken: document.token,
      fileType: document.fileType,
      attempted: true,
      deleted: false,
      retained: true,
      reason: 'delete-failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function setupDocAsChatFromScratchScenario(
  options: CliOptions,
): Promise<Omit<DocAsChatScenarioResult, 'contextAssertion'>> {
  const document = await createDocAsChatDocument(options);
  const groupName = `clk-doc-chat-${options.runId}`.slice(0, 60);
  const comment = await createDocAsChatComment(document, groupName, options);
  const binding = options.dryRun
    ? { chatId: '<created-doc-chat-id>', cloudDocumentChat: { provider: 'feishu', fileType: document.fileType, fileToken: document.token, commentId: comment.commentId } }
    : await waitFor('cloud document /new group binding', options.timeoutMs, options.pollMs, () => (
      findDocAsChatBinding(options, document, comment.commentId) || undefined
    ));
  const chatId = typeof (binding as { chatId?: unknown }).chatId === 'string'
    ? (binding as { chatId: string }).chatId
    : '';
  if (!chatId) throw new Error(`cloud document binding did not contain a chatId: ${JSON.stringify(binding).slice(0, 1000)}`);
  const userVisibleGroupInfo = await fetchChatInfoAsLarkCliUser(chatId, options);
  const userVisibleGroupMembers = await fetchChatMembersAsLarkCliUser(chatId, options);
  return {
    runId: options.runId,
    document,
    comment,
    createdGroup: {
      chatId,
      name: groupName,
    },
    binding,
    userVisibleGroupInfo,
    userVisibleGroupMembers,
  };
}

async function waitForDocAsChatContextAssertion(
  setup: Omit<DocAsChatScenarioResult, 'contextAssertion'>,
  options: CliOptions,
): Promise<DocAsChatScenarioResult['contextAssertion']> {
  if (options.dryRun) {
    return {
      expectedFileType: setup.document.fileType,
      expectedFileToken: setup.document.token,
      expectedMarker: setup.document.marker,
      passed: true,
      messages: null,
    };
  }
  const messages = await waitFor('doc-as-chat context assertion in Feishu transcript', options.timeoutMs, options.pollMs, async () => {
    const transcript = await listChatMessages(setup.createdGroup.chatId, options, 50);
    const passed = getFeishuTranscriptMessages(transcript).some((message) => {
      if (!isTestBotMessage(message, options)) return false;
      const content = messageContent(message);
      return content.includes(setup.document.fileType)
        && content.includes(setup.document.token)
        && content.includes(setup.document.marker);
    });
    return passed ? transcript : undefined;
  });
  return {
    expectedFileType: setup.document.fileType,
    expectedFileToken: setup.document.token,
    expectedMarker: setup.document.marker,
    passed: true,
    messages,
  };
}

function buildScenarioCommands(options: CliOptions): string[] {
  return getScenarioDefinition(options.scenario).buildCommands(options);
}

function scenarioCommandsIncludeFinalMessage(options: CliOptions): boolean {
  return options.scenario === 'basic-dialogue-suite'
    || options.scenario === 'session-management'
    || options.scenario === 'history-boundaries'
    || options.scenario === 'history-attachments'
    || options.scenario === 'history-empty-isolation'
    || options.scenario === 'history-long-truncation'
    || options.scenario === 'history-suite'
    || options.scenario === 'agent-question-forms'
    || options.scenario === 'markdown-rendering';
}

function scenarioSendsTrailingFinalMessage(options: CliOptions): boolean {
  return scenarioRequiresRuntimeOutput(options) && !scenarioCommandsIncludeFinalMessage(options);
}

function scenarioSwitchesToNewChatAfterNewCommand(options: CliOptions): boolean {
  return options.scenario === 'session-management'
    || options.scenario === 'history-boundaries'
    || options.scenario === 'history-attachments'
    || options.scenario === 'history-empty-isolation'
    || options.scenario === 'history-long-truncation'
    || options.scenario === 'history-suite';
}

function waitsForMirrorFinalBeforeFollowup(options: CliOptions, commandText?: string): boolean {
  if (options.scriptedBasicDialogue) return false;
  if (options.scenario === 'basic-dialogue-suite' && commandText) {
    const phase = basicDialoguePhaseForPrompt(options, commandText);
    return Boolean(phase && !phase.endsWith('-sdk'));
  }
  return scenarioCommandsIncludeFinalMessage(options) && options.provider !== 'sdk';
}

function shouldSendBasicDialogueQueuedFollowup(
  options: CliOptions,
  commandText: string,
  nextCommandText: string | undefined,
): boolean {
  if (!options.scriptedBasicDialogue || options.scenario !== 'basic-dialogue-suite') return false;
  const phase = basicDialoguePhaseForPrompt(options, commandText);
  return phase === 'codex-sdk' && nextCommandText === basicDialogueFollowupPrompt(options, phase);
}

function shouldSendBasicDialogueAppendFollowup(
  options: CliOptions,
  commandText: string,
  nextCommandText: string | undefined,
): boolean {
  if (!options.scriptedBasicDialogue || options.scenario !== 'basic-dialogue-suite') return false;
  const phase = basicDialoguePhaseForPrompt(options, commandText);
  return Boolean(
    phase
      && isBasicDialogueAppendInputPhase(phase)
      && nextCommandText === basicDialogueFollowupPrompt(options, phase),
  );
}

async function sendAndObserve(
  chatId: string,
  text: string,
  options: CliOptions,
  label: string,
  runtimeEnvironment: RuntimeEnvironmentPlan,
): Promise<MessageObservation> {
  const before = options.dryRun ? 0 : await countResponseEvidence(options, chatId);
  const sentMessageId = await sendUserText(chatId, text, options);
  let messages: unknown = null;
  if (!options.dryRun) {
    const expectedReply = expectedReplyForMessage(options, text, label);
    const replyTimeoutMs = replyTimeoutMsForMessage(options, text, label);
    try {
      if (shouldObserveFinalPromptByMirrorEvidence(options, label, expectedReply)) {
        await waitForNewResponseEvidence(options, chatId, before, label);
        messages = await listChatMessages(chatId, options, 50);
      } else {
        messages = await waitForBotReplyToMessage(options, chatId, sentMessageId, label, replyTimeoutMs, expectedReply);
      }
    } catch (error) {
      messages = await listChatMessages(chatId, options);
      const nextCount = await countResponseEvidence(options, chatId);
      writeFailureReport({
        label,
        sentText: text,
        chatId,
        options,
        runtimeEnvironment,
        feishuMessages: {
          responseEvidenceBefore: before,
          responseEvidenceAfter: nextCount,
          sentMessageId,
          messages,
        },
      });
      throw error;
    }
  }
  return {
    label,
    chatId,
    sentText: text,
    sentMessageId,
    expectation: shouldObserveFinalPromptByMirrorEvidence(
      options,
      label,
      expectedReplyForMessage(options, text, label),
    ) ? 'mirror-stream-evidence' : 'bot-reply',
    ok: true,
    check: shouldObserveFinalPromptByMirrorEvidence(
      options,
      label,
      expectedReplyForMessage(options, text, label),
    ) ? 'feishu-mirror-stream' : 'feishu-reply_to',
    ...(expectedReplyForMessage(options, text, label).texts.length > 0
      ? {
        expectedText: expectedReplyForMessage(options, text, label).texts[0],
        expectedTexts: expectedReplyForMessage(options, text, label).texts,
      }
      : {}),
    ...(expectedReplyForMessage(options, text, label).forbiddenTexts.length > 0
      ? { expectedForbiddenTexts: expectedReplyForMessage(options, text, label).forbiddenTexts }
      : {}),
    ...(expectedReplyForMessage(options, text, label).messageTypes.length > 0
      ? { expectedReplyMessageTypes: expectedReplyForMessage(options, text, label).messageTypes }
      : {}),
    ...(expectedReplyForMessage(options, text, label).contentKeys.length > 0
      ? { expectedReplyContentKeys: expectedReplyForMessage(options, text, label).contentKeys }
      : {}),
    feishuMessages: messages,
  };
}

async function sendBasicDialogueQueuedFollowup(
  chatId: string,
  promptText: string,
  followupText: string,
  options: CliOptions,
  promptLabel: string,
  followupLabel: string,
  runtimeEnvironment: RuntimeEnvironmentPlan,
): Promise<MessageObservation[]> {
  const promptBefore = options.dryRun ? 0 : await countResponseEvidence(options, chatId);
  const promptMessageId = await sendUserText(chatId, promptText, options);
  const followupDelayMs = BASIC_DIALOGUE_QUEUED_FOLLOWUP_DELAY_MS;
  if (!options.dryRun && followupDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, followupDelayMs));
  }
  const followupMessageId = await sendUserText(chatId, followupText, options);

  let promptMessages: unknown = null;
  let followupMessages: unknown = null;
  if (!options.dryRun) {
    const promptExpectation = expectedReplyForMessage(options, promptText, promptLabel);
    const followupExpectation = expectedReplyForMessage(options, followupText, followupLabel);
    try {
      promptMessages = await waitForBotReplyToMessage(
        options,
        chatId,
        promptMessageId,
        promptLabel,
        replyTimeoutMsForMessage(options, promptText, promptLabel),
        promptExpectation,
      );
      followupMessages = await waitForBotReplyToMessage(
        options,
        chatId,
        followupMessageId,
        followupLabel,
        replyTimeoutMsForMessage(options, followupText, followupLabel),
        followupExpectation,
      );
    } catch (error) {
      const messages = await listChatMessages(chatId, options);
      const nextCount = await countResponseEvidence(options, chatId);
      writeFailureReport({
        label: `${promptLabel} + queued followup`,
        sentText: `${promptText}\n---FOLLOWUP---\n${followupText}`,
        chatId,
        options,
        runtimeEnvironment,
        feishuMessages: {
          responseEvidenceBefore: promptBefore,
          responseEvidenceAfter: nextCount,
          promptMessageId,
          followupMessageId,
          messages,
        },
      });
      throw error;
    }
  }

  const promptExpectation = expectedReplyForMessage(options, promptText, promptLabel);
  const followupExpectation = expectedReplyForMessage(options, followupText, followupLabel);
  return [{
    label: promptLabel,
    chatId,
    sentText: promptText,
    sentMessageId: promptMessageId,
    expectation: 'bot-reply',
    ok: true,
    check: 'feishu-reply_to-queued-prompt',
    ...(promptExpectation.texts.length > 0
      ? { expectedText: promptExpectation.texts[0], expectedTexts: promptExpectation.texts }
      : {}),
    feishuMessages: promptMessages,
  }, {
    label: followupLabel,
    chatId,
    sentText: followupText,
    sentMessageId: followupMessageId,
    expectation: 'bot-reply-after-queued-send',
    ok: true,
    check: 'feishu-reply_to-queued-followup',
    ...(followupExpectation.texts.length > 0
      ? { expectedText: followupExpectation.texts[0], expectedTexts: followupExpectation.texts }
      : {}),
    feishuMessages: followupMessages,
  }];
}

async function sendBasicDialogueAppendFollowup(
  chatId: string,
  promptText: string,
  followupText: string,
  options: CliOptions,
  promptLabel: string,
  followupLabel: string,
  runtimeEnvironment: RuntimeEnvironmentPlan,
): Promise<MessageObservation[]> {
  const promptBefore = options.dryRun ? 0 : await countResponseEvidence(options, chatId);
  const promptMessageId = await sendUserText(chatId, promptText, options);
  const followupDelayMs = BASIC_DIALOGUE_QUEUED_FOLLOWUP_DELAY_MS;
  if (!options.dryRun && followupDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, followupDelayMs));
  }
  const followupMessageId = await sendUserText(chatId, followupText, options);

  let promptMessages: unknown = null;
  let appendObservation: MessageObservation;
  if (!options.dryRun) {
    const promptExpectation = expectedReplyForMessage(options, promptText, promptLabel);
    try {
      promptMessages = await waitForBotReplyToMessage(
        options,
        chatId,
        promptMessageId,
        promptLabel,
        replyTimeoutMsForMessage(options, promptText, promptLabel),
        promptExpectation,
      );
      appendObservation = {
        ...(await assertNoBotReplyToMessage(
          chatId,
          followupMessageId,
          options,
          followupLabel,
          runtimeEnvironment,
        )),
        label: followupLabel,
        sentText: followupText,
        expectation: 'append-input-delivered-no-direct-reply',
        check: 'feishu-append-input-no-direct-reply',
      };
    } catch (error) {
      const messages = await listChatMessages(chatId, options);
      const nextCount = await countResponseEvidence(options, chatId);
      writeFailureReport({
        label: `${promptLabel} + append followup`,
        sentText: `${promptText}\n---APPEND---\n${followupText}`,
        chatId,
        options,
        runtimeEnvironment,
        feishuMessages: {
          responseEvidenceBefore: promptBefore,
          responseEvidenceAfter: nextCount,
          promptMessageId,
          followupMessageId,
          messages,
        },
      });
      throw error;
    }
  } else {
    appendObservation = {
      label: followupLabel,
      chatId,
      sentText: followupText,
      sentMessageId: followupMessageId,
      expectation: 'append-input-delivered-no-direct-reply',
      ok: true,
      check: 'feishu-append-input-no-direct-reply',
      feishuMessages: null,
    };
  }

  const promptExpectation = expectedReplyForMessage(options, promptText, promptLabel);
  return [{
    label: promptLabel,
    chatId,
    sentText: promptText,
    sentMessageId: promptMessageId,
    expectation: 'bot-reply',
    ok: true,
    check: 'feishu-reply_to',
    ...(promptExpectation.texts.length > 0
      ? { expectedText: promptExpectation.texts[0], expectedTexts: promptExpectation.texts }
      : {}),
    feishuMessages: promptMessages,
  }, appendObservation];
}

async function sendMentionedAndObserve(
  chatId: string,
  text: string,
  options: CliOptions,
  label: string,
  runtimeEnvironment: RuntimeEnvironmentPlan,
): Promise<MessageObservation> {
  const before = options.dryRun ? 0 : await countResponseEvidence(options, chatId);
  const sentMessageId = await sendMentionedUserText(chatId, text, options);
  let messages: unknown = null;
  if (!options.dryRun) {
    try {
      messages = await waitForBotReplyToMessage(options, chatId, sentMessageId, label, COMMAND_RESPONSE_TIMEOUT_MS);
    } catch (error) {
      messages = await listChatMessages(chatId, options);
      const nextCount = await countResponseEvidence(options, chatId);
      writeFailureReport({
        label,
        sentText: `@bot ${text}`,
        chatId,
        options,
        runtimeEnvironment,
        feishuMessages: {
          responseEvidenceBefore: before,
          responseEvidenceAfter: nextCount,
          sentMessageId,
          messages,
        },
      });
      throw error;
    }
  }
  return {
    label,
    chatId,
    sentText: `@bot ${text}`,
    sentMessageId,
    expectation: 'bot-reply',
    ok: true,
    check: 'feishu-reply_to',
    feishuMessages: messages,
  };
}

async function assertNoBotReplyToMessage(
  chatId: string,
  sourceMessageId: string,
  options: CliOptions,
  label: string,
  runtimeEnvironment: RuntimeEnvironmentPlan,
): Promise<MessageObservation> {
  if (options.dryRun) {
    return {
      label,
      chatId,
      sentText: '',
      sentMessageId: sourceMessageId,
      expectation: 'no-bot-reply',
      ok: true,
      check: 'feishu-reply_to',
      feishuMessages: null,
    };
  }
  const deadline = Date.now() + FILTERED_MESSAGE_OBSERVE_MS;
  let latestMessages: unknown = null;
  while (Date.now() < deadline) {
    latestMessages = await listChatMessages(chatId, options);
    if (hasBotReplyToMessage(latestMessages, sourceMessageId, options)) {
      writeFailureReport({
        label,
        chatId,
        options,
        runtimeEnvironment,
        feishuMessages: {
          unexpectedReplyTo: sourceMessageId,
          messages: latestMessages,
        },
      });
      throw new Error(`${label}: bot replied to filtered message ${sourceMessageId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollMs, 2_000)));
  }
  return {
    label,
    chatId,
    sentText: '',
    sentMessageId: sourceMessageId,
    expectation: 'no-bot-reply',
    ok: true,
    check: 'feishu-reply_to',
    feishuMessages: latestMessages,
  };
}

async function runRequireAtToggleScenario(
  chatId: string,
  options: CliOptions,
  runtimeEnvironment: RuntimeEnvironmentPlan,
): Promise<MessageObservation[]> {
  const observations: MessageObservation[] = [];
  for (const commandText of buildScenarioCommands(options)) {
    observations.push(await sendAndObserve(chatId, commandText, options, `bridge response for ${commandText}`, runtimeEnvironment));
  }
  observations.push(await sendAndObserve(chatId, '/require-at on', options, 'bridge response for /require-at on', runtimeEnvironment));
  const filteredStatusMessageId = await sendUserText(chatId, '/status', options);
  const filteredObservation = await assertNoBotReplyToMessage(
    chatId,
    filteredStatusMessageId,
    options,
    'no bot reply for non-mentioned /status while require-at is on',
    runtimeEnvironment,
  );
  observations.push({ ...filteredObservation, sentText: '/status' });
  observations.push(await sendMentionedAndObserve(chatId, '/require-at off', options, 'bridge response for mentioned /require-at off', runtimeEnvironment));
  observations.push(await sendAndObserve(chatId, '/status', options, 'bridge response for /status after /require-at off', runtimeEnvironment));
  return observations;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  loadRealFeishuTestEnvFile(argv);
  const options = parseOptions(argv);
  if (hasFlag(process.argv, '--help') || hasFlag(process.argv, '-h')) {
    printUsage();
    return;
  }
  getScenarioDefinition(options.scenario);
  validateScriptedBasicDialogueOptions(options);
  if (options.listScenarios) {
    writeReport({
      scenarios: listScenarioMetadata(),
      naming: {
        e2e: 'real-feishu::<scenario>::<runtime>-<provider>',
        unit: 'unit::<suite>::<behavior>',
      },
    }, options.outputPath);
    return;
  }
  if (options.stopTestBridge) {
    writeReport(await stopPreviousTestBridge(options), options.outputPath);
    return;
  }
  requireRealGuard(options);
  await resolveEffectiveTestFeishuAppId(options);
  assertNoLiveBridgeUsingSameApp(options);

  if (options.dumpOnly) {
    writeReport(latestDump(options), options.outputPath);
    return;
  }

  let child: ChildProcess | null = null;
  let appLock: AppLock | null = null;
  let runtimeEnvironment = plannedRuntimeEnvironment(options);
  let createdChatId = '';
  let createdGroupName = '';
  let completedSuccessfully = false;
  let createdChatCleanup: CreatedChatCleanupResult | null = null;
  let createdDocumentCleanup: CreatedDocumentCleanupResult | null = null;
  let docAsChatScenario: DocAsChatScenarioResult | null = null;
  let scenarioCreatedChatCleanup: CreatedChatCleanupResult[] = [];
  let scenarioCreatedChatInfo: ScenarioCreatedChatInfo[] = [];
  let startupChatCleanup: CreatedChatCleanupResult[] = [];
  let fakeCcrBackend: LocalFakeCcrBackend | null = null;
  let codexResponsesProxy: LocalCodexResponsesProxy | null = null;
  const messageObservations: MessageObservation[] = [];
  try {
    if (options.launchBridge && !options.dryRun) {
      initializeIsolatedLarkCliConfig(options);
    }
    await assertLarkCliUserAuthorizationPreflight(options);
    startupChatCleanup = await cleanupRegisteredTestChats(options);
    appLock = acquireAppLock(options);
    if (usesProxyBackedBasicDialogue(options) && !options.dryRun) {
      codexResponsesProxy = await startLocalCodexResponsesProxy(options.fakeCcrResponseText);
      options.codexProxyBaseUrl = codexResponsesProxy.baseUrl;
      process.stderr.write(`[real-feishu-e2e] Started local Codex Responses proxy at ${codexResponsesProxy.baseUrl}; Codex SDK/pty/tmux will use isolated CODEX_HOME=${options.codexHome}\n`);
    }
    if (usesFakeCcrBackend(options) && !options.dryRun) {
      fakeCcrBackend = await startLocalFakeCcrBackend(options.fakeCcrResponseText);
      options.fakeCcrProxyBaseUrl = fakeCcrBackend.baseUrl;
      options.fakeCcrPort = await reserveLocalPort();
      process.stderr.write(`[real-feishu-e2e] Started local fake CCR model backend at ${fakeCcrBackend.baseUrl}; true ccr will listen on 127.0.0.1:${options.fakeCcrPort}\n`);
    } else if (options.claudeExecutable === 'ccr' && !options.dryRun) {
      options.fakeCcrPort = await reserveLocalPort();
      process.stderr.write(`[real-feishu-e2e] Reserved isolated CCR port 127.0.0.1:${options.fakeCcrPort}\n`);
    }
    if (options.launchBridge && !options.dryRun) {
      runtimeEnvironment = prepareRuntimeEnvironment(options);
    }
    child = await launchBridgeChild(options, runtimeEnvironment);

    let chatId = options.chatId;
    if (options.scenario === 'doc-as-chat-from-scratch') {
      const setup = await setupDocAsChatFromScratchScenario(options);
      chatId = setup.createdGroup.chatId;
      createdGroupName = setup.createdGroup.name;
      if (!options.dryRun) {
        await new Promise((resolve) => setTimeout(resolve, options.pollMs));
      }
      docAsChatScenario = {
        ...setup,
        contextAssertion: {
          expectedFileType: setup.document.fileType,
          expectedFileToken: setup.document.token,
          expectedMarker: setup.document.marker,
          passed: false,
          messages: null,
        },
      };
    } else if (!chatId && options.createChat) {
      const created = await createUserChat(options);
      chatId = created.chatId;
      createdGroupName = created.groupName;
      createdChatId = options.dryRun ? '' : chatId;
      if (!options.dryRun) {
        await new Promise((resolve) => setTimeout(resolve, options.pollMs));
      }
    }
    if (!chatId) {
      if (!options.sourceChatId) {
        throw new Error('Set --chat-id, --create-chat, or --source-chat-id so the harness has a Feishu chat to drive.');
      }
      const groupName = `clk-real-e2e-${options.runId}`.slice(0, 60);
      const newCommand = `/new ${groupName} ${options.workDir}`;
      await sendUserText(options.sourceChatId, newCommand, options);
      if (!options.dryRun) {
        chatId = await waitFor('new Feishu group binding', options.timeoutMs, options.pollMs, () => findCreatedChatId(options));
      }
    }

    if (options.dryRun) {
      const plannedChatId = chatId || '<created-chat-id>';
      for (const commandText of buildScenarioCommands(options)) {
        await sendUserText(plannedChatId, commandText, options);
      }
      if (scenarioSendsTrailingFinalMessage(options)) {
        await sendUserText(plannedChatId, scenarioFinalMessage(options), options);
      }
      writeReport({
        runId: options.runId,
        dryRun: true,
        launchBridge: options.launchBridge,
        createChat: options.createChat,
        scriptedBasicDialogue: options.scriptedBasicDialogue,
        scenario: options.scenario,
        commands: buildScenarioCommands(options),
        commandReplyExpectations: commandReplyExpectations(options),
        coverage: scenarioCoverage(options),
        validationChatSwitchesAfterNew: scenarioSwitchesToNewChatAfterNewCommand(options),
        waitsForMirrorFinalBeforeFollowup: waitsForMirrorFinalBeforeFollowup(options),
        finalMessageObservationMode: finalMessageObservationMode(options),
        runRoot: options.runRoot,
        codelarkHome: options.codelarkHome,
        codexModel: options.codexModel,
        runtimeEnvironment,
        createChatBotAppId: options.createChat ? options.testFeishuAppId || null : null,
        docAsChatScenario,
        plannedChatId,
        keepGroup: options.keepGroup,
      }, options.outputPath);
      return;
    }

    if (!chatId) throw new Error('No real Feishu chat_id available.');
    let validationChatId = chatId;
    if (options.scenario === 'require-at-toggle') {
      messageObservations.push(...await runRequireAtToggleScenario(chatId, options, runtimeEnvironment));
    } else {
      let activeChatId = chatId;
      let runtimeValidationChatId = chatId;
      const scenarioCommands = buildScenarioCommands(options);
      for (let commandIndex = 0; commandIndex < scenarioCommands.length; commandIndex += 1) {
        const commandText = scenarioCommands[commandIndex];
        const nextCommandText = scenarioCommands[commandIndex + 1];
        const label = commandLabelForScenario(options, commandText, commandIndex);
        if (shouldSendBasicDialogueQueuedFollowup(options, commandText, nextCommandText)) {
          const followupLabel = commandLabelForScenario(options, nextCommandText, commandIndex + 1);
          const observations = await sendBasicDialogueQueuedFollowup(
            activeChatId,
            commandText,
            nextCommandText,
            options,
            label,
            followupLabel,
            runtimeEnvironment,
          );
          messageObservations.push(...observations);
          runtimeValidationChatId = activeChatId;
          commandIndex += 1;
          continue;
        }
        if (shouldSendBasicDialogueAppendFollowup(options, commandText, nextCommandText)) {
          const followupLabel = commandLabelForScenario(options, nextCommandText, commandIndex + 1);
          const observations = await sendBasicDialogueAppendFollowup(
            activeChatId,
            commandText,
            nextCommandText!,
            options,
            label,
            followupLabel,
            runtimeEnvironment,
          );
          messageObservations.push(...observations);
          runtimeValidationChatId = activeChatId;
          commandIndex += 1;
          continue;
        }
        const observation = await sendAndObserve(activeChatId, commandText, options, label, runtimeEnvironment);
        messageObservations.push(observation);
        if (isScenarioRuntimePrompt(options, commandText)) {
          runtimeValidationChatId = activeChatId;
        }
        if (isScenarioRuntimePrompt(options, commandText) && waitsForMirrorFinalBeforeFollowup(options, commandText)) {
          const finalExpectedText = expectedRuntimePromptResponseText(options, commandText);
          const finalExpectation = expectedReplyForMessage(options, commandText, label);
          try {
            await waitForMirrorStreamCompleted(
              options,
              activeChatId,
              `mirror stream completion for ${commandText}`,
            );
          } catch (error) {
            const messages = await listChatMessages(activeChatId, options, 50);
            writeFailureReport({
              label: `mirror stream completion for ${commandText}`,
              sentText: commandText,
              chatId: activeChatId,
              options,
              runtimeEnvironment,
              feishuMessages: {
                finalMessages: messages,
                messageObservations,
              },
            });
            throw error;
          }
          if (!isEmptyReplyExpectation(finalExpectation)) {
            try {
              await waitForBotTranscriptExpectation(
                options,
                activeChatId,
                finalExpectation,
                `mirror final transcript expectation for ${commandText}`,
              );
            } catch (error) {
              const messages = await listChatMessages(activeChatId, options, 50);
              writeFailureReport({
                label: `mirror final transcript expectation for ${commandText}`,
                sentText: commandText,
                chatId: activeChatId,
                options,
                runtimeEnvironment,
                feishuMessages: {
                  expectedTexts: finalExpectation.texts,
                  expectedForbiddenTexts: finalExpectation.forbiddenTexts,
                  expectedReplyMessageTypes: finalExpectation.messageTypes,
                  expectedReplyContentKeys: finalExpectation.contentKeys,
                  finalMessages: messages,
                  messageObservations,
                },
              });
              throw error;
            }
          } else if (finalExpectedText) {
            try {
              await waitForBotTranscriptText(
                options,
                activeChatId,
                finalExpectedText,
                `mirror final transcript for ${commandText}`,
              );
            } catch (error) {
              const messages = await listChatMessages(activeChatId, options, 50);
              writeFailureReport({
                label: `mirror final transcript for ${commandText}`,
                sentText: commandText,
                chatId: activeChatId,
                options,
                runtimeEnvironment,
                feishuMessages: {
                  expectedText: finalExpectedText,
                  finalMessages: messages,
                  messageObservations,
                },
              });
              throw error;
            }
          }
        }
        if (scenarioSwitchesToNewChatAfterNewCommand(options) && commandText.trim().startsWith('/new ')) {
          const nextChatId = nextScenarioChatIdFromObservation(observation, [
            activeChatId,
            chatId,
            createdChatId,
            options.chatId,
            options.sourceChatId,
          ]);
          if (nextChatId) {
            activeChatId = nextChatId;
            validationChatId = nextChatId;
          }
        }
      }
      validationChatId = requiredCheckChatIdForScenario(options, validationChatId, runtimeValidationChatId);
      if (scenarioSendsTrailingFinalMessage(options)) {
        const observation = await sendAndObserve(activeChatId, scenarioFinalMessage(options), options, 'bridge response for final message', runtimeEnvironment);
        messageObservations.push(observation);
        validationChatId = activeChatId;
        if (docAsChatScenario) {
          try {
            docAsChatScenario.contextAssertion = await waitForDocAsChatContextAssertion(docAsChatScenario, options);
          } catch (error) {
            const messages = await listChatMessages(activeChatId, options, 50);
            writeFailureReport({
              label: 'doc-as-chat context assertion',
              sentText: scenarioFinalMessage(options),
              chatId: activeChatId,
              options,
              runtimeEnvironment,
              feishuMessages: {
                expectedFileType: docAsChatScenario.document.fileType,
                expectedFileToken: docAsChatScenario.document.token,
                expectedMarker: docAsChatScenario.document.marker,
                messages,
                docAsChatScenario,
              },
            });
            throw error;
          }
        }
      }
    }
    await waitFor('bridge response evidence', options.timeoutMs, options.pollMs, async () => (
      await hasResponseEvidence(options, validationChatId) ? true : undefined
    ));
    let report: ReturnType<typeof latestDump>;
    try {
      report = await waitForScenarioChecks(options, validationChatId);
    } catch (error) {
      const messages = await listChatMessages(validationChatId, options);
      writeFailureReport({
        label: 'required real Feishu E2E checks',
        chatId: validationChatId,
        options,
        runtimeEnvironment,
        feishuMessages: {
          finalMessages: messages,
          messageObservations,
        },
      });
      throw error;
    }
    const finalFeishuMessages = await listFinalFeishuMessagesForObservations(messageObservations, options, validationChatId);
    scenarioCreatedChatInfo = await inspectScenarioCreatedChats(messageObservations, options, [
      chatId,
      createdChatId,
      options.chatId,
      options.sourceChatId,
    ]);
    scenarioCreatedChatCleanup = await cleanupScenarioCreatedChats(messageObservations, options, [
      chatId,
      createdChatId,
      options.chatId,
      options.sourceChatId,
    ]);
    if (docAsChatScenario) {
      scenarioCreatedChatCleanup.push(await deleteCreatedChat(docAsChatScenario.createdGroup.chatId, options));
      createdDocumentCleanup = await deleteCreatedDocument(docAsChatScenario.document, options);
    }
    if (createdChatId) {
      createdChatCleanup = await deleteCreatedChat(createdChatId, options);
      updateTestChatRegistryCleanup(createdChatId, createdChatCleanup, options.keepGroup);
      createdChatId = '';
    }
    const effectiveReportChecks = report.checks.map((check) => (
      check.name === 'messages_present' && options.provider !== 'sdk'
        ? {
          ...check,
          ok: true,
          detail: `${check.detail}; not required for ${options.provider} mirror provider.`,
        }
        : check.name === 'claude_jsonl_found' && options.runtime === 'claude' && options.provider === 'sdk'
          ? {
            ...check,
            ok: true,
            detail: `${check.detail}; not required for claude-sdk direct provider.`,
          }
        : check
    ));
    const codexModelAudit = codexProxyModelAudit(options, codexResponsesProxy);
    const checks = [
      ...effectiveReportChecks,
      ...scenarioSpecificChecks(options, report, finalFeishuMessages),
      ...(options.fakeCcr
        ? [{
          name: 'fake_ccr_backend_used',
          ok: (fakeCcrBackend?.requests.length || 0) > 0,
          detail: `Fake CCR backend request count: ${fakeCcrBackend?.requests.length || 0}.`,
        }]
        : []),
      ...(usesProxyBackedBasicDialogue(options)
        ? [{
          name: 'codex_responses_proxy_used',
          ok: (codexResponsesProxy?.requests.length || 0) > 0,
          detail: `Codex Responses proxy request count: ${codexResponsesProxy?.requests.length || 0}.`,
        }, {
          name: 'codex_responses_proxy_model_resolved',
          ok: codexModelAudit.hasModelField,
          detail: codexProxyModelAuditDetail(codexModelAudit),
        }, {
          name: 'codex_responses_proxy_reasoning_low',
          ok: codexModelAudit.hasReasoningLow,
          detail: `Codex Responses proxy request reasoning low observed: ${codexModelAudit.hasReasoningLow ? 'yes' : 'no'}.`,
        }, {
          name: 'codex_responses_proxy_bootstrap_prompt_observed',
          ok: codexModelAudit.hasBootstrapPrompt,
          detail: `Codex Responses proxy bootstrap prompt observed: ${codexModelAudit.hasBootstrapPrompt ? 'yes' : 'no'}.`,
        }, {
          name: 'basic_dialogue_ccr_proxy_used',
          ok: (fakeCcrBackend?.requests.length || 0) > 0,
          detail: `CCR fake backend request count: ${fakeCcrBackend?.requests.length || 0}.`,
        }]
        : []),
      ...automatedSuccessChecks({
        options,
        report,
        messageObservations,
        finalFeishuMessages,
        createdChatCleanup,
        docAsChatScenario,
        createdDocumentCleanup,
        scenarioCreatedChatInfo,
        scenarioCreatedChatCleanup,
      }),
    ];
    const finalReport = {
      ...report,
      checks,
      launchBridge: options.launchBridge,
      createChat: options.createChat,
      scriptedBasicDialogue: options.scriptedBasicDialogue,
      scenario: options.scenario,
      commands: buildScenarioCommands(options),
      commandReplyExpectations: commandReplyExpectations(options),
      coverage: scenarioCoverage(options),
      validationChatSwitchesAfterNew: scenarioSwitchesToNewChatAfterNewCommand(options),
      waitsForMirrorFinalBeforeFollowup: waitsForMirrorFinalBeforeFollowup(options),
      finalMessageObservationMode: finalMessageObservationMode(options),
      runRoot: options.runRoot,
      codelarkHome: options.codelarkHome,
      codexModel: options.codexModel,
      runtimeEnvironment,
      ...(fakeCcrBackend
        ? {
          fakeCcrExpectedResponse: options.fakeCcrResponseText,
          fakeCcrRequestCount: fakeCcrBackend.requests.length,
          fakeCcrRequests: fakeCcrBackend.requests.map((request) => ({
            method: request.method,
            url: request.url,
          })),
        }
        : {}),
      ...(codexResponsesProxy
        ? {
          codexProxyBaseUrl: codexResponsesProxy.baseUrl,
          codexProxyRequestCount: codexResponsesProxy.requests.length,
          codexProxyRequests: codexResponsesProxy.requests.map((request) => ({
            method: request.method,
            url: request.url,
          })),
          codexProxyRequestSummaries: codexProxyRequestSummaries(codexResponsesProxy.requests),
          codexProxyModelAudit: codexModelAudit,
        }
        : {}),
      unexpectedMirror: unexpectedMirrorIssues(options, report),
      messageObservations,
      finalFeishuMessages,
      docAsChatScenario,
      scenarioCreatedChatInfo,
      scenarioCreatedChatCleanup,
      ...(createdDocumentCleanup ? { createdDocumentCleanup } : {}),
      testChatRegistryPath: TEST_CHAT_REGISTRY_PATH,
      startupChatCleanup,
      ...(createdGroupName ? { createdGroupName } : {}),
      ...(createdChatCleanup ? { createdChatCleanup } : {}),
      keepGroup: options.keepGroup,
      note: options.keepGroup
        ? 'Group cleanup was skipped by request.'
        : '临时 run root 会自动清理；本次脚本创建的飞书测试群会在成功后尝试自动删除。',
    };
    const failedChecks = checks.filter((check) => !check.ok);
    if (failedChecks.length > 0) {
      const reportPath = options.outputPath
        ? options.outputPath.replace(/\.json$/i, '.failure.json')
        : path.join(os.tmpdir(), `${path.basename(options.runRoot)}.failure.json`);
      writeReport({
        ...finalReport,
        failedChecks,
      }, reportPath);
      throw new Error(`Automated real Feishu E2E checks failed: ${failedChecks.map((check) => check.name).join(', ')}`);
    }
    writeReport(finalReport, options.outputPath);
    completedSuccessfully = true;
  } finally {
    if (!completedSuccessfully && scenarioCreatedChatCleanup.length === 0) {
      scenarioCreatedChatCleanup = await cleanupScenarioCreatedChats(messageObservations, options, [
        createdChatId,
        options.chatId,
        options.sourceChatId,
      ]).catch((error) => {
        process.stderr.write(`[real-feishu-e2e] Failed to cleanup scenario-created /new chats: ${error instanceof Error ? error.message : String(error)}\n`);
        return [];
      });
    }
    if (createdChatId && completedSuccessfully && !createdChatCleanup) {
      const cleanup = await deleteCreatedChat(createdChatId, options);
      updateTestChatRegistryCleanup(createdChatId, cleanup, options.keepGroup);
    } else if (createdChatId && !completedSuccessfully && !options.keepGroup) {
      process.stderr.write(`[real-feishu-e2e] Keeping failed-run Feishu test group for diagnosis: ${createdChatId}\n`);
      updateTestChatRegistryCleanup(createdChatId, {
        chatId: createdChatId,
        attempted: false,
        deleted: false,
        retained: true,
        reason: 'failed-run-kept-for-diagnosis',
      }, false);
    }
    await stopBridgeChild(child);
    await stopFakeCcrRouter(options);
    if (fakeCcrBackend) {
      await fakeCcrBackend.close().catch(() => {});
    }
    if (codexResponsesProxy) {
      await codexResponsesProxy.close().catch(() => {});
    }
    releaseAppLock(appLock);
    await cleanupTestTmuxSessions(options);
    await cleanupTemporaryRunRoot(options);
  }
}

main().catch((error) => {
  process.stderr.write(`[real-feishu-e2e] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
