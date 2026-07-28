#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { FeishuSite } from '../src/channels/types.js';
import {
  feishuSetupUserAuthScopeArgument,
} from '../src/channels/feishu/permissions.js';
import { feishuSiteToApiBaseUrl } from '../src/channels/feishu/site.js';
import { createConfigService } from '../src/configuration/service.js';
import { DEFAULT_WORKSPACE_ROOT } from '../src/configuration/paths.js';
import type { ClaudeExecutable } from '../src/runtime/options.js';
import type { ConfigPatch } from '../src/configuration/schema.js';
import {
  basicDialogueStreamCardCheckpointIssues,
  collectRealE2eDump,
  cursorStreamCardUnifiedUiIssues,
  kimiThinkingStatusOnlyIssues,
  scriptedKimiToolCardIssues,
  scriptedKimiHistoryTranscriptIssues,
  scriptedKimiLifecycleAndSteerIssues,
  scriptedKimiRuntimeSlotIssues,
  scriptedKimiWireTranscriptIssues,
} from '../src/bridge/diagnostics/real-e2e-dump.js';
import {
  BASIC_DIALOGUE_MODEL_PROXY_CHUNK_DELAY_MS,
  basicDialogueProxyReplyPlan,
  startLocalCodexResponsesProxy as startSharedLocalCodexResponsesProxy,
} from '../src/testing/real-feishu/codex-responses-proxy.js';
import type {
  LocalCodexResponsesProxy,
  ScriptedModelReplyPlan,
} from '../src/testing/real-feishu/codex-responses-proxy.js';
import { serializeFailureError } from '../src/testing/real-feishu/failure-report.js';
import { containsGeneratedReplyTexts } from '../src/testing/real-feishu/reply-evidence.js';

const execFileAsync = promisify(execFile);

type RuntimeName = 'codex' | 'claude' | 'kimi' | 'cursor';
type ProviderName = 'sdk' | 'tmux';

const COMMAND_RESPONSE_TIMEOUT_MS = 15_000;
const FILTERED_MESSAGE_OBSERVE_MS = 6_000;
const TEST_CHAT_REGISTRY_PATH = process.env.CODELARK_REAL_FEISHU_TEST_CHAT_REGISTRY_PATH
  || path.join(os.tmpdir(), 'codelark-real-feishu-e2e-chats.json');

function defaultRealFeishuTestEnvFile(): string {
  const codelarkHome = process.env.CODELARK_HOME || path.join(os.homedir(), '.codelark');
  return path.join(codelarkHome, 'real-feishu-e2e', 'test.env');
}

interface CliOptions {
  dryRun: boolean;
  dumpOnly: boolean;
  listScenarios: boolean;
  coverageMatrix: boolean;
  requireCanonicalCoverage: '' | 'kimi' | 'kimi-current';
  stopTestBridge: boolean;
  launchBridge: boolean;
  fakeCcr: boolean;
  scriptedBasicDialogue: boolean;
  scriptedKimi: boolean;
  keepGroup: boolean;
  keepCodelarkHome: boolean;
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
  kimiHome: string;
  cursorConfigDir: string;
  cursorDataDir: string;
  claudeExecutable: ClaudeExecutable;
  testFeishuAppId: string;
  testFeishuAppSecret: string;
  testBotOpenId: string;
  testUserAccessToken: string;
  testLarkCliConfigDir: string;
  testLarkCliXdgDataHome: string;
  feishuSite: FeishuSite;
  larkProfile: string;
  scenario: string;
  commands: string[];
  chatId: string;
  workDir: string;
  message: string;
  codexModel: string;
  cursorModel: string;
  timeoutMs: number;
  pollMs: number;
  outputPath: string;
  reportsDir: string;
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
  bridgeHome: string;
  codexHome: string;
  claudeHome: string;
  kimiHome: string;
  cursorConfigDir: string;
  cursorDataDir: string;
  claudeExecutable: ClaudeExecutable;
  larkCliConfigSource: 'test-env-app' | 'not-needed' | 'missing';
  codexAuthSource: 'env-api-key' | 'host-auth-copy' | 'missing';
  claudeAuthSource: 'host-config-copy' | 'missing';
  kimiAuthSource: 'host-config-copy' | 'not-needed' | 'missing';
  kimiExecutableSource: 'scripted-fake-executable' | 'env-executable' | 'host-home-bin' | 'path';
  kimiExecutablePath?: string;
  cursorAuthSource: 'host-config-copy' | 'missing';
  cursorExecutableSource: 'env-executable' | 'host-home-bin' | 'path';
  cursorExecutablePath?: string;
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
  check: 'feishu-reply_to' | 'feishu-new-chat-transcript' | 'feishu-reply_to-queued-prompt' | 'feishu-reply_to-queued-followup' | 'feishu-mirror-stream' | 'feishu-append-input-no-direct-reply';
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

type CoverageEvidenceStatus =
  | 'none'
  | 'dry-run'
  | 'diagnostic-failure'
  | 'diagnostic-pass'
  | 'legacy-pass'
  | 'canonical-pass';

interface CoverageEvidence {
  status: CoverageEvidenceStatus;
  reportPath?: string;
  reportMtimeMs?: number;
  runId?: string;
  dryRun?: boolean;
  failedChecks?: string[];
  missingCanonicalChecks?: string[];
  canonicalEligible?: boolean;
  canonicalBlockers?: string[];
  canonicalReportCheck?: boolean | null;
}

interface CoverageMatrixEntry {
  scenario: string;
  testName: string;
  matchingTestNames: string[];
  providerCoverage: ScenarioDefinition['providerCoverage'];
  coverageTier: ScenarioDefinition['coverageTier'];
  includesKimi: boolean;
  runtime?: RuntimeName;
  provider?: ProviderName;
  evidence: CoverageEvidence;
  unitCoverage: string[];
  e2eCoverage: string[];
}

interface CoverageMatrixGap {
  scenario: string;
  testName: string;
  coverageTier: ScenarioDefinition['coverageTier'];
  evidenceStatus: CoverageEvidenceStatus;
  reportPath?: string;
  runId?: string;
  failedChecks?: string[];
  missingCanonicalChecks?: string[];
}

interface CoverageRateBucket {
  total: number;
  canonicalPass: number;
  legacyPass: number;
  diagnosticPass: number;
  diagnosticFailure: number;
  dryRun: number;
  plannedOnly: number;
  executed: number;
  canonicalPercent: number;
  executedPercent: number;
}

interface CoverageRateSummary {
  all: CoverageRateBucket;
  current: CoverageRateBucket;
  tmux: CoverageRateBucket;
  currentTmux: CoverageRateBucket;
  kimi: CoverageRateBucket;
  kimiCurrent: CoverageRateBucket;
  kimiCurrentTmux: CoverageRateBucket;
  cardFrontend: CoverageRateBucket;
  cardFrontendTmux: CoverageRateBucket;
}

interface CoverageMatrixReport {
  reportDir: string;
  scenarios: number;
  summary: Record<string, number>;
  coverageRates: CoverageRateSummary;
  entries: CoverageMatrixEntry[];
  unmatchedReports: CoverageEvidence[];
  kimiGaps: CoverageMatrixGap[];
  kimiCurrentGaps: CoverageMatrixGap[];
}

const BASIC_DIALOGUE_SDK_MIRROR_SUPPRESSION_GRACE_MS = 10_000;
const BASIC_DIALOGUE_QUEUED_FOLLOWUP_DELAY_MS = 250;

const BASIC_DIALOGUE_PROVIDER_SEQUENCE = [
  'codex-sdk',
  'claude-sdk',
  'kimi-tmux',
  'codex-tmux',
];
const BASIC_DIALOGUE_APPEND_INPUT_PROVIDER_KEYS = [
  'kimi-tmux',
  'codex-tmux',
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
      'e2e::mock-app-kimi-runtime-provider-message',
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
    description: '同一会话中按 codex-sdk -> claude-sdk -> kimi-tmux -> codex-tmux 切换，覆盖基本对话、工具/权限/goal/context/stop、Kimi steer 和 SDK mirror 抑制。',
    unitCoverage: [
      'unit::interactive-turn-runner::basic-dialogue-session-simulator',
      'unit::interactive-turn-runner::controlled-tool-context-stream-card',
      'unit::interactive-turn-runner::stop-interrupted-stream',
      'unit::mirror-suppression::sdk-terminal-grace',
      'unit::command-dispatch::runtime-provider-switch',
      'unit::bridge-manager::kimi-thinking-status-only',
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
      'unit::bridge-command-e2e::file-command-local-file',
      'unit::bridge-command-e2e::large-file-upload-confirmation',
      'unit::bridge-command-e2e::kimi-command-state',
      'unit::interactive-turn-runner::runtime-turn',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::require-at-off',
      'e2e::runtime-switch',
      'e2e::session-state-commands',
      'e2e::every-task-create-list-remove',
      'e2e::file-command-feishu-file-reply',
      'e2e::large-file-confirmation-card-reply',
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
      `/file ${commandStateFixtureFilePath(options)}`,
      `/file ${commandStateLargeFixtureFilePath(options)}`,
      `/every 1h e2e seed ${options.runId}`,
      '/every',
      '/every no 1',
    ],
  },
  {
    name: 'session-management',
    testNamePrefix: 'real-feishu::session-management',
    description: '覆盖帮助、全局配置、/new、/clear、/cd、/current、/check、/t 列表/分页/解绑/归档，发送 runtime prompt 后再用 /his 验证历史。',
    unitCoverage: [
      'unit::help-command::slash-command-groups',
      'unit::command-dispatch::global-settings',
      'unit::command-dispatch::new-session',
      'unit::command-dispatch::clear-session-runtime-preservation',
      'unit::command-dispatch::cd-command',
      'unit::command-dispatch::shell-command',
      'unit::command-dispatch::health-diagnostics',
      'unit::command-dispatch::thread-list-unbind-archive',
      'unit::bridge-command-e2e::history-commands',
      'unit::bridge-command-e2e::kimi-command-state',
      'unit::bridge-command-e2e::kimi-session-management-identity-archive',
      'unit::interactive-turn-runner::runtime-turn',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::help-command-response',
      'e2e::global-settings-response',
      'e2e::new-session-binding',
      'e2e::clear-session-runtime-binding',
      'e2e::session-working-directory-update',
      'e2e::shell-command-sandbox-reply',
      'e2e::health-diagnostics-response',
      'e2e::thread-list-card-response',
      'e2e::thread-list-limit-response',
      'e2e::thread-unbind-temporary-session',
      'e2e::thread-archive-current-runtime-session',
      'e2e::mock-app-kimi-session-management-identity-archive',
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
      sessionManagementProviderSettingCommand(options),
      `/new mgmt-${options.runId} ${options.workDir}`,
      ...buildRuntimeProviderCommands(options),
      `/clear clear-${options.runId} ${options.workDir}`,
      `/cd ${options.workDir}`,
      sessionManagementShellCommand(options),
      '/current',
      '/check',
      '/t',
      '/t n 50',
      '/t unbind',
      scenarioFinalMessage(options),
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
      'unit::bridge-command-e2e::kimi-history-suite-wire',
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
      'e2e::mock-app-kimi-history-default-msg-raw-json-file',
    ],
    providerCoverage: 'runtime-parameterized',
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
    description: '覆盖命令 rich card 表单在飞书客户端以 interactive reply_to 返回，包括新会话和自动化输入表单入口。',
    unitCoverage: [
      'unit::bridge-command-e2e::new-session-form-card',
      'unit::bridge-command-e2e::every-card-form-callback-chain',
      'unit::command-dispatch::then-form-card',
      'unit::feishu-adapter::rich-card-form',
      'unit::delivery-pipeline::question-form-card',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-command',
      'e2e::feishu-interactive-card-reply_to',
      'e2e::card-form-visible-transcript',
      'e2e::automation-form-visible-transcript',
    ],
    providerCoverage: 'runtime-neutral',
    coverageTier: 'runtime-neutral-check',
    requiresRuntimeOutput: false,
    buildCommands: (options) => [...options.commands, '/new', '/every-form', '/then-form'],
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
      'unit::feishu-adapter-card-e2e::kimi-mirror-markdown-ask-form',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-message',
      'e2e::runtime-response',
      'e2e::feishu-interactive-card-reply_to',
      'e2e::agent-question-form-visible-transcript',
      'e2e::mock-app-kimi-mirror-clk-ask-form',
      'e2e::mock-app-kimi-mirror-markdown-ask-split',
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
      'unit::feishu-adapter-card-e2e::kimi-mirror-markdown-card',
      'unit::feishu-adapter-card-e2e::kimi-mirror-markdown-ask-form',
    ],
    e2eCoverage: [
      'e2e::lark-cli-user-message',
      'e2e::runtime-response',
      'e2e::feishu-markdown-table',
      'e2e::feishu-markdown-fenced-code',
      'e2e::feishu-outbound-response',
      'e2e::mock-app-kimi-mirror-markdown-ask-split',
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

function sessionManagementProviderSettingCommand(options: CliOptions): string {
  if (options.runtime === 'kimi') return '/set kimiProvider tmux';
  if (options.runtime === 'cursor') return '/set cursorProvider tmux';
  return `/set claudeProvider ${options.runtime === 'claude' ? options.provider : 'tmux'}`;
}

function parseRuntimeProviderKey(key: string): { runtime: RuntimeName; provider: ProviderName } {
  const [runtimePart, providerPart] = key.split('-');
  if (!runtimePart || !providerPart || key.split('-').length !== 2) {
    throw new Error(`Invalid runtime/provider key "${key}". Expected <runtime>-<provider>.`);
  }
  const runtime = parseRuntimeName(runtimePart);
  return {
    runtime,
    provider: normalizeProviderForRuntime(runtime, providerPart),
  };
}

function runtimeProviderCommandTitle(runtime: RuntimeName): string {
  if (runtime === 'claude') return 'Claude Provider';
  if (runtime === 'kimi') return 'Kimi Provider';
  if (runtime === 'cursor') return 'Cursor Provider';
  return 'Codex Provider';
}

function runtimeDisplayLabel(runtime: RuntimeName): string {
  if (runtime === 'claude') return 'Claude Code';
  if (runtime === 'kimi') return 'Kimi Code';
  if (runtime === 'cursor') return 'Cursor';
  return 'Codex';
}

function runtimeIdentityFieldName(runtime: RuntimeName): string {
  if (runtime === 'claude') return 'claude_session_id';
  if (runtime === 'kimi') return 'kimi_session_id';
  if (runtime === 'cursor') return 'cursor_session_id';
  return 'codex_thread_id';
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
    ...(providerKey === 'codex-tmux' ? ['/stop'] : []),
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
      terminalRuntime: options.scriptedBasicDialogue
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
        ...(providerKey === 'codex-tmux' ? { stopCommand: '/stop' } : {}),
        ...(isBasicDialogueAppendInputPhase(providerKey)
          ? {
            appendInputGate: options.scriptedBasicDialogue
              ? 'message-delivered-no-direct-reply'
              : 'planned-not-yet-gated',
          }
          : {}),
        ...(options.scriptedBasicDialogue && providerKey === 'kimi-tmux'
          ? {
            streamCardRequiredTexts: basicDialogueKimiThinkingCheckpointTexts(options),
          }
          : {}),
      };
    }),
  };
}

function basicDialogueKimiThinkingCheckpointTexts(options: CliOptions): string[] {
  return [
    '当前思考',
    `scripted Kimi thinking for ${basicDialogueMarker(options, 'kimi-tmux')}`,
  ];
}

function valueArg(args: string[], name: string, fallback = ''): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1] || fallback;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

const BOOLEAN_CLI_FLAGS = new Set([
  '--dry-run',
  '--dump-only',
  '--list-scenarios',
  '--coverage-matrix',
  '--stop-test-bridge',
  '--launch-bridge',
  '--fake-ccr',
  '--scripted-basic-dialogue',
  '--scripted-kimi',
  '--keep-group',
  '--keep-clk-home',
  '--help',
  '-h',
]);

