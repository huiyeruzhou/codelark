import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
} from '../../../../runtime/options.js';
import {
  initBridgeTestContext,
  makeBridgeSettings,
  resetBridgeTestState,
} from '../../../helpers/bridge/test-bridge-utils.js';
import type { BridgeStore } from '../../../../domain/index.js';
import type { LLMProvider, StreamChatParams } from '../../../../runtime/contracts.js';
import { CODELARK_HOME } from '../../../../configuration/paths.js';
import {
  getSessionKimiCwd,
  getSessionKimiSessionId,
} from '../../../../domain/session-runtime.js';

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
  it('routes active Claude runtime turns with Claude-specific settings from yolo mode', async () => {
    resetBridgeTestState();
    const configTomlPath = path.join(CODELARK_HOME, 'config.toml');
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
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
    try {
      fs.mkdirSync(CODELARK_HOME, { recursive: true });
      fs.writeFileSync(configTomlPath, `
schema_version = 2

[runtime.claude]
executable = "ccr"
model = "claude-sonnet-test"
yolo_mode = "on"
permission_mode = "plan"
`);
      const store = initBridgeTestContext({
        settings: makeBridgeSettings(),
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
      assert.equal(calls[0]?.claudePermissionMode, 'bypassPermissions');
      assert.equal(calls[0]?.codexProvider, 'tmux');
      assert.equal(calls[0]?.systemPrompt, undefined);
      const updatedSession = store.getSession(session.id);
      assert.equal(updatedSession?.runtime?.claude?.sessionId, 'claude-session-1');
      assert.equal(updatedSession?.runtime?.codex?.threadId, undefined);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

  it('captures Kimi status identity and thinking notes from SDK streams', async () => {
    resetBridgeTestState();
    const calls: StreamChatParams[] = [];
    const llm: LLMProvider = {
      streamChat(params: StreamChatParams): ReadableStream<string> {
        calls.push(params);
        return new ReadableStream({
          start(controller) {
            controller.enqueue(sseEvent('status', {
              session_id: 'session_kimi_sdk_status_1',
              cwd: '/tmp/kimi-sdk',
              reasoning: '思考',
              thinking: '正在分析 Kimi 上下文',
            }));
            controller.enqueue(sseEvent('text', 'kimi reply'));
            controller.enqueue(sseEvent('result', {
              session_id: 'session_kimi_sdk_status_1',
              cwd: '/tmp/kimi-sdk',
            }));
            controller.close();
          },
        });
      },
    };
    const store = initBridgeTestContext({
      settings: makeBridgeSettings(),
      llm,
    });
    const session = store.createSession('kimi-runtime-test', 'codex-model', undefined, '/tmp/kimi-sdk', 'normal');
    store.updateSession(session.id, {
      runtime: {
        activeRuntime: 'kimi',
      },
    });
    const binding = store.upsertChannelChat({
      channelType: 'feishu',
      chatId: 'chat-kimi-runtime',
      bridgeSessionId: session.id,
    });
    const statusNotes: Array<string | null> = [];
    const thinkingNotes: string[] = [];
    const identities: Array<{ runtime: string; sessionId: string; cwd?: string }> = [];

    const result = await processMessage(
      binding,
      'hello kimi',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (note) => statusNotes.push(note),
      undefined,
      {
        onThinkingNote: (note) => thinkingNotes.push(note),
        onRuntimeIdentity: (identity) => {
          identities.push({
            runtime: identity.runtime,
            sessionId: identity.sessionId,
            ...(identity.cwd ? { cwd: identity.cwd } : {}),
          });
        },
      },
      createTestSdkConversationRuntime(store, llm),
    );

    assert.equal(result.responseText, 'kimi reply');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.runtime, 'kimi');
    assert.equal(calls[0]?.kimiSessionId, undefined);
    assert.deepEqual(statusNotes, ['思考']);
    assert.deepEqual(thinkingNotes, ['正在分析 Kimi 上下文']);
    assert.deepEqual(identities, [
      { runtime: 'kimi', sessionId: 'session_kimi_sdk_status_1', cwd: '/tmp/kimi-sdk' },
      { runtime: 'kimi', sessionId: 'session_kimi_sdk_status_1', cwd: '/tmp/kimi-sdk' },
    ]);
    const updatedSession = store.getSession(session.id);
    assert.equal(getSessionKimiSessionId(updatedSession), 'session_kimi_sdk_status_1');
    assert.equal(getSessionKimiCwd(updatedSession), '/tmp/kimi-sdk');
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
    const preview = previews.join('\n');
    assert.match(preview, /💻 运行 `pwd` · 输出 1 行/);
    assert.match(preview, /```bash\npwd\n```/);
    assert.doesNotMatch(preview, /```text\n\/tmp\/project\n```/);

    const { messages } = store.getMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.role, 'assistant');
    assert.match(messages[1]?.content || '', /"type":"tool_use"/);
    assert.match(messages[1]?.content || '', /"type":"tool_result"/);
  });
});
