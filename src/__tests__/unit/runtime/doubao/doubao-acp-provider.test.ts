import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';

import {
  DoubaoAcpProvider,
  closeAllDoubaoAcpSessions,
  closeDoubaoAcpSession,
  doubaoModeToAcpModeId,
  getDoubaoAcpSessionActivity,
  interruptDoubaoAcpSession,
} from '../../../../runtime/doubao/acp-provider.js';
import type { AcpConnection, AcpMessage } from '../../../../runtime/acp/client.js';
import {
  parseDoubaoModelListOutput,
  resolveDoubaoModelChoice,
} from '../../../../runtime/doubao/models.js';
import {
  clearDoubaoSessionListCacheForTests,
  findCachedDoubaoSessionById,
  getCachedDoubaoSessions,
  parseDoubaoAcpSessionList,
  seedDoubaoSessionListCacheForTests,
} from '../../../../runtime/doubao/session-index.js';
import { PendingPermissions } from '../../../../runtime/permission-gateway.js';

class FakeDoubaoAcp implements AcpConnection {
  connected = true;
  nativeId = `doubao-${randomUUID()}`;
  calls: Array<{ method: string; params: any }> = [];
  responses: Array<{ id: string | number; result: any }> = [];
  listeners = new Set<(message: AcpMessage) => void>();
  disconnectListeners = new Set<(error: Error) => void>();
  pending?: { resolve(value: any): void; reject(error: Error): void };
  onPrompt?: (params: any, index: number) => void;
  onCancel?: () => void;
  count = 0;
  currentModeId = 'default';
  configOptions: Array<Record<string, any>> = [
    {
      id: 'model',
      currentValue: 'doubao-seed-2.0-code',
      options: [
        { value: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code' },
        { value: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro' },
      ],
    },
    {
      id: 'effort',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
  ];

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'initialize') {
      return Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
        authMethods: [],
      } as T);
    }
    if (method === 'session/new') {
      return Promise.resolve({
        sessionId: this.nativeId,
        modes: {
          currentModeId: this.currentModeId,
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
            { id: 'bypass_permissions', name: 'Bypass' },
          ],
        },
        configOptions: this.configOptions,
      } as T);
    }
    if (method === 'session/load') {
      this.nativeId = (params as any).sessionId;
      // 模拟跨进程 load 时的历史回放；provider 必须抑制，不能流向新 turn
      this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY MUST NOT REPLAY' } });
      this.update({ sessionUpdate: 'tool_call', toolCallId: 'historical-tool', kind: 'execute' });
      return Promise.resolve({
        modes: { currentModeId: this.currentModeId },
        configOptions: this.configOptions,
      } as T);
    }
    if (method === 'session/set_mode') {
      this.currentModeId = (params as any).modeId;
      return Promise.resolve({} as T);
    }
    if (method === 'session/set_config_option') {
      const { configId, value } = params as any;
      const option = this.configOptions.find((item) => item.id === configId);
      if (!option || !option.options.some((entry: any) => entry.value === value)) {
        return Promise.reject(new Error(`Invalid option ${configId}=${value}`));
      }
      option.currentValue = value;
      return Promise.resolve({ configOptions: this.configOptions } as T);
    }
    if (method === 'session/prompt') {
      assert.equal(this.pending, undefined, 'only one native prompt at a time');
      const promise = new Promise<T>((resolve, reject) => {
        this.pending = { resolve, reject };
      });
      const count = ++this.count;
      queueMicrotask(() => this.onPrompt?.(params, count));
      return promise;
    }
    return Promise.resolve({} as T);
  }

  notify(method: string, params: unknown = {}) {
    this.calls.push({ method, params });
    if (method === 'session/cancel') this.onCancel?.();
  }

  respond(id: string | number, result: unknown) {
    this.responses.push({ id, result });
  }

  reject(id: string | number, code: number, message: string) {
    this.responses.push({ id, result: { error: { code, message } } });
  }

  onMessage(listener: (message: AcpMessage) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onDisconnect(listener: (error: Error) => void) {
    this.disconnectListeners.add(listener);
    return () => { this.disconnectListeners.delete(listener); };
  }

  send(message: AcpMessage) {
    for (const listener of this.listeners) listener(message);
  }

  update(update: unknown) {
    this.send({ method: 'session/update', params: { sessionId: this.nativeId, update } });
  }

  end(stopReason = 'end_turn') {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve({ stopReason });
  }

  close() {
    this.disconnect(new Error('test process exited'));
  }

  disconnect(error: Error) {
    if (!this.connected) return;
    this.connected = false;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
    for (const listener of this.disconnectListeners) listener(error);
  }
}