const VALUE_CLI_OPTIONS = new Set([
  '--require-canonical',
  '--test-env-file',
  '--run-id',
  '--runtime',
  '--scenario',
  '--provider',
  '--run-root',
  '--clk-home',
  '--runtime-home',
  '--codex-home',
  '--claude-home',
  '--claude-executable',
  '--feishu-site',
  '--channel-type',
  '--channel-alias',
  '--test-feishu-app-id',
  '--test-feishu-app-secret',
  '--test-bot-open-id',
  '--test-user-access-token',
  '--test-lark-cli-config-dir',
  '--test-lark-cli-xdg-data-home',
  '--lark-profile',
  '--commands',
  '--chat-id',
  '--workdir',
  '--message',
  '--codex-model',
  '--cursor-model',
  '--timeout-ms',
  '--poll-ms',
  '--output',
  '--reports-dir',
  '--fake-ccr-response',
]);

function validateCliArgs(argv: string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (BOOLEAN_CLI_FLAGS.has(arg)) continue;
    if (VALUE_CLI_OPTIONS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for option: ${arg}`);
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    throw new Error(`Unexpected positional argument: ${arg}. Use named options only.`);
  }
}

function parseRuntimeName(raw: string): RuntimeName {
  if (raw === 'codex' || raw === 'claude' || raw === 'kimi' || raw === 'cursor') return raw;
  throw new Error(`Invalid runtime "${raw}". Expected codex, claude, kimi, or cursor.`);
}

function parseClaudeExecutable(raw: string): ClaudeExecutable {
  if (raw === 'ccr' || raw === 'claude') return raw;
  throw new Error(`Invalid Claude executable "${raw}". Expected ccr or claude.`);
}

function parseFeishuSite(raw: string): FeishuSite {
  if (raw === 'feishu' || raw === 'lark') return raw;
  throw new Error(`Invalid Feishu site "${raw}". Expected feishu or lark.`);
}

function parseRequireCanonicalCoverage(argv: string[]): CliOptions['requireCanonicalCoverage'] {
  const raw = valueArg(argv, '--require-canonical', '').trim();
  if (!raw) return '';
  if (raw === 'kimi' || raw === 'kimi-current') return raw;
  throw new Error(`Invalid --require-canonical "${raw}". Expected kimi or kimi-current.`);
}

function parsePositiveIntOption(argv: string[], name: string, fallback: number): number {
  const value = valueArg(argv, name, '');
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} "${value}". Expected a positive integer.`);
  }
  return parsed;
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
    if (!parsed.key.startsWith('CODELARK_REAL_FEISHU_TEST_') && parsed.key !== 'CODELARK_REAL_FEISHU_AUTH_HOME') continue;
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
  return resolved;
}

function parseOptions(argv: string[]): CliOptions {
  const runId = valueArg(argv, '--run-id', `clk-real-${Date.now()}`);
  const runtime = parseRuntimeName(valueArg(argv, '--runtime', 'claude'));
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
  const launchBridge = hasFlag(argv, '--launch-bridge');
  const kimiHome = path.join(runtimeHome, '.kimi-code');
  const cursorConfigDir = path.join(runRoot, 'cursor-config');
  const cursorDataDir = path.join(runRoot, 'cursor-data');
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
    coverageMatrix: hasFlag(argv, '--coverage-matrix'),
    requireCanonicalCoverage: parseRequireCanonicalCoverage(argv),
    stopTestBridge: hasFlag(argv, '--stop-test-bridge'),
    launchBridge,
    fakeCcr: hasFlag(argv, '--fake-ccr'),
    scriptedBasicDialogue: hasFlag(argv, '--scripted-basic-dialogue'),
    scriptedKimi: hasFlag(argv, '--scripted-kimi'),
    keepGroup: hasFlag(argv, '--keep-group'),
    keepCodelarkHome: hasFlag(argv, '--keep-clk-home'),
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
    kimiHome,
    cursorConfigDir,
    cursorDataDir,
    claudeExecutable: parseClaudeExecutable(claudeExecutableArg),
    testFeishuAppId: valueArg(argv, '--test-feishu-app-id', process.env.CODELARK_REAL_FEISHU_TEST_APP_ID || ''),
    testFeishuAppSecret: valueArg(argv, '--test-feishu-app-secret', process.env.CODELARK_REAL_FEISHU_TEST_APP_SECRET || ''),
    testBotOpenId: valueArg(argv, '--test-bot-open-id', process.env.CODELARK_REAL_FEISHU_TEST_BOT_OPEN_ID || ''),
    testUserAccessToken: valueArg(argv, '--test-user-access-token', process.env.CODELARK_REAL_FEISHU_TEST_USER_ACCESS_TOKEN || ''),
    testLarkCliConfigDir: valueArg(argv, '--test-lark-cli-config-dir', process.env.CODELARK_REAL_FEISHU_TEST_LARK_CLI_CONFIG_DIR || ''),
    testLarkCliXdgDataHome: valueArg(argv, '--test-lark-cli-xdg-data-home', process.env.CODELARK_REAL_FEISHU_TEST_LARK_CLI_XDG_DATA_HOME || ''),
    feishuSite: parseFeishuSite(siteArg),
    larkProfile: valueArg(argv, '--lark-profile', ''),
    scenario,
    commands: parseCommandList(valueArg(argv, '--commands', '')),
    chatId: valueArg(argv, '--chat-id', ''),
    workDir: valueArg(argv, '--workdir', DEFAULT_WORKSPACE_ROOT),
    message: valueArg(argv, '--message', `real feishu e2e ${runId}`),
    codexModel: valueArg(argv, '--codex-model', process.env.CODELARK_REAL_FEISHU_CODEX_MODEL || 'gpt-5.5'),
    cursorModel: valueArg(argv, '--cursor-model', process.env.CODELARK_REAL_FEISHU_CURSOR_MODEL || 'gpt-5.3-codex'),
    timeoutMs: parsePositiveIntOption(argv, '--timeout-ms', 120_000),
    pollMs: parsePositiveIntOption(argv, '--poll-ms', 2_000),
    outputPath: valueArg(argv, '--output', ''),
    reportsDir: valueArg(argv, '--reports-dir', path.join(process.cwd(), 'work', 'real-feishu')),
    fakeCcrResponseText: valueArg(argv, '--fake-ccr-response', defaultFakeCcrResponseText(runId, scenario)),
  };
}

function normalizeProviderForRuntime(runtime: RuntimeName, raw: string): ProviderName {
  const provider = raw.trim().toLowerCase();
  if (!provider) return 'tmux';
  if (runtime === 'codex') {
    if (provider === 'sdk' || provider === 'tmux') return provider;
    throw new Error(`Invalid Codex provider "${raw}". Expected sdk or tmux.`);
  }
  if (runtime === 'kimi') {
    if (provider === 'tmux') return provider;
    throw new Error(`Invalid Kimi provider "${raw}". Expected tmux.`);
  }
  if (runtime === 'cursor') {
    if (provider === 'tmux') return provider;
    throw new Error(`Invalid Cursor provider "${raw}". Expected tmux.`);
  }
  if (provider === 'sdk' || provider === 'tmux') return provider;
  throw new Error(`Invalid Claude provider "${raw}". Expected sdk or tmux.`);
}

function printUsage(): void {
  process.stdout.write([
    'Usage:',
    '  CODELARK_REAL_FEISHU_E2E=1 node --import tsx scripts/real-feishu-e2e.ts --launch-bridge [options]',
    '',
    'Options:',
    '  --dry-run                 Print planned lark-cli commands without sending messages',
    '  --dump-only               Only collect bridge dump state',
    '  --list-scenarios          Print scenario names and coverage metadata as JSON',
    '  --coverage-matrix         Print scenario/test-name coverage matrix and scan report evidence',
    '  --reports-dir <path>      Report directory for --coverage-matrix; default work/real-feishu',
    '  --require-canonical <scope> With --coverage-matrix, fail unless canonical coverage exists; scope kimi|kimi-current',
    '  --stop-test-bridge        Stop a previous isolated real Feishu E2E bridge for --run-root/--clk-home',
    '  --launch-bridge           Start a test-only bridge child process with an isolated CODELARK_HOME',
    `  --test-env-file <path>     Load CODELARK_REAL_FEISHU_TEST_* values from a private test env file; default ${defaultRealFeishuTestEnvFile()}`,
    '  When --chat-id is omitted, the harness creates the initial test group through the product /new use case.',
    '  --fake-ccr                Run true ccr/Claude Code against a local fake OpenAI-compatible backend',
    '  --fake-ccr-response <txt> Expected fake backend response text',
    '  --scripted-basic-dialogue Run basic-dialogue through isolated Codex Responses/CCR proxies, not direct provider injection',
    '  --scripted-kimi           Replace only the Kimi executable with a deterministic wire producer; valid for Kimi tmux runtime-message E2E',
    '  --keep-clk-home           Keep the temporary CODELARK_HOME after the run; default cleans it',
    '  --run-root <path>          Parent directory for ccr/codex/codelark test homes; default /tmp/clk-real-feishu-<run-id>',
    '  --clk-home <path>          CODELARK_HOME for the launched/dumped test bridge',
    '  --runtime-home <path>      HOME for the launched bridge child; default <clk-home>/runtime-home; KIMI_CODE_HOME is <runtime-home>/.kimi-code',
    '  --codex-home <path>        CODEX_HOME for the launched bridge child; default <clk-home>/codex-home',
    '  --claude-home <path>       CODELARK_CLAUDE_HOME for Claude JSONL mirror; default runtime home',
    '  --claude-executable <cmd>  ccr|claude for Claude runtime; default ccr',
    '  --test-feishu-app-id <cli_>     Test Feishu app id; env CODELARK_REAL_FEISHU_TEST_APP_ID is preferred',
    '  --test-feishu-app-secret <sec>  Test Feishu app secret; prefer --test-env-file or CODELARK_REAL_FEISHU_TEST_APP_SECRET to avoid shell/npm echo',
    '  --test-user-access-token <u-...> Optional current bridge app user access token for deleting user-owned test groups',
    '  --test-lark-cli-config-dir <dir> Optional lark-cli config dir used for user-side send/read/create/delete actions',
    '  --test-lark-cli-xdg-data-home <dir> Optional XDG_DATA_HOME used for user-side lark-cli auth tokens',
    '  --feishu-site <site>       feishu|lark, default feishu',
    '  --lark-profile <name>      Optional lark-cli profile for user identity',
    '  --test-bot-open-id <ou_>        Optional bot open_id for structured cloud document mention comments',
    '  --scenario <name>          runtime-message|basic-dialogue-suite|command-state|session-management|history-boundaries|history-attachments|history-empty-isolation|history-long-truncation|history-suite|card-forms|agent-question-forms|markdown-rendering|doc-as-chat-from-scratch|message-only|require-at-toggle',
    '  --commands <list>          Extra commands to run before the final message; JSON array or ;; separated',
    '  --chat-id <oc_>            Existing real test group; skips /new creation',
    '  --runtime <claude|codex|kimi|cursor> Runtime to validate after group creation',
    '  --cursor-model <model>    Cursor model for the isolated bridge; default gpt-5.3-codex',
    '  --provider <name>          Codex/Claude: sdk|tmux; Kimi/Cursor: tmux. Default tmux.',
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
      `${scenario.testNamePrefix}::codex-tmux`,
      `${scenario.testNamePrefix}::claude-sdk`,
      `${scenario.testNamePrefix}::claude-tmux`,
      `${scenario.testNamePrefix}::kimi-tmux`,
      `${scenario.testNamePrefix}::cursor-tmux`,
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
        ? name.endsWith('::claude-tmux')
        : name.endsWith('::codex-tmux')
    )) || null,
    matrix,
    matrixCompanions: matrix.filter((name) => name !== runtimeTestName),
    unitCoverage: scenario.unitCoverage,
    e2eCoverage: scenario.e2eCoverage,
    coverageNotes: [
      scenario.providerCoverage === 'runtime-parameterized'
        ? '该场景需要覆盖 codex-sdk、codex-tmux、claude-sdk、claude-tmux、kimi-tmux、cursor-tmux 六条路径，才能形成完整 runtime/provider 矩阵证据。'
        : scenario.providerCoverage === 'representative-provider'
        ? '该功能簇场景默认只要求代表 provider 路径；provider smoke matrix 负责完整 runtime/provider 健康检查。'
        : scenario.providerCoverage === 'cross-provider-suite'
        ? '该场景在同一会话中按固定 runtime/provider 顺序切换，用一条长对话验证 provider 独立性和无污染。'
        : '该场景验证与具体 runtime provider 无关的 bridge 行为。',
      scenario.coverageTier === 'mandatory-suite'
        ? 'mandatory-suite：最高优先级真实飞书集成测试，必须优先维护。'
        : scenario.coverageTier === 'representative-suite'
        ? 'representative-suite：高信息量用户流程；是否进入完整 runtime/provider 矩阵由 providerCoverage 决定。'
        : scenario.coverageTier === 'legacy-transitional-evidence'
        ? 'legacy/transitional evidence：保留历史报告和局部回归价值，但不再作为后续补齐 full matrix 的主线。'
        : scenario.coverageTier === 'runtime-compressed-command-check'
        ? 'runtime-compressed command check：后续命令类覆盖应按 Codex/Claude/Kimi/Cursor runtime 压缩，tmux 命令族额外覆盖各 tmux runtime。'
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
    requiresRuntimeOutput: scenario.requiresRuntimeOutput !== false,
    ...(scenario.providerSequence ? { providerSequence: scenario.providerSequence } : {}),
    providerMatrix: providerMatrixForScenario(scenario),
    unitCoverage: scenario.unitCoverage,
    e2eCoverage: scenario.e2eCoverage,
  }));
}

function parseRuntimeProviderFromTestName(testName: string): { runtime?: RuntimeName; provider?: ProviderName } {
  const suffix = testName.split('::').pop() || '';
  const [runtime, provider] = suffix.split('-');
  if ((runtime === 'codex' || runtime === 'claude' || runtime === 'kimi' || runtime === 'cursor')
    && (provider === 'sdk' || provider === 'tmux')) {
    return { runtime, provider };
  }
  return {};
}

