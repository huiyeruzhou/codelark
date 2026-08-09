import '../../../setup/test-setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAdapterRuntime } from '../../../../channels/adapter-runtime/runtime.js';
import { BaseChannelAdapter } from '../../../../channels/contracts.js';
import type { InboundMessage, OutboundMessage, SendResult } from '../../../../domain/index.js';
import { CODELARK_HOME } from '../../../../configuration/paths.js';

async function waitForCondition(fn: () => boolean, timeoutMs = 200): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 5));
  for (let index = 0; index < attempts; index += 1) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fn(), true);
}

describe('bridge-adapter-runtime', () => {
  it('classifies manually injected text through the existing command and regular lanes', async () => {
    class ManualAdapter extends BaseChannelAdapter {
      readonly channelType = 'feishu-manual';
      readonly provider = 'feishu';
      running = true;
      start(): Promise<void> { return Promise.resolve(); }
      stop(): Promise<void> { this.running = false; this.rejectPendingInboundConsumers(); return Promise.resolve(); }
      isRunning(): boolean { return this.running; }
      consumeOne(): Promise<InboundMessage | null> { return this.consumeInboundMessage(this.running); }
      send(_message: OutboundMessage): Promise<SendResult> { return Promise.resolve({ ok: true }); }
      validateConfig(): string | null { return null; }
      isAuthorized(): boolean { return true; }
    }
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const handled: string[] = [];
    const locked: string[] = [];
    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => { handled.push(msg.text); },
      processWithSessionLock: async (sessionId, fn) => { locked.push(sessionId); await fn(); },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: () => 'target-session',
    });
    const adapter = new ManualAdapter();
    runtime.runAdapterLoop(adapter);
    adapter.enqueueManualInboundMessage({
      messageId: 'manual-command',
      address: { channelType: adapter.channelType, chatId: 'target-chat' },
      text: '/stop',
      contextText: '<codelark_source>\n来源会话 ID："source-session"\n</codelark_source>',
      timestamp: Date.now(),
    });
    adapter.enqueueManualInboundMessage({
      messageId: 'manual-regular',
      address: { channelType: adapter.channelType, chatId: 'target-chat' },
      text: 'hello',
      timestamp: Date.now(),
    });

    await waitForCondition(() => handled.length === 2);
    state.running = false;
    await adapter.stop();
    assert.deepEqual(handled, ['/stop', 'hello']);
    assert.deepEqual(locked, ['target-session']);
  });

  it('delays ordinary routing until a serialized chat attachment commits', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    const locked: string[] = [];
    let activeSessionId = 'session-old';
    let releaseAttachment!: () => void;
    const attachmentMayCommit = new Promise<void>((resolve) => {
      releaseAttachment = resolve;
    });
    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-attach') {
          await attachmentMayCommit;
          activeSessionId = 'session-new';
        }
      },
      processWithSessionLock: async (sessionId, fn) => {
        locked.push(sessionId);
        await fn();
      },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: () => activeSessionId,
      getImmediateLane: (msg, category) => category === 'command' && msg.text === '/attach'
        ? {
            laneKey: `job:attach:${msg.address.channelType}:${msg.address.chatId}`,
            laneKind: 'job',
            jobKind: 'command:attach',
            waitForConversationBarrier: false,
            blocksRouting: true,
            serialize: true,
          }
        : null,
    });
    let running = true;
    const messages = [
      {
        messageId: 'msg-attach',
        address: { channelType: 'feishu-default', chatId: 'chat-attach' },
        text: '/attach',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-after-attach',
        address: { channelType: 'feishu-default', chatId: 'chat-attach' },
        text: 'continue in selected runtime',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await waitForCondition(() => started.includes('msg-attach'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(started, ['msg-attach']);

    releaseAttachment();
    await waitForCondition(() => started.includes('msg-after-attach'));
    assert.deepEqual(started, ['msg-attach', 'msg-after-attach']);
    assert.deepEqual(locked, ['session-new']);
  });

  it('lets clear preempt a provider tmux startup waiting for external input', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    const locked: string[] = [];
    let activeSessionId = 'bridge-session-a';
    let releaseProvider!: () => void;
    const providerDone = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-provider') await providerDone;
        if (msg.messageId === 'msg-clear') activeSessionId = 'bridge-session-b';
      },
      processWithSessionLock: async (sessionId, fn) => {
        locked.push(sessionId);
        await fn();
      },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: () => activeSessionId,
      getImmediateLane: (msg) => msg.text === '/provider tmux'
        ? {
            laneKey: `job:provider-tmux:${msg.address.channelType}:${msg.address.chatId}`,
            laneKind: 'job',
            jobKind: 'command:provider-tmux',
            waitForConversationBarrier: false,
            blocksConversation: false,
            serialize: true,
            blocksRouting: true,
          }
        : null,
      getSessionLane: (msg, category) => msg.text === '/clear next'
        ? {
            sessionId: 'bridge-session-a',
            jobKind: 'command:clear',
            blocksConversation: true,
          }
        : category === 'regular'
          ? {
              sessionId: activeSessionId,
              jobKind: 'interactive-turn',
              blocksConversation: true,
            }
        : null,
    });
    let running = true;
    const messages = [
      {
        messageId: 'msg-provider',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/provider tmux',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-clear',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/clear next',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-regular-after-clear',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: 'continue after provider startup',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await waitForCondition(() => started.includes('msg-clear'));

    assert.deepEqual(started, ['msg-provider', 'msg-clear']);
    assert.deepEqual(locked, ['bridge-session-a']);
    releaseProvider();
    await waitForCondition(() => started.includes('msg-regular-after-clear'));
    assert.deepEqual(started, ['msg-provider', 'msg-clear', 'msg-regular-after-clear']);
    assert.deepEqual(locked, ['bridge-session-a', 'bridge-session-b']);
  });

  it('routes regular messages through the session lock but keeps slash commands inline', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const handled: string[] = [];
    const locked: string[] = [];

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        handled.push(msg.text);
      },
      processWithSessionLock: async (sessionId, fn) => {
        locked.push(sessionId);
        await fn();
      },
      isCommandMessage: (msg) => msg.text === '/status',
      resolveSessionIdForMessage: (msg) => `session:${msg.address.chatId}`,
    });

    let runningRegular = true;
    let regularConsumed = false;
    const regularAdapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => runningRegular || !regularConsumed,
      consumeOne: async () => {
        if (regularConsumed) return null;
        regularConsumed = true;
        runningRegular = false;
        return {
          messageId: 'msg-regular',
          address: { channelType: 'feishu-default', chatId: 'chat-regular' },
          text: 'hello',
          timestamp: Date.now(),
        };
      },
    };

    runtime.runAdapterLoop(regularAdapter as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(handled, ['hello']);
    assert.deepEqual(locked, ['session:chat-regular']);

    handled.length = 0;
    locked.length = 0;

    let runningCommand = true;
    let commandConsumed = false;
    const commandAdapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => runningCommand || !commandConsumed,
      consumeOne: async () => {
        if (commandConsumed) return null;
        commandConsumed = true;
        runningCommand = false;
        return {
          messageId: 'msg-command',
          address: { channelType: 'feishu-default', chatId: 'chat-command' },
          text: '/status',
          timestamp: Date.now(),
        };
      },
    };

    runtime.runAdapterLoop(commandAdapter as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(handled, ['/status']);
    assert.deepEqual(locked, []);

    handled.length = 0;
    locked.length = 0;

    let runningEscapedSlash = true;
    let escapedSlashConsumed = false;
    const escapedSlashAdapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => runningEscapedSlash || !escapedSlashConsumed,
      consumeOne: async () => {
        if (escapedSlashConsumed) return null;
        escapedSlashConsumed = true;
        runningEscapedSlash = false;
        return {
          messageId: 'msg-escaped-slash',
          address: { channelType: 'feishu-default', chatId: 'chat-escaped-slash' },
          text: '//status',
          timestamp: Date.now(),
        };
      },
    };

    runtime.runAdapterLoop(escapedSlashAdapter as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(handled, ['//status']);
    assert.deepEqual(locked, ['session:chat-escaped-slash']);
  });

  it('lets terminal append candidates bypass the session lock without changing command routing', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const handled: string[] = [];
    const locked: string[] = [];
    const bypassed: string[] = [];

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        handled.push(msg.text);
      },
      processWithSessionLock: async (sessionId, fn) => {
        locked.push(sessionId);
        await fn();
      },
      isCommandMessage: (msg) => msg.text === '/status',
      resolveSessionIdForMessage: (msg) => `session:${msg.address.chatId}`,
      shouldBypassSessionLock: (msg) => {
        if (msg.text === 'append while running') {
          bypassed.push(msg.messageId);
          return true;
        }
        return false;
      },
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-append',
        address: { channelType: 'feishu-default', chatId: 'chat-append' },
        text: 'append while running',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-regular',
        address: { channelType: 'feishu-default', chatId: 'chat-regular' },
        text: 'regular next turn',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-command',
        address: { channelType: 'feishu-default', chatId: 'chat-command' },
        text: '/status',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.deepEqual(handled, ['append while running', 'regular next turn', '/status']);
    assert.deepEqual(bypassed, ['msg-append']);
    assert.deepEqual(locked, ['session:chat-regular']);
  });

  it('does not let a slow command in one chat block another chat on the same adapter', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    let releaseSlow!: () => void;
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-slow') {
          await slowDone;
        }
      },
      processWithSessionLock: async (_sessionId, fn) => { await fn(); },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: (msg) => `session:${msg.address.chatId}`,
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-slow',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/slow',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-fast',
        address: { channelType: 'feishu-default', chatId: 'chat-b' },
        text: '/fast',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await waitForCondition(() => started.includes('msg-fast'));

    assert.deepEqual(started, ['msg-slow', 'msg-fast']);
    releaseSlow();
  });

  it('lets ordinary same-chat command jobs run concurrently without an active barrier', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    let releaseSlow!: () => void;
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-slow') {
          await slowDone;
        }
      },
      processWithSessionLock: async (_sessionId, fn) => { await fn(); },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: (msg) => `session:${msg.address.chatId}`,
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-slow',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/slow',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-next',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/next',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(started, ['msg-slow', 'msg-next']);
    releaseSlow();
    assert.deepEqual(started, ['msg-slow', 'msg-next']);
  });

  it('lets high-priority control messages bypass the same chat lane', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    let releaseSlow!: () => void;
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-slow') {
          await slowDone;
        }
      },
      processWithSessionLock: async (_sessionId, fn) => { await fn(); },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: (msg) => `session:${msg.address.chatId}`,
      getImmediateLane: (msg) => (msg.text === '/stop'
        ? {
          laneKey: `control:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId}`,
          laneKind: 'control',
          jobKind: 'control:command',
        }
        : null),
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-slow',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/slow',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-stop',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/stop',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await waitForCondition(() => started.includes('msg-stop'));

    assert.deepEqual(started, ['msg-slow', 'msg-stop']);
    releaseSlow();
  });

  it('lets read-only command jobs bypass the same chat lane', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    let releaseSlow!: () => void;
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-slow') {
          await slowDone;
        }
      },
      processWithSessionLock: async (_sessionId, fn) => { await fn(); },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: (msg) => `session:${msg.address.chatId}`,
      getImmediateLane: (msg) => (msg.text.startsWith('/shell')
        ? {
          laneKey: `job:shell:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId}`,
          laneKind: 'job',
          jobKind: 'command:shell',
        }
        : null),
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-slow',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/slow',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-shell',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/shell git status --short',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await waitForCondition(() => started.includes('msg-shell'));

    assert.deepEqual(started, ['msg-slow', 'msg-shell']);
    releaseSlow();
  });

  it('uses session-mutating commands as conversation barriers except for controls', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    let releaseBarrier!: () => void;
    const barrierDone = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-runtime') {
          await barrierDone;
        }
      },
      processWithSessionLock: async (_sessionId, fn) => { await fn(); },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: () => 'bridge-session-a',
      getImmediateLane: (msg) => {
        if (msg.text === '/stop') {
          return {
            laneKey: `control:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId}`,
            laneKind: 'control',
            jobKind: 'control:command',
          };
        }
        if (msg.text.startsWith('/shell')) {
          return {
            laneKey: `job:shell:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId}`,
            laneKind: 'job',
            jobKind: 'command:shell',
          };
        }
        return null;
      },
      getSessionLane: (msg) => (msg.text.startsWith('/runtime')
        ? {
          sessionId: 'bridge-session-a',
          jobKind: 'command:runtime',
          blocksConversation: true,
        }
        : null),
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-runtime',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/runtime claude',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-shell',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/shell git status --short',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-status',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/status',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-stop',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/stop',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await waitForCondition(() => started.includes('msg-stop'));

    assert.deepEqual(started, ['msg-runtime', 'msg-stop']);
    releaseBarrier();
    await waitForCondition(() => started.includes('msg-shell') && started.includes('msg-status'));
    assert.equal(started[0], 'msg-runtime');
    assert.ok(started.indexOf('msg-shell') > started.indexOf('msg-runtime'));
    assert.ok(started.indexOf('msg-status') > started.indexOf('msg-runtime'));
  });

  it('lets regular messages opt into a conversation barrier without blocking controls', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    let releaseRegular!: () => void;
    const regularDone = new Promise<void>((resolve) => {
      releaseRegular = resolve;
    });

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-regular') {
          await regularDone;
        }
      },
      processWithSessionLock: async (_sessionId, fn) => { await fn(); },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: () => 'bridge-session-a',
      getImmediateLane: (msg) => {
        if (msg.text.startsWith('/tmux-screen')) {
          return {
            laneKey: `job:tmux-screen:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId}`,
            laneKind: 'job',
            jobKind: 'command:tmux-screen',
            waitForConversationBarrier: false,
            blocksConversation: false,
          };
        }
        if (msg.text === '/stop') {
          return {
            laneKey: `control:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId}`,
            laneKind: 'control',
            jobKind: 'control:command',
          };
        }
        return null;
      },
      getSessionLane: (msg, category) => {
        if (category === 'regular') {
          return {
            sessionId: 'bridge-session-a',
            jobKind: 'interactive-turn:tmux-provider-auto-forward',
            blocksConversation: true,
          };
        }
        if (msg.text.startsWith('/runtime')) {
          return {
            sessionId: 'bridge-session-a',
            jobKind: 'command:runtime',
            blocksConversation: true,
          };
        }
        return null;
      },
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-regular',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: 'hello tmux',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-screen',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/tmux-screen',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-runtime',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/runtime codex',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-stop',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/stop',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await waitForCondition(() => started.includes('msg-screen') && started.includes('msg-stop'));
    assert.deepEqual(started, ['msg-regular', 'msg-screen', 'msg-stop']);

    releaseRegular();
    await waitForCondition(() => started.includes('msg-runtime'));
    assert.equal(started[0], 'msg-regular');
    assert.equal(started[1], 'msg-screen');
    assert.equal(started[2], 'msg-stop');
    assert.ok(started.indexOf('msg-runtime') > started.indexOf('msg-regular'));
  });

  it('does not let screen monitor jobs block later conversation barriers', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    let releaseFirstRegular!: () => void;
    let releaseScreen!: () => void;
    const firstRegularDone = new Promise<void>((resolve) => {
      releaseFirstRegular = resolve;
    });
    const screenDone = new Promise<void>((resolve) => {
      releaseScreen = resolve;
    });

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-regular-1') {
          await firstRegularDone;
        }
        if (msg.messageId === 'msg-screen') {
          await screenDone;
        }
      },
      processWithSessionLock: async (_sessionId, fn) => { await fn(); },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: () => 'bridge-session-a',
      getImmediateLane: (msg) => (msg.text.startsWith('/tmux-screen')
        ? {
          laneKey: `job:tmux-screen:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId}`,
          laneKind: 'job',
          jobKind: 'command:tmux-screen',
          waitForConversationBarrier: false,
          blocksConversation: false,
        }
        : null),
      getSessionLane: (_msg, category) => (category === 'regular'
        ? {
          sessionId: 'bridge-session-a',
          jobKind: 'interactive-turn:tmux-provider-auto-forward',
          blocksConversation: true,
        }
        : null),
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-regular-1',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: 'first',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-screen',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/tmux-screen',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-regular-2',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: 'second',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await waitForCondition(() => started.includes('msg-screen'));
    assert.deepEqual(started, ['msg-regular-1', 'msg-screen']);

    releaseFirstRegular();
    await waitForCondition(() => started.includes('msg-regular-2'));
    assert.deepEqual(started, ['msg-regular-1', 'msg-screen', 'msg-regular-2']);

    releaseScreen();
  });

  it('does not let a pending non-blocking command callback job block the next message', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    let releaseCallback!: () => void;
    const callbackDone = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-new-callback') await callbackDone;
      },
      processWithSessionLock: async (_sessionId, fn) => { await fn(); },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: () => 'bridge-session-a',
      getImmediateLane: (msg, category) => (
        category === 'callback' && msg.callbackData === 'new-session-callback'
          ? {
              laneKey: `job:new:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId}`,
              laneKind: 'job',
              jobKind: 'command:new',
              waitForConversationBarrier: true,
              blocksConversation: false,
            }
          : null
      ),
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-new-callback',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '',
        callbackData: 'new-session-callback',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-regular-after-new',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: 'continue while createGroupChat is pending',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await waitForCondition(() => started.includes('msg-regular-after-new'));
    assert.deepEqual(started, ['msg-new-callback', 'msg-regular-after-new']);
    releaseCallback();
  });

  it('waits for prior same-chat command jobs before running a conversation barrier', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    let releaseShell!: () => void;
    const shellDone = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-shell') {
          await shellDone;
        }
      },
      processWithSessionLock: async (_sessionId, fn) => { await fn(); },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: () => 'bridge-session-a',
      getImmediateLane: (msg) => (msg.text.startsWith('/shell')
        ? {
          laneKey: `job:shell:${msg.address.channelType}:${msg.address.chatId}:${msg.messageId}`,
          laneKind: 'job',
          jobKind: 'command:shell',
        }
        : null),
      getSessionLane: (msg) => (msg.text.startsWith('/model')
        ? {
          sessionId: 'bridge-session-a',
          jobKind: 'command:model',
          blocksConversation: true,
        }
        : null),
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-shell',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/shell sleep 1',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-model',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/model gpt-5.4',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(started, ['msg-shell']);
    releaseShell();
    await waitForCondition(() => started.includes('msg-model'));
    assert.deepEqual(started, ['msg-shell', 'msg-model']);
  });

  it('serializes session-mutating commands with regular prompts on the session queue', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    let releasePrompt!: () => void;
    const promptDone = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const sessionTails = new Map<string, Promise<void>>();

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-prompt') {
          await promptDone;
        }
      },
      processWithSessionLock: (sessionId, fn) => {
        const previous = sessionTails.get(sessionId) || Promise.resolve();
        const current = previous.then(fn, fn);
        sessionTails.set(sessionId, current.catch(() => {}));
        return current;
      },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: () => 'bridge-session-a',
      getSessionLane: (msg) => (msg.text.startsWith('/provider')
        ? { sessionId: 'bridge-session-a', jobKind: 'command:provider' }
        : null),
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-prompt',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: 'regular prompt',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-provider',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/provider tmux',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(started, ['msg-prompt']);
    releasePrompt();
    await waitForCondition(() => started.includes('msg-provider'));
    assert.deepEqual(started, ['msg-prompt', 'msg-provider']);
  });

  it('serializes session-mutating command callbacks with regular prompts on the session queue', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    let releasePrompt!: () => void;
    const promptDone = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const sessionTails = new Map<string, Promise<void>>();

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-prompt') {
          await promptDone;
        }
      },
      processWithSessionLock: (sessionId, fn) => {
        const previous = sessionTails.get(sessionId) || Promise.resolve();
        const current = previous.then(fn, fn);
        sessionTails.set(sessionId, current.catch(() => {}));
        return current;
      },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: () => 'bridge-session-a',
      getSessionLane: (msg, category) => (category === 'callback' && msg.callbackData === 'session-config-callback'
        ? { sessionId: 'bridge-session-a', jobKind: 'command:current-config' }
        : null),
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-prompt',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: 'regular prompt',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-current-config',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '',
        callbackData: 'session-config-callback',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(started, ['msg-prompt']);
    releasePrompt();
    await waitForCondition(() => started.includes('msg-current-config'));
    assert.deepEqual(started, ['msg-prompt', 'msg-current-config']);
  });

  it('does not let a slow same-chat command block a regular prompt before the session queue', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const started: string[] = [];
    const locked: string[] = [];
    let releaseCommand!: () => void;
    const commandDone = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });

    const runtime = createAdapterRuntime(() => state, {
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        started.push(msg.messageId);
        if (msg.messageId === 'msg-command') {
          await commandDone;
        }
      },
      processWithSessionLock: async (sessionId, fn) => {
        locked.push(sessionId);
        await fn();
      },
      isCommandMessage: (msg) => msg.text.startsWith('/'),
      resolveSessionIdForMessage: (msg) => `session:${msg.address.chatId}`,
    });

    let running = true;
    const messages = [
      {
        messageId: 'msg-command',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: '/mode yolo',
        timestamp: Date.now(),
      },
      {
        messageId: 'msg-prompt',
        address: { channelType: 'feishu-default', chatId: 'chat-a' },
        text: 'regular prompt',
        timestamp: Date.now(),
      },
    ];
    const adapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => running || messages.length > 0,
      consumeOne: async () => {
        const next = messages.shift() || null;
        if (messages.length === 0) running = false;
        return next;
      },
    };

    runtime.runAdapterLoop(adapter as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(started, ['msg-command', 'msg-prompt']);
    assert.deepEqual(locked, ['session:chat-a']);
    releaseCommand();
    assert.deepEqual(started, ['msg-command', 'msg-prompt']);
    assert.deepEqual(locked, ['session:chat-a']);
  });

  it('writes adapter lane flamegraph spans as structured JSON', async () => {
    const logPath = path.join(CODELARK_HOME, 'logs', 'bridge.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '');

    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const originalNow = Date.now;
    let now = 0;
    let releaseSlow!: () => void;
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let consumed = 0;

    Date.now = () => now;
    try {
      const runtime = createAdapterRuntime(() => state, {
        notifyAdapterSetChanged: () => {},
        handleMessage: async (_adapter, msg) => {
          if (msg.messageId === 'msg-slow') {
            await slowDone;
          }
        },
        processWithSessionLock: async (_sessionId, fn) => { await fn(); },
        isCommandMessage: (msg) => msg.text.startsWith('/'),
        resolveSessionIdForMessage: (msg) => `session:${msg.address.chatId}`,
        getSessionLane: (msg) => (msg.messageId === 'msg-slow'
          ? { sessionId: 'bridge-session-a', jobKind: 'command:runtime', blocksConversation: true }
          : null),
      });

      const messages = [
        {
          messageId: 'msg-slow',
          address: { channelType: 'feishu-default', chatId: 'chat-a' },
          text: '/slow token=abcdefghijklmnop',
          timestamp: 0,
        },
        {
          messageId: 'msg-next',
          address: { channelType: 'feishu-default', chatId: 'chat-a' },
          text: '/next',
          timestamp: 0,
        },
      ];
      const adapter = {
        channelType: 'feishu-default',
        provider: 'feishu',
        isRunning: () => messages.length > 0,
        consumeOne: async () => {
          const next = messages.shift() || null;
          if (next) consumed++;
          return next;
        },
      };

      runtime.runAdapterLoop(adapter as never);
      await waitForCondition(() => consumed === 2);
      now = 2_001;
      releaseSlow();
      await waitForCondition(() => {
        if (!fs.existsSync(logPath)) return false;
        const logText = fs.readFileSync(logPath, 'utf-8');
        return logText.includes('"event":"adapter.message.handler"')
          && logText.includes('"event":"adapter.message.wait"')
          && logText.includes('"event":"adapter.message.scheduled"')
          && logText.includes('"event":"adapter.message.started"')
          && logText.includes('"event":"adapter.message.finished"');
      });
    } finally {
      Date.now = originalNow;
    }

    const entries = fs.readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const handlerLog = entries.find((entry) => entry.event === 'adapter.message.handler');
    const waitLog = entries.find((entry) => entry.event === 'adapter.message.wait');
    const scheduledLog = entries.find((entry) => (
      entry.event === 'adapter.message.scheduled'
      && entry.message_id === 'msg-slow'
    ));
    const nextScheduledLog = entries.find((entry) => (
      entry.event === 'adapter.message.scheduled'
      && entry.message_id === 'msg-next'
    ));
    const nextStartedLog = entries.find((entry) => (
      entry.event === 'adapter.message.started'
      && entry.message_id === 'msg-next'
    ));
    const finishedLog = entries.find((entry) => (
      entry.event === 'adapter.message.finished'
      && entry.message_id === 'msg-slow'
    ));

    assert.equal(handlerLog?.level, 'WARN');
    assert.equal(handlerLog?.duration_ms, 2_001);
    assert.equal(handlerLog?.lane, 'chat:feishu-default:chat-a');
    assert.equal(handlerLog?.chat, 'chat-a');
    assert.equal(handlerLog?.category, 'command');
    assert.equal(handlerLog?.message_id, 'msg-slow');
    assert.equal(handlerLog?.session_id, 'bridge-session-a');
    assert.equal(handlerLog?.uses_session_lock, true);
    assert.equal(handlerLog?.conversation_barrier, true);
    assert.equal(handlerLog?.msg, 'slow adapter message handler');
    assert.equal(waitLog?.duration_ms, 2_001);
    assert.equal(waitLog?.msg, 'slow adapter message queue wait');
    assert.equal(waitLog?.lane, 'chat:feishu-default:chat-a');
    assert.equal(waitLog?.message_id, 'msg-next');
    assert.equal(waitLog?.blocked_by_span_id, scheduledLog?.span_id);
    assert.equal(waitLog?.blocked_by_message_id, 'msg-slow');
    assert.equal(waitLog?.blocked_by_session_id, 'bridge-session-a');
    assert.equal(waitLog?.blocked_by_category, 'command');
    assert.equal(waitLog?.blocked_by_started_at_ms, 0);
    assert.equal(waitLog?.blocked_by_age_ms, 2_001);
    assert.equal(scheduledLog?.span_kind, 'adapter.message');
    assert.equal(scheduledLog?.parent_span_id, 'chat:feishu-default:chat-a');
    assert.equal(scheduledLog?.session_id, 'bridge-session-a');
    assert.equal(scheduledLog?.uses_session_lock, true);
    assert.equal(scheduledLog?.conversation_barrier, true);
    assert.equal(scheduledLog?.scheduled_at_ms, 0);
    assert.equal(nextScheduledLog?.blocked_by_span_id, scheduledLog?.span_id);
    assert.equal(nextScheduledLog?.blocked_by_message_id, 'msg-slow');
    assert.equal(nextScheduledLog?.blocked_by_session_id, 'bridge-session-a');
    assert.equal(nextScheduledLog?.blocked_by_category, 'command');
    assert.equal(nextStartedLog?.lane_wait_ms, 2_001);
    assert.equal(nextStartedLog?.started_at_ms, 2_001);
    assert.equal(nextStartedLog?.blocked_by_age_ms, 2_001);
    assert.equal(finishedLog?.status, 'success');
    assert.equal(finishedLog?.duration_ms, 2_001);
    assert.equal(finishedLog?.total_ms, 2_001);
    assert.equal(finishedLog?.started_at_ms, 0);
    assert.equal(finishedLog?.ended_at_ms, 2_001);
    assert.equal(finishedLog?.finished_at_ms, 2_001);
    assert.doesNotMatch(String(handlerLog?.text), /token=abcdefghijklmnop/);
  });

  it('writes regular prompt adapter spans on the session lane', async () => {
    const logPath = path.join(CODELARK_HOME, 'logs', 'bridge.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '');

    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const originalNow = Date.now;
    let now = 0;
    let consumed = false;

    Date.now = () => now;
    try {
      const runtime = createAdapterRuntime(() => state, {
        notifyAdapterSetChanged: () => {},
        handleMessage: async () => {},
        processWithSessionLock: async (_sessionId, fn) => {
          now = 750;
          await fn();
        },
        isCommandMessage: (msg) => msg.text.startsWith('/'),
        resolveSessionIdForMessage: () => 'bridge-session-a',
      });

      const adapter = {
        channelType: 'feishu-default',
        provider: 'feishu',
        isRunning: () => !consumed,
        consumeOne: async () => {
          if (consumed) return null;
          consumed = true;
          return {
            messageId: 'msg-regular',
            address: { channelType: 'feishu-default', chatId: 'chat-a' },
            text: 'regular prompt',
            timestamp: 0,
          };
        },
      };

      runtime.runAdapterLoop(adapter as never);
      await waitForCondition(() => {
        if (!fs.existsSync(logPath)) return false;
        const logText = fs.readFileSync(logPath, 'utf-8');
        return logText.includes('"event":"adapter.session_lock.acquired"')
          && logText.includes('"event":"adapter.message.finished"');
      });
    } finally {
      Date.now = originalNow;
    }

    const entries = fs.readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const scheduledLog = entries.find((entry) => entry.event === 'adapter.message.scheduled');
    const lockLog = entries.find((entry) => entry.event === 'adapter.session_lock.acquired');
    const finishedLog = entries.find((entry) => entry.event === 'adapter.message.finished');

    assert.equal(scheduledLog?.lane, 'session:bridge-session-a');
    assert.equal(scheduledLog?.lane_kind, 'session');
    assert.equal(scheduledLog?.job_kind, 'interactive-turn');
    assert.equal(scheduledLog?.parent_span_id, 'session:bridge-session-a');
    assert.equal(scheduledLog?.session_id, 'bridge-session-a');
    assert.equal(scheduledLog?.uses_session_lock, true);
    assert.equal(lockLog?.session_lock_wait_ms, 750);
    assert.equal(finishedLog?.lane, 'session:bridge-session-a');
    assert.equal(finishedLog?.duration_ms, 750);
    assert.equal(finishedLog?.total_ms, 750);
    assert.equal(finishedLog?.session_lock_acquired, true);
  });
});