interface Event { type: string; data: any }

async function collect(stream: ReadableStream<string>, onEvent?: (event: Event) => void): Promise<Event[]> {
  const reader = stream.getReader();
  const events: Event[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    for (const line of next.value.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const raw = JSON.parse(line.slice(6));
      let data: unknown = raw.data;
      try { data = JSON.parse(raw.data); } catch {}
      const event = { type: raw.type, data };
      events.push(event);
      onEvent?.(event);
    }
  }
  return events;
}

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setup(perms?: PendingPermissions) {
  const client = new FakeDoubaoAcp();
  const provider = new DoubaoAcpProvider(perms, {
    clientFactory: async () => client,
    cancelTimeoutMs: 100,
    retryDelayMs: 0,
  });
  const sessionId = `bridge-doubao-${randomUUID()}`;
  return { client, provider, sessionId };
}

afterEach(async () => {
  await closeAllDoubaoAcpSessions();
  clearDoubaoSessionListCacheForTests();
});

describe('Doubao ACP provider', () => {
  it('maps doubao modes to ACP mode ids', () => {
    assert.equal(doubaoModeToAcpModeId('normal'), 'default');
    assert.equal(doubaoModeToAcpModeId('plan'), 'plan');
    assert.equal(doubaoModeToAcpModeId('yolo'), 'bypass_permissions');
    assert.equal(doubaoModeToAcpModeId(undefined), 'default');
  });

  it('streams thought, text, tool_call, tool_call_update, and plan events, and hot-updates mode/model/effort', async () => {
    const { client, provider, sessionId } = setup();
    client.onPrompt = () => {
      client.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先检查文件结构' } });
      client.update({ sessionUpdate: 'plan', entries: [{ content: '读取配置', status: 'completed' }, { content: '输出结果', status: 'in_progress' }] });
      client.update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read file', kind: 'read', rawInput: { path: 'package.json' } });
      client.update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: '{"name":"codelark"}' });
      client.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '全部检查完成。' } });
      client.end('end_turn');
    };

    const events = await collect(provider.streamChat({
      sessionId,
      runtime: 'doubao',
      workingDirectory: '/tmp/doubao-ws',
      prompt: '检查项目',
      doubaoMode: 'plan',
      model: 'doubao-seed-2.0-pro',
      doubaoReasoningEffort: 'high',
    }));

    assert.equal(client.calls.filter((c) => c.method === 'session/set_mode')[0]?.params.modeId, 'plan');
    const configCalls = client.calls.filter((c) => c.method === 'session/set_config_option');
    assert.ok(configCalls.some((c) => c.params.configId === 'model' && c.params.value === 'doubao-seed-2.0-pro'));
    assert.ok(configCalls.some((c) => c.params.configId === 'effort' && c.params.value === 'high'));

    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.data).join(''), '全部检查完成。');
    assert.ok(events.some((e) => e.type === 'tool_use' && e.data.id === 'tool-1'));
    assert.ok(events.some((e) => e.type === 'tool_result' && e.data.tool_use_id === 'tool-1'));
    assert.ok(events.some((e) => e.type === 'status' && typeof e.data.reasoning === 'string' && e.data.reasoning.includes('豆包正在思考')));
    assert.ok(events.some((e) => e.type === 'task_update' && Array.isArray(e.data.tasks) && e.data.tasks.some((t: any) => t.text === '读取配置')));
    const result = events.find((e) => e.type === 'result');
    assert.equal(result?.data.outcome, 'completed');
    assert.equal(result?.data.session_id, client.nativeId);
    assert.equal(result?.data.model, 'Doubao Seed 2.0 Pro');

    // 第二轮复用同一个 ACP session 且只更新变化项
    const beforeCalls = client.calls.length;
    client.onPrompt = () => {
      client.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第二轮完成。' } });
      client.end('end_turn');
    };
    const secondEvents = await collect(provider.streamChat({
      sessionId,
      runtime: 'doubao',
      workingDirectory: '/tmp/doubao-ws',
      prompt: '继续',
      doubaoMode: 'yolo',
      model: 'doubao-seed-2.0-pro',
      doubaoReasoningEffort: 'high',
    }));
    const newCalls = client.calls.slice(beforeCalls);
    assert.equal(newCalls.filter((c) => c.method === 'session/new').length, 0);
    assert.equal(newCalls.filter((c) => c.method === 'session/set_mode')[0]?.params.modeId, 'bypass_permissions');
    assert.equal(newCalls.filter((c) => c.method === 'session/set_config_option').length, 0);
    assert.equal(secondEvents.filter((e) => e.type === 'text').map((e) => e.data).join(''), '第二轮完成。');
  });

  it('updates cached model/effort locally when session/set_config_option returns empty object', async () => {
    const { client, provider, sessionId } = setup();
    const origRequest = client.request.bind(client);
    client.request = (async <T = unknown>(method: string, params: Record<string, any> = {}): Promise<T> => {
      if (method === 'session/set_config_option') {
        client.calls.push({ method, params });
        return {} as T;
      }
      return origRequest<T>(method, params);
    }) as typeof client.request;

    client.onPrompt = () => {
      client.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
      client.end('end_turn');
    };

    const events = await collect(provider.streamChat({
      sessionId,
      runtime: 'doubao',
      workingDirectory: '/tmp/doubao-empty-set',
      prompt: 'hi',
      model: 'doubao-seed-2.0-pro',
      doubaoReasoningEffort: 'high',
    }));

    const result = events.find((e) => e.type === 'result');
    assert.equal(result?.data.model, 'Doubao Seed 2.0 Pro');

    const beforeCalls = client.calls.length;
    await collect(provider.streamChat({
      sessionId,
      runtime: 'doubao',
      workingDirectory: '/tmp/doubao-empty-set',
      prompt: 'hi again',
      model: 'doubao-seed-2.0-pro',
      doubaoReasoningEffort: 'high',
    }));
    const secondCalls = client.calls.slice(beforeCalls);
    assert.equal(secondCalls.filter((c) => c.method === 'session/set_config_option').length, 0);
  });

  it('loads an existing native doubao session and suppresses historical replay', async () => {
    const { client, provider, sessionId } = setup();
    client.onPrompt = () => {
      client.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '仅当前轮正文' } });
      client.end('end_turn');
    };

    const events = await collect(provider.streamChat({
      sessionId,
      runtime: 'doubao',
      workingDirectory: '/tmp/doubao-resume',
      doubaoSessionId: 'existing-native-123',
      prompt: '接着上次聊',
    }));

    assert.equal(client.calls.filter((c) => c.method === 'session/load').length, 1);
    assert.equal(client.calls.filter((c) => c.method === 'session/new').length, 0);
    const fullText = events.filter((e) => e.type === 'text').map((e) => e.data).join('');
    assert.equal(fullText, '仅当前轮正文');
    assert.ok(!fullText.includes('OLD HISTORY'));
    assert.equal(events.filter((e) => e.type === 'tool_use').length, 0);
  });

  it('forwards session/request_permission through PendingPermissions and auto-approves in yolo mode', async () => {
    const perms = new PendingPermissions();
    const { client, provider, sessionId } = setup(perms);
    client.onPrompt = (_params, index) => {
      if (index === 1) {
        client.send({
          id: 91,
          method: 'session/request_permission',
          params: {
            sessionId: client.nativeId,
            toolCall: { toolCallId: 'perm-1', title: 'Run shell', kind: 'execute', rawInput: { command: 'rm -rf /tmp/x' } },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          },
        });
      } else {
        client.send({
          id: 92,
          method: 'session/request_permission',
          params: {
            sessionId: client.nativeId,
            toolCall: { toolCallId: 'perm-2', title: 'Run shell', kind: 'execute', rawInput: { command: 'ls' } },
            options: [
              { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          },
        });
        queueMicrotask(() => {
          client.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'yolo 自动放行' } });
          client.end('end_turn');
        });
      }
    };

    const turn1 = collect(provider.streamChat({
      sessionId,
      runtime: 'doubao',
      workingDirectory: '/tmp/doubao-perm',
      doubaoMode: 'normal',
      prompt: '需要审批的命令',
    }), (event) => {
      if (event.type === 'permission_request') {
        perms.resolve(event.data.permissionRequestId, { behavior: 'allow' });
        queueMicrotask(() => {
          client.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '审批已通过' } });
          client.end('end_turn');
        });
      }
    });
    const events1 = await turn1;
    assert.ok(events1.some((e) => e.type === 'permission_request'));
    assert.deepEqual(client.responses.find((r) => r.id === 91)?.result, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    const events2 = await collect(provider.streamChat({
      sessionId,
      runtime: 'doubao',
      workingDirectory: '/tmp/doubao-perm',
      doubaoMode: 'yolo',
      prompt: '免审批命令',
    }));
    assert.equal(events2.filter((e) => e.type === 'permission_request').length, 0);
    assert.deepEqual(client.responses.find((r) => r.id === 92)?.result, {
      outcome: { outcome: 'selected', optionId: 'allow-always' },
    });
  });

  it('cancels an active prompt cleanly via interruptDoubaoAcpSession and reports activity', async () => {
    const { client, provider, sessionId } = setup();
    client.onPrompt = () => {
      client.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正在输出...' } });
    };
    client.onCancel = () => {
      queueMicrotask(() => client.end('cancelled'));
    };

    const eventsPromise = collect(provider.streamChat({
      sessionId,
      runtime: 'doubao',
      workingDirectory: '/tmp/doubao-cancel',
      prompt: '长任务',
    }));

    await until(() => client.count === 1);
    assert.equal(getDoubaoAcpSessionActivity(sessionId), 'active');
    const interrupted = await interruptDoubaoAcpSession(sessionId);
    assert.equal(interrupted, true);

    const events = await eventsPromise;
    assert.equal(events.find((e) => e.type === 'result')?.data.outcome, 'aborted');
    assert.equal(getDoubaoAcpSessionActivity(sessionId), 'idle');

    await closeDoubaoAcpSession(sessionId);
    assert.equal(getDoubaoAcpSessionActivity(sessionId), 'idle');
  });

  it('retries transient errors without repeating completed side-effect tools', async () => {
    const { client, provider, sessionId } = setup();
    client.onPrompt = (_params, index) => {
      if (index === 1) {
        client.update({ sessionUpdate: 'tool_call', toolCallId: 'once', kind: 'execute', rawInput: { command: 'echo hi' } });
        client.update({ sessionUpdate: 'tool_call_update', toolCallId: 'once', status: 'completed', rawOutput: 'hi' });
        client.pending?.reject(new Error('http/2 stream closed with error code CANCEL'));
        client.pending = undefined;
      } else {
        client.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已自动续接完成' } });
        client.end('end_turn');
      }
    };

    const events = await collect(provider.streamChat({
      sessionId,
      runtime: 'doubao',
      workingDirectory: '/tmp/doubao-retry',
      prompt: '原始请求',
    }));

    const prompts = client.calls.filter((c) => c.method === 'session/prompt');
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0]?.params.prompt[0].text, '原始请求');
    assert.match(prompts[1]?.params.prompt[0].text, /不要重复已完成/);
    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.data).join(''), '已自动续接完成');
    assert.equal(events.find((e) => e.type === 'result')?.data.outcome, 'completed');
  });

  it('reloads the ACP session when clearing an explicit model or effort override back to default', async () => {
    const clients: FakeDoubaoAcp[] = [];
    const launches: Array<string[] | undefined> = [];
    const provider = new DoubaoAcpProvider(undefined, {
      clientFactory: async (opts) => {
        launches.push(opts.args);
        const client = new FakeDoubaoAcp();
        client.onPrompt = () => client.end('end_turn');
        clients.push(client);
        return client;
      },
    });
    const sessionId = `doubao-reset-${randomUUID()}`;

    await collect(provider.streamChat({
      sessionId,
      runtime: 'doubao',
      workingDirectory: '/tmp/doubao-reset',
      prompt: 'turn 1',
      model: 'doubao-seed-2.0-pro',
      doubaoReasoningEffort: 'high',
    }));
    const nativeId = clients[0]!.nativeId;
    assert.equal(clients.length, 1);

    // Clearing model & effort overrides back to default must dispose and reload without --model/--effort.
    await collect(provider.streamChat({
      sessionId,
      runtime: 'doubao',
      doubaoSessionId: nativeId,
      workingDirectory: '/tmp/doubao-reset',
      prompt: 'turn 2',
    }));
    assert.equal(clients.length, 2);
    assert.equal(clients[0]!.connected, false);
    assert.ok(!launches[1]?.includes('--model'));
    assert.ok(!launches[1]?.includes('--effort'));
    assert.equal(clients[1]!.calls.find((c) => c.method === 'session/load')?.params.sessionId, nativeId);
  });
});