function coverageEntriesForScenario(scenario: ScenarioDefinition): Omit<CoverageMatrixEntry, 'evidence'>[] {
  if (scenario.providerCoverage === 'runtime-neutral') {
    const matchingTestNames = ['codex', 'claude', 'kimi', 'cursor'].map((runtime) => `${scenario.testNamePrefix}::${runtime}`);
    return [{
      scenario: scenario.name,
      testName: `${scenario.testNamePrefix}::runtime-neutral`,
      matchingTestNames,
      providerCoverage: scenario.providerCoverage,
      coverageTier: scenario.coverageTier,
      includesKimi: false,
      unitCoverage: scenario.unitCoverage,
      e2eCoverage: scenario.e2eCoverage,
    }];
  }
  return providerMatrixForScenario(scenario).map((testName) => {
    const parsed = parseRuntimeProviderFromTestName(testName);
    return {
      scenario: scenario.name,
      testName,
      matchingTestNames: [testName],
      providerCoverage: scenario.providerCoverage,
      coverageTier: scenario.coverageTier,
      includesKimi: parsed.runtime === 'kimi' || Boolean(scenario.providerSequence?.includes('kimi-tmux')),
      ...(parsed.runtime ? { runtime: parsed.runtime } : {}),
      ...(parsed.provider ? { provider: parsed.provider } : {}),
      unitCoverage: scenario.unitCoverage,
      e2eCoverage: scenario.e2eCoverage,
    };
  });
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function reportTestName(report: Record<string, unknown>): string {
  const coverage = safeObject(report.coverage);
  if (typeof coverage.testName === 'string') return coverage.testName;
  if (typeof report.testName === 'string') return report.testName;
  const scenario = typeof report.scenario === 'string' ? report.scenario : '';
  const runtime = typeof report.runtime === 'string' ? report.runtime : '';
  const provider = typeof report.provider === 'string' ? report.provider : '';
  return scenario && runtime && provider ? `real-feishu::${scenario}::${runtime}-${provider}` : '';
}

function reportCheckValue(report: Record<string, unknown>, checkName: string): boolean | null {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const check = checks.map(safeObject).find((item) => item.name === checkName);
  if (!check) return null;
  return check.ok === true;
}

function reportChecksByName(report: Record<string, unknown>): Map<string, boolean> {
  const checks = new Map<string, boolean>();
  for (const raw of Array.isArray(report.checks) ? report.checks : []) {
    const check = safeObject(raw);
    const name = typeof check.name === 'string' ? check.name : '';
    if (!name) continue;
    const ok = check.ok === true;
    checks.set(name, checks.get(name) === false ? false : ok);
  }
  for (const raw of Array.isArray(report.failedChecks) ? report.failedChecks : []) {
    const check = safeObject(raw);
    const name = typeof check.name === 'string' ? check.name : '';
    if (name) checks.set(name, false);
  }
  return checks;
}

function failedReportCheckNames(report: Record<string, unknown>): string[] {
  return [...reportChecksByName(report).entries()]
    .filter(([, ok]) => ok !== true)
    .map(([name]) => name);
}

function scenarioFromReport(report: Record<string, unknown>): string {
  if (typeof report.scenario === 'string' && report.scenario) return report.scenario;
  const testName = reportTestName(report);
  const match = testName.match(/^real-feishu::([^:]+)::/);
  return match?.[1] || '';
}

function providerSuffixFromReport(report: Record<string, unknown>): string {
  const testName = reportTestName(report);
  const match = testName.match(/^real-feishu::[^:]+::(.+)$/);
  return match?.[1] || '';
}

function canonicalRequiredCheckNamesForParts(scenario: string, providerSuffix: string): string[] {
  const required = new Set<string>([
    'canonical_report_eligible',
    'message_observations_passed',
    'final_feishu_transcript_present',
    'coverage_metadata_present',
    'created_chat_cleanup_completed',
    'scenario_created_chat_cleanup_completed',
    'scenario_created_chat_names_match_requests',
    'required_checks_passed',
    'unexpected_mirror_absent',
  ]);

  if (providerSuffix === 'kimi-tmux') {
    required.add('runtime_identity_bound');
    required.add('kimi_wire_jsonl_found');
    required.add('provider_output_path');
    required.add('mirror_final_not_duplicated_in_direct_reply');
  }

  if (providerSuffix === 'claude-tmux') {
    required.add('runtime_identity_bound');
    required.add('claude_jsonl_found');
    required.add('provider_output_path');
    required.add('mirror_final_not_duplicated_in_direct_reply');
  }

  if (providerSuffix === 'cursor-tmux') {
    required.add('runtime_identity_bound');
    required.add('cursor_transcript_found');
    required.add('provider_output_path');
    if (scenario === 'runtime-message') required.add('cursor_stream_card_unified_ui');
  }

  if (
    providerSuffix === 'kimi-tmux'
    && [
      'command-state',
      'session-management',
      'history-suite',
      'markdown-rendering',
    ].includes(scenario)
  ) {
    required.add('runtime_prompt_final_transcript_marker');
  }

  if (scenario === 'command-state') {
    required.add('command_state_runtime_settings_transcript');
    required.add('command_state_file_and_large_file_transcript');
  }
  if (scenario === 'session-management') {
    required.add('session_management_runtime_identity_transcript');
  }
  if (scenario === 'history-suite') {
    required.add('history_suite_transcript_contract');
  }
  if (scenario === 'agent-question-forms') {
    required.add('agent_question_form_interactive_transcript');
  }
  if (scenario === 'markdown-rendering') {
    required.add('markdown_rendering_transcript_structure');
  }
  if (scenario === 'basic-dialogue-suite') {
    required.add('basic_dialogue_stream_card_checkpoints');
    required.add('basic_dialogue_terminal_append_input_delivered');
    required.add('basic_dialogue_scripted_kimi_lifecycle_and_ctrl_s');
    required.add('basic_dialogue_kimi_runtime_slot_persisted');
    required.add('basic_dialogue_kimi_wire_transcript_read');
    required.add('basic_dialogue_kimi_history_transcript_excludes_thinking');
    required.add('basic_dialogue_kimi_thinking_status_only');
    required.add('basic_dialogue_kimi_tool_card');
  }

  return [...required];
}

function canonicalRequiredCheckNames(report: Record<string, unknown>): string[] {
  return canonicalRequiredCheckNamesForParts(
    scenarioFromReport(report),
    providerSuffixFromReport(report),
  );
}

function canonicalRequiredCheckNamesForEntry(entry: CoverageMatrixEntry): string[] {
  const providerSuffix = entry.runtime && entry.provider
    ? `${entry.runtime}-${entry.provider}`
    : entry.testName.replace(/^real-feishu::[^:]+::/, '');
  return canonicalRequiredCheckNamesForParts(entry.scenario, providerSuffix);
}

function reportEvidenceStatus(filePath: string, report: Record<string, unknown>): CoverageEvidence {
  const checksByName = reportChecksByName(report);
  const failedChecks = failedReportCheckNames(report);
  const canonicalEligibility = safeObject(report.canonicalEligibility);
  const canonicalEligible = typeof canonicalEligibility.eligible === 'boolean'
    ? canonicalEligibility.eligible
    : undefined;
  const canonicalReportCheck = reportCheckValue(report, 'canonical_report_eligible');
  const missingCanonicalChecks = canonicalRequiredCheckNames(report)
    .filter((name) => checksByName.get(name) !== true);
  const isFailure = filePath.endsWith('.failure.json') || failedChecks.length > 0;
  const dryRun = report.dryRun === true;
  const base: CoverageEvidence = {
    status: 'none',
    reportPath: filePath,
    reportMtimeMs: fs.statSync(filePath).mtimeMs,
    ...(typeof report.runId === 'string' ? { runId: report.runId } : {}),
    dryRun,
    ...(failedChecks.length > 0 ? { failedChecks } : {}),
    ...(canonicalEligible !== undefined ? { canonicalEligible } : {}),
    ...(canonicalEligibility.blockers !== undefined ? { canonicalBlockers: stringArray(canonicalEligibility.blockers) } : {}),
    canonicalReportCheck,
    ...(missingCanonicalChecks.length > 0 ? { missingCanonicalChecks } : {}),
  };
  if (isFailure) return { ...base, status: 'diagnostic-failure' };
  if (dryRun) return { ...base, status: 'dry-run' };
  if (canonicalEligible === false) return { ...base, status: 'diagnostic-pass' };
  if (canonicalEligible === true && missingCanonicalChecks.length === 0) return { ...base, status: 'canonical-pass' };
  if (canonicalEligible === true) return { ...base, status: 'diagnostic-pass' };
  return { ...base, status: 'legacy-pass' };
}

function isCoverageEvidenceCandidate(report: Record<string, unknown>): boolean {
  return report.coverage !== undefined
    || report.runId !== undefined
    || report.dryRun !== undefined
    || report.canonicalEligibility !== undefined
    || report.checks !== undefined
    || report.failedChecks !== undefined;
}

function evidencePriority(status: CoverageEvidenceStatus): number {
  switch (status) {
    case 'canonical-pass': return 5;
    case 'legacy-pass': return 4;
    case 'diagnostic-pass': return 3;
    case 'diagnostic-failure': return 2;
    case 'dry-run': return 1;
    case 'none': return 0;
  }
}

function strongerEvidence(a: CoverageEvidence, b: CoverageEvidence): CoverageEvidence {
  const aPriority = evidencePriority(a.status);
  const bPriority = evidencePriority(b.status);
  if (bPriority !== aPriority) return bPriority > aPriority ? b : a;
  return (b.reportMtimeMs ?? -1) > (a.reportMtimeMs ?? -1) ? b : a;
}

function isCurrentKimiMatrixEntry(entry: CoverageMatrixEntry): boolean {
  return entry.includesKimi && entry.coverageTier !== 'legacy-transitional-evidence';
}

function isCurrentMatrixEntry(entry: CoverageMatrixEntry): boolean {
  return entry.coverageTier !== 'legacy-transitional-evidence';
}

function isTmuxMatrixEntry(entry: CoverageMatrixEntry): boolean {
  return entry.provider === 'tmux';
}

function isTmuxOrRuntimeNeutralMatrixEntry(entry: CoverageMatrixEntry): boolean {
  return isTmuxMatrixEntry(entry) || entry.providerCoverage === 'runtime-neutral';
}

function isCardFrontendMatrixEntry(entry: CoverageMatrixEntry): boolean {
  return [
    'basic-dialogue-suite',
    'command-state',
    'session-management',
    'card-forms',
    'agent-question-forms',
    'markdown-rendering',
  ].includes(entry.scenario);
}

function percent(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function coverageRateBucket(entries: CoverageMatrixEntry[]): CoverageRateBucket {
  const canonicalPass = entries.filter((entry) => entry.evidence.status === 'canonical-pass').length;
  const legacyPass = entries.filter((entry) => entry.evidence.status === 'legacy-pass').length;
  const diagnosticPass = entries.filter((entry) => entry.evidence.status === 'diagnostic-pass').length;
  const diagnosticFailure = entries.filter((entry) => entry.evidence.status === 'diagnostic-failure').length;
  const dryRun = entries.filter((entry) => entry.evidence.status === 'dry-run').length;
  const plannedOnly = entries.filter((entry) => entry.evidence.status === 'none').length;
  const total = entries.length;
  const executed = total - plannedOnly;
  return {
    total,
    canonicalPass,
    legacyPass,
    diagnosticPass,
    diagnosticFailure,
    dryRun,
    plannedOnly,
    executed,
    canonicalPercent: percent(canonicalPass, total),
    executedPercent: percent(executed, total),
  };
}

function coverageRateSummary(entries: CoverageMatrixEntry[]): CoverageRateSummary {
  const currentEntries = entries.filter(isCurrentMatrixEntry);
  const tmuxEntries = entries.filter(isTmuxMatrixEntry);
  const currentTmuxEntries = currentEntries.filter(isTmuxMatrixEntry);
  const kimiEntries = entries.filter((entry) => entry.includesKimi);
  const kimiCurrentEntries = entries.filter(isCurrentKimiMatrixEntry);
  const cardFrontendEntries = currentEntries.filter(isCardFrontendMatrixEntry);
  const cardFrontendTmuxEntries = cardFrontendEntries.filter(isTmuxOrRuntimeNeutralMatrixEntry);
  return {
    all: coverageRateBucket(entries),
    current: coverageRateBucket(currentEntries),
    tmux: coverageRateBucket(tmuxEntries),
    currentTmux: coverageRateBucket(currentTmuxEntries),
    kimi: coverageRateBucket(kimiEntries),
    kimiCurrent: coverageRateBucket(kimiCurrentEntries),
    kimiCurrentTmux: coverageRateBucket(kimiCurrentEntries.filter(isTmuxMatrixEntry)),
    cardFrontend: coverageRateBucket(cardFrontendEntries),
    cardFrontendTmux: coverageRateBucket(cardFrontendTmuxEntries),
  };
}

function scanCoverageEvidence(reportsDir: string): {
  evidenceByTestName: Map<string, CoverageEvidence>;
  unmatchedReports: CoverageEvidence[];
} {
  const evidenceByTestName = new Map<string, CoverageEvidence>();
  const unmatchedReports: CoverageEvidence[] = [];
  if (!fs.existsSync(reportsDir)) return { evidenceByTestName, unmatchedReports };
  for (const entry of fs.readdirSync(reportsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const reportPath = path.join(reportsDir, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    } catch {
      continue;
    }
    const report = safeObject(parsed);
    if (!isCoverageEvidenceCandidate(report)) continue;
    const evidence = reportEvidenceStatus(reportPath, report);
    const testName = reportTestName(report);
    if (!testName) {
      unmatchedReports.push(evidence);
      continue;
    }
    evidenceByTestName.set(testName, strongerEvidence(
      evidenceByTestName.get(testName) || { status: 'none' },
      evidence,
    ));
  }
  return { evidenceByTestName, unmatchedReports };
}

function coverageGapForEntry(entry: CoverageMatrixEntry): CoverageMatrixGap {
  const missingCanonicalChecks = entry.evidence.missingCanonicalChecks?.length
    ? entry.evidence.missingCanonicalChecks
    : entry.evidence.status === 'none'
    ? canonicalRequiredCheckNamesForEntry(entry)
    : [];
  return {
    scenario: entry.scenario,
    testName: entry.testName,
    coverageTier: entry.coverageTier,
    evidenceStatus: entry.evidence.status,
    ...(entry.evidence.reportPath ? { reportPath: entry.evidence.reportPath } : {}),
    ...(entry.evidence.runId ? { runId: entry.evidence.runId } : {}),
    ...(entry.evidence.failedChecks?.length ? { failedChecks: entry.evidence.failedChecks } : {}),
    ...(missingCanonicalChecks.length ? { missingCanonicalChecks } : {}),
  };
}

function coverageMatrix(options: CliOptions): CoverageMatrixReport {
  const reportsDir = path.resolve(options.reportsDir);
  const { evidenceByTestName, unmatchedReports } = scanCoverageEvidence(reportsDir);
  const entries: CoverageMatrixEntry[] = SCENARIOS.flatMap(coverageEntriesForScenario)
    .map((entry) => {
      const evidence = entry.matchingTestNames.reduce<CoverageEvidence>((best, testName) => (
        strongerEvidence(best, evidenceByTestName.get(testName) || { status: 'none' })
      ), { status: 'none' });
      return { ...entry, evidence };
    });
  const statusCount = entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.evidence.status] = (acc[entry.evidence.status] || 0) + 1;
    return acc;
  }, {});
  const kimiEntries = entries.filter((entry) => entry.includesKimi);
  const kimiCurrentEntries = entries.filter(isCurrentKimiMatrixEntry);
  return {
    reportDir: reportsDir,
    scenarios: SCENARIOS.length,
    summary: {
      matrixEntries: entries.length,
      kimiEntries: kimiEntries.length,
      canonicalPass: statusCount['canonical-pass'] || 0,
      legacyPass: statusCount['legacy-pass'] || 0,
      diagnosticPass: statusCount['diagnostic-pass'] || 0,
      diagnosticFailure: statusCount['diagnostic-failure'] || 0,
      dryRun: statusCount['dry-run'] || 0,
      plannedOnly: statusCount.none || 0,
      unmatchedReports: unmatchedReports.length,
      unmatchedFailures: unmatchedReports.filter((report) => report.status === 'diagnostic-failure').length,
      kimiCanonicalPass: kimiEntries.filter((entry) => entry.evidence.status === 'canonical-pass').length,
      kimiLegacyPass: kimiEntries.filter((entry) => entry.evidence.status === 'legacy-pass').length,
      kimiDiagnosticFailure: kimiEntries.filter((entry) => entry.evidence.status === 'diagnostic-failure').length,
      kimiDryRun: kimiEntries.filter((entry) => entry.evidence.status === 'dry-run').length,
      kimiPlannedOnly: kimiEntries.filter((entry) => entry.evidence.status === 'none').length,
      kimiCurrentEntries: kimiCurrentEntries.length,
      kimiCurrentCanonicalPass: kimiCurrentEntries.filter((entry) => entry.evidence.status === 'canonical-pass').length,
      kimiCurrentDiagnosticFailure: kimiCurrentEntries.filter((entry) => entry.evidence.status === 'diagnostic-failure').length,
      kimiCurrentDryRun: kimiCurrentEntries.filter((entry) => entry.evidence.status === 'dry-run').length,
      kimiCurrentPlannedOnly: kimiCurrentEntries.filter((entry) => entry.evidence.status === 'none').length,
    },
    coverageRates: coverageRateSummary(entries),
    entries,
    unmatchedReports,
    kimiGaps: kimiEntries
      .filter((entry) => entry.evidence.status !== 'canonical-pass')
      .map(coverageGapForEntry),
    kimiCurrentGaps: kimiCurrentEntries
      .filter((entry) => entry.evidence.status !== 'canonical-pass')
      .map(coverageGapForEntry),
  };
}

function enforceCoverageMatrixRequirements(options: CliOptions, matrix: CoverageMatrixReport): void {
  if (!options.requireCanonicalCoverage) return;
  const gaps = options.requireCanonicalCoverage === 'kimi-current'
    ? matrix.kimiCurrentGaps
    : matrix.kimiGaps;
  if (gaps.length === 0) return;
  throw new Error([
    `Kimi canonical coverage requirement failed for scope ${options.requireCanonicalCoverage}.`,
    `missing=${gaps.length}`,
    `gaps=${gaps.map((gap) => `${gap.testName}:${gap.evidenceStatus}`).join(', ')}`,
  ].join(' '));
}

