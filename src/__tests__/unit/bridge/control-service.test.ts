import '../../setup/test-setup.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  cancelRemoteConditionMonitor,
  createRemoteConditionMonitor,
  deliverAgentInputFromSession,
  deliverManualInput,
  deliverPlatformMessageToSession,
  discoverBridgeSessions,
  listRemoteConditionMonitors,
  startBridgeControlService,
  type BridgeControlService,
} from '../../../bridge/control/service-discovery.js';
import { formatAgentSourceXml } from '../../../bridge/control/session-catalog.js';

describe('bridge control service', () => {
  const roots: string[] = [];
  const services: BridgeControlService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('registers multiple CodeLark homes globally and searches live sessions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-discovery-test-'));
    roots.push(root);
    const directory = path.join(root, 'discovery');
    for (const [index, name] of ['qaq', '八千代'].entries()) {
      services.push(await startBridgeControlService({
        codelarkHome: path.join(root, `home-${index}`),
        runId: `run-${index}`,
        discoveryDirectory: directory,
        handlers: {
          listSessions: (query) => {
            const session = {
              codelarkHome: path.join(root, `home-${index}`),
              internalChatId: `chat-internal-${index}`,
              platformChatId: `oc_${index}`,
              bridgeSessionId: `bridge-${index}`,
              chatName: `${name}群`,
              agentName: name,
              channelType: `feishu-${index}`,
              runtime: 'codex',
              runtimeStatus: 'idle',
            };
            return !query || JSON.stringify(session).includes(query) ? [session] : [];
          },
          receiveInput: () => {},
        },
      }));
    }

    assert.equal((await discoverBridgeSessions({ discoveryDirectory: directory })).length, 2);
    const matched = await discoverBridgeSessions({ query: '八千代', discoveryDirectory: directory });
    assert.deepEqual(matched.map((item) => item.internalChatId), ['chat-internal-1']);
  });

  it('rejects an empty structured target instead of selecting an arbitrary session', async () => {
    await assert.rejects(
      deliverManualInput({
        target: {},
        text: 'must not send',
        source: {
          codelarkHome: '/source',
          internalChatId: 'source',
          platformChatId: 'oc_source',
          bridgeSessionId: 'source-session',
          chatName: '来源',
          botName: '来源',
        },
      }),
      /目标筛选条件不能为空/u,
    );
  });

  it('lets a restarted Bridge replace the descriptor for the same Home', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-discovery-restart-test-'));
    roots.push(root);
    const directory = path.join(root, 'discovery');
    const home = path.join(root, 'same-home');
    const first = await startBridgeControlService({
      codelarkHome: home,
      runId: 'old-run',
      discoveryDirectory: directory,
      handlers: {
        listSessions: () => [],
        receiveInput: () => {},
      },
    });
    services.push(first);
    const replacement = await startBridgeControlService({
      codelarkHome: home,
      runId: 'new-run',
      discoveryDirectory: directory,
      handlers: {
        listSessions: () => [{
          codelarkHome: home,
          internalChatId: 'replacement-chat',
          platformChatId: 'oc_replacement',
          bridgeSessionId: 'replacement-session',
          chatName: '新 Bridge',
          agentName: '新 Bridge',
          channelType: 'feishu-new',
          runtime: 'codex',
          runtimeStatus: 'idle',
        }],
        receiveInput: () => {},
      },
    });
    services.push(replacement);

    await first.close();
    services.splice(services.indexOf(first), 1);
    assert.deepEqual(
      (await discoverBridgeSessions({ codelarkHome: home, discoveryDirectory: directory }))
        .map((item) => item.internalChatId),
      ['replacement-chat'],
    );
  });

  it('delivers ordinary text and source metadata to one exact target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-delivery-test-'));
    roots.push(root);
    const directory = path.join(root, 'discovery');
    const received: unknown[] = [];
    services.push(await startBridgeControlService({
      codelarkHome: path.join(root, 'target-home'),
      runId: 'target-run',
      discoveryDirectory: directory,
      handlers: {
        listSessions: () => [{
          codelarkHome: path.join(root, 'target-home'),
          internalChatId: 'target-internal',
          platformChatId: 'oc_target',
          bridgeSessionId: 'target-bridge',
          chatName: '目标群',
          agentName: '目标群',
          channelType: 'feishu-target',
          runtime: 'codex',
          runtimeStatus: 'idle',
        }],
        receiveInput: (request) => { received.push(request); },
      },
    }));
    const source = {
      codelarkHome: path.join(root, 'source-home'),
      internalChatId: 'source-internal',
      platformChatId: 'oc_source',
      bridgeSessionId: 'source-bridge',
      chatName: '来源<&群',
      botName: 'qaq',
    };

    const target = await deliverManualInput({
      target: 'target-bridge',
      text: '  /stop\n',
      source,
      discoveryDirectory: directory,
    });

    assert.equal(target.chatName, '目标群');
    assert.deepEqual(received, [{ targetInternalChatId: 'target-internal', text: '  /stop\n', source }]);
    const targetByVisiblePrefix = await deliverManualInput({
      target: 'target-bri',
      text: '卡片显示的唯一前缀也可解析',
      source,
      discoveryDirectory: directory,
    });
    assert.equal(targetByVisiblePrefix.bridgeSessionId, 'target-bridge');
    for (const compatibleTarget of ['target-internal', 'oc_target']) {
      const resolved = await deliverManualInput({
        target: compatibleTarget,
        text: `字符串 target 兼容 ${compatibleTarget}`,
        source,
        discoveryDirectory: directory,
      });
      assert.equal(resolved.bridgeSessionId, 'target-bridge');
    }
    for (const compatibleId of ['target-bridge', 'target-internal', 'oc_target']) {
      const compatibilityTarget = await deliverManualInput({
        target: {
          chatId: compatibleId,
          codelarkHome: path.join(root, 'target-home'),
        },
        text: `兼容既有身份 ${compatibleId}`,
        source,
        discoveryDirectory: directory,
      });
      assert.equal(compatibilityTarget.bridgeSessionId, 'target-bridge');
    }
    const agentContext = formatAgentSourceXml(source, 'target-bridge');
    assert.match(agentContext, /来源群聊："来源\\u003c&群"/u);
    assert.match(agentContext, /来源会话 ID："source-bridge"/u);
    assert.match(agentContext, /当前会话 ID："target-bridge"/u);
    assert.equal(agentContext.split('\n').length, 6);
    assert.doesNotMatch(agentContext, /source-internal|codelark_home|platform_chat_id/u);
  });

  it('delivers Agent input, visible Feishu cards, and stable monitor control over one target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-monitor-control-test-'));
    roots.push(root);
    const directory = path.join(root, 'discovery');
    const agentRequests: unknown[] = [];
    const platformRequests: unknown[] = [];
    const tasks: any[] = [];
    services.push(await startBridgeControlService({
      codelarkHome: path.join(root, 'home'),
      runId: 'monitor-run',
      discoveryDirectory: directory,
      handlers: {
        listSessions: () => [{
          codelarkHome: path.join(root, 'home'),
          internalChatId: 'internal-1',
          platformChatId: 'oc_1',
          bridgeSessionId: 'bridge-1',
          chatName: '监控群',
          agentName: 'qaq',
          channelType: 'feishu',
          runtime: 'codex',
          runtimeStatus: 'idle',
        }],
        receiveInput: () => {},
        sendAgentInput: (request) => { agentRequests.push(request); },
        sendPlatformMessage: (request) => { platformRequests.push(request); },
        conditionMonitors: {
          create: (request) => {
            const task = {
              id: 'stable-task-id',
              ...request,
              label: request.label || 'monitor',
              status: 'running' as const,
              createdAt: '2026-08-09T00:00:00.000Z',
              updatedAt: '2026-08-09T00:00:00.000Z',
              checkedCount: 0,
            };
            tasks.push(task);
            return task;
          },
          list: () => tasks,
          cancel: (taskId) => {
            const task = tasks.find((candidate) => candidate.id === taskId);
            if (!task) return null;
            task.status = 'cancelled';
            return task;
          },
        },
      },
    }));

    await deliverAgentInputFromSession({
      source: 'bridge-1',
      target: 'bridge-1',
      text: '检查完成',
      discoveryDirectory: directory,
    });
    await deliverPlatformMessageToSession({
      target: 'bridge-1',
      platformMessage: {
        msgType: 'interactive',
        content: { header: { template: 'green' } },
      },
      discoveryDirectory: directory,
    });
    const created = await createRemoteConditionMonitor({
      owner: 'bridge-1',
      scriptPath: path.join(root, 'monitor.py'),
      pythonExecutable: 'python3',
      intervalSeconds: 300,
      timeoutSeconds: 60,
      discoveryDirectory: directory,
    });
    assert.equal(created.id, 'stable-task-id');
    assert.deepEqual(agentRequests, [{
      sourceInternalChatId: 'internal-1',
      target: 'bridge-1',
      codelarkHome: path.join(root, 'home'),
      text: '检查完成',
    }]);
    assert.deepEqual(platformRequests, [{
      targetInternalChatId: 'internal-1',
      platformMessage: { msgType: 'interactive', content: { header: { template: 'green' } } },
    }]);
    assert.equal((await listRemoteConditionMonitors({
      owner: 'bridge-1',
      discoveryDirectory: directory,
    })).length, 1);
    assert.equal((await listRemoteConditionMonitors({
      ownerHome: path.join(root, 'home'),
      discoveryDirectory: directory,
    })).length, 1);
    assert.equal((await cancelRemoteConditionMonitor({
      codelarkHome: path.join(root, 'home'),
      taskId: 'stable-task-id',
      discoveryDirectory: directory,
    })).status, 'cancelled');
  });

  it('rejects an ambiguous name unless a CodeLark home disambiguates it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-ambiguous-test-'));
    roots.push(root);
    const directory = path.join(root, 'discovery');
    const received: string[] = [];
    for (const index of [0, 1]) {
      const home = path.join(root, `home-${index}`);
      services.push(await startBridgeControlService({
        codelarkHome: home,
        runId: `run-${index}`,
        discoveryDirectory: directory,
        handlers: {
          listSessions: () => [{
            codelarkHome: home,
            internalChatId: `internal-${index}`,
            platformChatId: `oc_${index}`,
            bridgeSessionId: `bridge-${index}`,
            chatName: '同名群',
            agentName: `agent-${index}`,
            channelType: `feishu-${index}`,
            runtime: 'codex',
            runtimeStatus: 'idle',
          }],
          receiveInput: () => { received.push(home); },
        },
      }));
    }
    const source = {
      codelarkHome: root,
      internalChatId: 'source',
      platformChatId: 'oc_source',
      bridgeSessionId: 'source-session',
      chatName: '来源',
      botName: '来源',
    };

    await assert.rejects(
      deliverManualInput({ target: '同名群', text: 'hello', source, discoveryDirectory: directory }),
      /目标群聊不唯一/u,
    );
    const target = await deliverManualInput({
      target: '同名群',
      text: 'hello',
      source,
      codelarkHome: path.join(root, 'home-1'),
      discoveryDirectory: directory,
    });
    assert.equal(target.internalChatId, 'internal-1');
    assert.deepEqual(received, [path.join(root, 'home-1')]);

    const compositeTarget = await deliverManualInput({
      target: {
        chatName: '同名群',
        botName: 'agent-0',
        runtime: 'codex',
      },
      text: 'composite',
      source,
      discoveryDirectory: directory,
    });
    assert.equal(compositeTarget.internalChatId, 'internal-0');
    assert.deepEqual(received, [path.join(root, 'home-1'), path.join(root, 'home-0')]);
  });

  it('keeps a live descriptor after a transient endpoint failure and prunes a dead one', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-stale-test-'));
    roots.push(root);
    const directory = path.join(root, 'discovery');
    fs.mkdirSync(directory, { recursive: true });
    const base = {
      version: 1,
      endpoint: 'http://127.0.0.1:9',
      token: 'test-token',
      startedAt: new Date().toISOString(),
    } as const;
    const descriptorFile = (home: string) => {
      const resolved = path.resolve(home);
      const canonical = process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
      return path.join(
        directory,
        `${crypto.createHash('sha256').update(canonical).digest('hex')}.json`,
      );
    };
    const liveHome = path.join(root, 'live-home');
    const deadHome = path.join(root, 'dead-home');
    const livePath = descriptorFile(liveHome);
    const deadPath = descriptorFile(deadHome);
    const deadPid = process.pid === 424_242 ? 424_243 : 424_242;
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(signal, 0);
      if (pid === deadPid) {
        const error = new Error('process not found') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    });
    fs.writeFileSync(livePath, JSON.stringify({
      ...base,
      codelarkHome: liveHome,
      pid: process.pid,
      runId: 'live-run',
    }));
    fs.writeFileSync(deadPath, JSON.stringify({
      ...base,
      codelarkHome: deadHome,
      pid: deadPid,
      runId: 'dead-run',
    }));

    assert.deepEqual(await discoverBridgeSessions({ discoveryDirectory: directory }), []);
    assert.equal(fs.existsSync(livePath), true);
    assert.equal(fs.existsSync(deadPath), false);
    await assert.rejects(
      deliverManualInput({
        target: 'unknown-target',
        text: 'hello',
        source: {
          codelarkHome: root,
          internalChatId: 'source',
          platformChatId: 'oc_source',
          bridgeSessionId: 'source-session',
          chatName: '来源',
          botName: '来源',
        },
        codelarkHome: liveHome,
        discoveryDirectory: directory,
      }),
      /目标 Bridge 暂时无法访问/u,
    );
  });
});
