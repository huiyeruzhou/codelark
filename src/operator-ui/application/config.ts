import crypto from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';

import { createConfigService } from '../../configuration/service.js';
import type { ConfigService } from '../../configuration/service.js';
import {
  claudeExecutableSchema,
  claudeProviderSchema,
  claudeReasoningEffortSchema,
  codexProviderSchema,
  kimiProviderSchema,
  kimiThinkingModeSchema,
  cursorProviderSchema,
  cursorReasoningEffortSchema,
  zcodeProviderSchema,
  zcodeModeSchema,
  reasoningEffortSchema,
  runtimeAgentSchema,
  sandboxModeSchema,
  type ConfigPatch,
  type ConfigV2,
} from '../../configuration/schema.js';
import { listSelectableCodexModels, readConfiguredCodexModel } from '../../runtime/codex/models.js';
import { readDefaultsConfig, resolveConfigPaths } from '../../configuration/sources.js';

const availableCodexModels = listSelectableCodexModels();
const availableCodexModelSlugs = new Set(availableCodexModels.map((model) => model.slug));

function hasPayloadKey(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function generateAccessToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function v2ChannelToPayload(channel: ConfigV2['channels'][number]) {
  return {
    id: channel.id,
    alias: channel.alias,
    provider: channel.provider,
    enabled: channel.enabled,
    config: { ...channel.config },
  };
}

function optionalString() {
  return z.preprocess(
    (value) => typeof value === 'string' ? value.trim() : value,
    z.string(),
  ).optional();
}

function optionalEnum<T extends z.ZodEnum>(schema: T) {
  return z.preprocess(
    (value) => typeof value === 'string' ? value.trim().toLowerCase() : value,
    schema,
  ).optional();
}

function optionalPositiveInteger() {
  return z.preprocess(
    (value) => typeof value === 'string' ? Number(value.trim()) : value,
    z.number().int().positive(),
  ).optional();
}

function optionalNonNegativeInteger() {
  return z.preprocess(
    (value) => typeof value === 'string' ? Number(value.trim()) : value,
    z.number().int().nonnegative(),
  ).optional();
}

const uiConfigPayloadSchema = z.object({
  runtime: optionalEnum(runtimeAgentSchema),
  tmuxCaptureLines: optionalPositiveInteger().refine(
    (value) => value === undefined || value <= 500,
    { message: 'tmux 输出行数必须在 1 到 500 之间。' },
  ),
  tmuxEchoInput: z.boolean().optional(),
  defaultWorkspaceRoot: optionalString(),
  defaultModel: optionalString(),
  defaultProvider: z.preprocess(
    (value) => typeof value === 'string' ? value.trim().toLowerCase() : value,
    z.union([codexProviderSchema, z.literal('')]),
  ).optional(),
  defaultMode: z.enum(['normal', 'yolo']).optional(),
  codexSkipGitRepoCheck: z.boolean().optional(),
  codexSandboxMode: optionalEnum(sandboxModeSchema),
  codexNetworkAccess: z.boolean().optional(),
  codexReasoningEffort: optionalEnum(reasoningEffortSchema),
  claudeProvider: optionalEnum(claudeProviderSchema),
  claudeMode: z.enum(['normal', 'yolo']).optional(),
  claudeReasoningEffort: optionalEnum(claudeReasoningEffortSchema),
  claudeExecutable: optionalEnum(claudeExecutableSchema),
  claudeDefaultModel: optionalString(),
  claudeIdleTimeoutMinutes: optionalNonNegativeInteger(),
  kimiDefaultModel: optionalString(),
  kimiProvider: optionalEnum(kimiProviderSchema),
  kimiThinkingMode: optionalEnum(kimiThinkingModeSchema),
  cursorDefaultModel: optionalString(),
  cursorProvider: optionalEnum(cursorProviderSchema),
  cursorReasoningEffort: z.preprocess(
    (value) => typeof value === 'string' ? value.trim().toLowerCase() : value,
    z.union([cursorReasoningEffortSchema, z.literal('')]),
  ).optional(),
  cursorForce: z.boolean().optional(),
  zcodeDefaultModel: optionalString(),
  zcodeProvider: optionalEnum(zcodeProviderSchema),
  zcodeMode: optionalEnum(zcodeModeSchema),
  uiAllowLan: z.boolean().optional(),
  uiAccessToken: optionalString(),
}).strict();

export const UI_CONFIG_INPUT_KEYS = Object.freeze(Object.keys(uiConfigPayloadSchema.shape).sort());

type UiConfigPayload = z.infer<typeof uiConfigPayloadSchema>;

export function parseUiConfigPayload(
  payload: Record<string, unknown>,
  currentCodexModel = '',
): UiConfigPayload {
  return uiConfigPayloadSchema.extend({
    defaultModel: optionalString().refine(
      (value) => (
        value === undefined
        || value === ''
        || value === currentCodexModel
        || availableCodexModelSlugs.has(value)
      ),
      { message: '未知 Codex 模型。' },
    ),
  }).parse(payload);
}

interface UiConfigPresentation {
  defaultProviderInherited?: boolean;
  defaultProviderDefaultValue?: string;
}

export function configV2ToPayload(config: ConfigV2, presentation: UiConfigPresentation = {}) {
  const defaultProviderInherited = presentation.defaultProviderInherited === true;
  return {
    runtime: config.runtime.agent,
    tmuxCaptureLines: config.session.tmuxCaptureLines,
    tmuxEchoInput: config.session.tmuxEchoInput,
    defaultWorkspaceRoot: config.bridge.defaultWorkspace === '~' ? os.homedir() : config.bridge.defaultWorkspace,
    defaultModel: config.runtime.codex.model || '',
    defaultProvider: defaultProviderInherited ? '' : config.runtime.codex.provider || '',
    defaultProviderInherited,
    defaultProviderDefaultValue: presentation.defaultProviderDefaultValue || '',
    codexDefaultModel: readConfiguredCodexModel() || '',
    availableModels: availableCodexModels,
    defaultMode: config.runtime.codex.yoloMode === 'on' || config.runtime.codex.yoloMode === 'yolo' ? 'yolo' : 'normal',
    codexSkipGitRepoCheck: config.runtime.codex.skipGitRepoCheck === true,
    codexSandboxMode: config.runtime.codex.sandboxMode || 'workspace-write',
    codexNetworkAccess: config.runtime.codex.networkAccess !== false,
    codexReasoningEffort: config.runtime.codex.reasoningEffort || 'medium',
    claudeProvider: config.runtime.claude.provider || 'tmux',
    claudeMode: config.runtime.claude.yoloMode === 'on' || config.runtime.claude.yoloMode === 'yolo' ? 'yolo' : 'normal',
    claudeExecutable: config.runtime.claude.executable || 'claude',
    claudeDefaultModel: config.runtime.claude.model || '',
    claudeReasoningEffort: config.runtime.claude.reasoningEffort || 'medium',
    claudeIdleTimeoutMinutes: config.runtime.claude.idleTimeoutMinutes ?? 0,
    kimiDefaultModel: config.runtime.kimi.model || '',
    kimiProvider: config.runtime.kimi.provider || 'tmux',
    kimiThinkingMode: config.runtime.kimi.thinkingMode || 'default',
    cursorDefaultModel: config.runtime.cursor.model || '',
    cursorProvider: config.runtime.cursor.provider || 'tmux',
    cursorReasoningEffort: config.runtime.cursor.reasoningEffort || '',
    cursorForce: config.runtime.cursor.force === true,
    zcodeDefaultModel: config.runtime.zcode.model || '',
    zcodeProvider: config.runtime.zcode.provider || 'tmux',
    zcodeMode: config.runtime.zcode.mode || 'build',
    uiAllowLan: config.bridge.uiAllowLan === true,
    uiAccessToken: config.bridge.uiAccessToken || '',
    channels: config.channels.map(v2ChannelToPayload),
  };
}

export function mergeConfigV2HomePatch(current: ConfigV2, payload: Record<string, unknown>): ConfigPatch {
  const parsed = parseUiConfigPayload(payload, current.runtime.codex.model);
  const uiAllowLan = hasPayloadKey(payload, 'uiAllowLan')
    ? parsed.uiAllowLan === true
    : current.bridge.uiAllowLan;
  const requestedUiAccessToken = parsed.uiAccessToken || undefined;
  const uiAccessToken = requestedUiAccessToken
    || current.bridge.uiAccessToken
    || (uiAllowLan ? generateAccessToken() : '');
  return {
    schemaVersion: 2,
    session: {
      tmuxCaptureLines: parsed.tmuxCaptureLines ?? current.session.tmuxCaptureLines,
      tmuxEchoInput: hasPayloadKey(payload, 'tmuxEchoInput')
        ? parsed.tmuxEchoInput === true
        : current.session.tmuxEchoInput,
    },
    runtime: {
      agent: parsed.runtime ?? current.runtime.agent,
      codex: {
        model: parsed.defaultModel === undefined
          ? current.runtime.codex.model
          : parsed.defaultModel === ''
            ? ''
            : parsed.defaultModel,
        provider: parsed.defaultProvider === undefined
          ? current.runtime.codex.provider
          : parsed.defaultProvider,
        yoloMode: hasPayloadKey(payload, 'defaultMode')
          ? parsed.defaultMode === 'yolo' ? 'on' : 'off'
          : current.runtime.codex.yoloMode,
        skipGitRepoCheck: hasPayloadKey(payload, 'codexSkipGitRepoCheck')
          ? parsed.codexSkipGitRepoCheck === true
          : current.runtime.codex.skipGitRepoCheck,
        sandboxMode: parsed.codexSandboxMode ?? current.runtime.codex.sandboxMode,
        networkAccess: hasPayloadKey(payload, 'codexNetworkAccess')
          ? parsed.codexNetworkAccess !== false
          : current.runtime.codex.networkAccess,
        reasoningEffort: parsed.codexReasoningEffort ?? current.runtime.codex.reasoningEffort,
      },
      claude: {
        model: parsed.claudeDefaultModel === undefined
          ? current.runtime.claude.model
          : parsed.claudeDefaultModel || '',
        provider: parsed.claudeProvider === undefined
          ? current.runtime.claude.provider
          : parsed.claudeProvider,
        executable: parsed.claudeExecutable ?? current.runtime.claude.executable,
        yoloMode: hasPayloadKey(payload, 'claudeMode')
          ? parsed.claudeMode === 'yolo' ? 'on' : 'off'
          : current.runtime.claude.yoloMode,
        reasoningEffort: parsed.claudeReasoningEffort ?? current.runtime.claude.reasoningEffort,
        idleTimeoutMinutes: parsed.claudeIdleTimeoutMinutes
          ?? current.runtime.claude.idleTimeoutMinutes
          ?? 0,
      },
      kimi: {
        model: parsed.kimiDefaultModel === undefined
          ? current.runtime.kimi.model
          : parsed.kimiDefaultModel || '',
        provider: parsed.kimiProvider ?? current.runtime.kimi.provider,
        thinkingMode: parsed.kimiThinkingMode ?? current.runtime.kimi.thinkingMode,
      },
      cursor: {
        model: parsed.cursorDefaultModel === undefined
          ? current.runtime.cursor.model
          : parsed.cursorDefaultModel || '',
        provider: parsed.cursorProvider ?? current.runtime.cursor.provider,
        reasoningEffort: parsed.cursorReasoningEffort ?? current.runtime.cursor.reasoningEffort,
        force: hasPayloadKey(payload, 'cursorForce')
          ? parsed.cursorForce === true
          : current.runtime.cursor.force,
      },
      zcode: {
        model: parsed.zcodeDefaultModel === undefined
          ? current.runtime.zcode.model
          : parsed.zcodeDefaultModel || '',
        provider: parsed.zcodeProvider ?? current.runtime.zcode.provider,
        mode: parsed.zcodeMode ?? current.runtime.zcode.mode,
      },
    },
    bridge: {
      defaultWorkspace: hasPayloadKey(payload, 'defaultWorkspaceRoot')
        ? parsed.defaultWorkspaceRoot || '~'
        : current.bridge.defaultWorkspace,
      uiAllowLan,
      uiAccessToken,
    },
    channels: current.channels,
  };
}

export function checkUiConfigPayload(payload: Record<string, unknown>): void {
  const service = createConfigService({ migrate: false });
  mergeConfigV2HomePatch(service.snapshot().config, payload);
}

export function homeWritableConfigPatch(config: ConfigV2): ConfigPatch {
  return {
    schemaVersion: config.schemaVersion,
    session: {
      tmuxCaptureLines: config.session.tmuxCaptureLines,
      tmuxEchoInput: config.session.tmuxEchoInput,
    },
    runtime: config.runtime,
    bridge: config.bridge,
    channels: config.channels,
  };
}

export function readUiHomeConfig(): ConfigV2 {
  return createConfigService({ migrate: false }).snapshot().config;
}

function defaultCodexProvider(): string {
  return codexProviderSchema.parse(
    readDefaultsConfig(resolveConfigPaths().defaultsToml).patch.runtime?.codex?.provider,
  );
}

function configServiceToUiPayload(service: ConfigService) {
  const snapshot = service.snapshot();
  const providerSource = snapshot.provenance.get('runtime.codex.provider')?.source || 'defaults';
  return configV2ToPayload(snapshot.config, {
    defaultProviderInherited: providerSource === 'defaults',
    defaultProviderDefaultValue: defaultCodexProvider(),
  });
}

export function readUiConfigPayload() {
  return configServiceToUiPayload(createConfigService({ migrate: false }));
}

export function replaceUiHomeConfig(config: ConfigV2): void {
  createConfigService({ migrate: false }).replace({ kind: 'home' }, homeWritableConfigPatch(config));
}

export function saveUiConfigPayload(payload: Record<string, unknown>) {
  const service = createConfigService({ migrate: false });
  const current = service.snapshot().config;
  const parsed = parseUiConfigPayload(payload, current.runtime.codex.model);
  const patch = mergeConfigV2HomePatch(current, payload);
  if (hasPayloadKey(payload, 'defaultProvider') && parsed.defaultProvider === '') {
    delete patch.runtime?.codex?.provider;
  }
  service.replace({ kind: 'home' }, patch);
  return configServiceToUiPayload(service);
}
