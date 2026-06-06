import '../../../../setup/test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import fs from 'node:fs';
import { loadConfig } from '../../../../../configuration/index.js';
import { _testOnlyPtyScreens } from '../../../../../runtime/codex/pty-provider.js';
import { _testOnlyClaudePty } from '../../../../../runtime/claude/pty-provider.js';
import { getClaudeProjectDir } from '../../../../../runtime/claude/session-jsonl.js';
import { CodexRoutingProvider } from '../../../../../runtime/codex/routing-provider.js';
import { findSessionFileByThreadId } from '../../../../../runtime/codex/tmux-provider.js';
import { _testOnly, registerAdapter } from '../../../../../bridge/host/manager.js';
import { listAutoTasks } from '../../../../../bridge/automation/auto-tasks.js';
import { getSessionActiveRuntime, getSessionWorkingDirectory } from '../../../../../domain/session-runtime.js';
import type { LLMProvider, StreamChatParams } from '../../../../../runtime/contracts.js';
import {
  BRIDGE_TEST_DATA_DIR,
  initBridgeTestContext,
  inboundMessage,
  makeBridgeSettings,
  RecordingAdapter,
  resetBridgeTestState,
  writeCodexSessionJsonlFixture,
} from '../../../../helpers/bridge/test-bridge-utils.js';

interface RecordedLlmCall {
  sessionId: string;
  runtime?: string;
  codexThreadId: string;
  prompt: string;
  codexProvider?: string;
  claudeExecutable?: string;
  sandboxMode?: string;
  networkAccessEnabled?: boolean;
  modelReasoningEffort?: string;
  permissionMode?: string;
  codexMode?: string;
}

interface ControlledLlmCall extends RecordedLlmCall {
  controller: ReadableStreamDefaultController<string>;
}

function writeClaudeJsonlFixture(params: {
  homeDir: string;
  cwd: string;
  sessionId: string;
  timestamp?: string;
  text?: string;
}): string {
  const projectDir = getClaudeProjectDir(params.cwd, params.homeDir);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${params.sessionId}.jsonl`);
  fs.writeFileSync(filePath, [
    JSON.stringify({
      type: 'user',
      uuid: `${params.sessionId}-user`,
      sessionId: params.sessionId,
      cwd: params.cwd,
      timestamp: params.timestamp || '2026-06-02T00:00:00.000Z',
      message: { role: 'user', content: params.text || 'hello claude e2e' },
    }),
  ].join('\n') + '\n', 'utf-8');
  return filePath;
}

class StreamingRecordingAdapter extends RecordingAdapter {
  readonly streamEvents: Array<{
    kind: 'message_start' | 'message_end' | 'mirror_start' | 'metadata' | 'status' | 'text' | 'end';
    chatId: string;
    streamKey?: string;
    text?: string;
    status?: string;
  }> = [];
  readonly reactions: Array<{ action: 'add' | 'remove'; messageId: string; emojiType?: string; reactionId?: string }> = [];
  private activeStreams = new Set<string>();

  onMessageStart(chatId: string, streamKey?: string): void {
    this.streamEvents.push({ kind: 'message_start', chatId, streamKey });
  }

  onMessageEnd(chatId: string, streamKey?: string): void {
    this.streamEvents.push({ kind: 'message_end', chatId, streamKey });
  }

  onMirrorStreamStart(chatId: string, streamKey?: string): void {
    if (streamKey) this.activeStreams.add(streamKey);
    this.streamEvents.push({ kind: 'mirror_start', chatId, streamKey });
  }

  onStreamMetadata(chatId: string, _metadata: unknown, streamKey?: string): void {
    this.streamEvents.push({ kind: 'metadata', chatId, streamKey });
  }

  onStreamStatus(chatId: string, statusText: string, streamKey?: string): void {
    if (streamKey) this.activeStreams.add(streamKey);
    this.streamEvents.push({ kind: 'status', chatId, streamKey, text: statusText });
  }

  onStreamText(chatId: string, fullText: string, streamKey?: string): void {
    if (streamKey) this.activeStreams.add(streamKey);
    this.streamEvents.push({ kind: 'text', chatId, streamKey, text: fullText });
  }

  async onStreamEnd(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    streamKey?: string,
  ): Promise<boolean> {
    this.streamEvents.push({ kind: 'end', chatId, streamKey, status, text: responseText });
    if (streamKey) this.activeStreams.delete(streamKey);
    return true;
  }

  supportsStructuredStreamingUi(): boolean {
    return true;
  }

  hasActiveStreamingUi(_chatId: string, streamKey?: string): boolean {
    return Boolean(streamKey && this.activeStreams.has(streamKey));
  }

  async addMessageReaction(messageId: string, emojiType: string): Promise<string | null> {
    const reactionId = `reaction-${this.reactions.length + 1}`;
    this.reactions.push({ action: 'add', messageId, emojiType, reactionId });
    return reactionId;
  }

  async removeMessageReaction(messageId: string, reactionId: string, emojiType?: string): Promise<void> {
    this.reactions.push({ action: 'remove', messageId, emojiType, reactionId });
  }
}

function waitForCondition(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Timed out waiting for condition.'));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function createRecordingLlm(calls: RecordedLlmCall[]): LLMProvider {
  return {
    streamChat(params: StreamChatParams): ReadableStream<string> {
      calls.push({
        sessionId: params.sessionId,
        runtime: params.runtime,
        codexThreadId: params.codexThreadId || '',
        prompt: params.prompt,
        codexProvider: params.codexProvider,
        claudeExecutable: params.claudeExecutable,
        sandboxMode: params.sandboxMode,
        networkAccessEnabled: params.networkAccessEnabled,
        modelReasoningEffort: params.modelReasoningEffort,
        permissionMode: params.permissionMode,
        codexMode: params.codexMode,
      });
      return new ReadableStream({
        start(controller) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: `回复：${params.prompt}` })}\n`);
          controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }) })}\n`);
          controller.close();
        },
      });
    },
  };
}

function createControlledLlm(calls: ControlledLlmCall[]): LLMProvider {
  return {
    streamChat(params: StreamChatParams): ReadableStream<string> {
      return new ReadableStream({
        start(controller) {
          calls.push({
            sessionId: params.sessionId,
            codexThreadId: params.codexThreadId || '',
            prompt: params.prompt,
            controller,
          });
        },
      });
    },
  };
}

function finishControlledCall(call: ControlledLlmCall, responseText: string): void {
  call.controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: responseText })}\n`);
  call.controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }) })}\n`);
  call.controller.close();
}

function readAuditSummaries(): string[] {
  const auditJsonPath = path.join(BRIDGE_TEST_DATA_DIR, 'audit.json');
  const auditJsonlPath = path.join(BRIDGE_TEST_DATA_DIR, 'audit.jsonl');
  const jsonRows = fs.existsSync(auditJsonPath)
    ? JSON.parse(fs.readFileSync(auditJsonPath, 'utf-8')) as Array<{ summary?: string }>
    : [];
  const jsonlRows = fs.existsSync(auditJsonlPath)
    ? fs.readFileSync(auditJsonlPath, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { summary?: string })
    : [];
  return [...jsonRows, ...jsonlRows].map((entry) => entry.summary || '');
}

function writeAutoScript(name: string, body: string): string {
  const root = path.join(process.env.CODEX_HOME!, 'auto-scripts');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, `clk-auto-${name}-`));
  const scriptPath = path.join(dir, `${name}.sh`);
  fs.writeFileSync(scriptPath, body, 'utf-8');
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function latestCreatedGroupAddress(adapter: RecordingAdapter): { channelType: 'feishu'; chatId: string } {
  const group = adapter.createdGroups.at(-1);
  assert.ok(group);
  return { channelType: 'feishu', chatId: group.chatId };
}

async function createNewGroupSession(
  store: ReturnType<typeof initBridgeTestContext>,
  adapter: RecordingAdapter,
  sourceAddress: { channelType: 'feishu'; chatId: string },
  commandText: string,
  messageId: string,
): Promise<{
  address: { channelType: 'feishu'; chatId: string };
  binding: NonNullable<ReturnType<typeof store.getChannelChat>>;
}> {
  await _testOnly.handleMessage(adapter, inboundMessage(sourceAddress, commandText, messageId));
  const address = latestCreatedGroupAddress(adapter);
  const binding = store.getChannelChat(address.channelType, address.chatId);
  assert.ok(binding);
  return { address, binding };
}

function createExistingChannelChat(
  store: ReturnType<typeof initBridgeTestContext>,
  address: { channelType: 'feishu'; chatId: string; chatKind?: 'group' | 'direct' },
  options: {
    workDir: string;
    name?: string;
    model?: string;
  },
): {
  binding: NonNullable<ReturnType<typeof store.getChannelChat>>;
  sessionId: string;
} {
  const session = store.createSession(
    options.name || address.chatId,
    options.model || 'test-model',
    undefined,
    options.workDir,
  );
  const binding = store.upsertChannelChat({
    channelType: address.channelType,
    chatId: address.chatId,
    chatKind: address.chatKind,
    bridgeSessionId: session.id,
  });
  return { binding, sessionId: session.id };
}

function appendCodexMirrorTurn(filePath: string, params: {
  timestampPrefix: string;
  turnId: string;
  userText: string;
  assistantText: string;
}): void {
  fs.appendFileSync(filePath, [
    {
      timestamp: `${params.timestampPrefix}:01.000Z`,
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: params.turnId,
      },
    },
    {
      timestamp: `${params.timestampPrefix}:02.000Z`,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: params.userText,
      },
    },
    {
      timestamp: `${params.timestampPrefix}:03.000Z`,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: params.assistantText }],
      },
    },
    {
      timestamp: `${params.timestampPrefix}:04.000Z`,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: params.turnId,
        last_agent_message: params.assistantText,
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
}

function installFakeTmux(): { binDir: string; logPath: string; statePath: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-e2e-fake-tmux-'));
  const logPath = path.join(binDir, 'tmux.log');
  const statePath = path.join(binDir, 'sessions.txt');
  const tmuxPath = path.join(binDir, 'tmux');
  fs.writeFileSync(logPath, '', 'utf-8');
  fs.writeFileSync(statePath, '', 'utf-8');
  fs.writeFileSync(tmuxPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TMUX_FAKE_LOG"
state="$TMUX_FAKE_STATE"
case "$1" in
  has-session)
    target="$3"
    if grep -Fx -- "$target" "$state" >/dev/null 2>&1; then
      exit 0
    fi
    exit 1
    ;;
  new-session)
    name=""
    prev=""
    for arg in "$@"; do
      if [[ "$prev" == "-s" ]]; then
        name="$arg"
        break
      fi
      prev="$arg"
    done
    if [[ -n "$name" ]] && ! grep -Fx -- "$name" "$state" >/dev/null 2>&1; then
      printf '%s\\n' "$name" >> "$state"
    fi
    if [[ -n "$name" ]]; then
      safe_name="\${name//[^A-Za-z0-9_.-]/_}"
      rm -f "\${state}.\${safe_name}.captures"
    fi
    exit 0
    ;;
  kill-session)
    target="$3"
    tmp="\${state}.tmp"
    grep -Fxv -- "$target" "$state" > "$tmp" 2>/dev/null || true
    mv "$tmp" "$state"
    safe_target="\${target//[^A-Za-z0-9_.-]/_}"
    rm -f "\${state}.\${safe_target}.captures"
    exit 0
    ;;
  send-keys)
    exit 0
    ;;
  capture-pane)
    target=""
    prev=""
    for arg in "$@"; do
      if [[ "$prev" == "-t" ]]; then
        target="$arg"
        break
      fi
      prev="$arg"
    done
    ready_after="\${TMUX_FAKE_READY_AFTER_CAPTURES:-2}"
    safe_target="\${target//[^A-Za-z0-9_.-]/_}"
    count_file="\${state}.\${safe_target:-default}.captures"
    count=0
    [[ -f "$count_file" ]] && count="$(cat "$count_file" 2>/dev/null || printf '0')"
    count=$((count + 1))
    printf '%s\\n' "$count" > "$count_file"
    if [[ "$count" -le "$ready_after" ]]; then
      printf 'Codex starting...\\n'
    else
      printf 'OpenAI Codex\\n› \\n'
    fi
    exit 0
    ;;
  list-sessions)
    while IFS= read -r name; do
      [[ -n "$name" ]] && printf '%s\\t1\\t0\\t0\\t0\\n' "$name"
    done < "$state"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`, 'utf-8');
  fs.chmodSync(tmuxPath, 0o755);
  return { binDir, logPath, statePath };
}

function installFailingCodexCli(): { binDir: string; executable: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-e2e-failing-codex-'));
  const executable = path.join(binDir, 'codex');
  fs.writeFileSync(executable, `#!/usr/bin/env bash
printf 'fake local bootstrap failed\\n' >&2
exit 42
`, 'utf-8');
  fs.chmodSync(executable, 0o755);
  return { binDir, executable };
}