describe('Doubao models and session-index parsers', () => {
  it('parses doubao model list --json output mixed with [cli-chat] log lines', () => {
    const stdout = [
      '[cli-chat] {"level":"info","msg":"init"}',
      '[cli-chat] {"level":"info","msg":"fetching models"}',
      JSON.stringify({
        type: 'result',
        result: {
          type: 'model_list',
          models: [
            { id: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code', default: true, reasoning_efforts: ['low', 'medium', 'high'], default_reasoning_effort: 'medium' },
            { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro', isDefault: false, efforts: ['none', 'low', 'high'] },
          ],
        },
      }),
    ].join('\n');

    const models = parseDoubaoModelListOutput(stdout);
    assert.equal(models.length, 2);
    assert.equal(models[0]?.id, 'doubao-seed-2.0-code');
    assert.equal(models[0]?.isDefault, true);
    assert.deepEqual(models[0]?.efforts, ['low', 'medium', 'high']);
    assert.equal(resolveDoubaoModelChoice('2.0 Pro', models)?.id, 'doubao-seed-2.0-pro');
    assert.equal(resolveDoubaoModelChoice('doubao-seed-2.0-code', models)?.id, 'doubao-seed-2.0-code');
  });

  it('parses ACP session/list payloads and resolves cached doubao sessions', () => {
    const parsed = parseDoubaoAcpSessionList({
      sessions: [
        { sessionId: 'db-1', cwd: '/tmp/a', title: 'First', updatedAt: '2026-11-26T08:00:00.000Z' },
        { sessionId: 'db-2', cwd: '/tmp/b', title: 'Second', updatedAt: '2026-11-26T09:00:00.000Z' },
      ],
    });
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.sessionId, 'db-2');

    seedDoubaoSessionListCacheForTests(parsed);
    assert.equal(getCachedDoubaoSessions().length, 2);
    assert.equal(findCachedDoubaoSessionById('db-1', '/tmp/a')?.title, 'First');
    assert.equal(findCachedDoubaoSessionById('nonexistent'), null);
  });
});
