/**
 * Minimal Mock Host Example
 *
 * Demonstrates how to wire up the CodeLark bridge with mock implementations
 * of all host interfaces. This runs the full bridge pipeline without
 * any real database, LLM, or permission system.
 *
 * Usage:
 *   npx tsx src/bridge/host/examples/mock-host.ts
 *
 * This example:
 * 1. Creates an in-memory store
 * 2. Creates a mock LLM that echoes back messages
 * 3. Initializes the bridge context
 * 4. Simulates processing a message through the pipeline
 */

import { initBridgeContext } from '../context.js';
import * as router from '../channel-router.js';
import * as engine from '../../turn/interactive/sdk-conversation-engine.js';
import { consumeSseEvents } from '../../../runtime/sse-stream-decoder.js';
import {
  normalizeReasoningEffort,
  normalizeSandboxMode,
} from '../../../runtime/options.js';
import type {
  BridgeStore,
  BridgeSession,
  BridgeSessionUpdate,
  BridgeSessionCodexRuntimeState,
  RuntimeAgent,
  UpsertChannelChatInput,
} from '../../../domain/index.js';
import type {
  LLMProvider,
  StreamChatParams,
} from '../../../runtime/contracts.js';
import type {
  BridgeMessage,
} from '../../../domain/message.js';
import {
  getSessionCodexThreadId,
  getSessionWorkingDirectory,
  materializeBridgeSessionRuntime,
  setSessionCodexThreadIdUpdate,
} from '../../../domain/session-runtime.js';
import type { ChannelChat, ChannelType } from '../../../domain/channel.js';

// ── In-memory Store ─────────────────────────────────────────

class InMemoryStore implements BridgeStore {
  private settings = new Map<string, string>();
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelChat>();
  private messages = new Map<string, BridgeMessage[]>();
  private nextId = 1;

  getSetting(key: string) { return this.settings.get(key) ?? null; }

  getChannelChat(channelType: string, chatId: string) {
    return Array.from(this.bindings.values()).find((binding) => (
      binding.channelType === channelType
      && binding.chatId === chatId
    )) ?? null;
  }

