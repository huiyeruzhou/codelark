import type {
  Options as ClaudeAgentOptions,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type { LLMProvider, StreamChatParams, TokenUsage } from '../contracts.js';
import { sseEvent } from '../sse.js';
import { prepareClaudeCodeRouterEnv } from './code-router.js';
import { resolveClaudeCliExecutable } from '../../runtime/codex/cli-executable.js';

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

let cachedSdk: ClaudeAgentSdkModule | null = null;

async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  if (cachedSdk) return cachedSdk;
  try {
    cachedSdk = await (Function('return import("@anthropic-ai/claude-agent-sdk")')() as Promise<ClaudeAgentSdkModule>);
    return cachedSdk;
  } catch {
    throw new Error(
      '[ClaudeSdkProvider] @anthropic-ai/claude-agent-sdk is missing from this codelark installation. '
      + 'Reinstall codelark or run npm install in the project root.',
    );
  }
}

function isUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function buildClaudeSdkBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = env.CLAUDE_AGENT_SDK_CLIENT_APP || 'codelark';
  return env;
}

async function buildClaudeSdkEnv(
  executable?: StreamChatParams['claudeExecutable'],
  controller?: ReadableStreamDefaultController<string>,
): Promise<Record<string, string>> {
  const env = buildClaudeSdkBaseEnv();
  const resolvedExecutable = executable || env.CODELARK_CLAUDE_EXECUTABLE;
  if (resolvedExecutable === 'ccr') {
    env.CODELARK_CLAUDE_EXECUTABLE = 'ccr';
    const command = resolveClaudeCliExecutable('ccr', { env });
    return prepareClaudeCodeRouterEnv(command, env, { controller, logPrefix: '[claude-sdk]' });
  }
  return env;
}

function toPermissionMode(params: StreamChatParams): ClaudeAgentOptions['permissionMode'] {
  if (params.claudePermissionMode === 'acceptEdits'
    || params.claudePermissionMode === 'bypassPermissions'
    || params.claudePermissionMode === 'plan'
    || params.claudePermissionMode === 'default') {
    return params.claudePermissionMode;
  }
  return 'default';
}

function toUsage(usage: SDKResultMessage['usage'] | undefined, totalCostUsd?: number): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    ...(typeof totalCostUsd === 'number' ? { cost_usd: totalCostUsd } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringifyToolResultContent(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => stringifyToolResultContent(item)).filter(Boolean).join('\n\n');
  }
  if (!isRecord(value)) return String(value);
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if ('content' in value) return stringifyToolResultContent(value.content);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textFromAssistant(message: SDKAssistantMessage): string {
  const parts: string[] = [];
  const content = message.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as unknown as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    }
  }
  return parts.join('');
}

function enqueueAssistantContentBlocks(
  controller: ReadableStreamDefaultController<string>,
  message: SDKAssistantMessage,
): boolean {
  let emittedText = false;
  const content = message.message.content;
  if (typeof content === 'string') {
    if (content) {
      controller.enqueue(sseEvent('text', content));
      emittedText = true;
    }
    return emittedText;
  }
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      controller.enqueue(sseEvent('text', block.text));
      emittedText = true;
      continue;
    }
    if (block.type === 'tool_use') {
      const id = typeof block.id === 'string' ? block.id : `claude-tool-${Date.now()}`;
      const name = typeof block.name === 'string' ? block.name : 'tool';
      controller.enqueue(sseEvent('tool_use', {
        id,
        name,
        input: block.input,
      }));
    }
  }
  return emittedText;
}

function enqueueUserToolResults(
  controller: ReadableStreamDefaultController<string>,
  message: SDKMessage,
): void {
  if (message.type !== 'user') return;
  const record = message as unknown as Record<string, unknown>;
  const parentToolUseId = typeof record.parent_tool_use_id === 'string' ? record.parent_tool_use_id : '';
  if (parentToolUseId && 'tool_use_result' in record) {
    controller.enqueue(sseEvent('tool_result', {
      tool_use_id: parentToolUseId,
      content: stringifyToolResultContent(record.tool_use_result),
      is_error: false,
    }));
  }
  const envelope = isRecord(record.message) ? record.message : null;
  const content = envelope?.content;
  const blocks = Array.isArray(content) ? content : [];
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'tool_result') continue;
    const toolUseId = typeof block.tool_use_id === 'string'
      ? block.tool_use_id
      : typeof block.toolUseId === 'string'
        ? block.toolUseId
        : parentToolUseId;
    if (!toolUseId) continue;
    controller.enqueue(sseEvent('tool_result', {
      tool_use_id: toolUseId,
      content: stringifyToolResultContent(block.content),
      is_error: Boolean(block.is_error || block.isError),
    }));
  }
}

