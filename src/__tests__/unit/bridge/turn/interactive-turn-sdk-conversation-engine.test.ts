import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  processMessage,
  type SdkConversationRuntime,
} from '../../../../bridge/turn/interactive/sdk-conversation-engine.js';
import {
  buildConversationPromptText,
  buildLocalAttachmentPromptSupplement,
} from '../../../../bridge/turn/interactive/sdk-attachments.js';
import { appendStreamPreviewChunk, buildInlineToolBlock, buildReasoningPreviewNote } from '../../../../bridge/turn/interactive/sdk-stream-preview.js';
import { sseEvent } from '../../../../runtime/sse.js';
import { consumeSseEvents } from '../../../../runtime/sse-stream-decoder.js';
import {
  normalizeReasoningEffort,
  normalizeSandboxMode,
} from '../../../../configuration/runtime-options.js';
import {
  initBridgeTestContext,
  makeBridgeSettings,
  resetBridgeTestState,
} from '../../../helpers/bridge/test-bridge-utils.js';
import type { BridgeStore } from '../../../../domain/index.js';
import type { LLMProvider, StreamChatParams } from '../../../../runtime/contracts.js';

function toolOnlyLlm(): LLMProvider {
  return {
    streamChat(): ReadableStream<string> {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(sseEvent('tool_use', {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'pwd' },
          }));
          controller.enqueue(sseEvent('tool_result', {
            tool_use_id: 'tool-1',
            content: '/tmp/project',
            is_error: false,
          }));
          controller.close();
        },
      });
    },
  };
}

function createTestSdkConversationRuntime(store: BridgeStore, llm: LLMProvider): SdkConversationRuntime {
  return {
    store,
    llm,
    consumeSseEvents,
    normalizeSandboxMode,
    normalizeReasoningEffort,
  };
}

describe('buildLocalAttachmentPromptSupplement', () => {
  it('returns an empty string when only images are present', () => {
    const result = buildLocalAttachmentPromptSupplement([
      {
        id: 'img-1',
        name: 'screenshot.png',
        type: 'image/png',
        size: 2048,
        filePath: 'D:\\work\\.codepilot-uploads\\screenshot.png',
      },
    ]);

    assert.equal(result, '');
  });

  it('includes local file paths for non-image attachments', () => {
    const result = buildLocalAttachmentPromptSupplement([
      {
        id: 'pdf-1',
        name: 'report.pdf',
        type: 'application/pdf',
        size: 40960,
        filePath: 'D:\\work\\.codepilot-uploads\\report.pdf',
      },
      {
        id: 'video-1',
        name: 'demo.mp4',
        type: 'video/mp4',
        size: 5 * 1024 * 1024,
        filePath: 'D:\\work\\.codepilot-uploads\\demo.mp4',
      },
    ]);

    assert.match(result, /Attached local files:/);
    assert.match(result, /report\.pdf/);
    assert.match(result, /application\/pdf/);
    assert.match(result, /D:\\work\\\.codepilot-uploads\\report\.pdf/);
    assert.match(result, /demo\.mp4/);
    assert.match(result, /video\/mp4/);
    assert.match(result, /extract frames or audio only when needed/i);
  });

  it('builds the effective conversation prompt including non-image attachment guidance', () => {
    const result = buildConversationPromptText('请帮我总结附件', [
      {
        id: 'pdf-1',
        name: 'report.pdf',
        type: 'application/pdf',
        size: 40960,
        filePath: 'D:\\work\\.codepilot-uploads\\report.pdf',
      },
    ]);

    assert.match(result, /^请帮我总结附件\n\nAttached local files:/);
    assert.match(result, /report\.pdf/);
    assert.match(result, /D:\\work\\\.codepilot-uploads\\report\.pdf/);
  });
});

describe('appendStreamPreviewChunk', () => {
  it('starts a new paragraph when text resumes after tool progress', () => {
    const result = appendStreamPreviewChunk('先检查文件', '然后继续说明', true);
    assert.equal(result, '先检查文件\n\n然后继续说明');
  });

  it('does not add an extra paragraph for continuous text chunks', () => {
    const result = appendStreamPreviewChunk('先检查', '文件', false);
    assert.equal(result, '先检查文件');
  });

  it('leaves a blank line after status reasoning notes before SDK text resumes', () => {
    const result = `${buildReasoningPreviewNote('等待 Claude Code Router 启动。')}Claude 已就绪`;
    assert.equal(result, '> 等待 Claude Code Router 启动。\n\nClaude 已就绪');
  });
});