  upsertChannelChat(data: UpsertChannelChatInput) {
    const existing = Array.from(this.bindings.values()).find((binding) => (
      binding.channelType === data.channelType
      && binding.chatId === data.chatId
    ));
    const id = existing?.id || `binding-${this.nextId++}`;
    const binding: ChannelChat = {
      id,
      channelType: data.channelType,
      channelProvider: data.channelProvider ?? existing?.channelProvider,
      channelAlias: data.channelAlias ?? existing?.channelAlias,
      chatId: data.chatId,
      chatUserId: data.chatUserId ?? existing?.chatUserId,
      bridgeSessionId: data.bridgeSessionId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.bindings.set(id, binding);
    return binding;
  }

  deleteChannelChat(id: string) {
    this.bindings.delete(id);
  }

  updateChannelChat(id: string, updates: Partial<ChannelChat>) {
    const existing = this.bindings.get(id);
    if (!existing) return;
    const updated = { ...existing, ...updates };
    this.bindings.set(id, updated);
  }

  touchChannelChatActivity(id: string, timestamp = new Date().toISOString()) {
    const existing = this.bindings.get(id);
    if (!existing) return;
    this.bindings.set(id, { ...existing, lastActivityAt: timestamp });
  }

  listChannelChats(_channelType?: ChannelType) { return Array.from(this.bindings.values()); }
  getSession(id: string) { return this.sessions.get(id) ?? null; }

  listSessions() { return Array.from(this.sessions.values()); }

  findSessionByCodexThreadId(codexThreadId: string) {
    return Array.from(this.sessions.values()).find((session) => (
      getSessionCodexThreadId(session) === codexThreadId
    )) ?? null;
  }

  createSession(
    name: string,
    _model: string,
    _sp?: string,
    cwd?: string,
    _mode?: string,
    options?: {
      reasoningEffort?: BridgeSessionCodexRuntimeState['reasoningEffort'];
      activeRuntime?: RuntimeAgent;
      sessionType?: BridgeSession['session_type'];
      hidden?: boolean;
      parentSessionId?: string;
      expiresAt?: string;
    },
  ) {
    const now = new Date().toISOString();
    const session: BridgeSession = {
      id: `session-${this.nextId++}`,
      name,
      runtime: options?.activeRuntime === 'claude' || options?.activeRuntime === 'kimi' || options?.activeRuntime === 'cursor' || options?.activeRuntime === 'zcode' ? {
        activeRuntime: options.activeRuntime,
        general: {
          workingDirectory: cwd || '/tmp',
        },
      } : {
        ...(options?.activeRuntime === 'codex' ? { activeRuntime: 'codex' as const } : {}),
        general: {
          workingDirectory: cwd || '/tmp',
        },
      },
      session_type: options?.sessionType || 'normal',
      hidden: options?.hidden === true,
      parent_session_id: options?.parentSessionId,
      expires_at: options?.expiresAt,
      created_at: now,
      updated_at: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  updateSessionProviderId() {}
  updateSession(sessionId: string, updates: BridgeSessionUpdate, options?: { touch?: boolean }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, materializeBridgeSessionRuntime({
      ...session,
      ...updates,
      id: session.id,
      updated_at: options?.touch === false ? session.updated_at : new Date().toISOString(),
    } as unknown as BridgeSession));
  }
  deleteSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    for (const [key, binding] of this.bindings) {
      if (binding.bridgeSessionId === sessionId) {
        this.bindings.delete(key);
      }
    }
  }
  addMessage(sessionId: string, role: string, content: string) {
    const msgs = this.messages.get(sessionId) || [];
    msgs.push({ role, content });
    this.messages.set(sessionId, msgs);
  }
  getMessages(sessionId: string) { return { messages: this.messages.get(sessionId) || [] }; }
  acquireSessionLock() { return true; }
  renewSessionLock() {}
  releaseSessionLock() {}
  setSessionRuntimeStatus() {}
  updateSessionCodexThreadId(sessionId: string, codexThreadId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.updateSession(sessionId, setSessionCodexThreadIdUpdate(codexThreadId || undefined));
    }
  }
  updateSessionModel(_sessionId: string, _model: string) {
    // Runtime-reported model is no longer persisted as session config.
  }
  syncSdkTasks() {}
  getProvider() { return undefined; }
  getDefaultProviderId() { return null; }
  insertAuditLog() {}
  checkDedup() { return false; }
  insertDedup() {}
  cleanupExpiredDedup() {}
  insertOutboundRef() {}
  insertPermissionLink() {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved() { return false; }
  listPendingPermissionLinksByChat() { return []; }
  getChannelOffset() { return '0'; }
  setChannelOffset() {}
}

// ── Echo LLM (returns user input as response) ───────────────

class EchoLLM implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const response = `Echo: ${params.prompt}`;
    return new ReadableStream({
      start(controller) {
        // Emit text event
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: response })}\n`);
        // Emit result event
        controller.enqueue(`data: ${JSON.stringify({
          type: 'result',
          data: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }),
        })}\n`);
        controller.close();
      },
    });
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('=== CodeLark Bridge Mock Host Example ===\n');

  // 1. Initialize context
  const store = new InMemoryStore();
  const llm = new EchoLLM();
  initBridgeContext({
    store,
    llm,
    permissions: { resolvePendingPermission: () => true },
    lifecycle: {
      onBridgeStart: () => console.log('[lifecycle] Bridge started'),
      onBridgeStop: () => console.log('[lifecycle] Bridge stopped'),
    },
  });

  // 2. Simulate an inbound message
  const address = { channelType: 'feishu-default', chatId: '12345', displayName: 'Test User' };

  console.log('Resolving channel chat...');
  const binding = router.resolve(address);
  console.log(`  Session: ${binding.bridgeSessionId}`);
  console.log(`  CWD: ${getSessionWorkingDirectory(store.getSession(binding.bridgeSessionId)) || ''}\n`);

  // 3. Process message through conversation engine
  console.log('Processing message: "Hello, Codex!"');
  const result = await engine.processMessage(
    binding,
    'Hello, Codex!',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      store,
      llm,
      consumeSseEvents,
      normalizeSandboxMode,
      normalizeReasoningEffort,
    },
  );

  console.log(`\nResult:`);
  console.log(`  Response: "${result.responseText}"`);
  console.log(`  Has error: ${result.hasError}`);
  console.log(`  Token usage: ${JSON.stringify(result.tokenUsage)}`);

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