function enqueueStatus(controller: ReadableStreamDefaultController<string>, message: SDKSystemMessage): void {
  controller.enqueue(sseEvent('status', {
    session_id: message.session_id,
    cwd: message.cwd,
    model: message.model,
    slash_commands: message.slash_commands,
  }));
}

function enqueueResult(controller: ReadableStreamDefaultController<string>, message: SDKResultMessage): void {
  const usage = toUsage(message.usage, message.total_cost_usd);
  const errors = message.subtype === 'success' ? [] : message.errors;
  controller.enqueue(sseEvent('result', {
    session_id: message.session_id,
    is_error: message.is_error,
    ...(usage ? { usage } : {}),
    ...(message.subtype === 'success' ? { result: message.result } : {}),
    ...(errors.length ? { error: errors.join('\n') } : {}),
  }));
  if (message.is_error || message.subtype !== 'success') {
    controller.enqueue(sseEvent('error', errors.join('\n') || message.subtype));
  }
}

async function buildClaudeSdkOptions(
  params: StreamChatParams,
  controller?: ReadableStreamDefaultController<string>,
): Promise<ClaudeAgentOptions> {
  const permissionMode = toPermissionMode(params);
  return {
    cwd: params.workingDirectory || process.cwd(),
    env: await buildClaudeSdkEnv(params.claudeExecutable, controller),
    includePartialMessages: false,
    ...(params.model ? { model: params.model } : {}),
    ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.claudeReasoningEffort ? { effort: params.claudeReasoningEffort } : {}),
    permissionMode,
    ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    ...(params.claudeSessionId
      ? { resume: params.claudeSessionId }
      : isUuid(params.sessionId)
        ? { sessionId: params.sessionId }
        : {}),
  };
}

export class ClaudeSdkProvider implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          let query: { close?: () => void } | null = null;
          const abortListener = () => {
            try { query?.close?.(); } catch { /* best effort */ }
          };
          try {
            const sdk = await loadClaudeAgentSdk();
            const options = await buildClaudeSdkOptions(params, controller);
            console.log('[claude-sdk] Claude Agent SDK start:', {
              bridge_session_id: params.sessionId,
              resume: params.claudeSessionId || null,
              session_id: 'sessionId' in options ? options.sessionId : null,
              cwd: options.cwd,
              model: options.model || null,
              permission_mode: options.permissionMode || null,
            });
            params.abortController?.signal.addEventListener('abort', abortListener, { once: true });
            query = sdk.query({ prompt: params.prompt, options });
            let emittedAssistantText = false;
            let resultText = '';
            for await (const message of query as AsyncIterable<SDKMessage>) {
              if (message.type === 'system' && message.subtype === 'init') {
                enqueueStatus(controller, message);
                continue;
              }
              if (message.type === 'assistant') {
                if (enqueueAssistantContentBlocks(controller, message)) {
                  emittedAssistantText = true;
                }
                continue;
              }
              enqueueUserToolResults(controller, message);
              if (message.type === 'result') {
                if (message.subtype === 'success') resultText = message.result || '';
                if (!emittedAssistantText && resultText) {
                  emittedAssistantText = true;
                  controller.enqueue(sseEvent('text', resultText));
                }
                enqueueResult(controller, message);
              }
            }
            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[claude-sdk] Error:', error instanceof Error ? error.stack || error.message : error);
            try {
              controller.enqueue(sseEvent('error', message || 'Claude SDK execution failed.'));
              controller.close();
            } catch {
              // Controller may already be closed.
            }
          } finally {
            params.abortController?.signal.removeEventListener('abort', abortListener);
          }
        })();
      },
    });
  }
}

export const _testOnlyClaudeSdk = {
  buildClaudeSdkBaseEnv,
  buildClaudeSdkEnv,
  buildClaudeSdkOptions,
  enqueueAssistantContentBlocks,
  enqueueUserToolResults,
  textFromAssistant,
  toUsage,
};