function requireRealGuard(options: CliOptions): void {
  if (options.dryRun || options.dumpOnly || options.listScenarios || options.coverageMatrix || options.stopTestBridge) return;
  if (process.env.CODELARK_REAL_FEISHU_E2E !== '1') {
    throw new Error('Refusing to send real Feishu messages without CODELARK_REAL_FEISHU_E2E=1. Use --dry-run to inspect commands.');
  }
  if (!options.launchBridge) {
    throw new Error([
      'Refusing to run real Feishu E2E without --launch-bridge.',
      'Real Feishu E2E must launch an isolated bridge with isolated CODELARK_HOME, HOME, CODEX_HOME, CODELARK_CLAUDE_HOME, and KIMI_CODE_HOME.',
      'Do not drive the currently running live bridge; use --dry-run to inspect a plan without sending messages.',
    ].join(' '));
  }
  if (usesFakeCcrBackend(options) && !options.launchBridge) {
    throw new Error([
      'Refusing to use fake CCR/basic-dialogue proxy mode without --launch-bridge.',
      'The fake CCR backend and .claude-code-router config are only injected into an isolated bridge launched by this harness.',
      'Use --launch-bridge with test Feishu app credentials so the harness controls the runtime environment.',
    ].join(' '));
  }
  if (options.scriptedBasicDialogue && !options.launchBridge) {
    throw new Error([
      'Refusing to use --scripted-basic-dialogue without --launch-bridge.',
      'The deterministic basic-dialogue proxies are injected into the isolated bridge child through HOME/CODEX_HOME/CCR proxy environment.',
    ].join(' '));
  }
  if (options.scriptedKimi && !options.launchBridge) {
    throw new Error([
      'Refusing to use --scripted-kimi without --launch-bridge.',
      'The deterministic Kimi executable may only run inside the isolated bridge environment.',
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

function validateScriptedKimiOptions(options: CliOptions): void {
  if (!options.scriptedKimi) return;
  if (options.scenario !== 'runtime-message' || options.runtime !== 'kimi' || options.provider !== 'tmux') {
    throw new Error('--scripted-kimi is only valid with --scenario runtime-message --runtime kimi --provider tmux.');
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

function runningProcessCodelarkHomes(): string[] {
  if (process.platform !== 'linux') return [];
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  const homes = new Set<string>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environ = fs.readFileSync(path.join('/proc', entry, 'environ'), 'utf-8');
      for (const item of environ.split('\0')) {
        if (!item.startsWith('CODELARK_HOME=')) continue;
        const value = item.slice('CODELARK_HOME='.length).trim();
        if (value) homes.add(path.resolve(value));
      }
    } catch {
      // Other users' process environments may be unreadable.
    }
  }
  return [...homes];
}

function assertNoLiveBridgeUsingSameApp(options: CliOptions): void {
  if (options.dryRun || options.dumpOnly || !options.launchBridge) return;
  const candidateHomes = new Set<string>([
    defaultCodelarkHome(),
    path.join(os.homedir(), '.codelark'),
  ].map((candidate) => path.resolve(candidate)));
  for (const baseHome of [...candidateHomes]) {
    const parent = path.dirname(baseHome);
    try {
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name !== '.codelark' && !entry.name.startsWith('.codelark-')) continue;
        candidateHomes.add(path.resolve(parent, entry.name));
      }
    } catch {
      // A missing or unreadable sibling directory cannot own a local bridge.
    }
  }
  for (const processHome of runningProcessCodelarkHomes()) candidateHomes.add(processHome);

  const testHome = path.resolve(options.codelarkHome);
  const conflicts = [...candidateHomes].flatMap((liveCodelarkHome) => {
    if (liveCodelarkHome === testHome) return [];
    const status = readJsonIfExists<{ running?: boolean; pid?: number; channels?: string[] }>(
      path.join(liveCodelarkHome, 'runtime', 'status.json'),
      {},
    );
    if (!status.running || !isPidAlive(status.pid)) return [];
    try {
      if (!listConfiguredFeishuAppIds(liveCodelarkHome).includes(options.testFeishuAppId)) return [];
    } catch {
      return [];
    }
    return [{
      codelarkHome: liveCodelarkHome,
      pid: status.pid!,
      channels: status.channels || [],
    }];
  });
  if (conflicts.length === 0) return;

  const conflictDetails = conflicts.flatMap((conflict, index) => {
    const suffix = conflicts.length > 1 ? `_${index + 1}` : '';
    return [
      `live_clk_home${suffix}=${conflict.codelarkHome}`,
      `live_pid${suffix}=${conflict.pid}`,
      `live_channels${suffix}=${conflict.channels.join(',') || '-'}`,
    ];
  });

  throw new Error([
    `Refusing to launch a second bridge for Feishu test app ${options.testFeishuAppId}.`,
    `live_bridge_count=${conflicts.length}`,
    ...conflictDetails,
    `test_clk_home=${options.codelarkHome}`,
    'Feishu long-connection events are load-balanced, not broadcast; two bridge clients using one app split inbound messages at random.',
    'Use the separate test Feishu app, or stop/switch the live bridge first.',
  ].join('\n'));
}

function acquireAppLock(options: CliOptions): AppLock | null {
  if (options.dryRun || options.dumpOnly || !options.launchBridge) return null;
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
      'Stop the other test before launching another bridge for the same app.',
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
      return typeof name === 'string' && isProviderOwnedTmuxSessionName(name.trim()) ? name.trim() : '';
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
    for (const sessionName of findProviderOwnedTmuxSessionNames(content)) {
      tmuxSessionNames.add(sessionName);
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

function isProviderOwnedTmuxSessionName(value: string): boolean {
  return /^(?:codex_[0-9a-f-]{20,}|claude_[A-Za-z0-9_-]{8,}|clk-kimi-[A-Za-z0-9_-]{8,}|clk-cursor-[A-Za-z0-9_-]{8,})$/.test(value);
}

function findProviderOwnedTmuxSessionNames(content: string): string[] {
  const names = new Set<string>();
  const pattern = /(?:^|[^A-Za-z0-9_-])((?:codex_[0-9a-f-]{20,}|claude_[A-Za-z0-9_-]{8,}|clk-kimi-[A-Za-z0-9_-]{8,}|clk-cursor-[A-Za-z0-9_-]{8,}))(?![A-Za-z0-9_-])/g;
  for (const match of content.matchAll(pattern)) {
    names.add(match[1]);
  }
  return [...names];
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

function copyDirectoryIfExists(sourcePath: string, targetPath: string): boolean {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return false;
  if (!fs.statSync(sourcePath).isDirectory()) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: true });
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

function copyHostKimiConfig(hostHome: string, kimiHome: string): boolean {
  const hostKimiHome = process.env.CODELARK_REAL_FEISHU_TEST_KIMI_HOME
    || path.join(hostHome, '.kimi-code');
  const hadAuth = hasKimiAuthConfig(kimiHome);
  const copiedCredentials = copyDirectoryIfExists(
    path.join(hostKimiHome, 'credentials'),
    path.join(kimiHome, 'credentials'),
  );
  const copiedOauth = copyDirectoryIfExists(
    path.join(hostKimiHome, 'oauth'),
    path.join(kimiHome, 'oauth'),
  );
  for (const relativePath of [
    'config.toml',
    'tui.toml',
    'device_id',
  ]) {
    copyFileIfExists(path.join(hostKimiHome, relativePath), path.join(kimiHome, relativePath));
  }
  const copied = copiedCredentials || copiedOauth;
  if (copied) {
    process.stderr.write(`[real-feishu-e2e] Copied host Kimi auth/config into isolated KIMI_CODE_HOME=${kimiHome}\n`);
  }
  return hadAuth || hasKimiAuthConfig(kimiHome);
}

function hasKimiAuthConfig(kimiHome: string): boolean {
  return fs.existsSync(path.join(kimiHome, 'credentials'))
    || fs.existsSync(path.join(kimiHome, 'oauth'));
}

function hostKimiExecutablePath(): string {
  return path.join(os.homedir(), '.kimi-code', 'bin', 'kimi');
}

function kimiExecutableEnv(): Record<string, string> {
  const explicit = process.env.CODELARK_KIMI_EXECUTABLE || process.env.KIMI_CODE_EXECUTABLE || '';
  if (explicit) return { CODELARK_KIMI_EXECUTABLE: explicit };
  const hostBin = hostKimiExecutablePath();
  return fs.existsSync(hostBin) ? { CODELARK_KIMI_EXECUTABLE: hostBin } : {};
}

function resolveKimiExecutableSource(): RuntimeEnvironmentPlan['kimiExecutableSource'] {
  if (process.env.CODELARK_KIMI_EXECUTABLE || process.env.KIMI_CODE_EXECUTABLE) return 'env-executable';
  if (fs.existsSync(hostKimiExecutablePath())) return 'host-home-bin';
  return 'path';
}

function copyHostCursorConfig(hostHome: string, cursorConfigDir: string): boolean {
  const copied = copyFileIfExists(
    path.join(hostHome, '.cursor', 'cli-config.json'),
    path.join(cursorConfigDir, 'cli-config.json'),
  );
  return copied || fs.existsSync(path.join(cursorConfigDir, 'cli-config.json'));
}

function resolveCursorExecutablePath(): string | undefined {
  const explicit = process.env.CURSOR_AGENT_EXECUTABLE || process.env.CODELARK_CURSOR_EXECUTABLE;
  if (explicit?.trim()) return explicit.trim();
  const hostBin = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'agent.exe' : 'agent');
  if (fs.existsSync(hostBin)) return hostBin;
  return undefined;
}

function resolveCursorExecutableSource(): RuntimeEnvironmentPlan['cursorExecutableSource'] {
  if (process.env.CURSOR_AGENT_EXECUTABLE || process.env.CODELARK_CURSOR_EXECUTABLE) return 'env-executable';
  return resolveCursorExecutablePath() ? 'host-home-bin' : 'path';
}

function scriptedKimiSessionId(options: CliOptions): string {
  const token = runIdToken(options.runId).toLowerCase().replace(/_/g, '-');
  return `session_${token}-scripted`;
}

function writeScriptedKimiExecutable(options: CliOptions): string {
  const binDir = path.join(options.runRoot, 'bin');
  const executablePath = path.join(binDir, 'kimi');
  const scriptPath = path.join(binDir, 'scripted-kimi.cjs');
  const sessionId = scriptedKimiSessionId(options);
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const fallbackSessionId = ${JSON.stringify(sessionId)};
const kimiHome = process.env.KIMI_CODE_HOME;
if (!kimiHome) {
  process.stderr.write('KIMI_CODE_HOME is required\\n');
  process.exit(2);
}

const launchLogPath = path.join(kimiHome, 'scripted-kimi-launches.jsonl');
const keyLogPath = path.join(kimiHome, 'scripted-kimi-keys.log');
const resumeIndex = process.argv.indexOf('-r');
const resumed = resumeIndex >= 0 && Boolean(process.argv[resumeIndex + 1]);
const sessionId = resumed ? process.argv[resumeIndex + 1] : fallbackSessionId;
const sessionDir = path.join(kimiHome, 'sessions', 'wd_real-feishu-basic-dialogue', sessionId);
const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');

fs.mkdirSync(path.dirname(wirePath), { recursive: true });
fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  title: 'Scripted Kimi basic-dialogue',
  lastPrompt: 'scripted basic-dialogue kimi',
}, null, 2) + '\\n');
fs.writeFileSync(wirePath, '', { flag: 'a' });
fs.appendFileSync(path.join(kimiHome, 'session_index.jsonl'), JSON.stringify({
  sessionId,
  sessionDir,
  workDir: process.cwd(),
}) + '\\n');
fs.appendFileSync(launchLogPath, JSON.stringify({ argv: process.argv.slice(2), resumed, cwd: process.cwd() }) + '\\n');

process.stdout.write('Kimi Code scripted real Feishu E2E\\n');
process.stdout.write('Session: ' + sessionId + '\\n');
process.stdout.write('│ > \\ncontext: 0% (0/256k)\\n');
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();

let buffer = '';
let answered = false;
let ctrlCCount = 0;

function appendWire(entry) {
  fs.appendFileSync(wirePath, JSON.stringify(entry) + '\\n');
}

function visiblePrompt(text) {
  return text
    .replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/g, '');
}

function markerFromPrompt(text) {
  const match = text.match(/\\bCODELARK_[A-Z0-9_]+\\b/u);
  return match ? match[0] : 'CODELARK_SCRIPTED_KIMI_TMUX';
}

function providerKeyFromMarker(marker) {
  const suffix = (marker.match(/_(KIMI_TMUX)$/u) || [])[1] || 'KIMI_TMUX';
  return suffix.toLowerCase().replace(/_/g, '-');
}

const longTypeScriptPath = 'src/features/tool-card-preview/this-is-a-deliberately-long-typescript-fixture-for-title-budget.ts';

function answerOnce() {
  if (answered) return;
  answered = true;
  const prompt = visiblePrompt(buffer);
  const marker = markerFromPrompt(prompt);
  const providerKey = providerKeyFromMarker(marker);
  const now = Date.now();
  appendWire({ type: 'context.append_loop_event', time: now, event: { type: 'step.begin', turnId: 'turn-scripted-kimi', stepUuid: 'step-scripted-kimi' } });
  appendWire({ type: 'context.append_loop_event', time: now + 1, event: { type: 'content.part', turnId: 'turn-scripted-kimi', part: { type: 'think', think: 'scripted Kimi thinking for ' + marker } } });
  const patchLines = ['*** Begin Patch', '*** Update File: ' + longTypeScriptPath, '@@'];
  for (let index = 1; index <= 100; index += 1) patchLines.push('+export const fixtureLine' + index + ' = ' + index + ';');
  patchLines.push('*** Update File: scripts/tool_card_fixture.py', '@@');
  for (let index = 1; index <= 90; index += 1) patchLines.push('+fixture_line_' + index + ' = ' + index);
  patchLines.push('*** End Patch');
  const longPatch = patchLines.join('\\n');
  const toolEvents = [
    { type: 'tool.call', turnId: 'turn-scripted-kimi', toolCallId: 'read-scripted-kimi', name: 'Read', args: { path: longTypeScriptPath, line_offset: 0, n_lines: 80 } },
    { type: 'tool.result', turnId: 'turn-scripted-kimi', toolCallId: 'read-scripted-kimi', result: { output: 'export const fixtureLine1 = 1;\\nexport const fixtureLine2 = 2;' } },
    { type: 'tool.call', turnId: 'turn-scripted-kimi', toolCallId: 'grep-scripted-kimi', name: 'Bash', args: { command: 'rg -n "toolPanels:" src/__tests__ -g \\'*.ts\\' && git diff --check' } },
    { type: 'tool.result', turnId: 'turn-scripted-kimi', toolCallId: 'grep-scripted-kimi', result: { output: 'src/__tests__/a.ts:10:toolPanels:\\nsrc/__tests__/b.ts:20:toolPanels:' } },
    { type: 'tool.call', turnId: 'turn-scripted-kimi', toolCallId: 'patch-scripted-kimi', name: 'apply_patch', args: { patch: longPatch } },
    { type: 'tool.result', turnId: 'turn-scripted-kimi', toolCallId: 'patch-scripted-kimi', result: { output: 'Success. Updated the following files:\\nM ' + longTypeScriptPath + '\\nM scripts/tool_card_fixture.py' } },
    { type: 'tool.call', turnId: 'turn-scripted-kimi', toolCallId: 'bash-scripted-kimi', name: 'Bash', args: { command: 'npm test' } },
    { type: 'tool.result', turnId: 'turn-scripted-kimi', toolCallId: 'bash-scripted-kimi', result: { output: 'Script running with cell ID 90\\nWall time 0.2 seconds\\nOutput:\\n' } },
  ];
  toolEvents.forEach((event, index) => appendWire({ type: 'context.append_loop_event', time: now + 2 + index, event }));
  const chunks = [
    marker + '\\n',
    'provider preload complete: ' + providerKey + '\\n',
    providerKey + ' partial text\\n',
    'Goal Active: ' + providerKey + ' provider isolation\\n',
    'running representative tool: ' + providerKey + '\\n',
    'Bash\\n',
    'Context: 42%\\n',
  ];
  chunks.forEach((chunk, index) => {
    setTimeout(() => {
      appendWire({ type: 'context.append_loop_event', time: now + 10 + index, event: { type: 'content.part', turnId: 'turn-scripted-kimi', part: { type: 'text', text: chunk } } });
    }, 120 * index);
  });
  setTimeout(() => {
    appendWire({ type: 'context.append_loop_event', time: now + 100, event: { type: 'step.end', turnId: 'turn-scripted-kimi', stepUuid: 'step-scripted-kimi' } });
  }, 1800);
}