function installFakeClaudeExecutable(): { binDir: string; logPath: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-e2e-fake-claude-'));
  const logPath = path.join(binDir, 'claude.log');
  const claudePath = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.writeFileSync(logPath, '', 'utf-8');
  fs.writeFileSync(claudePath, `#!/usr/bin/env bash
{
  printf 'argv:'
  printf ' <%s>' "$0" "$@"
  printf '\\n'
  printf 'cwd:%s\\n' "$PWD"
} >> "$CLAUDE_FAKE_LOG"
printf 'Claude Code v0.0.0\\n❯ ? for shortcuts\\n'
IFS= read -r prompt || true
printf 'prompt:%s\\n' "$prompt" >> "$CLAUDE_FAKE_LOG"
printf '\\nFAKE_CLAUDE_RESPONSE:%s\\n' "$prompt"
sleep 0.1
`, 'utf-8');
  fs.chmodSync(claudePath, 0o755);
  return { binDir, logPath };
}

describe('bridge command e2e', () => {
  beforeEach(() => {
    resetBridgeTestState({ cleanCodexHome: true });
    _testOnly.resetStateForTests();
  });

  afterEach(() => {
    _testOnly.resetStateForTests();
    _testOnlyPtyScreens.clear();
    _testOnlyClaudePty.clear();
  });

  it('handles /new, /his limit, and /his msg through the bridge manager entrypoint', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-history-e2e-'));

    const { address: groupAddress, binding } = await createNewGroupSession(
      store,
      adapter,
      address,
      `/new history ${workDir}`,
      'incoming-new',
    );
    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    assert.equal(getSessionWorkingDirectory(store.getSession(binding.bridgeSessionId)), workDir);

    store.addMessage(binding.bridgeSessionId, 'user', '端到端用户消息');
    store.addMessage(binding.bridgeSessionId, 'assistant', '**端到端助手回复**\n\n```ts\nconst ok = true;\n```');

    await _testOnly.handleMessage(adapter, inboundMessage(groupAddress, '/his limit 12', 'incoming-limit'));
    assert.equal(loadConfig().historyMessageLimit, 12);

    await _testOnly.handleMessage(adapter, inboundMessage(groupAddress, '/ui off', 'incoming-ui-detail-off'));
    assert.equal('showToolCallDetails' in loadConfig(), false);
    assert.match(adapter.sent.at(-1)?.text || '', /UI 显示设置已简化/);
    assert.match(adapter.sent.at(-1)?.text || '', /工具详情.*始终显示/s);

    await _testOnly.handleMessage(adapter, inboundMessage(groupAddress, '/ui on', 'incoming-ui-detail-on'));
    assert.equal('showToolCallDetails' in loadConfig(), false);
    assert.match(adapter.sent.at(-1)?.text || '', /工具详情.*始终显示/s);

    await _testOnly.handleMessage(adapter, inboundMessage(groupAddress, '/his msg', 'incoming-history-msg'));

    const lastText = adapter.sent.at(-1)?.text || '';
    assert.match(lastText, /最近对话（msg）/);
    assert.match(lastText, /返回条数.*2 \/ 配置 12/s);
    assert.match(lastText, /端到端用户消息/);
    assert.match(lastText, /端到端助手回复/);
    const richCard = adapter.sent.at(-1)?.richCard;
    assert.equal(richCard?.title, '最近对话');
    assert.equal(richCard?.template, 'blue');
    assert.equal(richCard?.sections.length, 3);
    assert.equal(richCard?.sections[0]?.fields?.[1]?.[1], 'Bridge 缓存');
    assert.match(richCard?.sections[2]?.markdown || '', /\*\*端到端助手回复\*\*/);
    assert.doesNotMatch(richCard?.sections[2]?.markdown || '', /^```text/);

    await _testOnly.handleMessage(adapter, inboundMessage(groupAddress, '/his msg 1', 'incoming-history-msg-once'));
    assert.equal(loadConfig().historyMessageLimit, 12);
    const temporaryText = adapter.sent.at(-1)?.text || '';
    assert.match(temporaryText, /最近对话（msg）/);
    assert.match(temporaryText, /返回条数.*1 \/ 本次 1（配置 12）/s);
    assert.doesNotMatch(temporaryText, /端到端用户消息/);
    assert.match(temporaryText, /端到端助手回复/);
  });

  it('handles /auto-script skill install and uninstall idempotently', async () => {
    initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-auto-skill-e2e' } as const;
    const skillDir = path.join(process.env.CODEX_HOME!, 'skills', 'codelark-auto');
    const legacySkillDir = path.join(process.env.CODEX_HOME!, 'skills', 'codelark-auto');

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto-script skill install', 'incoming-auto-skill-install'));
    assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')));
    const installedSkill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    assert.match(installedSkill, /^name:\s*codelark-auto$/m);
    assert.match(installedSkill, /\/auto-script new <absolute-script-path> <times>/);
    assert.match(installedSkill, /~\/\.codex\/auto-scripts/);
    assert.match(adapter.sent.at(-1)?.text || '', /已安装自动脚本 skill|自动脚本 skill 已存在/);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto-script skill install', 'incoming-auto-skill-install-again'));
    assert.match(adapter.sent.at(-1)?.text || '', /自动脚本 skill 已存在/);

    fs.mkdirSync(legacySkillDir, { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), 'skills', 'codelark-auto', 'SKILL.md'), path.join(legacySkillDir, 'SKILL.md'));
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto-script skill uninstall', 'incoming-auto-skill-uninstall'));
    assert.equal(fs.existsSync(path.join(skillDir, 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(legacySkillDir, 'SKILL.md')), false);
    assert.match(adapter.sent.at(-1)?.text || '', /已删除自动脚本 skill/);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto-script skill uninstall', 'incoming-auto-skill-uninstall-again'));
    assert.match(adapter.sent.at(-1)?.text || '', /自动脚本 skill 未安装/);
  });

  it('runs the /auto text command chain from list to create, refresh, remove, and refresh', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-auto-text-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-auto-text-work-'));
    const scriptPath = writeAutoScript('slow_text_timer', '#!/usr/bin/env bash\nsleep 30\nprintf "text timer prompt\\n"\n');

    createExistingChannelChat(store, address, { workDir, name: 'auto-text' });
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto ls', 'incoming-auto-text-ls-empty'));
    assert.match(adapter.sent.at(-1)?.text || '', /当前聊天没有自动化任务/);
    assert.equal(adapter.sent.at(-1)?.richCard?.title, '当前聊天自动化任务（0）');
    assert.deepEqual(adapter.sent.at(-1)?.richCard?.actions?.flat().map((action) => action.text), ['安装skill', '刷新']);

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/auto-script new ${scriptPath} 3`, 'incoming-auto-text-new'));
    assert.match(adapter.sent.at(-1)?.text || '', /已创建自动化任务/);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto ls', 'incoming-auto-text-ls-created'));
    assert.match(adapter.sent.at(-1)?.text || '', /当前聊天自动化任务/);
    assert.match(adapter.sent.at(-1)?.text || '', /slow_text_timer/);
    assert.equal(adapter.sent.at(-1)?.richCard?.template, 'green');
    assert.equal(adapter.sent.at(-1)?.richCard?.updateKey, `thread-card:auto:${address.channelType}:${address.chatId}`);
    assert.equal(adapter.sent.at(-1)?.richCard?.updateTtlMs, null);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto rm 1', 'incoming-auto-text-rm'));
    assert.match(adapter.sent.at(-1)?.text || '', /已删除自动化任务/);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto ls', 'incoming-auto-text-ls-removed'));
    assert.match(adapter.sent.at(-1)?.text || '', /当前聊天没有自动化任务/);
    assert.equal(adapter.sent.at(-1)?.richCard?.title, '当前聊天自动化任务（0）');
  });

  it('runs /auto interval prompts in a fresh session for each trigger', async () => {
    const calls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({ dynamicSettings: true, llm: createRecordingLlm(calls) });
    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const address = { channelType: 'feishu', chatId: 'chat-auto-interval-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-auto-interval-work-'));

    const { sessionId: ownerSessionId } = createExistingChannelChat(store, address, {
      workDir,
      name: 'auto-interval',
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto 1 interval prompt', 'incoming-auto-interval-new'));
    assert.match(adapter.sent.at(-1)?.text || '', /已创建定时自动任务/);
    await waitForCondition(() => calls.length >= 2, 3500);

    assert.deepEqual(calls.slice(0, 2).map((call) => call.prompt), ['interval prompt', 'interval prompt']);
    assert.notEqual(calls[0].sessionId, ownerSessionId);
    assert.notEqual(calls[1].sessionId, ownerSessionId);
    assert.notEqual(calls[0].sessionId, calls[1].sessionId);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto ls', 'incoming-auto-interval-ls'));
    const listText = adapter.sent.at(-1)?.text || '';
    assert.match(listText, /每 1 s/);
    assert.match(listText, /interval prompt/);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto rm 1', 'incoming-auto-interval-rm'));
    assert.equal(listAutoTasks({ bridgeSessionId: ownerSessionId, includeCompleted: true }).length, 0);
  });

  it('runs the /auto rich card chain with refresh, set, remove, and refresh callbacks', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-auto-card-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-auto-card-work-'));
    const scriptPath = writeAutoScript('slow_card_timer', '#!/usr/bin/env bash\nsleep 30\nprintf "card timer prompt\\n"\n');

    createExistingChannelChat(store, address, {
      workDir,
      name: 'auto-card',
    });
    await _testOnly.handleMessage(adapter, inboundMessage(address, `/auto-script new ${scriptPath} 2`, 'incoming-auto-card-new'));
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto ls', 'incoming-auto-card-ls'));

    const card = adapter.sent.at(-1)?.richCard;
    assert.ok(card);
    assert.equal(card.template, 'green');
    assert.equal(card.title, '当前聊天自动化任务（1）');
    assert.equal(card.updateKey, `thread-card:auto:${address.channelType}:${address.chatId}`);
    assert.equal(card.updateTtlMs, null);
    const selectCallback = card.selects?.[0]?.options?.[0]?.callbackData;
    const setCallback = card.actions?.[0]?.find((action) => action.text === '设为1次')?.callbackData;
    const rmCallback = card.actions?.[0]?.find((action) => action.text === '删除')?.callbackData;
    const refreshCallback = card.actions?.[0]?.find((action) => action.text === '刷新')?.callbackData;
    assert.ok(selectCallback);
    assert.ok(setCallback);
    assert.ok(rmCallback);
    assert.ok(refreshCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'auto-card-callback-message'),
      callbackData: selectCallback,
      callbackMessageId: 'auto-card-message',
    });
    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'auto-card-callback-message'),
      callbackData: setCallback,
      callbackMessageId: 'auto-card-message',
    });
    assert.match(adapter.sent.at(-1)?.text || '', /已更新自动化任务次数/);
    assert.match(adapter.sent.at(-1)?.text || '', /总次数.*1/s);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'auto-card-callback-message'),
      callbackData: rmCallback,
      callbackMessageId: 'auto-card-message',
    });
    assert.match(adapter.sent.at(-1)?.text || '', /已删除自动化任务/);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'auto-card-refresh-message'),
      callbackData: refreshCallback,
      callbackMessageId: 'auto-card-message',
    });
    assert.match(adapter.sent.at(-1)?.text || '', /当前聊天没有自动化任务/);
  });

  it('delivers /auto SDK final output for a still-bound session without duplicate mirror output', async () => {
    const calls: ControlledLlmCall[] = [];
    const store = initBridgeTestContext({ dynamicSettings: true, llm: createControlledLlm(calls) });
    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-auto-sdk-mirror-e2e' } as const;
    const threadId = 'auto-sdk-mirror-thread-0000000001';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-auto-sdk-mirror-'));
    const fixture = writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [{
        timestamp: '2026-05-28T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: '2026-05-28T00:00:00.000Z',
          cwd: workDir,
          originator: 'Codex CLI',
        },
      }],
    });
    const scriptPath = writeAutoScript('instant_sdk_mirror_timer', '#!/usr/bin/env bash\nprintf "auto sdk prompt\\n"\n');

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${threadId}`, 'incoming-auto-sdk-mirror-bind'));
    const binding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(binding);
    await _testOnly.reconcileMirrorSubscriptions();
    assert.ok(bridgeState.mirrorSubscriptions.has(binding.id));

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/auto-script new ${scriptPath} 1`, 'incoming-auto-sdk-mirror-new'));
    await waitForCondition(() => calls.length === 1, 3000);
    assert.equal(calls[0].sessionId, binding.bridgeSessionId);
    assert.equal(calls[0].prompt, 'auto sdk prompt');
    assert.equal(_testOnly.isMirrorSuppressed(binding.bridgeSessionId), true);

    appendCodexMirrorTurn(fixture.sessionPath, {
      timestampPrefix: '2026-05-28T00:01',
      turnId: 'turn-auto-sdk-mirror',
      userText: 'auto sdk prompt',
      assistantText: 'duplicate mirror final',
    });
    await _testOnly.reconcileMirrorSubscriptions();
    assert.doesNotMatch(adapter.sent.map((message) => message.text).join('\n\n'), /duplicate mirror final/);

    finishControlledCall(calls[0], 'auto sdk final');
    await waitForCondition(() => adapter.sent.some((message) => /auto sdk final/.test(message.text)));
    const sentText = adapter.sent.map((message) => message.text).join('\n\n');
    assert.match(sentText, /auto sdk final/);
    assert.doesNotMatch(sentText, /回复已跳过/);
    assert.doesNotMatch(sentText, /duplicate mirror final/);
  });

  it('stops /auto task after configured times and set restarts from zero', async () => {
    const calls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({ dynamicSettings: true, llm: createRecordingLlm(calls) });
    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const address = { channelType: 'feishu', chatId: 'chat-auto-times-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-auto-times-work-'));
    const scriptPath = writeAutoScript('instant_times_timer', '#!/usr/bin/env bash\nprintf "times prompt\\n"\n');

    const { sessionId } = createExistingChannelChat(store, address, {
      workDir,
      name: 'auto-times',
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/auto-script new ${scriptPath} 2`, 'incoming-auto-times-new'));
    await waitForCondition(() => calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.prompt), ['times prompt', 'times prompt']);

    const completedTask = listAutoTasks({ bridgeSessionId: sessionId, includeCompleted: true })[0];
    assert.equal(completedTask.times, 2);
    assert.equal(completedTask.triggeredCount, 2);
    assert.equal(completedTask.status, 'completed');

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/auto set 1 1', 'incoming-auto-times-set'));
    assert.match(adapter.sent.at(-1)?.text || '', /已更新自动化任务次数/);
    await waitForCondition(() => calls.length === 3);
    await waitForCondition(() => {
      const task = listAutoTasks({ bridgeSessionId: sessionId, includeCompleted: true })[0];
      return task.triggeredCount === 1 && task.status === 'completed';
    });

    const resetTask = listAutoTasks({ bridgeSessionId: sessionId, includeCompleted: true })[0];
    assert.equal(resetTask.times, 1);
    assert.equal(resetTask.triggeredCount, 1);
    assert.equal(resetTask.status, 'completed');
    assert.equal(calls[2].sessionId, sessionId);
    assert.equal(calls[2].prompt, 'times prompt');
  });

  it('applies Codex thread card buttons to the currently selected dropdown option', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-card-actions' } as const;
    const threadId = '33333333-3333-4333-8333-333333333333';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-thread-card-'));
    writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [{
        timestamp: '2026-05-28T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: '2026-05-28T00:00:00.000Z',
          cwd: workDir,
          originator: 'Codex CLI',
        },
      }],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-thread-card-list'));
    const card = adapter.sent.at(-1)?.richCard;
    assert.ok(card);
    assert.match(card.updateKey || '', /^thread-card:global:/);
    assert.equal(card.updateTtlMs, null);
    const selectCallback = card.tableBlocks?.[0]?.selects?.[0]?.options?.[0]?.callbackData;
    const switchCallback = card.tableBlocks?.[0]?.actions?.[0]?.[0]?.callbackData;
    assert.equal(card.tableBlocks?.[0]?.actions?.[0]?.[0]?.text, '接管');
    assert.ok(selectCallback);
    assert.ok(switchCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-1'),
      callbackData: selectCallback,
      callbackMessageId: 'reply-1',
    });
    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-1'),
      callbackData: switchCallback,
      callbackMessageId: 'reply-1',
    });

    const binding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(binding);
    assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, threadId);
    assert.match(adapter.sent.at(-1)?.text || '', /已切换到本地 Codex 会话/);
    assert.ok(adapter.sent.at(-1)?.richCard);
    assert.match(adapter.sent.at(-1)?.richCard?.updateKey || '', /^thread-card:global:/);
    assert.equal(adapter.sent.at(-1)?.richCard?.updateTtlMs, null);
    assert.equal(adapter.sent.at(-1)?.richCardUpdateMessageId, 'reply-1');
    assert.equal(adapter.sent.at(-1)?.richCard?.tableBlocks?.[0]?.selects?.[0]?.selectedCallbackData, selectCallback);
  });

  it('removes the temporary BridgeSession after /t unbind then switching to a local session', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-draft-cleanup' } as const;
    const threadId = '33333333-3333-4333-8333-333333333336';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-thread-draft-cleanup-'));
    writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [{
        timestamp: '2026-05-28T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: '2026-05-28T00:00:00.000Z',
          cwd: workDir,
          originator: 'Codex CLI',
        },
      }],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t unbind', 'incoming-thread-draft-unbind'));
    const draftBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(draftBinding);
    assert.equal(store.getSession(draftBinding.bridgeSessionId)?.session_type, 'normal');
    assert.equal(store.getSession(draftBinding.bridgeSessionId)?.hidden, true);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t 1', 'incoming-thread-draft-switch'));

    const active = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(active);
    assert.equal(store.getSession(active.bridgeSessionId)?.runtime?.codex?.threadId, threadId);
    assert.equal(store.getSession(draftBinding.bridgeSessionId), null);
    assert.match(adapter.sent.at(-1)?.text || '', /已切换到本地 Codex 会话/);
  });

  it('renders /t Codex and Claude Code runtime groups in the mock app card', async () => {
    initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-card-runtime-groups' } as const;
    const codexThreadId = '33333333-3333-4333-8333-333333333334';
    const claudeSessionId = '33333333-3333-4333-8333-333333333335';
    const codexWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-thread-card-groups-codex-'));
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-thread-card-groups-claude-home-'));
    const previousClaudeHome = process.env.CODELARK_CLAUDE_HOME;
    process.env.CODELARK_CLAUDE_HOME = claudeHome;
    writeCodexSessionJsonlFixture({
      threadId: codexThreadId,
      workDir: codexWorkDir,
      lines: [{
        timestamp: '2026-05-28T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: codexThreadId,
          timestamp: '2026-05-28T00:00:00.000Z',
          cwd: codexWorkDir,
          originator: 'Codex CLI',
        },
      }],
    });
    writeClaudeJsonlFixture({
      homeDir: claudeHome,
      cwd: '/tmp/thread-card-groups-claude',
      sessionId: claudeSessionId,
      timestamp: '2026-05-28T00:00:01.000Z',
      text: 'thread card groups claude',
    });

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-thread-card-runtime-groups'));
      const card = adapter.sent.at(-1)?.richCard;
      assert.ok(card);
      assert.equal(card.template, 'blue');
      assert.equal(card.panels, undefined);
      assert.equal(card.title, '');
      assert.equal(card.tableBlocks?.length, 1);
      assert.equal(card.tableBlocks?.[0]?.selects?.[0]?.id, 'codex_select');
      assert.equal(card.tableBlocks?.[0]?.selects?.[2]?.id, 'thread_runtime_select');
      assert.deepEqual(card.tableBlocks?.[0]?.actions?.map((row) => row.map((action) => action.text)), [['接管', '归档', '新建'], ['解绑', '刷新']]);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/t claude', 'incoming-thread-card-runtime-claude'));
      const claudeCard = adapter.sent.at(-1)?.richCard;
      assert.equal(claudeCard?.tableBlocks?.length, 1);
      assert.equal(claudeCard?.tableBlocks?.[0]?.selects?.[0]?.id, 'claude_select');
      assert.equal(claudeCard?.tableBlocks?.[0]?.selects?.[2]?.id, 'thread_runtime_select');
    } finally {
      if (previousClaudeHome === undefined) {
        delete process.env.CODELARK_CLAUDE_HOME;
      } else {
        process.env.CODELARK_CLAUDE_HOME = previousClaudeHome;
      }
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it('opens a named new-session form from the /t rich card create button', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-card-new-form', userId: 'ou-user' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-thread-card-new-form-'));
    createExistingChannelChat(store, address, { workDir, name: 'base-thread' });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-thread-card-new-form-list'));
    const card = adapter.sent.at(-1)?.richCard;
    const createAction = card?.tableBlocks?.flatMap((block) => block.actions?.flat() || []).find((action) => action.text === '新建');
    assert.ok(createAction?.callbackData);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-new-form'),
      callbackData: createAction.callbackData,
      callbackMessageId: 'reply-new-form',
    });

    const formCard = adapter.sent.at(-1)?.richCard;
    assert.equal(formCard?.title, '创建群聊会话');
    assert.equal(formCard?.form?.inputElementId, 'clk_input');
    assert.match(formCard?.form?.inputPlaceholder || '', /merge/);
    assert.equal(formCard?.form?.extraInputs?.[0]?.elementId, 'clk_path');
    assert.equal(formCard?.form?.extraInputs?.[0]?.defaultValue, workDir);
    const submitCallback = formCard?.form?.submitCallbackData;
    assert.ok(submitCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-new-form-submit'),
      callbackData: submitCallback,
      callbackMessageId: 'reply-new-form-submit',
      raw: {
        event: {
          action: {
            form_value: {
              clk_input: 'merge',
              clk_path: workDir,
            },
          },
        },
      },
    });

    assert.equal(adapter.createdGroups.at(-1)?.name, 'merge');
    const binding = store.getChannelChat(address.channelType, adapter.createdGroups.at(-1)?.chatId || '');
    assert.ok(binding);
    assert.equal(getSessionWorkingDirectory(store.getSession(binding.bridgeSessionId)), workDir);
    assert.match(adapter.sent.at(-1)?.text || '', /已创建群聊会话/);
  });

  it('opens the same named new-session form when the user sends bare /new', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-bare-new-form', userId: 'ou-user' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bare-new-form-'));
    const session = store.createSession('draft-like-thread', 'test-model', undefined, workDir, undefined, {
      sessionType: 'draft',
      hidden: true,
    });
    store.upsertChannelChat({
      channelType: address.channelType,
      chatId: address.chatId,
      chatKind: 'p2p',
      chatUserId: address.userId,
      bridgeSessionId: session.id,
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/new', 'incoming-bare-new-form'));

    const formCard = adapter.sent.at(-1)?.richCard;
    assert.equal(adapter.createdGroups.length, 0);
    assert.equal(formCard?.title, '创建群聊会话');
    assert.equal(formCard?.form?.inputElementId, 'clk_input');
    assert.equal(formCard?.form?.extraInputs?.[0]?.elementId, 'clk_path');
    assert.equal(formCard?.form?.extraInputs?.[0]?.defaultValue, workDir);
    const submitCallback = formCard?.form?.submitCallbackData;
    assert.ok(submitCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'incoming-bare-new-form-submit'),
      callbackData: submitCallback,
      callbackMessageId: 'incoming-bare-new-form-submit',
      raw: {
        event: {
          action: {
            form_value: {
              clk_input: 'merge',
              clk_path: '',
            },
          },
        },
      },
    });

    assert.equal(adapter.createdGroups.at(-1)?.name, 'merge');
    const binding = store.getChannelChat(address.channelType, adapter.createdGroups.at(-1)?.chatId || '');
    assert.ok(binding);
    assert.equal(getSessionWorkingDirectory(store.getSession(binding.bridgeSessionId)), workDir);
    assert.match(adapter.sent.at(-1)?.text || '', /已创建群聊会话/);
  });

  it('archives the selected Codex thread from the /t rich card', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-card-archive' } as const;
    const threadId = '33333333-3333-4333-8333-444444444444';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-thread-card-archive-'));
    const { sessionPath } = writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [{
        timestamp: '2026-05-28T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: '2026-05-28T00:00:00.000Z',
          cwd: workDir,
          originator: 'Codex CLI',
        },
      }],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-thread-card-archive-list'));
    const card = adapter.sent.at(-1)?.richCard;
    const selectCallback = card?.tableBlocks?.[0]?.selects?.[0]?.options?.[0]?.callbackData;
    const archiveCallback = card?.tableBlocks?.flatMap((block) => block.actions?.flat() || []).find((action) => action.text === '归档')?.callbackData;
    assert.ok(selectCallback);
    assert.ok(archiveCallback);

    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-archive-1'),
      callbackData: selectCallback,
      callbackMessageId: 'reply-archive-1',
    });
    await _testOnly.handleMessage(adapter, {
      ...inboundMessage(address, '', 'reply-archive-1'),
      callbackData: archiveCallback,
      callbackMessageId: 'reply-archive-1',
    });

    assert.match(adapter.sent.at(-1)?.text || '', /已归档本地 Codex 会话/);
    assert.equal(fs.existsSync(sessionPath), false);
    assert.equal(store.getChannelChat(address.channelType, address.chatId), null);
    assert.match(adapter.sent.at(-1)?.richCardUpdateMessageId || '', /reply-archive-1/);
  });

  it('orders /t global Codex entries by active time without showing Bridge-only sessions', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-global-thread-active-order-e2e' } as const;
    const bridgeWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-global-order-bridge-'));
    const localWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-global-order-local-'));
    const localThreadId = '019e81d3-e5b0-7540-ad14-4f3073b2703b';

    const { binding: bridgeBinding } = createExistingChannelChat(store, address, {
      workDir: bridgeWorkDir,
      name: 'bridge-old',
    });

    const { sessionPath } = writeCodexSessionJsonlFixture({
      threadId: localThreadId,
      workDir: localWorkDir,
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: localThreadId,
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: localWorkDir,
            originator: 'Codex CLI',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Newer local Codex thread' },
        },
      ],
    });
    const futureTime = new Date('2030-01-01T00:00:00.000Z');
    fs.utimesSync(sessionPath, futureTime, futureTime);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-global-order-list'));
    const listText = adapter.sent.at(-1)?.text || '';
    assert.match(listText, /本地会话（Codex1）/);
    assert.match(listText, new RegExp(localThreadId));
    assert.doesNotMatch(listText, new RegExp(bridgeBinding.id.slice(0, 8)));
    const cardJson = JSON.stringify(adapter.sent.at(-1)?.richCard);
    assert.match(cardJson, new RegExp(localThreadId));
    assert.doesNotMatch(cardJson, new RegExp(bridgeBinding.id.slice(0, 8)));

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t 1', 'incoming-global-order-use-local'));
    const active = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(active);
    assert.equal(store.getSession(active.bridgeSessionId)?.runtime?.codex?.threadId, localThreadId);
  });

  it('keeps renamed thread titles identical in /current and /t dropdown surfaces', async () => {
    initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-thread-title-sync' } as const;
    const threadId = '44444444-4444-4444-8444-444444444444';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-title-sync-'));
    writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: workDir,
            originator: 'Codex CLI',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '原始 Codex 标题' },
        },
      ],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t 1', 'incoming-title-bind'));
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t rename 统一后的标题', 'incoming-title-rename'));
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/', 'incoming-title-current'));

    assert.match(adapter.sent.at(-1)?.text || '', /标题.*统一后的标题/s);
    assert.match(adapter.sent.at(-1)?.text || '', /name.*统一后的标题/s);
    assert.match(adapter.sent.at(-1)?.text || '', /codex_title.*原始 Codex 标题/s);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t', 'incoming-title-list'));
    const listMessage = adapter.sent.at(-1);
    assert.match(listMessage?.text || '', /统一后的标题/);
    assert.doesNotMatch(listMessage?.text || '', /原始 Codex 标题/);
    assert.equal(listMessage?.richCard?.tableBlocks?.[0]?.table.rows?.[0]?.title, '**统一后的标题**');
    assert.equal(String(listMessage?.richCard?.tableBlocks?.[0]?.table.rows?.[0]?.title || '').replace(/\*/g, ''), '统一后的标题');
    assert.equal(listMessage?.richCard?.tableBlocks?.[0]?.selects?.[0]?.options?.[0]?.text, '1. 统一后的标题');

  });

  it('syncs /t rename to the current group chat name', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-rename-group', chatKind: 'group' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-rename-group-'));
    createExistingChannelChat(store, address, {
      workDir,
      name: '旧标题',
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/t rename 新标题', 'incoming-group-rename'));

    assert.equal(adapter.renamedGroups.length, 1);
    assert.deepEqual(adapter.renamedGroups[0], { chatId: address.chatId, name: '新标题' });
    assert.match(adapter.sent.at(-1)?.text || '', /群聊名称.*新标题/s);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('accepts a text confirmation after /clear sees a running session', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-clear-confirm-text', chatKind: 'group' } as const;
    const oldWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-text-old-'));
    const newWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-clear-text-new-'));
    const { binding } = createExistingChannelChat(store, address, {
      workDir: oldWorkDir,
      name: '旧对话',
    });
    store.updateSession(binding.bridgeSessionId, {
      runtime_status: 'running',
      health_status: 'running_active',
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/clear 新对话 ${newWorkDir}`, 'incoming-clear-text-prompt'));
    assert.equal(store.getChannelChat(address.channelType, address.chatId)?.bridgeSessionId, binding.bridgeSessionId);
    assert.match(adapter.sent.at(-1)?.text || '', /确认清空当前对话/);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '是', 'incoming-clear-text-confirm'));
    const nextBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(nextBinding);
    assert.notEqual(nextBinding!.bridgeSessionId, binding.bridgeSessionId);
    assert.equal(store.getSession(nextBinding!.bridgeSessionId)?.name, '新对话');
    assert.equal(getSessionWorkingDirectory(store.getSession(nextBinding!.bridgeSessionId)), newWorkDir);
    assert.equal(adapter.renamedGroups.length, 1);
    assert.deepEqual(adapter.renamedGroups[0], { chatId: address.chatId, name: '新对话' });
    assert.match(adapter.sent.at(-1)?.text || '', /已清空当前聊天上下文/);
    assert.match(adapter.sent.at(-1)?.text || '', /在当前聊天上下文创建一个新的对话/);
    assert.match(adapter.sent.at(-1)?.text || '', /\/t.*重新附加到之前的对话/s);
    assert.doesNotMatch(adapter.sent.at(-1)?.text || '', /会创建一个新的群聊/);
  });

  it('starts tmux provider with current permissions and routes tmux-provider messages through the bridge entrypoint', async () => {
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-e2e-'));

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime',
      });
      const normalThreadId = '019e46bc-f466-71d3-a186-a2ce89051958';
      const normalTmuxSession = `codex_${normalThreadId}`;
      store.updateSessionCodexThreadId(binding.bridgeSessionId, normalThreadId);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/sandbox read-only', 'incoming-runtime-sandbox'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/network on', 'incoming-runtime-network'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/r minimal', 'incoming-runtime-reasoning-minimal'));
      assert.match(adapter.sent.at(-1)?.text || '', /已更新思考级别/);
      assert.match(adapter.sent.at(-1)?.text || '', /禁用 web search/);
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/r high', 'incoming-runtime-reasoning'));
      const beforeProviderSentCount = adapter.sent.length;
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-runtime-provider'));
      const providerMessages = adapter.sent.slice(beforeProviderSentCount).map((message) => message.text).join('\n\n');
      assert.doesNotMatch(providerMessages, /正在启动 tmux 后台会话/);
      assert.match(providerMessages, /已切换 Codex Provider/);

      const tmuxSession = store.getSession(binding.bridgeSessionId);
      assert.equal(tmuxSession?.runtime?.codex?.provider, 'tmux');
      assert.equal(tmuxSession?.runtime?.general?.tmuxSessionName, normalTmuxSession);
      assert.equal(tmuxSession?.runtime?.general?.autoEnter, true);
      assert.equal(tmuxSession?.runtime?.codex?.threadId, normalThreadId);

      const startLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(startLog, new RegExp(`has-session -t ${normalTmuxSession}`));
      assert.match(startLog, new RegExp(`new-session -d -s ${normalTmuxSession}`));
      assert.match(startLog, /-- .*codelark-shell-snapshot-[^ \n]+\.sh.*exec (?:\S+\/)?(?:codex|codelark-codex-[a-f0-9]+\.sh) --model test-model --sandbox read-only/);
      assert.doesNotMatch(startLog, /-- env .* codex/);
      assert.doesNotMatch(startLog, / new-session .* -e /);
      assert.match(startLog, new RegExp(`--cd ${workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(startLog, /--ask-for-approval on-request/);
      assert.match(startLog, /model_reasoning_effort="high"/);
      assert.match(startLog, /--config sandbox_workspace_write.network_access=true/);
      assert.match(startLog, new RegExp(`resume ${normalThreadId}`));

      const beforeRestartLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/provider tmux', 'incoming-runtime-provider-restart'));
      const restartResponse = adapter.sent.at(-1)?.text || '';
      const restartLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeRestartLog.length);
      assert.match(restartResponse, /同名 tmux session 已存在/);
      assert.match(restartResponse, /销毁并重新启动/);
      assert.match(restartLog, new RegExp(`has-session -t ${normalTmuxSession}`));
      assert.match(restartLog, new RegExp(`kill-session -t ${normalTmuxSession}`));
      assert.match(restartLog, new RegExp(`new-session -d -s ${normalTmuxSession}`));
      assert.match(restartLog, new RegExp(`resume ${normalThreadId}`));

      const beforeRoutingLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '普通消息', 'incoming-runtime-plain'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/goal 检查权限', 'incoming-runtime-unknown-command'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '//plan 下一步', 'incoming-runtime-escaped-command'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/tmux /compact', 'incoming-runtime-tmux-command'));

      const unknownCommandResponse = adapter.sent.find((message) => message.text.includes('未知命令：/goal'))?.text || '';
      assert.match(unknownCommandResponse, /未知命令：\/goal/);
      const routedLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeRoutingLog.length);
      assert.match(routedLog, new RegExp(`send-keys -t ${normalTmuxSession} -l 普通消息`));
      assert.doesNotMatch(routedLog, new RegExp(`send-keys -t ${normalTmuxSession} -l /goal 检查权限`));
      assert.match(routedLog, new RegExp(`send-keys -t ${normalTmuxSession} -l /plan 下一步`));
      assert.match(routedLog, new RegExp(`send-keys -t ${normalTmuxSession} -l /compact`));
      assert.ok((routedLog.match(new RegExp(`send-keys -t ${normalTmuxSession} Enter`, 'g')) || []).length >= 3);
      assert.ok(readAuditSummaries().some((summary) => (
        summary.includes('terminal append input delivered')
          && summary.includes('runtime=codex')
          && summary.includes('provider=tmux')
      )));
      assert.equal(store.getSession(binding.bridgeSessionId)?.health_status, 'running_active');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/clear tmux-mid-turn', 'incoming-runtime-clear-mid-turn'));
      assert.match(adapter.sent.at(-1)?.text || '', /确认清空当前对话/);
      assert.match(adapter.sent.at(-1)?.text || '', /mirror\/健康状态显示仍在运行/);
      assert.equal(adapter.sent.at(-1)?.richCard?.title, '确认清空当前对话');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/clear-cancel', 'incoming-runtime-clear-mid-turn-cancel'));
      assert.match(adapter.sent.at(-1)?.text || '', /已取消 \/clear/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/mode yolo', 'incoming-runtime-defer-mode'));
      assert.match(adapter.sent.at(-1)?.text || '', /已切换模式，请输入\/p tmux重启生效/);
      assert.match(adapter.sent.at(-1)?.text || '', /配置已保存/);
      assert.match(adapter.sent.at(-1)?.text || '', /不会影响已经启动的 Codex TUI/);
      assert.match(adapter.sent.at(-1)?.text || '', /\/p tmux/);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.mode, 'yolo');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/net off', 'incoming-runtime-defer-network'));
      assert.match(adapter.sent.at(-1)?.text || '', /已更新 Codex 网络/);
      assert.match(adapter.sent.at(-1)?.text || '', /重启后的后续请求中生效/);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.networkAccess, false);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/r minimal', 'incoming-runtime-defer-reasoning'));
      assert.match(adapter.sent.at(-1)?.text || '', /已更新思考级别/);
      assert.match(adapter.sent.at(-1)?.text || '', /配置已保存/);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.reasoningEffort, 'minimal');

      store.updateSession(binding.bridgeSessionId, { runtime: { codex: { model: 'old-model' } } });
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/model default', 'incoming-runtime-defer-model'));
      assert.match(adapter.sent.at(-1)?.text || '', /已恢复默认模型/);
      assert.match(adapter.sent.at(-1)?.text || '', /配置已保存/);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.model || undefined, undefined);

      const beforeStopLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/stop', 'incoming-runtime-stop-tmux-mid-turn'));
      const stopLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeStopLog.length);
      assert.match(adapter.sent.at(-1)?.text || '', /已发送停止按键/);
      assert.match(stopLog, new RegExp(`send-keys -t ${normalTmuxSession} C-c`));
      assert.equal(store.getSession(binding.bridgeSessionId)?.health_status, 'aborted');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p sdk', 'incoming-runtime-provider-sdk'));
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, 'sdk');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/m yolo', 'incoming-runtime-mode-yolo'));
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.mode, 'yolo');

      const yoloThreadId = '019e46bc-f466-71d3-a186-a2ce89051959';
      const yoloTmuxSession = `codex_${yoloThreadId}`;
      store.updateSessionCodexThreadId(binding.bridgeSessionId, yoloThreadId);
      const beforeYoloLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/provider tmux', 'incoming-runtime-provider-tmux-yolo'));
      const yoloLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeYoloLog.length);
      assert.match(yoloLog, new RegExp(`new-session -d -s ${yoloTmuxSession}`));
      assert.match(yoloLog, /-- .*codelark-shell-snapshot-[^ \n]+\.sh.*exec (?:\S+\/)?(?:codex|codelark-codex-[a-f0-9]+\.sh) --model test-model --dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(yoloLog, /-- env .* codex/);
      assert.doesNotMatch(yoloLog, / new-session .* -e /);
      assert.doesNotMatch(yoloLog, /--sandbox/);
      assert.doesNotMatch(yoloLog, /--ask-for-approval/);
      assert.match(yoloLog, new RegExp(`resume ${yoloThreadId}`));

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/', 'incoming-runtime-status'));
      const statusText = adapter.sent.at(-1)?.text || '';
      assert.match(statusText, /当前会话/);
      assert.match(statusText, /yolo/);
      assert.match(statusText, /tmux/);
      assert.match(statusText, /read-only/);
      assert.match(statusText, /disabled/);
      assert.match(statusText, /当前聊天正在使用 IM 会话/);
      assert.doesNotMatch(statusText, /当前聊天已绑定到一条共享会话/);
      assert.doesNotMatch(statusText, /还没有绑定本地 Codex 会话/);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('does not let the Codex tmux provider intercept plain messages after switching to Claude runtime', async () => {
    const calls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings({ bridge_default_provider: 'tmux' }),
      llm: createRecordingLlm(calls),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-claude-tmux-default' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-tmux-default-'));

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-claude',
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime claude', 'incoming-runtime-claude'));
      const claudeBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(claudeBinding);
      assert.notEqual(claudeBinding.bridgeSessionId, binding.bridgeSessionId);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.activeRuntime, 'claude');

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'hi', 'incoming-runtime-claude-plain'));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].runtime, 'claude');
      assert.equal(calls[0].sessionId, claudeBinding.bridgeSessionId);
      assert.equal(calls[0].prompt, 'hi');
      assert.equal(calls[0].codexProvider, 'tmux');
      assert.equal(calls[0].codexThreadId, '');
      assert.match(adapter.sent.at(-1)?.text || '', /回复：hi/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('streams Claude proxy JSONL through mirror cards without direct final text', async () => {
    const claudeSessionId = 'claude-proxy-jsonl-session';
    const calls: RecordedLlmCall[] = [];
    let transcriptPath = '';
    const llm: LLMProvider = {
      streamChat(params: StreamChatParams): ReadableStream<string> {
        calls.push({
          sessionId: params.sessionId,
          runtime: params.runtime,
          codexThreadId: params.codexThreadId || '',
          prompt: params.prompt,
          codexProvider: params.codexProvider,
          claudeExecutable: params.claudeExecutable,
        });
        return new ReadableStream({
          start(controller) {
            const cwd = params.workingDirectory || process.cwd();
            const projectDir = getClaudeProjectDir(cwd);
            fs.mkdirSync(projectDir, { recursive: true });
            transcriptPath = path.join(projectDir, `${claudeSessionId}.jsonl`);
            fs.writeFileSync(transcriptPath, `${JSON.stringify({
              type: 'user',
              uuid: 'claude-user-turn-1',
              sessionId: claudeSessionId,
              cwd,
              timestamp: '2026-06-02T04:25:30.000Z',
              message: { role: 'user', content: params.prompt },
            })}\n`, 'utf-8');
            controller.enqueue(`data: ${JSON.stringify({
              type: 'status',
              data: JSON.stringify({
                session_id: claudeSessionId,
                cwd,
                transcript_path: transcriptPath,
              }),
            })}\n`);
            setTimeout(() => {
              fs.appendFileSync(transcriptPath, `${JSON.stringify({
                type: 'assistant',
                uuid: 'claude-assistant-turn-1',
                parentUuid: 'claude-user-turn-1',
                sessionId: claudeSessionId,
                cwd,
                timestamp: '2026-06-02T04:25:31.000Z',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'Claude JSONL mirror response' }],
                },
              })}\n`, 'utf-8');
              controller.enqueue(`data: ${JSON.stringify({
                type: 'result',
                data: JSON.stringify({
                  session_id: claudeSessionId,
                  cwd,
                  transcript_path: transcriptPath,
                }),
              })}\n`);
              controller.close();
            }, 10);
          },
        });
      },
    };
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings({ bridge_default_provider: 'tmux' }),
      llm,
    });
    const adapter = new StreamingRecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-claude-jsonl-mirror' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-jsonl-mirror-'));

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-claude-jsonl-mirror',
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime claude', 'incoming-runtime-claude-jsonl-mirror'));
      const claudeBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(claudeBinding);
      assert.notEqual(claudeBinding.bridgeSessionId, binding.bridgeSessionId);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.activeRuntime, 'claude');
      const sentBeforePrompt = adapter.sent.length;

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'hi from claude jsonl', 'incoming-runtime-claude-jsonl-mirror-prompt'));
      await waitForCondition(() => adapter.streamEvents.some((event) => event.kind === 'end' && event.streamKey?.startsWith('mirror:')), 3000);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].runtime, 'claude');
      assert.equal(calls[0].prompt, 'hi from claude jsonl');
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.claude?.sessionId, claudeSessionId);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.claude?.cwd, workDir);

      const cardEvents = adapter.streamEvents.filter((event) => (
        event.kind === 'metadata'
        || event.kind === 'mirror_start'
        || event.kind === 'status'
        || event.kind === 'text'
        || event.kind === 'end'
      ));
      const firstResponseEvent = cardEvents.find((event) => (
        (event.kind === 'text' || event.kind === 'end')
        && /Claude JSONL mirror response/.test(event.text || '')
      ));
      const directImFinalEvents = adapter.streamEvents.filter((event) => (
        event.streamKey?.startsWith('im:')
        && (event.kind === 'text' || event.kind === 'end')
      ));
      assert.ok(cardEvents.length > 0);
      assert.equal(firstResponseEvent?.streamKey?.startsWith('mirror:'), true);
      assert.equal(directImFinalEvents.some((event) => /Claude JSONL mirror response/.test(event.text || '')), false);
      assert.ok(cardEvents.some((event) => event.kind === 'mirror_start' && event.streamKey?.startsWith('mirror:')));
      assert.ok(cardEvents.some((event) => event.kind === 'text' && /Claude JSONL mirror response/.test(event.text || '')));
      assert.ok(cardEvents.some((event) => event.kind === 'end' && event.status === 'completed' && /Claude JSONL mirror response/.test(event.text || '')));
      assert.equal(adapter.sent.slice(sentBeforePrompt).some((message) => /Claude JSONL mirror response/.test(message.text)), false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      if (transcriptPath) fs.rmSync(transcriptPath, { force: true });
    }
  });

  it('does not forward plain messages to an existing Codex tmux session after /p tmux then /runtime claude', async () => {
    const fakeTmux = installFakeTmux();
    const fakeClaude = installFakeClaudeExecutable();
    const previousEnv = {
      PATH: process.env.PATH,
      TMUX_FAKE_LOG: process.env.TMUX_FAKE_LOG,
      TMUX_FAKE_STATE: process.env.TMUX_FAKE_STATE,
      CLAUDE_FAKE_LOG: process.env.CLAUDE_FAKE_LOG,
      CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS,
      CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS,
      CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS: process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS,
    };
    process.env.PATH = [
      fakeTmux.binDir,
      fakeClaude.binDir,
      previousEnv.PATH || '',
    ].join(path.delimiter);
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;
    process.env.CLAUDE_FAKE_LOG = fakeClaude.logPath;
    process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = '1000';
    process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS = '250';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS = '3000';

    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings({ bridge_claude_provider: 'pty' }),
      llm: new CodexRoutingProvider(),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-claude-after-p-tmux' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-after-p-tmux-'));

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-claude-after-p-tmux',
      });
      const threadId = '019e46bc-f466-71d3-a186-a2ce89051960';
      const tmuxSession = `codex_${threadId}`;
      store.updateSessionCodexThreadId(binding.bridgeSessionId, threadId);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-runtime-p-tmux-before-claude'));
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, 'tmux');
      assert.match(fs.readFileSync(fakeTmux.logPath, 'utf-8'), new RegExp(`new-session -d -s ${tmuxSession}`));

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime claude', 'incoming-runtime-claude-after-p-tmux'));
      const claudeBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(claudeBinding);
      assert.notEqual(claudeBinding.bridgeSessionId, binding.bridgeSessionId);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.activeRuntime, 'claude');
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.codex, undefined);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p sdk', 'incoming-provider-while-claude'));
      assert.match(adapter.sent.at(-1)?.text || '', /已切换 Claude Provider/);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.claude?.provider, 'sdk');
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.codex, undefined);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, 'tmux');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p pty', 'incoming-provider-claude-back-to-pty'));
      assert.match(adapter.sent.at(-1)?.text || '', /已切换 Claude Provider/);
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.claude?.provider, 'pty');
      assert.equal(store.getSession(claudeBinding.bridgeSessionId)?.runtime?.codex, undefined);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, 'tmux');

      const tmuxLogBeforeClaudePrompt = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, 'hello claude real entrypoint', 'incoming-runtime-claude-plain-after-p-tmux'));

      const tmuxLogAfterClaudePrompt = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(tmuxLogBeforeClaudePrompt.length);
      assert.doesNotMatch(tmuxLogAfterClaudePrompt, /send-keys/);
      const claudeLog = fs.readFileSync(fakeClaude.logPath, 'utf-8');
      assert.match(claudeLog, /argv: <.*claude>/);
      assert.match(claudeLog, /prompt:hello claude real entrypoint/);
      assert.match(adapter.sent.map((message) => message.text).join('\n\n'), /FAKE_CLAUDE_RESPONSE:hello claude real entrypoint/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/pty-screen 20', 'incoming-claude-pty-screen'));
      const ptyScreenText = adapter.sent.at(-1)?.text || '';
      assert.match(ptyScreenText, /Runtime\s+claude|Runtime.*claude/s);
      assert.match(ptyScreenText, /Provider\s+pty|Provider.*pty/s);
      assert.match(ptyScreenText, /FAKE_CLAUDE_RESPONSE:hello claude real entrypoint/);
      assert.doesNotMatch(ptyScreenText, /当前会话不是 pty Provider/);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, 'tmux');
    } finally {
      _testOnlyClaudePty.clear();
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
      fs.rmSync(fakeClaude.binDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('shows Codex runtime state after switching back from a mock Claude Code pty session', async () => {
    const fakeClaude = installFakeClaudeExecutable();
    const previousEnv = {
      PATH: process.env.PATH,
      CLAUDE_FAKE_LOG: process.env.CLAUDE_FAKE_LOG,
      CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS,
      CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS,
      CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS: process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS,
      CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS: process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS,
    };
    process.env.PATH = [fakeClaude.binDir, previousEnv.PATH || ''].join(path.delimiter);
    process.env.CLAUDE_FAKE_LOG = fakeClaude.logPath;
    process.env.CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = '1000';
    process.env.CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS = '0';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS = '250';
    process.env.CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS = '3000';

    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings({ bridge_claude_provider: 'pty' }),
      llm: new CodexRoutingProvider(),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-codex-after-mock-claude' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-codex-after-claude-'));

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-codex-after-claude',
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime claude', 'incoming-runtime-claude-before-codex'));
      const claudeBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(claudeBinding);
      assert.notEqual(claudeBinding.bridgeSessionId, binding.bridgeSessionId);
      assert.equal(getSessionActiveRuntime(store.getSession(claudeBinding.bridgeSessionId)), 'claude');

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'hello mock claude', 'incoming-mock-claude-prompt'));
      assert.match(fs.readFileSync(fakeClaude.logPath, 'utf-8'), /prompt:hello mock claude/);
      assert.match(adapter.sent.map((message) => message.text).join('\n\n'), /FAKE_CLAUDE_RESPONSE:hello mock claude/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/runtime codex', 'incoming-runtime-codex-after-claude'));
      const codexBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.equal(codexBinding?.bridgeSessionId, binding.bridgeSessionId);
      assert.equal(codexBinding?.runtimeBridgeSessionIds?.claude, claudeBinding.bridgeSessionId);
      assert.equal(getSessionActiveRuntime(store.getSession(binding.bridgeSessionId)), undefined);
      assert.match(adapter.sent.at(-1)?.text || '', /Runtime.*codex/s);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/', 'incoming-runtime-codex-status-after-claude'));
      const statusText = adapter.sent.at(-1)?.text || '';
      assert.match(statusText, /当前会话/);
      assert.match(statusText, /runtime:\s*Codex/i);
      assert.doesNotMatch(statusText, /runtime:\s*Claude/i);
    } finally {
      _testOnlyClaudePty.clear();
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(fakeClaude.binDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('starts pty provider with current permissions and routes pty-provider messages through the bridge entrypoint', async () => {
    const bootstrapThreadIds = [
      '019e83a1-0000-7000-9000-000000000001',
      '019e83a1-0000-7000-9000-000000000002',
    ];
    let bootstrapIndex = 0;
    const llmCalls: RecordedLlmCall[] = [];
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-pty-e2e-'));
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: {
        streamChat(params: StreamChatParams): ReadableStream<string> {
          llmCalls.push({
            sessionId: params.sessionId,
            codexThreadId: params.codexThreadId || '',
            prompt: params.prompt,
            codexProvider: params.codexProvider,
            sandboxMode: params.sandboxMode,
            networkAccessEnabled: params.networkAccessEnabled,
            modelReasoningEffort: params.modelReasoningEffort,
            permissionMode: params.permissionMode,
            codexMode: params.codexMode,
          });
          const isBootstrap = params.prompt === 'Initialize this Codex session and wait for the next instruction.';
          const threadId = bootstrapThreadIds[Math.min(bootstrapIndex, bootstrapThreadIds.length - 1)];
          if (isBootstrap) bootstrapIndex += 1;
          return new ReadableStream({
            start(controller) {
              if (isBootstrap) {
                controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ session_id: threadId }) })}\n`);
                controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: threadId }) })}\n`);
              } else {
                controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: `pty回复：${params.prompt}` })}\n`);
                controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: params.codexThreadId }) })}\n`);
              }
              controller.close();
            },
          });
        },
      },
    });

    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-pty-e2e' } as const;

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-pty',
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/sandbox read-only', 'incoming-runtime-pty-sandbox'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/network on', 'incoming-runtime-pty-network'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/r high', 'incoming-runtime-pty-reasoning'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p pty', 'incoming-runtime-provider-pty'));
      assert.ok(adapter.sent.some((message) => /正在本地预创建 Codex thread/.test(message.text)));

      const ptySession = store.getSession(binding.bridgeSessionId);
      const ptyThreadId = ptySession?.runtime?.codex?.threadId || '';
      assert.equal(ptySession?.runtime?.codex?.provider, 'pty');
      assert.match(ptyThreadId, /^019e[0-9a-f-]+$/);
      assert.equal(ptySession?.runtime?.general?.tmuxSessionName, undefined);
      assert.equal(ptySession?.runtime?.general?.autoEnter, undefined);
      assert.match(adapter.sent.at(-1)?.text || '', /Provider.*pty/s);
      assert.match(adapter.sent.at(-1)?.text || '', new RegExp(`codex_thread_id.*${ptyThreadId}`, 's'));

      assert.equal(llmCalls.length, 0);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '普通消息', 'incoming-runtime-pty-plain'));
      _testOnlyPtyScreens.register({
        sessionId: binding.bridgeSessionId,
        threadId: ptyThreadId,
        cwd: workDir,
      });
      _testOnlyPtyScreens.append(binding.bridgeSessionId, 'pty screen line 1\npty screen line 2\npty screen line 3\n');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/pty-screen 2', 'incoming-runtime-pty-screen'));
      assert.match(adapter.sent.at(-1)?.text || '', /pty 当前屏幕状态/);
      assert.doesNotMatch(adapter.sent.at(-1)?.text || '', /pty screen line 1/);
      assert.match(adapter.sent.at(-1)?.text || '', /pty screen line 2/);
      assert.match(adapter.sent.at(-1)?.text || '', /pty screen line 3/);
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/tmux-screen', 'incoming-runtime-pty-wrong-screen'));
      assert.match(adapter.sent.at(-1)?.text || '', /tmux 未绑定|tmux session 不存在/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/goal 检查权限', 'incoming-runtime-pty-unknown-command'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, '//plan 下一步', 'incoming-runtime-pty-escaped-command'));

      const unknownCommandResponse = adapter.sent.find((message) => message.text.includes('未知命令：/goal'))?.text || '';
      assert.match(unknownCommandResponse, /未知命令：\/goal/);
      assert.deepEqual(llmCalls.map((call) => ({
        prompt: call.prompt,
        codexThreadId: call.codexThreadId,
        codexProvider: call.codexProvider,
      })), [
        {
          prompt: '普通消息',
          codexThreadId: ptyThreadId,
          codexProvider: 'pty',
        },
        {
          prompt: '/plan 下一步',
          codexThreadId: ptyThreadId,
          codexProvider: 'pty',
        },
      ]);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/mode yolo', 'incoming-runtime-pty-defer-mode'));
      assert.match(adapter.sent.at(-1)?.text || '', /已切换模式，请输入\/p pty重启生效/);
      assert.match(adapter.sent.at(-1)?.text || '', /配置已保存/);
      assert.match(adapter.sent.at(-1)?.text || '', /\/provider pty/);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.mode, 'yolo');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/net off', 'incoming-runtime-pty-defer-network'));
      assert.match(adapter.sent.at(-1)?.text || '', /已更新 Codex 网络/);
      assert.match(adapter.sent.at(-1)?.text || '', /不会影响已经启动的 Codex TUI/);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.networkAccess, false);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p sdk', 'incoming-runtime-pty-provider-sdk'));
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, 'sdk');

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/m yolo', 'incoming-runtime-pty-mode-yolo'));
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.mode, 'yolo');
      store.updateSessionCodexThreadId(binding.bridgeSessionId, '');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/provider pty', 'incoming-runtime-provider-pty-yolo'));
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, 'pty');
      assert.match(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId || '', /^019e[0-9a-f-]+$/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/', 'incoming-runtime-pty-status'));
      const statusText = adapter.sent.at(-1)?.text || '';
      assert.match(statusText, /当前会话/);
      assert.match(statusText, /yolo/);
      assert.match(statusText, /pty/);
      assert.match(statusText, /read-only/);
      assert.match(statusText, /disabled/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('bootstraps a codex thread before starting tmux provider and still allows /new ./sayhi', async () => {
    const bootstrapThreadId = '019e81d3-e5b0-7540-ad14-4f3073b2701d';
    const llmCalls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: {
        streamChat(params: StreamChatParams): ReadableStream<string> {
          llmCalls.push({
            sessionId: params.sessionId,
            codexThreadId: params.codexThreadId || '',
            prompt: params.prompt,
          });
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ session_id: bootstrapThreadId }) })}\n`);
              controller.close();
            },
          });
        },
      },
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-tmux-before-thread-e2e' } as const;

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-runtime-provider-first'));
      const tmuxBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(tmuxBinding);
      const tmuxSession = store.getSession(tmuxBinding.bridgeSessionId);
      const tmuxThreadId = tmuxSession?.runtime?.codex?.threadId || '';
      const tmuxSessionName = `codex_${tmuxThreadId}`;
      assert.equal(tmuxSession?.runtime?.codex?.provider, 'tmux');
      assert.match(tmuxThreadId, /^019e[0-9a-f-]+$/);
      assert.equal(tmuxSession?.runtime?.general?.tmuxSessionName, tmuxSessionName);
      assert.equal(tmuxSession?.runtime?.general?.autoEnter, true);
      assert.equal(llmCalls.length, 0);

      const startLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      assert.match(startLog, new RegExp(`new-session -d -s ${tmuxSessionName}`));
      assert.match(startLog, new RegExp(`resume ${tmuxThreadId}`));
      assert.match(adapter.sent.at(-1)?.text || '', new RegExp(`codex_thread_id.*${tmuxThreadId}`, 's'));

      const beforeClearLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(address, '//clear', 'incoming-runtime-clear-blocked'));
      const clearLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeClearLog.length);
      assert.equal(clearLog, '');
      assert.match(adapter.sent.at(-1)?.text || '', /不能通过 \/\/clear 清空上下文/);
      assert.match(adapter.sent.at(-1)?.text || '', /手动创建新会话/);

      await _testOnly.handleMessage(adapter, inboundMessage(address, '/new sayhi ./sayhi', 'incoming-runtime-new-sayhi'));
      const newAddress = latestCreatedGroupAddress(adapter);
      const newBinding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
      assert.ok(newBinding);
      assert.notEqual(newBinding.id, tmuxBinding.id);
      assert.equal(store.getSession(newBinding.bridgeSessionId)?.runtime?.codex?.threadId, undefined);
      assert.match(adapter.sent.at(-1)?.text || '', /已创建群聊会话/);
      assert.match(adapter.sent.at(-1)?.text || '', /sayhi/);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('bootstraps a codex thread before switching to pty provider and still allows /new ./sayhi', async () => {
    const bootstrapThreadId = '019e83a2-e5b0-7540-ad14-4f3073b2701d';
    const llmCalls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: {
        streamChat(params: StreamChatParams): ReadableStream<string> {
          llmCalls.push({
            sessionId: params.sessionId,
            codexThreadId: params.codexThreadId || '',
            prompt: params.prompt,
            codexProvider: params.codexProvider,
          });
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ session_id: bootstrapThreadId }) })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: bootstrapThreadId }) })}\n`);
              controller.close();
            },
          });
        },
      },
    });

    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-pty-before-thread-e2e' } as const;

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/p pty', 'incoming-runtime-provider-pty-first'));
    const ptyBinding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(ptyBinding);
    const ptySession = store.getSession(ptyBinding.bridgeSessionId);
    const ptyThreadId = ptySession?.runtime?.codex?.threadId || '';
    assert.equal(ptySession?.runtime?.codex?.provider, 'pty');
    assert.match(ptyThreadId, /^019e[0-9a-f-]+$/);
    assert.equal(llmCalls.length, 0);
    assert.match(adapter.sent.at(-1)?.text || '', new RegExp(`codex_thread_id.*${ptyThreadId}`, 's'));

    await _testOnly.handleMessage(adapter, inboundMessage(address, '//clear', 'incoming-runtime-pty-clear-escaped'));
    assert.deepEqual(llmCalls.map((call) => call.prompt), ['/clear']);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/new sayhi ./sayhi', 'incoming-runtime-pty-new-sayhi'));
    const newAddress = latestCreatedGroupAddress(adapter);
    const newBinding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
    assert.ok(newBinding);
    assert.notEqual(newBinding.id, ptyBinding.id);
    assert.equal(store.getSession(newBinding.bridgeSessionId)?.runtime?.codex?.provider, 'pty');
    assert.equal(store.getSession(newBinding.bridgeSessionId)?.runtime?.codex?.threadId, undefined);
    assert.match(adapter.sent.at(-1)?.text || '', /Provider.*pty/s);
  });

  it('appends a running codex pty follow-up into the active pty instead of starting a second turn', async () => {
    const calls: ControlledLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: createControlledLlm(calls),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-pty-inline-append' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-pty-inline-'));
    const oldSubmitDelay = process.env.CODELARK_CODEX_PTY_SUBMIT_DELAY_MS;

    try {
      process.env.CODELARK_CODEX_PTY_SUBMIT_DELAY_MS = '0';
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-pty-inline',
      });
      store.updateSession(binding.bridgeSessionId, {
        runtime: {
          codex: {
            provider: 'pty',
            threadId: 'thread-inline-pty',
          },
        },
      });

      const firstTurn = _testOnly.handleMessage(adapter, inboundMessage(address, 'first pty turn', 'incoming-pty-inline-first'));
      await waitForCondition(() => calls.length === 1);

      const writes: string[] = [];
      _testOnlyPtyScreens.register({
        sessionId: binding.bridgeSessionId,
        threadId: 'thread-inline-pty',
        cwd: workDir,
      });
      _testOnlyPtyScreens.attachChild(binding.bridgeSessionId, {
        write(data: string) {
          writes.push(data);
        },
        kill() {},
        onData() {},
        onExit() {},
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'append while pty is running', 'incoming-pty-inline-followup'));

      assert.equal(calls.length, 1);
      assert.deepEqual(writes, ['append while pty is running', '\r']);
      assert.ok(readAuditSummaries().some((summary) => (
        summary.includes('terminal append input delivered')
          && summary.includes('runtime=codex')
          && summary.includes('provider=pty')
          && summary.includes(`session=${binding.bridgeSessionId}`)
      )));

      finishControlledCall(calls[0], 'pty first turn done');
      await firstTurn;
    } finally {
      if (oldSubmitDelay === undefined) delete process.env.CODELARK_CODEX_PTY_SUBMIT_DELAY_MS;
      else process.env.CODELARK_CODEX_PTY_SUBMIT_DELAY_MS = oldSubmitDelay;
      _testOnlyPtyScreens.clear();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('replies when a running codex pty follow-up has no active local pty receiver', async () => {
    const calls: ControlledLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: createControlledLlm(calls),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-pty-inline-missing' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-pty-missing-'));

    try {
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-pty-missing',
      });
      store.updateSession(binding.bridgeSessionId, {
        runtime: {
          codex: {
            provider: 'pty',
            threadId: 'thread-inline-pty-missing',
          },
        },
      });

      const firstTurn = _testOnly.handleMessage(adapter, inboundMessage(address, 'first pty turn', 'incoming-pty-missing-first'));
      await waitForCondition(() => calls.length === 1);

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'append with no pty child', 'incoming-pty-missing-followup'));

      assert.equal(calls.length, 1);
      assert.match(adapter.sent.at(-1)?.text || '', /还没有可接收追加输入的本地会话/);
      assert.equal(adapter.sent.at(-1)?.replyToMessageId, 'incoming-pty-missing-followup');
      assert.ok(readAuditSummaries().some((summary) => (
        summary.includes('terminal append input receiver missing')
          && summary.includes('runtime=codex')
          && summary.includes('provider=pty')
          && summary.includes(`session=${binding.bridgeSessionId}`)
      )));

      finishControlledCall(calls[0], 'pty first turn done');
      await firstTurn;
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('appends a running Claude pty follow-up into the active Claude pty instead of starting a second turn', async () => {
    const calls: ControlledLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: createControlledLlm(calls),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-claude-pty-inline-append' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-claude-pty-inline-'));
    const oldInputReady = process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS;

    try {
      process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = '0';
      const { binding } = createExistingChannelChat(store, address, {
        workDir,
        name: 'runtime-claude-pty-inline',
      });
      store.updateSession(binding.bridgeSessionId, {
        runtime: {
          activeRuntime: 'claude',
          claude: {
            provider: 'pty',
            sessionId: 'claude-inline-jsonl-session',
            cwd: workDir,
          },
        },
      });

      const firstTurn = _testOnly.handleMessage(adapter, inboundMessage(address, 'first claude pty turn', 'incoming-claude-pty-inline-first'));
      await waitForCondition(() => calls.length === 1);

      const writes: string[] = [];
      _testOnlyClaudePty.registerSession(binding.bridgeSessionId, {
        child: {
          write(data: string) {
            writes.push(data);
          },
          kill() {},
          onData() {},
          onExit() {},
        },
        executable: 'claude',
        cwd: workDir,
        buffer: [
          'Claude Code v2.1.160',
          '❯ ',
          '? for shortcuts',
        ].join('\n'),
      });

      await _testOnly.handleMessage(adapter, inboundMessage(address, 'append while claude pty is running', 'incoming-claude-pty-inline-followup'));

      assert.equal(calls.length, 1);
      assert.deepEqual(writes, ['append while claude pty is running', '\r']);
      assert.ok(readAuditSummaries().some((summary) => (
        summary.includes('terminal append input delivered')
          && summary.includes('runtime=claude')
          && summary.includes('provider=pty')
          && summary.includes(`session=${binding.bridgeSessionId}`)
      )));

      finishControlledCall(calls[0], 'claude pty first turn done');
      await firstTurn;
    } finally {
      if (oldInputReady === undefined) delete process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS;
      else process.env.CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS = oldInputReady;
      _testOnlyClaudePty.clear();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('keeps tmux provider auto-enter enabled when /new follows /p tmux', async () => {
    const bootstrapThreadIds = [
      '019e82f0-0000-7000-9000-000000000001',
      '019e82f0-0000-7000-9000-000000000002',
    ];
    let bootstrapIndex = 0;
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: {
        streamChat(): ReadableStream<string> {
          const threadId = bootstrapThreadIds[Math.min(bootstrapIndex, bootstrapThreadIds.length - 1)];
          bootstrapIndex += 1;
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ session_id: threadId }) })}\n`);
              controller.close();
            },
          });
        },
      },
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const address = { channelType: 'feishu', chatId: 'chat-new-after-tmux-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-new-after-tmux-'));

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-new-after-tmux-provider'));
      const tmuxBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(tmuxBinding);
      assert.equal(store.getSession(tmuxBinding.bridgeSessionId)?.runtime?.codex?.provider, 'tmux');

      await _testOnly.handleMessage(adapter, inboundMessage(address, `/new tmux-next ${workDir}`, 'incoming-new-after-tmux-new'));
      const newAddress = latestCreatedGroupAddress(adapter);
      const newBinding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
      assert.ok(newBinding);
      assert.notEqual(newBinding.id, tmuxBinding.id);
      const newSession = store.getSession(newBinding.bridgeSessionId);
      assert.equal(newSession?.runtime?.codex?.provider, 'tmux');
      assert.equal(newSession?.runtime?.general?.autoEnter, true);
      assert.equal(newSession?.runtime?.codex?.threadId, undefined);
      assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux/s);

      const beforeFirstMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '新线程第一条', 'incoming-new-after-tmux-first'));
      const firstMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeFirstMessageLog.length);
      const newThreadId = store.getSession(newBinding.bridgeSessionId)?.runtime?.codex?.threadId || '';
      const newTmuxSession = `codex_${newThreadId}`;
      assert.match(newThreadId, /^019e[0-9a-f-]+$/);
      assert.match(firstMessageLog, new RegExp(`new-session -d -s ${newTmuxSession}`));
      assert.match(firstMessageLog, new RegExp(`send-keys -t ${newTmuxSession} -l 新线程第一条`));
      assert.match(firstMessageLog, new RegExp(`send-keys -t ${newTmuxSession} Enter`));
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('keeps pty provider selected when /new follows /p pty', async () => {
    const bootstrapThreadIds = [
      '019e83a3-0000-7000-9000-000000000001',
      '019e83a3-0000-7000-9000-000000000002',
    ];
    let bootstrapIndex = 0;
    const calls: RecordedLlmCall[] = [];
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-new-after-pty-'));
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
      llm: {
        streamChat(params: StreamChatParams): ReadableStream<string> {
          calls.push({
            sessionId: params.sessionId,
            codexThreadId: params.codexThreadId || '',
            prompt: params.prompt,
            codexProvider: params.codexProvider,
          });
          const isBootstrap = params.prompt === 'Initialize this Codex session and wait for the next instruction.';
          const threadId = isBootstrap
            ? bootstrapThreadIds[Math.min(bootstrapIndex++, bootstrapThreadIds.length - 1)]
            : bootstrapThreadIds[1];
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: isBootstrap ? 'status' : 'text', data: isBootstrap ? JSON.stringify({ session_id: threadId }) : '新线程响应' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: threadId }) })}\n`);
              controller.close();
            },
          });
        },
      },
    });

    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const address = { channelType: 'feishu', chatId: 'chat-new-after-pty-e2e' } as const;

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p pty', 'incoming-new-after-pty-provider'));
      const ptyBinding = store.getChannelChat(address.channelType, address.chatId);
      assert.ok(ptyBinding);
      assert.equal(store.getSession(ptyBinding.bridgeSessionId)?.runtime?.codex?.provider, 'pty');

      await _testOnly.handleMessage(adapter, inboundMessage(address, `/new pty-next ${workDir}`, 'incoming-new-after-pty-new'));
      const newAddress = latestCreatedGroupAddress(adapter);
      const newBinding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
      assert.ok(newBinding);
      assert.notEqual(newBinding.id, ptyBinding.id);
      const newSession = store.getSession(newBinding.bridgeSessionId);
      assert.equal(newSession?.runtime?.codex?.provider, 'pty');
      assert.equal(newSession?.runtime?.general?.autoEnter, undefined);
      assert.equal(newSession?.runtime?.codex?.threadId, undefined);
      assert.match(adapter.sent.at(-1)?.text || '', /Provider.*pty/s);

      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '新线程第一条', 'incoming-new-after-pty-first'));
      assert.equal(store.getSession(newBinding.bridgeSessionId)?.runtime?.codex?.threadId, bootstrapThreadIds[1]);
      assert.deepEqual(calls.at(-1), {
        sessionId: newBinding.bridgeSessionId,
        codexThreadId: '',
        prompt: '新线程第一条',
        codexProvider: 'pty',
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('initializes a default tmux provider conversation on first text after /set defaultProvider tmux and /new', async () => {
    const bootstrapThreadId = '019e824e-10ef-7430-985d-4349ce6a15f9';
    const llmCalls: RecordedLlmCall[] = [];
    const store = initBridgeTestContext({
      dynamicSettings: true,
      llm: {
        streamChat(params: StreamChatParams): ReadableStream<string> {
          llmCalls.push({
            sessionId: params.sessionId,
            codexThreadId: params.codexThreadId || '',
            prompt: params.prompt,
          });
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'status', data: JSON.stringify({ session_id: bootstrapThreadId }) })}\n`);
              controller.close();
            },
          });
        },
      },
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new StreamingRecordingAdapter();
    const streamingAdapter = adapter as StreamingRecordingAdapter;
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-tmux-default-recover-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-tmux-default-recover-'));

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/set defaultProvider tmux', 'incoming-tmux-default-set-provider'));
      assert.match(adapter.sent.at(-1)?.text || '', /默认 Codex Provider.*tmux/s);
      assert.equal(loadConfig().defaultProvider, 'tmux');

      await _testOnly.handleMessage(adapter, inboundMessage(address, `/new tmux-default ${workDir}`, 'incoming-tmux-default-new'));
      const newAddress = latestCreatedGroupAddress(adapter);
      const binding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
      assert.ok(binding);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, undefined);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, undefined);
      assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux \(全局默认\)/s);

      const beforeFirstMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      const beforeFirstMessageSentCount = adapter.sent.length;
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '第一条', 'incoming-tmux-default-first'));
      const firstMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeFirstMessageLog.length);
      const firstMessageSentText = adapter.sent.slice(beforeFirstMessageSentCount).map((message) => message.text).join('\n\n');
      assert.equal(llmCalls.length, 0);
      const actualThreadId = store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId || '';
      const tmuxSession = `codex_${actualThreadId}`;
      const actualSessionPath = findSessionFileByThreadId(actualThreadId) || '';
      assert.match(actualThreadId, /^019e[0-9a-f-]+$/);
      assert.equal(actualSessionPath ? fs.existsSync(actualSessionPath) : false, true);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.general?.tmuxSessionName, tmuxSession);
      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.general?.autoEnter, true);
      assert.match(firstMessageLog, new RegExp(`has-session -t ${tmuxSession}`));
      assert.match(firstMessageLog, new RegExp(`new-session -d -s ${tmuxSession}`));
      assert.match(firstMessageLog, new RegExp(`resume ${actualThreadId}`));
      assert.equal(
        firstMessageLog.split(`capture-pane -t ${tmuxSession} -p -S -80`).length - 1,
        3,
        'fake tmux should delay Codex TUI readiness for the regression path',
      );
      assert.ok(
        firstMessageLog.indexOf(`new-session -d -s ${tmuxSession}`) < firstMessageLog.indexOf(`capture-pane -t ${tmuxSession} -p -S -80`),
        'auto-recovered tmux session should be captured after startup before forwarding input',
      );
      assert.ok(
        firstMessageLog.indexOf(`capture-pane -t ${tmuxSession} -p -S -80`) < firstMessageLog.indexOf(`send-keys -t ${tmuxSession} -l 第一条`),
        'first auto-forwarded literal should wait until the resumed Codex TUI is ready',
      );
      assert.match(firstMessageLog, new RegExp(`send-keys -t ${tmuxSession} -l 第一条`));
      assert.match(firstMessageLog, new RegExp(`send-keys -t ${tmuxSession} Enter`));
      assert.doesNotMatch(firstMessageSentText, /tmux Provider 缺少 codex_thread_id|正在后台重新启动 Codex TUI/);
      assert.deepEqual(streamingAdapter.streamEvents.filter((event) => /^provider-tmux:/.test(event.streamKey || '')), []);
      assert.deepEqual(streamingAdapter.reactions.map((reaction) => reaction.action), ['add']);
      assert.equal(streamingAdapter.reactions[0]?.emojiType, 'Typing');
      appendCodexMirrorTurn(actualSessionPath, {
        timestampPrefix: '2026-05-28T00:01',
        turnId: 'turn-tmux-default-first',
        userText: '第一条',
        assistantText: '第一条响应',
      });
      await _testOnly.reconcileMirrorSubscriptions();
      await waitForCondition(() => streamingAdapter.reactions.some((reaction) => reaction.action === 'remove'));
      assert.equal(streamingAdapter.reactions.at(-1)?.reactionId, streamingAdapter.reactions[0]?.reactionId);
      assert.ok(streamingAdapter.streamEvents.some((event) => event.kind === 'text' && /^mirror:/.test(event.streamKey || '') && /第一条响应/.test(event.text || '')));

      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '/tmux manual after start', 'incoming-tmux-default-manual'));
      assert.doesNotMatch(adapter.sent.at(-1)?.text || '', /tmux session 不存在/);

      fs.writeFileSync(fakeTmux.statePath, '', 'utf-8');
      const beforeManualMissingLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '/tmux manual missing', 'incoming-tmux-default-manual-missing'));
      const manualMissingLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeManualMissingLog.length);
      assert.match(adapter.sent.at(-1)?.text || '', /tmux session 不存在|tmux Provider 缺少 codex_thread_id/);
      assert.doesNotMatch(manualMissingLog, new RegExp(`new-session -d -s ${tmuxSession}`));

      const beforeRecoveredMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8');
      const beforeSecondReactionCount = streamingAdapter.reactions.length;
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, '第二条', 'incoming-tmux-default-second'));
      const recoveredMessageLog = fs.readFileSync(fakeTmux.logPath, 'utf-8').slice(beforeRecoveredMessageLog.length);
      assert.match(recoveredMessageLog, new RegExp(`has-session -t ${tmuxSession}`));
      assert.match(recoveredMessageLog, new RegExp(`new-session -d -s ${tmuxSession}`));
      assert.match(recoveredMessageLog, new RegExp(`resume ${actualThreadId}`));
      assert.equal(
        recoveredMessageLog.split(`capture-pane -t ${tmuxSession} -p -S -80`).length - 1,
        3,
        'recovered missing tmux provider session should wait through fake delayed readiness again',
      );
      assert.ok(
        recoveredMessageLog.indexOf(`capture-pane -t ${tmuxSession} -p -S -80`) < recoveredMessageLog.indexOf(`send-keys -t ${tmuxSession} -l 第二条`),
        'recovered auto-forwarded literal should wait until the resumed Codex TUI is ready',
      );
      assert.match(recoveredMessageLog, new RegExp(`send-keys -t ${tmuxSession} -l 第二条`));
      assert.match(recoveredMessageLog, new RegExp(`send-keys -t ${tmuxSession} Enter`));
      assert.deepEqual(streamingAdapter.reactions.slice(beforeSecondReactionCount).map((reaction) => reaction.action), ['add']);
      appendCodexMirrorTurn(actualSessionPath, {
        timestampPrefix: '2026-05-28T00:02',
        turnId: 'turn-tmux-default-second',
        userText: '第二条',
        assistantText: '第二条响应',
      });
      await _testOnly.reconcileMirrorSubscriptions();
      await waitForCondition(() => streamingAdapter.reactions.slice(beforeSecondReactionCount).some((reaction) => reaction.action === 'remove'));
      assert.ok(streamingAdapter.streamEvents.some((event) => event.kind === 'text' && /^mirror:/.test(event.streamKey || '') && /第二条响应/.test(event.text || '')));
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
    }
  });

  it('keeps a locally bootstrapped tmux provider thread after the Codex session file appears', async () => {
    const llmCalls: RecordedLlmCall[] = [];
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-tmux-bootstrap-visible-'));
    const store = initBridgeTestContext({
      dynamicSettings: true,
      llm: createRecordingLlm(llmCalls),
    });
    const fakeTmux = installFakeTmux();
    const oldPath = process.env.PATH || '';
    const oldFakeLog = process.env.TMUX_FAKE_LOG;
    const oldFakeState = process.env.TMUX_FAKE_STATE;
    process.env.PATH = `${fakeTmux.binDir}${path.delimiter}${oldPath}`;
    process.env.TMUX_FAKE_LOG = fakeTmux.logPath;
    process.env.TMUX_FAKE_STATE = fakeTmux.statePath;

    const adapter = new RecordingAdapter();
    registerAdapter(adapter);
    const bridgeState = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    bridgeState.running = true;
    const address = { channelType: 'feishu', chatId: 'chat-runtime-tmux-bootstrap-visible-e2e' } as const;

    try {
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/set defaultProvider tmux', 'incoming-tmux-bootstrap-visible-provider'));
      await _testOnly.handleMessage(adapter, inboundMessage(address, `/new tmux-visible ${workDir}`, 'incoming-tmux-bootstrap-visible-new'));
      const newAddress = latestCreatedGroupAddress(adapter);
      await _testOnly.handleMessage(adapter, inboundMessage(newAddress, 'hi', 'incoming-tmux-bootstrap-visible-first'));

      const binding = store.getChannelChat(newAddress.channelType, newAddress.chatId);
      assert.ok(binding);
      const actualThreadId = store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId || '';
      const sessionPath = findSessionFileByThreadId(actualThreadId) || '';
      assert.match(actualThreadId, /^019e[0-9a-f-]+$/);
      assert.equal(sessionPath ? fs.existsSync(sessionPath) : false, true);
      assert.equal(llmCalls.length, 0);

      await _testOnly.reconcileMirrorSubscriptions();
      await _testOnly.reconcileMirrorSubscriptions();
      await _testOnly.reconcileMirrorSubscriptions();

      assert.equal(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.threadId, actualThreadId);
      assert.equal(bridgeState.mirrorSubscriptions.get(binding.id)?.filePath, sessionPath);
    } finally {
      process.env.PATH = oldPath;
      if (oldFakeLog === undefined) delete process.env.TMUX_FAKE_LOG;
      else process.env.TMUX_FAKE_LOG = oldFakeLog;
      if (oldFakeState === undefined) delete process.env.TMUX_FAKE_STATE;
      else process.env.TMUX_FAKE_STATE = oldFakeState;
      fs.rmSync(fakeTmux.binDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('surfaces the local bootstrap error when /p tmux cannot create a codex thread', async () => {
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings(),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-tmux-bootstrap-error-e2e' } as const;
    const originalError = console.error;
    const oldCodexCliPath = process.env.CODELARK_CODEX_CLI_PATH;
    const fakeCodex = installFailingCodexCli();
    const commandErrors: unknown[][] = [];

    try {
      process.env.CODELARK_CODEX_CLI_PATH = fakeCodex.executable;
      console.error = (...args: unknown[]) => {
        if (args[0] === '[bridge-manager] Command failed: /provider') {
          commandErrors.push(args);
          return;
        }
        originalError(...args);
      };
      await _testOnly.handleMessage(adapter, inboundMessage(address, '/p tmux', 'incoming-runtime-provider-error'));
    } finally {
      console.error = originalError;
      if (oldCodexCliPath === undefined) delete process.env.CODELARK_CODEX_CLI_PATH;
      else process.env.CODELARK_CODEX_CLI_PATH = oldCodexCliPath;
      fs.rmSync(fakeCodex.binDir, { recursive: true, force: true });
    }

    const response = adapter.sent.at(-1)?.text || '';
    assert.equal(commandErrors.length, 1);
    assert.match(response, /\/provider 执行失败：本地 Codex thread bootstrap 失败/);
    assert.match(response, /fake local bootstrap failed/);
    assert.doesNotMatch(response, /请稍后重试/);
    const binding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(binding);
    assert.notEqual(store.getSession(binding.bridgeSessionId)?.runtime?.codex?.provider, 'tmux');
  });

  it('renders the effective default provider in command echoes through the bridge entrypoint', async () => {
    const store = initBridgeTestContext({
      dynamicSettings: true,
      settings: makeBridgeSettings({ bridge_default_provider: 'tmux' }),
    });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-runtime-default-provider-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-runtime-default-provider-'));

    createExistingChannelChat(store, address, { workDir, name: 'default-provider' });

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/p', 'incoming-default-provider-p'));
    assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux \(全局默认\)/s);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/m', 'incoming-default-provider-m'));
    assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux \(全局默认\)/s);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/', 'incoming-default-provider-current'));
    assert.match(adapter.sent.at(-1)?.text || '', /Provider.*tmux \(全局默认\)/s);
  });

  it('falls back to bridge cached messages for /his and supports temporary raw limits', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-raw-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-history-raw-e2e-'));

    const { binding } = createExistingChannelChat(store, address, {
      workDir,
      name: 'history-raw',
    });

    store.addMessage(binding.bridgeSessionId, 'user', 'Bridge 缓存用户消息');
    store.addMessage(binding.bridgeSessionId, 'assistant', 'Bridge 缓存助手回复');
    store.addMessage(binding.bridgeSessionId, 'user', 'Bridge 缓存最后一条');

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his', 'incoming-history-default-msg'));

    const lastText = adapter.sent.at(-1)?.text || '';
    assert.match(lastText, /最近对话（msg）/);
    assert.match(lastText, /来源.*Bridge 缓存/s);
    assert.match(lastText, /Bridge 缓存用户消息/);
    assert.match(lastText, /Bridge 缓存助手回复/);
    assert.equal(adapter.sent.at(-1)?.richCard?.title, '最近对话');

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his raw 1', 'incoming-history-raw-once'));

    const rawText = adapter.sent.at(-1)?.text || '';
    assert.match(rawText, /最近对话（解析文本）/);
    assert.match(rawText, /返回条数.*1 \/ 本次 1（配置 8）/s);
    assert.doesNotMatch(rawText, /Bridge 缓存用户消息/);
    assert.doesNotMatch(rawText, /Bridge 缓存助手回复/);
    assert.match(rawText, /Bridge 缓存最后一条/);
  });

  it('truncates long /his history entries in text and rich-card views', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-long-e2e' } as const;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-history-long-e2e-'));
    const head = 'CODELARK_LONG_HISTORY_HEAD_LOCAL';
    const tail = 'CODELARK_LONG_HISTORY_TAIL_LOCAL';
    const longContent = `${head} ${'historypad '.repeat(220)}${tail}`;

    const { binding } = createExistingChannelChat(store, address, {
      workDir,
      name: 'history-long',
    });
    store.addMessage(binding.bridgeSessionId, 'assistant', longContent);

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his raw 1', 'incoming-history-long-raw'));

    const rawText = adapter.sent.at(-1)?.text || '';
    assert.match(rawText, /最近对话（解析文本）/);
    assert.match(rawText, new RegExp(head));
    assert.match(rawText, /\.\.\./);
    assert.doesNotMatch(rawText, new RegExp(tail));

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his msg 1', 'incoming-history-long-msg'));

    const msgText = adapter.sent.at(-1)?.text || '';
    const cardMarkdown = adapter.sent.at(-1)?.richCard?.sections.at(1)?.markdown || '';
    assert.match(msgText, /最近对话（msg）/);
    assert.match(msgText, new RegExp(head));
    assert.match(msgText, /\.\.\./);
    assert.doesNotMatch(msgText, new RegExp(tail));
    assert.match(cardMarkdown, new RegExp(head));
    assert.match(cardMarkdown, /\.\.\./);
    assert.doesNotMatch(cardMarkdown, new RegExp(tail));
  });

  it('prefers Codex JSONL messages over bridge cached messages for /his msg after /t binding', async () => {
    const store = initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-codex-msg-e2e' } as const;
    const threadId = '11111111-1111-4111-8111-111111111111';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-msg-e2e-'));
    writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: workDir,
            originator: 'Codex CLI',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Codex JSONL 用户消息' },
        },
        {
          timestamp: '2026-05-28T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Codex JSONL 助手回复' },
        },
        {
          timestamp: '2026-05-28T00:00:02.001Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Codex JSONL 助手回复' }],
          },
        },
      ],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${threadId}`, 'incoming-thread-msg'));
    const binding = store.getChannelChat(address.channelType, address.chatId);
    assert.ok(binding);
    store.addMessage(binding.bridgeSessionId, 'assistant', 'Bridge 缓存不应优先展示');

    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his msg', 'incoming-history-codex-msg'));

    const lastText = adapter.sent.at(-1)?.text || '';
    assert.match(lastText, /最近对话（msg）/);
    assert.match(lastText, /来源.*Codex session JSONL/s);
    assert.match(lastText, /Codex JSONL 用户消息/);
    assert.match(lastText, /Codex JSONL 助手回复/);
    assert.equal((lastText.match(/Codex JSONL 助手回复/g) || []).length, 1);
    assert.doesNotMatch(lastText, /Bridge 缓存不应优先展示/);
  });

  it('renders task_complete-only final answers from Codex JSONL through /his msg', async () => {
    initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-task-complete-e2e' } as const;
    const threadId = '22222222-2222-4222-8222-222222222222';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-task-complete-e2e-'));
    writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: workDir,
            originator: 'Codex CLI',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '请给最终答案' },
        },
        {
          timestamp: '2026-05-28T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: '只有 task_complete 里的最终答案',
          },
        },
      ],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${threadId}`, 'incoming-thread-task-complete'));
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his msg', 'incoming-history-task-complete'));

    const lastText = adapter.sent.at(-1)?.text || '';
    assert.match(lastText, /最近对话（msg）/);
    assert.match(lastText, /请给最终答案/);
    assert.match(lastText, /只有 task_complete 里的最终答案/);
  });

  it('sends the original Codex session JSONL file through /his json after /t binding', async () => {
    initBridgeTestContext({ dynamicSettings: true });
    const adapter = new RecordingAdapter();
    const address = { channelType: 'feishu', chatId: 'chat-history-json-e2e' } as const;
    const threadId = '0123456789abcdef0123456789abcdef';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-e2e-'));
    const { sessionPath, rawJsonl } = writeCodexSessionJsonlFixture({
      threadId,
      workDir,
      lines: [
        {
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-05-28T00:00:00.000Z',
            cwd: workDir,
            originator: 'Codex CLI',
          },
        },
        {
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '原始 JSONL 端到端内容' },
        },
      ],
    });

    await _testOnly.handleMessage(adapter, inboundMessage(address, `/t ${threadId}`, 'incoming-thread'));
    await _testOnly.handleMessage(adapter, inboundMessage(address, '/his json', 'incoming-history-json'));

    const attachmentMessage = adapter.sent.find((message) =>
      Array.isArray(message.attachments) && message.attachments.length === 1);
    assert.ok(attachmentMessage);
    assert.equal(attachmentMessage.attachments?.[0]?.path, sessionPath);
    assert.equal(fs.readFileSync(attachmentMessage.attachments![0].path, 'utf-8'), rawJsonl);
  });
});