describe('buildInlineToolBlock', () => {
  it('uses bash fences for exec-style inline tool input', () => {
    const result = buildInlineToolBlock({
      name: 'exec_command',
      status: 'running',
      input: { command: 'npm test' },
    });

    assert.match(result, /```bash\nnpm test\n```/);
    assert.doesNotMatch(result, /```json\nnpm test/);
  });

  it('uses diff fences for apply_patch inline input and protects nested fences', () => {
    const result = buildInlineToolBlock({
      name: 'apply_patch',
      status: 'running',
      input: '*** Begin Patch\n*** Update File: a.ts\n@@\n+```ts\n+const x = 1;\n+```\n*** End Patch',
    });

    assert.match(result, /````diff\n\*\*\* Begin Patch/);
    assert.match(result, /\n\+```ts\n\+const x = 1;\n\+```\n/);
  });
});

describe('interactive-turn sdk-conversation-engine tool expansion', () => {
  it('routes active Claude runtime turns with Claude-specific settings', async () => {
    resetBridgeTestState();
    const calls: StreamChatParams[] = [];
    const llm: LLMProvider = {
      streamChat(params: StreamChatParams): ReadableStream<string> {
        calls.push(params);
        return new ReadableStream({
          start(controller) {
            controller.enqueue(sseEvent('text', 'claude reply'));
            controller.enqueue(sseEvent('result', { session_id: 'claude-session-1' }));
            controller.close();
          },
        });
      },
    };
    const store = initBridgeTestContext({
      settings: makeBridgeSettings({
        bridge_claude_executable: 'ccr',
        bridge_claude_default_model: 'claude-sonnet-test',
        bridge_claude_permission_mode: 'plan',
      }),
      llm,
    });
    const session = store.createSession('claude-runtime-test', 'codex-model', undefined, '', 'normal');
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'claude',
      },
    });
    const binding = store.upsertChannelChat({
      channelType: 'feishu',
      chatId: 'chat-claude-runtime',
      bridgeSessionId: session.id,
    });

    const result = await processMessage(
      binding,
      'hello claude',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestSdkConversationRuntime(store, llm),
    );

    assert.equal(result.responseText, 'claude reply');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.runtime, 'claude');
    assert.equal(calls[0]?.claudeExecutable, 'ccr');
    assert.equal(calls[0]?.claudeSessionId, undefined);
    assert.equal(calls[0]?.model, 'claude-sonnet-test');
    assert.equal(calls[0]?.claudePermissionMode, 'plan');
    assert.equal(calls[0]?.codexProvider, 'sdk');
    assert.equal(calls[0]?.systemPrompt, undefined);
    const updatedSession = store.getSession(session.id);
    assert.equal(updatedSession?.runtime?.claude?.sessionId, 'claude-session-1');
    assert.equal(updatedSession?.runtime?.codex?.threadId, undefined);
  });

  it('passes only the configured session system prompt to SDK providers', async () => {
    resetBridgeTestState();
    const calls: StreamChatParams[] = [];
    const llm: LLMProvider = {
      streamChat(params: StreamChatParams): ReadableStream<string> {
        calls.push(params);
        return new ReadableStream({
          start(controller) {
            controller.enqueue(sseEvent('text', 'ok'));
            controller.close();
          },
        });
      },
    };
    const store = initBridgeTestContext({
      settings: makeBridgeSettings(),
      llm,
    });
    const session = store.createSession('system-prompt-test', '', 'Use repo conventions only.', '', 'normal');
    const binding = store.upsertChannelChat({
      channelType: 'feishu',
      chatId: 'chat-system-prompt',
      bridgeSessionId: session.id,
    });

    await processMessage(
      binding,
      'write code',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestSdkConversationRuntime(store, llm),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.systemPrompt, 'Use repo conventions only.');
    assert.doesNotMatch(calls[0]?.systemPrompt || '', /clk-ask|lark-cli/);
  });

  it('can keep SDK tool calls out of persisted assistant content and stream preview', async () => {
    resetBridgeTestState();
    const llm = toolOnlyLlm();
    const store = initBridgeTestContext({
      settings: makeBridgeSettings(),
      llm,
    });
    const session = store.createSession('tool-expansion-test', '', undefined, '', 'normal');
    const binding = store.upsertChannelChat({
      channelType: 'feishu',
      chatId: 'chat-tool-expansion',
      bridgeSessionId: session.id,
    });

    const previews: string[] = [];
    const result = await processMessage(
      binding,
      'run a tool',
      undefined,
      undefined,
      undefined,
      (text) => previews.push(text),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        expandToolCalls: false,
        streamPreview: {
          includeToolSnippets: true,
        },
      },
      createTestSdkConversationRuntime(store, llm),
    );

    assert.equal(result.responseText, '');
    assert.deepEqual(previews, []);

    const { messages } = store.getMessages(session.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, 'user');
  });

  it('expands SDK tool calls by default', async () => {
    resetBridgeTestState();
    const llm = toolOnlyLlm();
    const store = initBridgeTestContext({
      settings: makeBridgeSettings(),
      llm,
    });
    const session = store.createSession('tool-expansion-default-test', '', undefined, '', 'normal');
    const binding = store.upsertChannelChat({
      channelType: 'feishu',
      chatId: 'chat-tool-expansion-default',
      bridgeSessionId: session.id,
    });

    const previews: string[] = [];
    const result = await processMessage(
      binding,
      'run a tool',
      undefined,
      undefined,
      undefined,
      (text) => previews.push(text),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        streamPreview: {
          includeToolSnippets: true,
        },
      },
      createTestSdkConversationRuntime(store, llm),
    );

    assert.equal(result.responseText, '');
    assert.match(previews.join('\n'), /Bash/);
    assert.match(previews.join('\n'), /pwd/);
    assert.match(previews.join('\n'), /\/tmp\/project/);

    const { messages } = store.getMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.role, 'assistant');
    assert.match(messages[1]?.content || '', /"type":"tool_use"/);
    assert.match(messages[1]?.content || '', /"type":"tool_result"/);
  });
});