process.stdin.on('data', (chunk) => {
  fs.appendFileSync(keyLogPath, chunk.toString('hex') + '\\n');
  buffer += chunk.toString('utf8');
  if (chunk.includes(0x13)) answerOnce();
  for (const byte of chunk) {
    if (byte !== 0x03) continue;
    ctrlCCount += 1;
    if (ctrlCCount >= 2) {
      process.stdout.write('\\nTo resume this session: kimi -r ' + sessionId + '\\n');
      setTimeout(() => process.exit(0), 50);
    }
  }
});

setInterval(() => {}, 1000);
`, 'utf-8');
  fs.writeFileSync(executablePath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf-8');
  fs.chmodSync(executablePath, 0o755);
  return executablePath;
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

function usesProxyBackedBasicDialogue(options: CliOptions): boolean {
  return options.scriptedBasicDialogue && options.scenario === 'basic-dialogue-suite';
}

function usesScriptedKimiExecutable(options: CliOptions): boolean {
  return options.scriptedKimi || usesProxyBackedBasicDialogue(options);
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
  fs.mkdirSync(options.kimiHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(options.cursorConfigDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(options.cursorDataDir, { recursive: true, mode: 0o700 });

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
  const scriptedKimiExecutablePath = usesScriptedKimiExecutable(options)
    ? writeScriptedKimiExecutable(options)
    : '';
  const kimiAuthSource: RuntimeEnvironmentPlan['kimiAuthSource'] = scriptedKimiExecutablePath
    ? 'not-needed'
    : copyHostKimiConfig(os.homedir(), options.kimiHome)
      ? 'host-config-copy'
      : 'missing';
  const cursorAuthSource: RuntimeEnvironmentPlan['cursorAuthSource'] =
    copyHostCursorConfig(os.homedir(), options.cursorConfigDir)
      ? 'host-config-copy'
      : 'missing';
  const cursorExecutablePath = resolveCursorExecutablePath();

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
    bridgeHome: options.runtime === 'cursor' ? os.homedir() : options.runtimeHome,
    codexHome: options.codexHome,
    claudeHome: options.claudeHome,
    kimiHome: options.kimiHome,
    cursorConfigDir: options.cursorConfigDir,
    cursorDataDir: options.cursorDataDir,
    claudeExecutable: options.claudeExecutable,
    larkCliConfigSource,
    codexAuthSource,
    claudeAuthSource,
    kimiAuthSource,
    kimiExecutableSource: scriptedKimiExecutablePath ? 'scripted-fake-executable' : resolveKimiExecutableSource(),
    ...(scriptedKimiExecutablePath ? { kimiExecutablePath: scriptedKimiExecutablePath } : {}),
    cursorAuthSource,
    cursorExecutableSource: resolveCursorExecutableSource(),
    ...(cursorExecutablePath ? { cursorExecutablePath } : {}),
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
    bridgeHome: options.runtime === 'cursor' ? os.homedir() : options.runtimeHome,
    codexHome: options.codexHome,
    claudeHome: options.claudeHome,
    kimiHome: options.kimiHome,
    cursorConfigDir: options.cursorConfigDir,
    cursorDataDir: options.cursorDataDir,
    claudeExecutable: options.claudeExecutable,
    larkCliConfigSource: options.launchBridge ? 'missing' : 'not-needed',
    codexAuthSource: 'missing',
    claudeAuthSource: 'missing',
    kimiAuthSource: usesScriptedKimiExecutable(options) ? 'not-needed' : 'missing',
    kimiExecutableSource: usesScriptedKimiExecutable(options) ? 'scripted-fake-executable' : resolveKimiExecutableSource(),
    ...(usesScriptedKimiExecutable(options)
      ? { kimiExecutablePath: path.join(options.runRoot, 'bin', 'kimi') }
      : {}),
    cursorAuthSource: 'missing',
    cursorExecutableSource: resolveCursorExecutableSource(),
    ...(resolveCursorExecutablePath() ? { cursorExecutablePath: resolveCursorExecutablePath() } : {}),
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
  if (!existingConfig.apps?.some((app) => app.appId === options.testFeishuAppId)) {
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
  }
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

function larkCliUserEnv(options: CliOptions): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.CODELARK_REAL_FEISHU_AUTH_HOME) {
    env.HOME = process.env.CODELARK_REAL_FEISHU_AUTH_HOME;
    env.USERPROFILE = process.env.CODELARK_REAL_FEISHU_AUTH_HOME;
  }
  if (options.testLarkCliConfigDir) {
    env.LARKSUITE_CLI_CONFIG_DIR = options.testLarkCliConfigDir;
  }
  if (options.testLarkCliXdgDataHome) {
    env.XDG_DATA_HOME = options.testLarkCliXdgDataHome;
  }
  return env;
}

function sanitizedChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  delete env.LARK_CHANNEL;
  delete env.LARK_CHANNEL_HOME;
  delete env.LARK_CHANNEL_CONFIG;
  if (!extra.LARKSUITE_CLI_CONFIG_DIR) delete env.LARKSUITE_CLI_CONFIG_DIR;
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
    larkCliUserEnv(options),
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

function findMessageById(payload: unknown, messageId: string): unknown | undefined {
  return getFeishuTranscriptMessages(payload).find((message) => (
    message && typeof message === 'object'
    && (message as { message_id?: unknown }).message_id === messageId
  ));
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
  const sourceText = messageContent(findMessageById(payload, sourceMessageId));
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
    return containsGeneratedReplyTexts(content, sourceText, requiredTexts);
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

function botTranscriptContainsGeneratedText(
  payload: unknown,
  expectedText: string,
  sourceText: string,
  options: CliOptions,
): boolean {
  if (!expectedText) return true;
  return getFeishuTranscriptMessages(payload).some((message) => (
    isTestBotMessage(message, options)
    && containsGeneratedReplyTexts(messageContent(message), sourceText, [expectedText])
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

function createsInitialProductNewSessionGroup(options: CliOptions): boolean {
  return !options.chatId && options.scenario !== 'doc-as-chat-from-scratch';
}

function requiresCreatedGroupDeletionScope(options: CliOptions): boolean {
  return !options.keepGroup && (
    createsInitialProductNewSessionGroup(options)
    || options.scenario === 'doc-as-chat-from-scratch'
    || scenarioSwitchesToNewChatAfterNewCommand(options)
  );
}

function missingLarkCliUserScopes(scopes: Set<string>, options: CliOptions): string[] {
  const requiredScopes = [
    'im:chat:read',
    'im:message.send_as_user',
    'im:message.group_msg:get_as_user',
    'im:message.p2p_msg:get_as_user',
  ];
  if (requiresCreatedGroupDeletionScope(options)) {
    requiredScopes.push('im:chat:delete');
  }
  return requiredScopes.filter((scope) => !scopes.has(scope));
}

function larkCliUserAuthorizationHome(options: CliOptions): string {
  void options;
  if (process.env.CODELARK_REAL_FEISHU_AUTH_HOME) return process.env.CODELARK_REAL_FEISHU_AUTH_HOME;
  return process.env.HOME || os.homedir();
}

async function assertLarkCliUserAuthorizationPreflight(options: CliOptions): Promise<LarkCliUserAuthorizationStatus | null> {
  if (options.dryRun || options.dumpOnly || options.listScenarios || options.coverageMatrix || options.stopTestBridge) return null;
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
      `lark-cli auth login --scope "${feishuSetupUserAuthScopeArgument()}"`,
    ].filter(Boolean).join('\n'));
  }

  process.stderr.write([
    '[real-feishu-e2e] lark-cli user authorization preflight passed.',
    ` home=${larkCliUserAuthorizationHome(options)}`,
    ` app=${status.appId || '-'}`,
    ` user=${status.userOpenId}`,
    '\n',
  ].join(''));
  return status;
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

async function deleteCreatedChat(
  chatId: string,
  options: CliOptions,
  cleanupOptions: { notifyRetained?: boolean } = {},
): Promise<CreatedChatCleanupResult> {
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
    if (cleanupOptions.notifyRetained !== false) {
      await notifyRetainedTestChat(chatId, options, attempts);
    }
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
    if (record.status === 'deleted') continue;
    if (record.keepGroup) continue;
    if (record.runId === options.runId) continue;
    if (record.chatId === options.chatId) continue;
    if (record.testAppId && record.testAppId !== options.testFeishuAppId) continue;
    const cleanup = await deleteCreatedChat(record.chatId, options, { notifyRetained: false });
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
    kimiHome: options.kimiHome,
    cursorConfigDir: options.cursorConfigDir,
    cursorDataDir: options.cursorDataDir,
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
  // A response can land during the final poll sleep. Observe once at the
  // deadline before declaring a timeout so the failure report cannot contain
  // the very evidence this wait just missed.
  last = await fn();
  if (last) return last;
  throw new Error(`Timed out waiting for ${label}`);
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
    && options.provider !== 'sdk'
    && scenarioRequiresRuntimeOutput(options)
  ) {
    required.add('claude_jsonl_found');
  }
  if (options.runtime === 'kimi' && scenarioRequiresRuntimeOutput(options)) {
    required.add('kimi_wire_jsonl_found');
  }
  if (options.runtime === 'cursor' && scenarioRequiresRuntimeOutput(options)) {
    required.add('cursor_transcript_found');
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
  if (options.scenario === 'agent-question-forms') {
    const expectation = expectedReplyForMessage(
      options,
      scenarioFinalMessage(options),
      'bridge response for final message',
    );
    const observed = Boolean(finalFeishuMessages && botTranscriptMatchesExpectation(
      finalFeishuMessages,
      expectation,
      options,
    ));
    checks.push({
      name: 'agent_question_form_interactive_transcript',
      ok: observed,
      detail: observed
        ? 'Observed model-generated question form as a Feishu interactive CardKit reply with clk-agent-question callback fields.'
        : 'Final Feishu transcript did not contain the expected interactive question form fields.',
    });
  }
  if (options.scenario === 'markdown-rendering') {
    const expectation = expectedReplyForMessage(
      options,
      scenarioFinalMessage(options),
      'bridge response for final message',
    );
    const observed = Boolean(finalFeishuMessages && botTranscriptMatchesExpectation(
      finalFeishuMessages,
      expectation,
      options,
    ));
    checks.push({
      name: 'markdown_rendering_transcript_structure',
      ok: observed,
      detail: observed
        ? 'Observed Markdown marker, table, fenced code block, and Feishu-normalized code language in the final transcript.'
        : 'Final Feishu transcript did not contain the expected Markdown marker, table, fenced code block, and normalized language.',
    });
  }
  if (options.scenario === 'command-state') {
    const runtimeSettingsIssues = commandStateRuntimeSettingsTranscriptIssues(options, finalFeishuMessages);
    checks.push({
      name: 'command_state_runtime_settings_transcript',
      ok: runtimeSettingsIssues.length === 0,
      detail: runtimeSettingsIssues.length === 0
        ? 'Observed command-state runtime/settings and /every replies in the final Feishu transcript.'
        : runtimeSettingsIssues.join('\n'),
    });
    const issues = commandStateFileAndLargeFileTranscriptIssues(options, finalFeishuMessages);
    checks.push({
      name: 'command_state_file_and_large_file_transcript',
      ok: issues.length === 0,
      detail: issues.length === 0
        ? 'Observed Feishu file reply for the small /file command and interactive confirmation card for the large /file command.'
        : issues.join('\n'),
    });
  }
  if (options.scenario === 'session-management') {
    const issues = sessionManagementRuntimeIdentityTranscriptIssues(options, finalFeishuMessages);
    checks.push({
      name: 'session_management_runtime_identity_transcript',
      ok: issues.length === 0,
      detail: issues.length === 0
        ? 'Observed /current, /check, and /t archive runtime identity replies in the final Feishu transcript.'
        : issues.join('\n'),
    });
  }
  if (options.scenario === 'history-suite') {
    const issues = historySuiteTranscriptContractIssues(options, finalFeishuMessages);
    checks.push({
      name: 'history_suite_transcript_contract',
      ok: issues.length === 0,
      detail: issues.length === 0
        ? 'Observed history-suite short/raw/msg/json/file, long truncation, and empty-chat isolation replies in the final Feishu transcript.'
        : issues.join('\n'),
    });
  }
  if (shouldCheckRuntimePromptFinalTranscript(options)) {
    const issues = runtimePromptFinalTranscriptIssues(options, finalFeishuMessages);
    checks.push({
      name: 'runtime_prompt_final_transcript_marker',
      ok: issues.length === 0,
      detail: issues.length === 0
        ? 'Observed the runtime prompt final marker in the final Feishu transcript.'
        : issues.join('\n'),
    });
  }
  if (options.scenario === 'runtime-message' && options.runtime === 'cursor') {
    const marker = expectedRuntimePromptResponseText(options, scenarioFinalMessage(options));
    const issues = cursorStreamCardUnifiedUiIssues(
      report.streamCardCheckpoints || [],
      marker,
      options.cursorModel,
    );
    checks.push({
      name: 'cursor_stream_card_unified_ui',
      ok: issues.length === 0,
      detail: issues.length === 0
        ? 'Observed Cursor final output in the shared stream-card header, runtime metadata, history, and terminal layout.'
        : issues.join('\n'),
    });
  }
  if (options.scenario === 'basic-dialogue-suite' && options.scriptedBasicDialogue) {
    const issues = basicDialogueStreamCardCheckpointIssues(
      report.streamCardCheckpoints || [],
      BASIC_DIALOGUE_PROVIDER_SEQUENCE.map((providerKey) => ({
        providerKey,
        marker: basicDialogueMarker(options, providerKey),
        ...(providerKey === 'kimi-tmux'
          ? { requiredTexts: basicDialogueKimiThinkingCheckpointTexts(options) }
          : {}),
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
    const observedKimiSessionId = report.runtimeSlots.find((slot) => slot.runtime === 'kimi')?.kimiSessionId
      || scriptedKimiSessionId(options);
    const kimiLifecycleAndSteerIssues = scriptedKimiLifecycleAndSteerIssues({
      kimiHome: options.kimiHome,
      sessionId: observedKimiSessionId,
      cwd: options.workDir,
    });
    checks.push({
      name: 'basic_dialogue_scripted_kimi_lifecycle_and_ctrl_s',
      ok: kimiLifecycleAndSteerIssues.length === 0,
      detail: kimiLifecycleAndSteerIssues.length === 0
        ? 'Observed one fresh Kimi launch without resume, no bootstrap restart, and Ctrl-S steer.'
        : kimiLifecycleAndSteerIssues.join('\n'),
    });
    const kimiRuntimeSlotIssues = scriptedKimiRuntimeSlotIssues({
      report,
      sessionId: observedKimiSessionId,
      cwd: options.workDir,
    });
    checks.push({
      name: 'basic_dialogue_kimi_runtime_slot_persisted',
      ok: kimiRuntimeSlotIssues.length === 0,
      detail: kimiRuntimeSlotIssues.length === 0
        ? 'Observed ChannelChat kimi runtime slot bound to the scripted Kimi BridgeSession and wire transcript.'
        : kimiRuntimeSlotIssues.join('\n'),
    });
    const kimiWireTranscriptIssues = scriptedKimiWireTranscriptIssues({
      report,
      marker: basicDialogueMarker(options, 'kimi-tmux'),
      thinkingText: basicDialogueKimiThinkingCheckpointTexts(options)[1] || '',
    });
    checks.push({
      name: 'basic_dialogue_kimi_wire_transcript_read',
      ok: kimiWireTranscriptIssues.length === 0,
      detail: kimiWireTranscriptIssues.length === 0
        ? 'Observed scripted Kimi thinking, final marker text, and completion by reading the Kimi wire transcript.'
        : kimiWireTranscriptIssues.join('\n'),
    });
    const kimiHistoryTranscriptIssues = scriptedKimiHistoryTranscriptIssues({
      report,
      marker: basicDialogueMarker(options, 'kimi-tmux'),
      thinkingText: basicDialogueKimiThinkingCheckpointTexts(options)[1] || '',
    });
    checks.push({
      name: 'basic_dialogue_kimi_history_transcript_excludes_thinking',
      ok: kimiHistoryTranscriptIssues.length === 0,
      detail: kimiHistoryTranscriptIssues.length === 0
        ? 'Observed Kimi history transcript reads final marker text while excluding thinking/status content.'
        : kimiHistoryTranscriptIssues.join('\n'),
    });
    const kimiThinkingStatusIssues = kimiThinkingStatusOnlyIssues(report.streamCardCheckpoints || [], {
      providerKey: 'kimi-tmux',
      marker: basicDialogueMarker(options, 'kimi-tmux'),
      thinkingText: basicDialogueKimiThinkingCheckpointTexts(options)[1] || '',
    });
    checks.push({
      name: 'basic_dialogue_kimi_thinking_status_only',
      ok: kimiThinkingStatusIssues.length === 0,
      detail: kimiThinkingStatusIssues.length === 0
        ? 'Observed Kimi thinking only in non-final stream status checkpoints, not in the completed final answer card.'
        : kimiThinkingStatusIssues.join('\n'),
    });
    const kimiToolCardIssues = scriptedKimiToolCardIssues(report.streamCardCheckpoints || [], {
      providerKey: 'kimi-tmux',
      marker: basicDialogueMarker(options, 'kimi-tmux'),
    });
    checks.push({
      name: 'basic_dialogue_kimi_tool_card',
      ok: kimiToolCardIssues.length === 0,
      detail: kimiToolCardIssues.length === 0
        ? 'Observed one grouped Kimi tool-call panel with four inner semantic tool panels, a shared-budget multi-file patch with per-file highlighting, closed fences, and no transport-envelope leakage.'
        : kimiToolCardIssues.join('\n'),
    });
  }
  if (options.scenario === 'runtime-message' && options.scriptedKimi) {
    const marker = firstCodelarkMarker(scenarioFinalMessage(options));
    const issues = scriptedKimiToolCardIssues(report.streamCardCheckpoints || [], {
      providerKey: 'kimi-tmux',
      marker,
    });
    checks.push({
      name: 'runtime_message_scripted_kimi_tool_card',
      ok: issues.length === 0,
      detail: issues.length === 0
        ? 'Observed the scripted Kimi response as one Feishu tool-call group with four inner semantic tool panels, hidden ordinary output, a shared-budget multi-file patch with per-file highlighting, and no transport-envelope leakage.'
        : issues.join('\n'),
    });
  }
  return checks;
}

function commandStateRuntimeSettingsTranscriptIssues(options: CliOptions, finalFeishuMessages?: unknown): string[] {
  if (!finalFeishuMessages) {
    return ['Final Feishu transcript is missing; cannot verify command-state runtime/settings replies.'];
  }
  const commands = [
    '/status',
    '/require-at off',
    `/runtime ${options.runtime}`,
    `/p ${options.provider}`,
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
  ];
  return commands
    .map((command) => {
      const expectation = expectedReplyForMessage(options, command, `bridge response for ${command}`);
      if (botTranscriptMatchesExpectation(finalFeishuMessages, expectation, options)) return null;
      return `Command-state final transcript did not contain the expected runtime/settings reply for ${command}.`;
    })
    .filter((issue): issue is string => Boolean(issue));
}

function commandStateFileAndLargeFileTranscriptIssues(options: CliOptions, finalFeishuMessages?: unknown): string[] {
  if (!finalFeishuMessages) {
    return ['Final Feishu transcript is missing; cannot verify command-state /file replies.'];
  }
  const fileCommand = `/file ${commandStateFixtureFilePath(options)}`;
  const largeFileCommand = `/file ${commandStateLargeFixtureFilePath(options)}`;
  const fileExpectation = expectedReplyForMessage(options, fileCommand, `bridge response for ${fileCommand}`);
  const largeFileExpectation = expectedReplyForMessage(options, largeFileCommand, `bridge response for ${largeFileCommand}`);
  const issues: string[] = [];
  if (!botTranscriptMatchesExpectation(finalFeishuMessages, fileExpectation, options)) {
    issues.push('Small /file command did not produce a Feishu file message with file_key in the final transcript.');
  }
  if (!botTranscriptMatchesExpectation(finalFeishuMessages, largeFileExpectation, options)) {
    issues.push('Large /file command did not produce the expected Feishu interactive confirmation card in the final transcript.');
  }
  return issues;
}

function sessionManagementRuntimeIdentityTranscriptIssues(options: CliOptions, finalFeishuMessages?: unknown): string[] {
  if (!finalFeishuMessages) {
    return ['Final Feishu transcript is missing; cannot verify session-management runtime identity replies.'];
  }
  const commands = ['/current', '/check', '/t archive'];
  return commands
    .map((command) => {
      const expectation = expectedReplyForMessage(options, command, `bridge response for ${command}`);
      if (botTranscriptMatchesExpectation(finalFeishuMessages, expectation, options)) return null;
      return `${command} did not produce the expected ${runtimeDisplayLabel(options.runtime)} runtime identity reply in the final transcript.`;
    })
    .filter((issue): issue is string => Boolean(issue));
}

function historySuiteTranscriptContractIssues(options: CliOptions, finalFeishuMessages?: unknown): string[] {
  if (!finalFeishuMessages) {
    return ['Final Feishu transcript is missing; cannot verify history-suite replies.'];
  }
  const checks = [
    { command: '/his raw 1', label: 'bridge response for history-suite /his raw 1', description: 'short raw history marker' },
    { command: '/his limit 3', label: 'bridge response for history-suite /his limit 3', description: 'history limit setting reply' },
    { command: '/his', label: 'bridge response for history-suite /his', description: 'short default history marker' },
    { command: '/his msg 1', label: 'bridge response for history-suite /his msg 1', description: 'short msg history marker' },
    { command: '/his json', label: 'bridge response for history-suite /his json', description: 'JSON history file reply' },
    { command: '/his file', label: 'bridge response for history-suite /his file', description: 'text history file reply' },
    { command: '/his raw 2', label: 'bridge response for history-suite long /his raw 2', description: 'long raw history truncation' },
    { command: '/his msg 2', label: 'bridge response for history-suite long /his msg 2', description: 'long msg history truncation' },
    { command: '/his', label: 'bridge response for history-suite empty /his', description: 'empty default history isolation' },
    { command: '/his raw 1', label: 'bridge response for history-suite empty /his raw 1', description: 'empty raw history isolation' },
    { command: '/his msg 1', label: 'bridge response for history-suite empty /his msg 1', description: 'empty msg history isolation' },
  ];
  return checks
    .map(({ command, label, description }) => {
      const expectation = expectedReplyForMessage(options, command, label);
      if (botTranscriptMatchesExpectation(finalFeishuMessages, expectation, options)) return null;
      return `History-suite final transcript did not contain the expected ${description} for ${command}.`;
    })
    .filter((issue): issue is string => Boolean(issue));
}

function shouldCheckRuntimePromptFinalTranscript(options: CliOptions): boolean {
  return options.scenario !== 'basic-dialogue-suite'
    && options.scenario !== 'agent-question-forms'
    && scenarioRequiresRuntimeOutput(options)
    && Boolean(expectedRuntimePromptResponseText(options, scenarioFinalMessage(options)));
}

function runtimePromptFinalTranscriptIssues(options: CliOptions, finalFeishuMessages?: unknown): string[] {
  const expectedText = expectedRuntimePromptResponseText(options, scenarioFinalMessage(options));
  if (!expectedText) return [];
  if (!finalFeishuMessages) {
    return [`Final Feishu transcript is missing; cannot verify runtime prompt marker ${expectedText}.`];
  }
  if (botTranscriptContainsGeneratedText(
    finalFeishuMessages,
    expectedText,
    scenarioFinalMessage(options),
    options,
  )) return [];
  return [`Final Feishu transcript did not contain runtime prompt marker ${expectedText}.`];
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
  const directProvider = options.provider === 'sdk' || options.runtime === 'cursor';
  if (directProvider && mirrorKeys.length > 0) {
    issues.push(`${options.runtime}-${options.provider} direct provider produced mirror streams: ${mirrorKeys.join(', ')}`);
  }
  if (directProvider && directKeys.length > 0 && mirrorKeys.length > 0) {
    issues.push(`${options.runtime}-${options.provider} produced both direct IM streams and mirror streams; direct=${directKeys.join(', ')} mirror=${mirrorKeys.join(', ')}`);
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
  if (options.provider === 'sdk' || options.runtime === 'cursor') {
    if (directKeys.length === 0) {
      issues.push(`${options.runtime}-${options.provider} direct provider did not produce a direct IM stream; streamKeys=${report.streamKeys.join(', ') || '[none]'}`);
    }
    if (mirrorKeys.length > 0) {
      issues.push(`${options.runtime}-${options.provider} direct provider produced mirror streams: ${mirrorKeys.join(', ')}`);
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

function agentQuestionFormExpectedVisibleTexts(options: CliOptions): string[] {
  const match = options.fakeCcrResponseText.match(/<clk-ask>([\s\S]*?)<\/clk-ask>/u);
  if (!match?.[1]) return ['需要确认', '<form>'];
  try {
    const parsed = JSON.parse(match[1]) as {
      question?: unknown;
      options?: unknown;
      input?: { label?: unknown };
      submitText?: unknown;
    };
    return [
      '需要确认',
      '<form>',
      typeof parsed.question === 'string' ? parsed.question : '',
      ...(Array.isArray(parsed.options)
        ? parsed.options.filter((item): item is string => typeof item === 'string')
        : []),
      typeof parsed.input?.label === 'string' ? parsed.input.label : '',
      `[${typeof parsed.submitText === 'string' ? parsed.submitText : '提交'}]`,
    ].filter(Boolean);
  } catch {
    return ['需要确认', '<form>'];
  }
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
  if (options.scenario === 'session-management' && options.provider !== 'sdk') {
    return [
      '请只回复下面这个 marker，不要添加解释：',
      options.message,
    ].join('\n');
  }
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
    const { runtime } = parseRuntimeProviderKey(phase);
    return [
      runtimeProviderCommandTitle(runtime),
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
      runtimeProviderCommandTitle(options.runtime),
      options.provider,
    ];
  }
  if (command === '/current') {
    return ['当前会话', '对话名称', '工作目录', 'tmux 输出行数'];
  }
  if (command === '/model') {
    if (options.runtime === 'claude') return ['当前 Claude Code 模型'];
    if (options.runtime === 'kimi') return ['当前 Kimi Code 模型'];
    if (options.runtime === 'cursor') return ['当前 Cursor Agent 模型'];
    return ['当前模型'];
  }
  if (command === '/mode') {
    if (options.runtime === 'kimi') return ['Kimi Code 模式固定'];
    if (options.runtime === 'cursor') return ['当前 Cursor Agent 模式'];
    return ['当前模式', 'Runtime', options.runtime];
  }
  if (command === '/provider') {
    if (options.runtime === 'claude') return ['当前 Claude Provider'];
    if (options.runtime === 'kimi') return ['当前 Kimi Provider'];
    if (options.runtime === 'cursor') return ['当前 Cursor Provider'];
    return ['当前 Codex Provider'];
  }
  if (command === '/sandbox') {
    if (options.runtime === 'claude') return ['Claude Code 不支持 Bridge 沙箱设置'];
    if (options.runtime === 'kimi') return ['Kimi Code 不支持 Bridge 沙箱设置'];
    if (options.runtime === 'cursor') return ['Cursor Agent 不支持 Bridge 沙箱设置'];
    return ['当前 Codex 沙箱'];
  }
  if (command === '/network') {
    if (options.runtime === 'claude') return ['Claude Code 不支持 Bridge 网络开关'];
    if (options.runtime === 'kimi') return ['Kimi Code 不支持 Bridge 网络开关'];
    if (options.runtime === 'cursor') return ['Cursor Agent 不支持 Bridge 网络开关'];
    return ['当前 Codex 网络'];
  }
  if (command === '/reasoning') {
    if (options.runtime === 'claude') return ['当前 Claude Code 思考级别'];
    if (options.runtime === 'kimi') return ['Kimi Code 不支持 Bridge 思考级别设置'];
    if (options.runtime === 'cursor') return ['Cursor Agent 不支持 Bridge 思考级别设置'];
    return ['当前思考级别'];
  }
  if (command === `/every 1h e2e seed ${options.runId}`) {
    return ['已创建 /every 定时输入', `e2e seed ${options.runId}`, 'session runtime-id'];
  }
  if (command === '/every') return ['当前聊天 /every 定时输入', 'session runtime-id'];
  if (command === '/every no 1') return ['已取消 /every 定时输入'];
  return [];
}

function commandStateFixtureFileName(options: CliOptions): string {
  return `codelark-file-${runIdToken(options.runId)}.txt`;
}

function commandStateFixtureFilePath(options: CliOptions): string {
  return path.join(options.runRoot, 'fixtures', commandStateFixtureFileName(options));
}

function commandStateLargeFixtureFileName(options: CliOptions): string {
  return `codelark-large-file-${runIdToken(options.runId)}.bin`;
}

function commandStateLargeFixtureFilePath(options: CliOptions): string {
  return path.join(options.runRoot, 'fixtures', commandStateLargeFixtureFileName(options));
}

function prepareScenarioWorkspaceFixtures(options: CliOptions): void {
  if (options.scenario !== 'command-state') return;
  const filePath = commandStateFixtureFilePath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    filePath,
    [
      `CODELARK_FILE_COMMAND_${runIdToken(options.runId)}`,
      `runtime=${options.runtime}`,
      `provider=${options.provider}`,
      '',
    ].join('\n'),
    { encoding: 'utf-8', mode: 0o600 },
  );
  const largeFilePath = commandStateLargeFixtureFilePath(options);
  const fd = fs.openSync(largeFilePath, 'w', 0o600);
  try {
    fs.ftruncateSync(fd, 20 * 1024 * 1024 + 1);
  } finally {
    fs.closeSync(fd);
  }
}

function sessionManagementExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  if (command === `/runtime ${options.runtime}`) return ['Runtime', options.runtime];
  if (command === `/p ${options.provider}`) {
    return [
      runtimeProviderCommandTitle(options.runtime),
      options.provider,
    ];
  }
  if (command === '/help') return ['命令速览', 'Bridge 控制', 'SessionRuntime 配置'];
  if (command === '/set') return ['全局配置', '通用配置', '默认 agent', 'tmux 输出行数'];
  if (command === sessionManagementProviderSettingCommand(options)) {
    if (options.runtime === 'kimi') return ['已更新全局配置', 'runtime.kimi.provider', 'tmux'];
    if (options.runtime === 'cursor') return ['已更新全局配置', 'runtime.cursor.provider', 'tmux'];
    return ['已更新全局配置', 'runtime.claude.provider', options.runtime === 'claude' ? options.provider : 'tmux'];
  }
  if (command === `/new mgmt-${options.runId} ${options.workDir}`) {
    return ['已创建群聊会话', `mgmt-${options.runId}`, options.workDir, 'Runtime', runtimeDisplayLabel(options.runtime)];
  }
  if (command === `/clear clear-${options.runId} ${options.workDir}`) {
    return ['已清空当前聊天上下文', `clear-${options.runId}`, options.workDir, 'Provider', options.provider];
  }
  if (command === `/cd ${options.workDir}`) return ['已切换工作目录', options.workDir];
  if (command === sessionManagementShellCommand(options)) {
    return [
      '/shell 执行完成',
      sessionManagementShellMarker(options),
      'Codex sandbox',
      'read-only',
      '退出码',
      '0',
    ];
  }
  if (command === '/current') {
    return [
      runtimeDisplayLabel(options.runtime),
      `clear-${options.runId}`,
      'Provider',
      options.provider,
      '当前 agent',
    ];
  }
  if (command === '/check') {
    return [
      '当前会话健康检查',
      'runtime',
      runtimeDisplayLabel(options.runtime),
      runtimeIdentityFieldName(options.runtime),
      ...(options.runtime === 'claude' || options.runtime === 'kimi' || options.runtime === 'cursor' ? ['runtime_cwd'] : []),
    ];
  }
  if (command === '/t') return ['本地会话'];
  if (command === '/t n 50') return ['本地会话'];
  if (command === '/t unbind') return ['当前聊天已解绑', '新的临时 BridgeSession'];
  if (command === '/t archive') {
    if (options.runtime === 'claude') return ['已归档本地 Claude Code 会话'];
    if (options.runtime === 'kimi') return ['已归档本地 Kimi Code 会话'];
    if (options.runtime === 'cursor') return ['已归档本地 Cursor Agent 会话'];
    return ['已归档本地 Codex 会话'];
  }
  return [];
}

function sessionManagementShellMarker(options: CliOptions): string {
  return `CODELARK_SHELL_${runIdToken(options.runId)}`;
}

function sessionManagementShellCommand(options: CliOptions): string {
  return `/shell --sandbox read-only printf ${sessionManagementShellMarker(options)}`;
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
      runtimeProviderCommandTitle(options.runtime),
      options.provider,
    ];
  }
  return [];
}

function newSessionRuntimeExpectedTexts(options: CliOptions, command: string): string[] {
  const match = command.match(/^\/new\s+(\S+)/u);
  const groupName = match?.[1] || '';
  return [
    '已创建群聊会话',
    ...(groupName ? [groupName] : []),
    options.workDir,
    'Runtime',
    runtimeDisplayLabel(options.runtime),
  ];
}

function historyBoundariesExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  const seedTexts = runtimeProviderSeedExpectedTexts(options, text);
  if (seedTexts.length > 0) return seedTexts;
  if (command === `/new history-${options.runId} ${options.workDir}`) {
    return newSessionRuntimeExpectedTexts(options, command);
  }
  if (command === `/cd ${options.workDir}`) return ['已切换工作目录', options.workDir];
  return [];
}

function historyEmptyIsolationExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  const seedTexts = runtimeProviderSeedExpectedTexts(options, text);
  if (seedTexts.length > 0) return seedTexts;
  if (command.startsWith(`/new histiso-`)) return newSessionRuntimeExpectedTexts(options, command);
  if (command === `/cd ${options.workDir}`) return ['已切换工作目录', options.workDir];
  return [];
}

function historyAttachmentsExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  const seedTexts = runtimeProviderSeedExpectedTexts(options, text);
  if (seedTexts.length > 0) return seedTexts;
  if (command.startsWith(`/new histfile-`)) return newSessionRuntimeExpectedTexts(options, command);
  if (command === `/cd ${options.workDir}`) return ['已切换工作目录', options.workDir];
  return [];
}

function historyLongTruncationExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  const seedTexts = runtimeProviderSeedExpectedTexts(options, text);
  if (seedTexts.length > 0) return seedTexts;
  if (command.startsWith(`/new histlong-`)) return newSessionRuntimeExpectedTexts(options, command);
  if (command === `/cd ${options.workDir}`) return ['已切换工作目录', options.workDir];
  return [];
}

function historySuiteSetupExpectedTexts(options: CliOptions, text: string): string[] {
  const command = text.trim();
  const seedTexts = runtimeProviderSeedExpectedTexts(options, text);
  if (seedTexts.length > 0) return seedTexts;
  if (command.startsWith(`/new histsuite-`)) return newSessionRuntimeExpectedTexts(options, command);
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
  const runtimeSeedTexts = runtimeProviderSeedExpectedTexts(options, text);
  if (
    runtimeSeedTexts.length > 0
    && (
      options.scenario === 'message-only'
      || options.scenario === 'runtime-message'
      || options.scenario === 'agent-question-forms'
    )
  ) {
    return { ...empty, texts: runtimeSeedTexts };
  }
  if (options.scenario === 'card-forms') {
    const command = text.trim();
    if (command === '/new') {
      return {
        ...empty,
        texts: [
          '创建群聊会话',
          '<form>',
          '**群聊名称**',
          '**工作目录**',
          '[创建]',
          '提交后等同发送 `/new <名称> <目录>`。',
        ],
        messageTypes: ['interactive'],
      };
    }
    if (command === '/every-form') {
      return {
        ...empty,
        texts: [
          '新建 /every 定时输入',
          '<form>',
          '**间隔**',
          '**Prompt**',
          '[创建]',
          '提交后等同发送 `/every <数字><s|m|h|d> <prompt>`。',
        ],
        messageTypes: ['interactive'],
      };
    }
    if (command === '/then-form') {
      return {
        ...empty,
        texts: [
          '新建 /then 后续输入',
          '<form>',
          '**Prompt**',
          '[创建]',
          '提交后等同发送 `/then <prompt>`。',
        ],
        messageTypes: ['interactive'],
      };
    }
  }
  if (options.scenario === 'agent-question-forms' && label.includes('final message')) {
    return {
      ...empty,
      texts: agentQuestionFormExpectedVisibleTexts(options),
      messageTypes: ['interactive'],
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
  if (label.includes('final message') && (options.provider === 'sdk' || options.runtime === 'cursor')) {
    return { ...empty, texts: [expectedRuntimePromptResponseText(options, text)].filter(Boolean) };
  }
  if (options.scenario === 'command-state') {
    if (text.trim() === `/file ${commandStateFixtureFilePath(options)}`) {
      return { ...empty, messageTypes: ['file'], contentKeys: ['file_key'] };
    }
    if (text.trim() === `/file ${commandStateLargeFixtureFilePath(options)}`) {
      return {
        ...empty,
        texts: ['确认上传大文件', commandStateLargeFixtureFileName(options), '超过 20 MB'],
        messageTypes: ['interactive'],
        contentKeys: ['clk-command', '上传并发链接', '取消'],
      };
    }
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
  if (command.startsWith('/shell ')) return options.timeoutMs;
  // Provider switches may synchronously launch and probe an external runtime
  // before CodeLark can acknowledge the command (for example Cursor tmux).
  if (command === '/p' || command.startsWith('/p ')) return options.timeoutMs;
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
        reason: options.scenario === 'card-forms' && ['/new', '/every-form', '/then-form'].includes(command.trim())
          ? 'card form command must reply with a Feishu interactive form whose visible labels survive user-side transcript normalization'
          : options.scenario === 'basic-dialogue-suite' && basicDialoguePhaseForPrompt(options, command)
          ? 'basic dialogue provider phase must produce the expected deterministic model marker without provider contamination'
          : options.scenario === 'basic-dialogue-suite'
          ? 'basic dialogue setup/control message must reach the expected runtime/provider/stop state'
          : options.scenario === 'agent-question-forms' && label.includes('final message')
          ? 'agent question form must reply with a Feishu interactive form whose visible question and choices survive user-side transcript normalization'
          : options.scenario === 'agent-question-forms' && runtimeProviderSeedExpectedTexts(options, command).length > 0
          ? 'agent question runtime/provider seed must reach the final selected state before sending the model prompt'
          : options.scenario === 'markdown-rendering' && label.includes('final message')
          ? 'markdown rendering final reply must include the expected marker, table, fenced code block, and language tag'
          : options.scenario === 'markdown-rendering' && runtimeProviderSeedExpectedTexts(options, command).length > 0
          ? 'markdown rendering runtime/provider seed must reach the final selected state before sending the markdown prompt'
          : (options.scenario === 'message-only' || options.scenario === 'runtime-message')
            && runtimeProviderSeedExpectedTexts(options, command).length > 0
          ? 'runtime/provider seed command must reach the selected runtime and provider before sending the prompt'
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
          : command.trim() === `/file ${commandStateLargeFixtureFilePath(options)}`
          ? 'large file command must reply with a Feishu interactive confirmation card and clk-command callback prefix'
          : command.trim().startsWith('/file ')
          ? 'file command must reply with a Feishu file message containing a Feishu file key'
          : command.trim().startsWith('/shell ')
          ? 'shell command must complete in Codex sandbox and include the stdout marker'
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

function plannedSuccessCheckNames(options: CliOptions): string[] {
  const names = [
    'message_observations_passed',
    'final_feishu_transcript_present',
    'coverage_metadata_present',
    'canonical_report_eligible',
    'created_chat_cleanup_completed',
    'scenario_created_chat_cleanup_completed',
    'scenario_created_chat_names_match_requests',
    'required_checks_passed',
    'unexpected_mirror_absent',
  ];
  if (scenarioRequiresRuntimeOutput(options)) {
    names.push('provider_output_path');
  }
  if (scenarioRequiresRuntimeOutput(options) && options.provider !== 'sdk' && options.runtime !== 'cursor') {
    names.push('mirror_final_not_duplicated_in_direct_reply');
  }
  if (options.scenario === 'doc-as-chat-from-scratch') {
    names.push(
      'doc_as_chat_context_assertion',
      'doc_as_chat_user_group_read',
      'doc_as_chat_comment_granularity_binding',
      'created_document_cleanup_completed',
    );
  }
  if (options.fakeCcr && options.scenario !== 'require-at-toggle') {
    names.push('fake_ccr_response_observed');
  }
  if (options.fakeCcr) {
    names.push('fake_ccr_backend_used');
  }
  if (options.scenario === 'agent-question-forms') {
    names.push('agent_question_form_interactive_transcript');
  }
  if (options.scenario === 'markdown-rendering') {
    names.push('markdown_rendering_transcript_structure');
  }
  if (options.scenario === 'command-state') {
    names.push('command_state_runtime_settings_transcript');
    names.push('command_state_file_and_large_file_transcript');
  }
  if (options.scenario === 'session-management') {
    names.push('session_management_runtime_identity_transcript');
  }
  if (options.scenario === 'history-suite') {
    names.push('history_suite_transcript_contract');
  }
  if (shouldCheckRuntimePromptFinalTranscript(options)) {
    names.push('runtime_prompt_final_transcript_marker');
  }
  if (options.scenario === 'runtime-message' && options.runtime === 'cursor') {
    names.push('cursor_stream_card_unified_ui');
  }
  if (usesProxyBackedBasicDialogue(options)) {
    names.push(
      'codex_responses_proxy_used',
      'codex_responses_proxy_model_resolved',
      'codex_responses_proxy_reasoning_low',
      'codex_responses_proxy_bootstrap_prompt_observed',
      'basic_dialogue_ccr_proxy_used',
    );
  }
  if (options.scenario === 'basic-dialogue-suite' && options.scriptedBasicDialogue) {
    names.push(
      'basic_dialogue_stream_card_checkpoints',
      'basic_dialogue_terminal_append_input_delivered',
      'basic_dialogue_scripted_kimi_lifecycle_and_ctrl_s',
      'basic_dialogue_kimi_runtime_slot_persisted',
      'basic_dialogue_kimi_wire_transcript_read',
      'basic_dialogue_kimi_history_transcript_excludes_thinking',
      'basic_dialogue_kimi_thinking_status_only',
      'basic_dialogue_kimi_tool_card',
    );
  }
  if (options.scenario === 'runtime-message' && options.scriptedKimi) {
    names.push('runtime_message_scripted_kimi_tool_card');
  }
  return names;
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

async function cleanupScenarioCreatedChatsFromDump(
  options: CliOptions,
  baseChatId: string,
  excludedChatIds: string[] = [],
): Promise<CreatedChatCleanupResult[]> {
  if (!baseChatId) return [];
  const chatIds = extractScenarioCreatedChatIdsFromDump(latestDump(options, baseChatId), excludedChatIds);
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

function canonicalReportEligibility(
  options: CliOptions,
  runtimeEnvironment: RuntimeEnvironmentPlan,
): { eligible: boolean; blockers: string[]; notes: string[] } {
  const blockers: string[] = [];
  const notes: string[] = [];
  const runRoot = path.resolve(options.runRoot);
  const isolatedPaths: Array<[string, string]> = [
    ['codelarkHome', options.codelarkHome],
    ['runtimeHome', runtimeEnvironment.runtimeHome],
    ['codexHome', runtimeEnvironment.codexHome],
    ['kimiHome', runtimeEnvironment.kimiHome],
    ['cursorConfigDir', runtimeEnvironment.cursorConfigDir],
    ['cursorDataDir', runtimeEnvironment.cursorDataDir],
  ];

  if (!options.launchBridge) {
    blockers.push('real Feishu canonical reports must launch an isolated bridge.');
  }
  for (const [label, value] of isolatedPaths) {
    if (!isPathInside(runRoot, value)) {
      blockers.push(`${label} is outside runRoot: ${value}`);
    }
  }
  if (usesScriptedKimiExecutable(options)) {
    if (runtimeEnvironment.kimiExecutableSource !== 'scripted-fake-executable') {
      blockers.push(`scripted basic-dialogue expected scripted-fake-executable, got ${runtimeEnvironment.kimiExecutableSource}.`);
    }
    if (
      !runtimeEnvironment.kimiExecutablePath
      || !isPathInside(runRoot, runtimeEnvironment.kimiExecutablePath)
    ) {
      blockers.push(`scripted Kimi executable is outside runRoot: ${runtimeEnvironment.kimiExecutablePath || '-'}`);
    }
  }
  if (options.dryRun) {
    notes.push('dry-run only describes the planned canonical eligibility; it is not execution evidence.');
  }
  if (options.runtime === 'cursor') {
    notes.push('Cursor keeps config/data inside runRoot but preserves the host HOME only for the official CLI secure login store.');
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    notes,
  };
}

function automatedSuccessChecks(params: {
  options: CliOptions;
  report: ReturnType<typeof latestDump>;
  runtimeEnvironment: RuntimeEnvironmentPlan;
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
  const cleanupRequired = createsInitialProductNewSessionGroup(params.options) && !params.options.keepGroup;
  const cleanupOk = !cleanupRequired || params.createdChatCleanup?.deleted === true;
  const scenarioCreatedChatCleanupOk = params.scenarioCreatedChatCleanup.every((item) => item.deleted === true);
  const scenarioCreatedNameChecksOk = params.scenarioCreatedChatInfo.every((item) => item.ok);
  const coverage = scenarioCoverage(params.options);
  const e2eCoverage = Array.isArray(coverage.e2eCoverage) ? coverage.e2eCoverage : [];
  const testName = typeof coverage.testName === 'string' ? coverage.testName : '';
  const canonicalEligibility = canonicalReportEligibility(params.options, params.runtimeEnvironment);
  const finalObservation = params.messageObservations.find((observation) => observation.label.includes('final message'));
  const finalExpectedText = expectedFinalResponseText(params.options);
  const directMirrorDuplicate = Boolean(
    params.options.provider !== 'sdk'
    && params.options.runtime !== 'cursor'
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
      name: 'canonical_report_eligible',
      ok: canonicalEligibility.eligible,
      detail: canonicalEligibility.eligible
        ? 'Report satisfies canonical isolation requirements.'
        : canonicalEligibility.blockers.join('; '),
    },
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

  if (scenarioRequiresRuntimeOutput(params.options) && params.options.provider !== 'sdk' && params.options.runtime !== 'cursor') {
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
  error?: unknown;
  feishuMessages?: unknown;
}): void {
  const dump = latestDump(params.options, params.chatId);
  const failureReport = {
    runId: params.options.runId,
    dryRun: false,
    launchBridge: params.options.launchBridge,
    initialChatCreation: createsInitialProductNewSessionGroup(params.options) ? 'product-new-session-use-case' : 'provided-chat-id',
    scriptedBasicDialogue: params.options.scriptedBasicDialogue,
    scriptedKimi: params.options.scriptedKimi,
    scenario: params.options.scenario,
    runtime: params.options.runtime,
    provider: params.options.provider,
    coverage: scenarioCoverage(params.options),
    label: params.label,
    ...(params.sentText ? { sentText: params.sentText } : {}),
    chatId: params.chatId,
    runRoot: params.options.runRoot,
    codelarkHome: params.options.codelarkHome,
    runtimeEnvironment: params.runtimeEnvironment,
    canonicalEligibility: canonicalReportEligibility(params.options, params.runtimeEnvironment),
    missingChecks: missingRequiredChecks(params.options, dump),
    unexpectedMirror: unexpectedMirrorIssues(params.options, dump),
    ...(params.error !== undefined ? { failure: serializeFailureError(params.error) } : {}),
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
    && options.runtime !== 'cursor'
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

function shouldObserveScenarioNewChatTranscript(options: CliOptions, text: string): boolean {
  return scenarioSwitchesToNewChatAfterNewCommand(options) && text.trim().startsWith('/new ');
}

function extractScenarioCreatedChatIdsFromDump(
  dump: ReturnType<typeof latestDump>,
  excludedChatIds: string[] = [],
): string[] {
  const excluded = new Set(excludedChatIds.filter(Boolean));
  const chatIds = new Set<string>();
  const serialized = JSON.stringify(dump.audit ?? {});
  for (const match of serialized.matchAll(/\boc_[a-z0-9]+\b/g)) {
    const chatId = match[0];
    if (excluded.has(chatId)) continue;
    chatIds.add(chatId);
  }
  return [...chatIds];
}

async function waitForScenarioNewChatTranscript(
  options: CliOptions,
  baseChatId: string,
  expectation: ReplyExpectation,
  label: string,
  timeoutMs: number,
): Promise<{ chatId: string; messages: unknown }> {
  return waitFor(label, timeoutMs, options.pollMs, async () => {
    const dump = latestDump(options, baseChatId);
    const createdChatIds = extractScenarioCreatedChatIdsFromDump(dump, [
      baseChatId,
      options.chatId,
    ]);
    for (const chatId of createdChatIds) {
      const messages = await listChatMessages(chatId, options, 50);
      if (botTranscriptMatchesExpectation(messages, expectation, options)) {
        return { chatId, messages };
      }
    }
    return undefined;
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
    bridge: {
      defaultWorkspace: options.workDir,
    },
    runtime: {
      agent: options.runtime,
      codex: {
        ...(usesProxyBackedBasicDialogue(options) ? { model: options.codexModel } : {}),
        provider: options.runtime === 'codex' ? options.provider : (process.env.CODELARK_DEFAULT_CODEX_PROVIDER || 'tmux'),
        skipGitRepoCheck: true,
        sandboxMode: 'workspace-write',
        networkAccess: true,
        reasoningEffort: usesProxyBackedBasicDialogue(options) ? 'low' : 'medium',
      },
      claude: {
        provider: options.runtime === 'claude' ? options.provider : 'tmux',
        executable: options.claudeExecutable,
        permissionMode: process.env.CODELARK_CLAUDE_PERMISSION_MODE || 'default',
        ...(process.env.CODELARK_CLAUDE_DEFAULT_MODEL
          ? { model: process.env.CODELARK_CLAUDE_DEFAULT_MODEL }
          : {}),
      },
      kimi: {
        provider: 'tmux',
        ...(process.env.CODELARK_KIMI_MODEL
          ? { model: process.env.CODELARK_KIMI_MODEL }
          : {}),
      },
      cursor: {
        provider: 'tmux',
        model: options.cursorModel,
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
  process.stderr.write(`[real-feishu-e2e] Launching isolated bridge with CODELARK_HOME=${options.codelarkHome} CODEX_HOME=${options.codexHome} KIMI_CODE_HOME=${options.kimiHome} CURSOR_CONFIG_DIR=${options.cursorConfigDir} CURSOR_DATA_DIR=${options.cursorDataDir} HOME=${runtimeEnvironment.bridgeHome} claude=${options.claudeExecutable}\n`);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/entrypoints/daemon.ts'],
    {
      cwd: process.cwd(),
      env: sanitizedChildEnv({
        CODELARK_HOME: options.codelarkHome,
        HOME: runtimeEnvironment.bridgeHome,
        USERPROFILE: runtimeEnvironment.bridgeHome,
        XDG_DATA_HOME: path.join(runtimeEnvironment.runtimeHome, '.local', 'share'),
        XDG_CONFIG_HOME: path.join(runtimeEnvironment.runtimeHome, '.config'),
        XDG_CACHE_HOME: path.join(runtimeEnvironment.runtimeHome, '.cache'),
        CODEX_HOME: runtimeEnvironment.codexHome,
        CODELARK_CLAUDE_HOME: runtimeEnvironment.claudeHome,
        KIMI_CODE_HOME: runtimeEnvironment.kimiHome,
        CURSOR_CONFIG_DIR: runtimeEnvironment.cursorConfigDir,
        CURSOR_DATA_DIR: runtimeEnvironment.cursorDataDir,
        CODELARK_CURSOR_PROVIDER: 'tmux',
        CODELARK_CURSOR_MODEL: options.cursorModel,
        ...(runtimeEnvironment.cursorExecutablePath
          ? { CURSOR_AGENT_EXECUTABLE: runtimeEnvironment.cursorExecutablePath }
          : {}),
        CODELARK_CLAUDE_EXECUTABLE: runtimeEnvironment.claudeExecutable,
        CODELARK_CLAUDE_PROVIDER: options.runtime === 'claude' ? options.provider : (process.env.CODELARK_CLAUDE_PROVIDER || 'tmux'),
        CODELARK_KIMI_PROVIDER: 'tmux',
        CODELARK_DEFAULT_CODEX_PROVIDER: options.runtime === 'codex' ? options.provider : (process.env.CODELARK_DEFAULT_CODEX_PROVIDER || 'tmux'),
        CODELARK_CODEX_SKIP_GIT_REPO_CHECK: process.env.CODELARK_CODEX_SKIP_GIT_REPO_CHECK || 'true',
        ...(runtimeEnvironment.kimiExecutablePath
          ? { CODELARK_KIMI_EXECUTABLE: runtimeEnvironment.kimiExecutablePath }
          : kimiExecutableEnv()),
        ...(options.codexProxyBaseUrl
          ? {
            CODELARK_CODEX_BASE_URL: options.codexProxyBaseUrl,
            CODELARK_CODEX_API_KEY: 'clk-local-proxy-key',
            CODEX_API_KEY: 'clk-local-proxy-key',
            OPENAI_API_KEY: 'clk-local-proxy-key',
          }
          : {}),
        ...(usesScriptedKimiExecutable(options)
          || (options.scenario === 'runtime-message' && options.runtime === 'cursor')
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

async function createProductNewSessionChat(
  options: CliOptions,
  authorization: LarkCliUserAuthorizationStatus | null,
): Promise<{ chatId: string; groupName: string }> {
  const groupName = `clk-real-e2e-${options.runId}`.slice(0, 60);
  if (options.dryRun) return { chatId: '<created-chat-id>', groupName };
  if (!authorization?.userOpenId) {
    throw new Error('Unable to create a product /new Feishu test group: lark-cli user authorization preflight returned no user open_id.');
  }
  writeIsolatedBridgeConfig(options);
  const outputPath = path.join(options.runRoot, 'product-new-session.json');
  try {
    await runCommand(process.execPath, [
      '--import',
      'tsx',
      'scripts/real-feishu-product-new-session.ts',
      '--channel-type',
      options.channelType,
      '--channel-alias',
      options.channelAlias,
      '--user-open-id',
      authorization.userOpenId,
      '--group-name',
      groupName,
      '--workdir',
      options.workDir,
      '--run-id',
      options.runId,
      '--output',
      outputPath,
    ], options, {
      CODELARK_HOME: options.codelarkHome,
      HOME: options.runtimeHome,
      USERPROFILE: options.runtimeHome,
      XDG_DATA_HOME: path.join(options.runtimeHome, '.local', 'share'),
      XDG_CONFIG_HOME: path.join(options.runtimeHome, '.config'),
      XDG_CACHE_HOME: path.join(options.runtimeHome, '.cache'),
    });
  } catch (error) {
    const partial = readJsonIfExists<{ chatId?: string; groupName?: string }>(outputPath, {});
    if (partial.chatId) {
      registerCreatedTestChat(partial.chatId, partial.groupName || groupName, options);
      if (!options.keepGroup) {
        const cleanup = await deleteCreatedChat(partial.chatId, options).catch((cleanupError) => ({
          chatId: partial.chatId!,
          deleted: false,
          retained: true,
          reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        }));
        updateTestChatRegistryCleanup(partial.chatId, cleanup, false);
      }
    }
    throw error;
  }
  const parsed = readJsonIfExists<{ chatId?: string; groupName?: string }>(outputPath, {});
  const chatId = parsed.chatId || '';
  if (!chatId) {
    throw new Error(`product /new helper returned no chat_id; output=${JSON.stringify(parsed).slice(0, 1000)}`);
  }
  registerCreatedTestChat(chatId, parsed.groupName || groupName, options);
  return { chatId, groupName: parsed.groupName || groupName };
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
  return scenarioRequiresRuntimeOutput(options) && options.provider !== 'sdk' && options.runtime !== 'cursor';
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
  let observedChatId = chatId;
  let observationCheck: MessageObservation['check'] = 'feishu-reply_to';
  if (!options.dryRun) {
    const expectedReply = expectedReplyForMessage(options, text, label);
    const replyTimeoutMs = replyTimeoutMsForMessage(options, text, label);
    try {
      if (shouldObserveScenarioNewChatTranscript(options, text)) {
        const observed = await waitForScenarioNewChatTranscript(
          options,
          chatId,
          expectedReply,
          label,
          Math.max(replyTimeoutMs, Math.min(options.timeoutMs, 60_000)),
        );
        observedChatId = observed.chatId;
        observationCheck = 'feishu-new-chat-transcript';
        messages = observed.messages;
      } else if (shouldObserveFinalPromptByMirrorEvidence(options, label, expectedReply)) {
        await waitForNewResponseEvidence(options, chatId, before, label);
        messages = await listChatMessages(chatId, options, 50);
        observationCheck = 'feishu-mirror-stream';
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
        error,
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
    chatId: observedChatId,
    sentText: text,
    sentMessageId,
    expectation: shouldObserveFinalPromptByMirrorEvidence(
      options,
      label,
      expectedReplyForMessage(options, text, label),
    ) ? 'mirror-stream-evidence' : 'bot-reply',
    ok: true,
    check: observationCheck,
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
        error,
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
        error,
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
        error,
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
      const error = new Error(`${label}: bot replied to filtered message ${sourceMessageId}`);
      writeFailureReport({
        label,
        chatId,
        options,
        runtimeEnvironment,
        error,
        feishuMessages: {
          unexpectedReplyTo: sourceMessageId,
          messages: latestMessages,
        },
      });
      throw error;
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
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    printUsage();
    return;
  }
  validateCliArgs(argv);
  loadRealFeishuTestEnvFile(argv);
  const options = parseOptions(argv);
  getScenarioDefinition(options.scenario);
  validateScriptedBasicDialogueOptions(options);
  validateScriptedKimiOptions(options);
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
  if (options.coverageMatrix) {
    const matrix = coverageMatrix(options);
    writeReport(matrix, options.outputPath);
    enforceCoverageMatrixRequirements(options, matrix);
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
      copyHostKimiConfig(os.homedir(), options.kimiHome);
    }
    const userAuthorization = await assertLarkCliUserAuthorizationPreflight(options);
    startupChatCleanup = await cleanupRegisteredTestChats(options);
    appLock = acquireAppLock(options);
    if (usesProxyBackedBasicDialogue(options) && !options.dryRun) {
      codexResponsesProxy = await startSharedLocalCodexResponsesProxy(options.fakeCcrResponseText);
      options.codexProxyBaseUrl = codexResponsesProxy.baseUrl;
      process.stderr.write(`[real-feishu-e2e] Started local Codex Responses proxy at ${codexResponsesProxy.baseUrl}; Codex SDK/tmux will use isolated CODEX_HOME=${options.codexHome}\n`);
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
    } else if (!chatId) {
      const created = await createProductNewSessionChat(options, userAuthorization);
      chatId = created.chatId;
      createdGroupName = created.groupName;
      createdChatId = options.dryRun ? '' : chatId;
      if (!options.dryRun) {
        await new Promise((resolve) => setTimeout(resolve, options.pollMs));
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
        initialChatCreation: createsInitialProductNewSessionGroup(options) ? 'product-new-session-use-case' : 'provided-chat-id',
        scriptedBasicDialogue: options.scriptedBasicDialogue,
        scriptedKimi: options.scriptedKimi,
        scenario: options.scenario,
        commands: buildScenarioCommands(options),
        commandReplyExpectations: commandReplyExpectations(options),
        plannedSuccessCheckNames: plannedSuccessCheckNames(options),
        coverage: scenarioCoverage(options),
        validationChatSwitchesAfterNew: scenarioSwitchesToNewChatAfterNewCommand(options),
        waitsForMirrorFinalBeforeFollowup: waitsForMirrorFinalBeforeFollowup(options),
        finalMessageObservationMode: finalMessageObservationMode(options),
        runRoot: options.runRoot,
        codelarkHome: options.codelarkHome,
        codexModel: options.codexModel,
        cursorModel: options.cursorModel,
        runtimeEnvironment,
        canonicalEligibility: canonicalReportEligibility(options, runtimeEnvironment),
        initialChatCreationBotAppId: createsInitialProductNewSessionGroup(options) ? options.testFeishuAppId || null : null,
        initialChatCreationOwnerPolicy: createsInitialProductNewSessionGroup(options) ? 'product-new-session-use-case-ownerUserId' : null,
        docAsChatScenario,
        plannedChatId,
        keepGroup: options.keepGroup,
      }, options.outputPath);
      return;
    }

    if (!chatId) throw new Error('No real Feishu chat_id available.');
    prepareScenarioWorkspaceFixtures(options);
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
              error,
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
                error,
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
                error,
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
        if (waitsForMirrorFinalBeforeFollowup(options, scenarioFinalMessage(options))) {
          try {
            await waitForMirrorStreamCompleted(
              options,
              activeChatId,
              `mirror stream completion for ${scenarioFinalMessage(options)}`,
            );
          } catch (error) {
            const messages = await listChatMessages(activeChatId, options, 50);
            writeFailureReport({
              label: `mirror stream completion for ${scenarioFinalMessage(options)}`,
              sentText: scenarioFinalMessage(options),
              chatId: activeChatId,
              options,
              runtimeEnvironment,
              error,
              feishuMessages: {
                finalMessages: messages,
                messageObservations,
              },
            });
            throw error;
          }
        }
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
              error,
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
        error,
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
    ]);
    scenarioCreatedChatCleanup = await cleanupScenarioCreatedChats(messageObservations, options, [
      chatId,
      createdChatId,
      options.chatId,
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
    const runtimeOutputCheckNames = new Set([
      'binding_found',
      'session_found',
      'runtime_identity_bound',
      'messages_present',
    ]);
    const effectiveReportChecks = report.checks.map((check) => (
      !scenarioRequiresRuntimeOutput(options) && runtimeOutputCheckNames.has(check.name)
        ? {
          ...check,
          ok: true,
          detail: `${check.detail}; not required for the runtime-neutral ${options.scenario} scenario.`,
        }
      : check.name === 'messages_present' && options.provider !== 'sdk'
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
        runtimeEnvironment,
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
      initialChatCreation: createsInitialProductNewSessionGroup(options) ? 'product-new-session-use-case' : 'provided-chat-id',
      scriptedBasicDialogue: options.scriptedBasicDialogue,
      scriptedKimi: options.scriptedKimi,
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
      canonicalEligibility: canonicalReportEligibility(options, runtimeEnvironment),
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
      const failure = new Error(`Automated real Feishu E2E checks failed: ${failedChecks.map((check) => check.name).join(', ')}`);
      const reportPath = options.outputPath
        ? options.outputPath.replace(/\.json$/i, '.failure.json')
        : path.join(os.tmpdir(), `${path.basename(options.runRoot)}.failure.json`);
      writeReport({
        ...finalReport,
        failedChecks,
        failure: serializeFailureError(failure),
      }, reportPath);
      throw failure;
    }
    writeReport(finalReport, options.outputPath);
    completedSuccessfully = true;
  } finally {
    if (!completedSuccessfully && scenarioCreatedChatCleanup.length === 0) {
      scenarioCreatedChatCleanup = await cleanupScenarioCreatedChats(messageObservations, options, [
        createdChatId,
        options.chatId,
      ]).catch((error) => {
        process.stderr.write(`[real-feishu-e2e] Failed to cleanup scenario-created /new chats: ${error instanceof Error ? error.message : String(error)}\n`);
        return [];
      });
      const cleanedChatIds = new Set(scenarioCreatedChatCleanup.map((cleanup) => cleanup.chatId));
      const dumpSourceChatId = createdChatId || options.chatId;
      if (dumpSourceChatId) {
        const dumpCleanup = await cleanupScenarioCreatedChatsFromDump(options, dumpSourceChatId, [
          createdChatId,
          options.chatId,
          ...cleanedChatIds,
        ]).catch((error) => {
          process.stderr.write(`[real-feishu-e2e] Failed to cleanup dump-discovered /new chats: ${error instanceof Error ? error.message : String(error)}\n`);
          return [];
        });
        scenarioCreatedChatCleanup.push(...dumpCleanup);
      }
    }
    if (createdChatId && completedSuccessfully && !createdChatCleanup) {
      const cleanup = await deleteCreatedChat(createdChatId, options);
      updateTestChatRegistryCleanup(createdChatId, cleanup, options.keepGroup);
    } else if (createdChatId && !completedSuccessfully && !options.keepGroup) {
      const cleanup = await deleteCreatedChat(createdChatId, options).catch((error) => ({
        chatId: createdChatId,
        attempted: true,
        deleted: false,
        retained: true,
        reason: 'failed-run-cleanup-failed',
        error: error instanceof Error ? error.message : String(error),
      }));
      updateTestChatRegistryCleanup(createdChatId, cleanup, false);
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

function isCliEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(entry) === path.resolve(modulePath);
  }
}

if (isCliEntrypoint()) {
  main().catch((error) => {
    process.stderr.write(`[real-feishu-e2e] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
