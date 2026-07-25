import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FeishuAdapter, _testOnly } from '../../../../channels/feishu/adapter.js';
import { _testOnlyWaitForDeliveryQueuesForTests } from '../../../../channels/delivery/deliver.js';
import {
  _testOnly as largeFileUploadTestOnly,
  LARGE_FILE_UPLOAD_THRESHOLD_BYTES,
} from '../../../../bridge/command/file-upload-confirmations.js';
import type { FileAttachment } from '../../../../domain/index.js';
import { initBridgeTestContext } from '../../../helpers/bridge/test-bridge-utils.js';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function resolvesWithin<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`promise did not resolve within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function findCardElement(root: unknown, predicate: (element: any) => boolean): any | null {
  if (!root || typeof root !== 'object') return null;
  if (predicate(root as any)) return root;
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findCardElement(item, predicate);
      if (found) return found;
    }
    return null;
  }
  for (const value of Object.values(root as Record<string, unknown>)) {
    const found = findCardElement(value, predicate);
    if (found) return found;
  }
  return null;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function cloudDocumentCommentEvent(eventId: string, event: Record<string, any>) {
  return {
    header: { event_id: eventId },
    event,
  };
}

describe('feishu-adapter structured streaming regions', () => {
  it('extracts selected callback data from select_static object options', () => {
    const callbackData = 'codex-tui-selection-choice:codex-selection%3Aupdate%3Atmux%3Asession%3A1:skip';

    assert.equal(_testOnly.extractFeishuCardActionCallbackData({
      action: {
        tag: 'select_static',
        value: { select_id: 'clk_codex_tui_selection' },
        option: {
          text: { tag: 'plain_text', content: 'Skip' },
          value: callbackData,
        },
      },
    }), callbackData);

    assert.equal(_testOnly.extractFeishuCardActionCallbackData({
      action: {
        tag: 'select_static',
        value: { select_id: 'clk_codex_tui_selection' },
        option: {
          text: { tag: 'plain_text', content: 'Skip until next version' },
          value: { value: 'nested-choice' },
        },
      },
    }), 'nested-choice');
  });

  it('returns null for chat info only when Feishu reports the chat is gone', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).restClient = {
      im: {
        chat: {
          get: async () => ({ code: 230001, msg: 'chat not found: bot has been removed from chat' }),
        },
      },
    };

    const info = await adapter.getGroupChatInfo('oc_removed');

    assert.equal(info, null);
  });

  it('throws for non-missing Feishu chat info errors so startup checks do not archive blindly', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).restClient = {
      im: {
        chat: {
          get: async () => ({ code: 99991663, msg: 'permission denied' }),
        },
      },
    };

    await assert.rejects(
      () => adapter.getGroupChatInfo('oc_permission_error'),
      /permission denied/,
    );
  });

  it('treats a successful chat lookup without chat_mode as unavailable for startup archive cleanup', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).restClient = {
      im: {
        chat: {
          get: async () => ({ code: 0, msg: 'success', data: { chat_id: 'oc_empty_mode', chat_mode: '' } }),
        },
      },
    };

    const info = await adapter.getGroupChatInfo('oc_empty_mode');

    assert.equal(info, null);
  });

  it('uploads the bot avatar URL as an avatar image key before creating Feishu groups', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const createdPayloads: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.includes('/tenant_access_token/internal')) {
        return Response.json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
      }
      if (url === 'https://example.test/avatar.png') {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png' },
        });
      }
      if (url.includes('/open-apis/im/v1/images')) {
        return Response.json({ code: 0, data: { image_key: 'avatar-image-key' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    (adapter as any).botName = 'BotName';
    (adapter as any).botId = 'cli_bot_id';
    (adapter as any).botAvatarUrl = 'https://example.test/avatar.png';
    (adapter as any).restClient = {
      im: {
        chat: {
          create: async (payload: Record<string, any>) => {
            createdPayloads.push(payload);
            return { code: 0, msg: 'success', data: { chat_id: 'oc_created', name: '[BotName]smoke' } };
          },
        },
        chatMembers: {
          create: async () => ({ code: 0, msg: 'success', data: {} }),
        },
      },
    };

    try {
      const created = await adapter.createGroupChat({
        name: 'smoke',
        ownerUserId: 'ou_owner',
        userIds: ['ou_owner'],
      });

      assert.equal(created.chatId, 'oc_created');
      assert.equal(created.name, '[BotName]smoke');
      assert.equal(createdPayloads.length, 1);
      assert.equal(createdPayloads[0].data.name, '[BotName]smoke');
      assert.equal(createdPayloads[0].data.avatar, 'avatar-image-key');
      const imageUpload = fetchCalls.find((call) => call.url.includes('/open-apis/im/v1/images'));
      assert.ok(imageUpload);
      assert.equal(imageUpload.init?.method, 'POST');
      assert.ok(imageUpload.init?.body instanceof FormData);
      const form = imageUpload.init.body as FormData;
      assert.equal(form.get('image_type'), 'avatar');
      assert.ok(form.get('image') instanceof File);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates cloud document groups through bot OpenAPI and invites the comment user', async () => {
    const createdPayloads: Array<Record<string, any>> = [];
    const memberPayloads: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'cli_bridge_bot',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botName = 'BotName';
    (adapter as any).botId = 'cli_bridge_bot';
    (adapter as any).restClient = {
      im: {
        chat: {
          create: async (payload: Record<string, any>) => {
            createdPayloads.push(payload);
            return { code: 0, msg: 'success', data: { chat_id: 'oc_user_created', name: '[BotName]doc review' } };
          },
        },
        chatMembers: {
          create: async (payload: Record<string, any>) => {
            memberPayloads.push(payload);
            return { code: 0, msg: 'success', data: {} };
          },
        },
      },
    };

    const created = await adapter.createGroupChat({
      name: 'doc review',
      ownerUserId: 'ou_app_scoped_user',
      userIds: ['ou_app_scoped_user'],
    });

    assert.equal(created.chatId, 'oc_user_created');
    assert.equal(created.name, '[BotName]doc review');
    assert.equal(createdPayloads.length, 1);
    assert.equal(createdPayloads[0].data.name, '[BotName]doc review');
    assert.equal(createdPayloads[0].data.owner_id, 'ou_app_scoped_user');
    assert.deepEqual(createdPayloads[0].data.user_id_list, ['ou_app_scoped_user']);
    assert.deepEqual(createdPayloads[0].data.bot_id_list, ['cli_bridge_bot']);
    assert.equal(memberPayloads.length, 1);
    assert.deepEqual(memberPayloads[0], {
      path: { chat_id: 'oc_user_created' },
      params: { member_id_type: 'open_id', succeed_type: 1 },
      data: { id_list: ['ou_app_scoped_user'] },
    });
  });

  it('falls back to the default group avatar when bot avatar upload fails', async () => {
    const originalFetch = globalThis.fetch;
    const createdPayloads: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://example.test/avatar.png') {
        return new Response('', { status: 404 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    (adapter as any).botName = 'BotName';
    (adapter as any).botAvatarUrl = 'https://example.test/avatar.png';
    (adapter as any).restClient = {
      im: {
        chat: {
          create: async (payload: Record<string, any>) => {
            createdPayloads.push(payload);
            return { code: 0, msg: 'success', data: { chat_id: 'oc_created', name: '[BotName]smoke' } };
          },
        },
      },
    };

    try {
      const created = await adapter.createGroupChat({ name: 'smoke' });

      assert.equal(created.chatId, 'oc_created');
      assert.equal(createdPayloads.length, 1);
      assert.equal('avatar' in createdPayloads[0].data, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('updates Feishu group chat name through im.chat.update with the bot prefix', async () => {
    const updatePayloads: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botName = 'BotName';
    (adapter as any).restClient = {
      im: {
        chat: {
          update: async (payload: Record<string, any>) => {
            updatePayloads.push(payload);
            return { code: 0, msg: 'success', data: { chat_id: 'oc_chat', name: '[BotName]新群名' } };
          },
        },
      },
    };

    const updated = await adapter.renameGroupChat('oc_chat', '新群名');

    assert.deepEqual(updated, { chatId: 'oc_chat', chatKind: 'group', name: '[BotName]新群名' });
    assert.equal(updatePayloads.length, 1);
    assert.deepEqual(updatePayloads[0].path, { chat_id: 'oc_chat' });
    assert.deepEqual(updatePayloads[0].params, { user_id_type: 'open_id' });
    assert.deepEqual(updatePayloads[0].data, { name: '[BotName]新群名' });
  });

  it('turns first mentioned cloud document comments into an internal doc chat creation event', async () => {
    initBridgeTestContext();
    const reactionRequests: Array<Record<string, any>> = [];
    const reactionAck = createDeferred<{ code: number; data: Record<string, never> }>();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('ou_bot');
    (adapter as any).restClient = {
      wiki: {
        v2: {
          space: {
            getNode: async () => {
              throw new Error('not wiki');
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            get: async () => ({
              data: {
                comment_id: 'comment-1',
                is_whole: false,
                quote: '被评论的原文',
                reply_list: {
                  replies: [
                    {
                      reply_id: 'reply-1',
                      content: {
                        elements: [
                          { type: 'text_run', text_run: { text: '@机器人 请总结这一段' } },
                        ],
                      },
                    },
                  ],
                },
              },
            }),
          },
        },
      },
      request: (payload: Record<string, any>) => {
        reactionRequests.push(payload);
        return reactionAck.promise;
      },
    };

    const processing = (adapter as any).processCloudDocumentCommentEvent(cloudDocumentCommentEvent('evt-doc-comment-1', {
      file_token: 'doc-token',
      file_type: 'docx',
      comment_id: 'comment-1',
      file: { name: '需求评审云文档' },
      reply_id: 'reply-1',
      operator_id: { open_id: 'ou_user' },
      mention_list: [{ id: { open_id: 'ou_bot' } }],
    }));
    await waitForCondition(() => reactionRequests.length === 1);
    await resolvesWithin(processing);

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.address.chatId, 'doc:docx:doc-token:comment:comment-1');
    assert.equal(inbound.address.cloudDocument?.fileToken, 'doc-token');
    assert.equal(inbound.address.cloudDocument?.commentId, 'comment-1');
    assert.equal(inbound.address.cloudDocument?.title, '需求评审云文档');
    assert.equal(inbound.address.cloudDocument?.replyId, 'reply-1');
    assert.equal(inbound.address.cloudDocument?.typingReactionReplyId, 'reply-1');
    assert.match(inbound.address.cloudDocument?.initialPrompt || '', /用户的问题：@机器人 请总结这一段/);
    assert.match(inbound.address.cloudDocument?.initialPrompt || '', /用户选中的原文：\n> 被评论的原文/);
    assert.equal(inbound.text, '/new');
    assert.equal(reactionRequests.length, 1);
    assert.match(reactionRequests[0].url, /\/open-apis\/drive\/v2\/files\/doc-token\/comments\/reaction\?file_type=docx/);
    assert.deepEqual(reactionRequests[0].data, {
      action: 'add',
      reply_id: 'reply-1',
      reaction_type: 'Typing',
    });
    reactionAck.resolve({ code: 0, data: {} });
  });

  it('matches cloud document comment mentions from nested Feishu id fields', async () => {
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('cli_bot_id');

    const target = (adapter as any).extractCloudDocumentCommentTarget({
      file_token: 'doc-token',
      file_type: 'docx',
      comment_id: 'comment-1',
      file: { title: '产品评审' },
      mention_list: [
        {
          mention_user: {
            bot_id: 'cli_bot_id',
          },
        },
      ],
    });

    assert.ok(target);
    assert.equal(target.documentTitle, '产品评审');
    assert.equal(target.mentioned, true);
    assert.equal(target.mentionDiagnostics.mentionListSource, 'event.mention_list');
    assert.equal(target.mentionDiagnostics.mentionCandidates[0].candidates[0].path, 'mention[0].mention_user.bot_id');
    assert.equal(target.mentionDiagnostics.mentionCandidates[0].candidates[0].matchedBotId, true);
  });

  it('logs cloud document mention diagnostics when no mention candidate matches the bot', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('ou_bot');

    const logs: any[][] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args);
    };
    try {
      await (adapter as any).processCloudDocumentCommentEvent(cloudDocumentCommentEvent('evt-doc-comment-no-mention', {
        file_token: 'doc-token',
        file_type: 'docx',
        comment_id: 'comment-1',
        mention_list: [{ id: { open_id: 'ou_someone_else' } }],
      }));
    } finally {
      console.log = originalLog;
    }

    const ignoredLog = logs.find((entry) => entry[0] === '[feishu-adapter] Cloud document comment ignored: bot not mentioned');
    assert.ok(ignoredLog);
    assert.equal(ignoredLog[1].fileType, 'docx');
    assert.equal(ignoredLog[1].mentionDiagnostics.mentionListSource, 'event.mention_list');
    assert.equal(ignoredLog[1].mentionDiagnostics.mentionListLength, 1);
    assert.equal(ignoredLog[1].mentionDiagnostics.botIdsKnown, 1);
    assert.equal(ignoredLog[1].mentionDiagnostics.mentionCandidates[0].candidates[0].path, 'mention[0].id.open_id');
    assert.equal(ignoredLog[1].mentionDiagnostics.mentionCandidates[0].candidates[0].matchedBotId, false);
    assert.match(ignoredLog[1].mentionDiagnostics.mentionCandidates[0].candidates[0].sha256, /^[a-f0-9]{12}$/);
    assert.match(ignoredLog[1].mentionDiagnostics.botIdHashes[0], /^[a-f0-9]{12}$/);
  });

  it('forwards unmentioned cloud document comments once the document is bound to a group', async () => {
    const store = initBridgeTestContext();
    const session = store.createSession('Doc group chat', 'test-model');
    store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'oc_doc_group',
      chatKind: 'group',
      bridgeSessionId: session.id,
      cloudDocumentChat: {
        provider: 'feishu',
        fileToken: 'doc-bound-token',
        fileType: 'docx',
      },
    });
    const reactionRequests: Array<Record<string, any>> = [];
    const groupMessages: Array<Record<string, any>> = [];
    const groupNoticeAck = createDeferred<{ data: { message_id: string } }>();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('ou_bot');
    (adapter as any).restClient = {
      wiki: {
        v2: {
          space: {
            getNode: async () => {
              throw new Error('not wiki');
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            get: async () => ({
              data: {
                comment_id: 'comment-2',
                is_whole: true,
                reply_list: {
                  replies: [
                    {
                      reply_id: 'reply-2',
                      content: {
                        elements: [
                          { type: 'text_run', text_run: { text: '继续整理这个 TODO' } },
                        ],
                      },
                    },
                  ],
                },
              },
            }),
          },
        },
      },
      im: {
        message: {
          create: (payload: Record<string, any>) => {
            groupMessages.push(payload);
            return groupNoticeAck.promise;
          },
        },
      },
      request: async (payload: Record<string, any>) => {
        reactionRequests.push(payload);
        return { code: 0, data: {} };
      },
    };

    const processing = (adapter as any).processCloudDocumentCommentEvent(cloudDocumentCommentEvent('evt-doc-comment-bound', {
      file_token: 'doc-bound-token',
      file_type: 'docx',
      comment_id: 'comment-2',
      reply_id: 'reply-2',
      operator_id: { open_id: 'ou_user' },
      mention_list: [{ id: { open_id: 'ou_someone_else' } }],
    }));
    await waitForCondition(() => groupMessages.length === 1);
    await resolvesWithin(processing);

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.address.chatId, 'oc_doc_group');
    assert.equal(groupMessages.length, 1);
    assert.equal(groupMessages[0].data.receive_id, 'oc_doc_group');
    assert.match(JSON.parse(groupMessages[0].data.content).text, /收到一条云文档评论/);
    assert.match(inbound.text, /用户的问题：继续整理这个 TODO/);
    assert.deepEqual(reactionRequests, []);
    groupNoticeAck.resolve({ data: { message_id: 'om_notice_1' } });
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
  });

  it('turns mentioned cloud document comments into the internal doc chat creation command', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('ou_bot');
    (adapter as any).restClient = {
      wiki: {
        v2: {
          space: {
            getNode: async () => {
              throw new Error('not wiki');
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            get: async () => ({
              data: {
                comment_id: 'comment-new',
                reply_list: {
                  replies: [
                    {
                      reply_id: 'reply-new',
                      content: {
                        elements: [
                          { type: 'text_run', text_run: { text: '&#x2F;new 需求评审' } },
                        ],
                      },
                    },
                  ],
                },
              },
            }),
          },
        },
      },
      request: async () => ({ code: 0, data: {} }),
    };

    await (adapter as any).processCloudDocumentCommentEvent(cloudDocumentCommentEvent('evt-doc-comment-new', {
      file_token: 'doc-new-token',
      file_type: 'docx',
      comment_id: 'comment-new',
      reply_id: 'reply-new',
      operator_id: { open_id: 'ou_user' },
      mention_list: [{ id: { open_id: 'ou_bot' } }],
    }));

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.text, '/new');
    assert.equal(inbound.address.chatId, 'doc:docx:doc-new-token:comment:comment-new');
    assert.equal(inbound.address.cloudDocument?.commentId, 'comment-new');
  });

  it('turns mentioned cloud document comments into an internal doc chat creation event', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('ou_bot');
    (adapter as any).restClient = {
      wiki: {
        v2: {
          space: {
            getNode: async () => {
              throw new Error('not wiki');
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            get: async () => ({
              data: {
                comment_id: 'comment-auto-new',
                reply_list: {
                  replies: [
                    {
                      reply_id: 'reply-auto-new',
                      content: {
                        elements: [
                          { type: 'text_run', text_run: { text: '帮我看一下这个文档' } },
                        ],
                      },
                    },
                  ],
                },
              },
            }),
          },
        },
      },
      request: async () => ({ code: 0, data: {} }),
    };

    await (adapter as any).processCloudDocumentCommentEvent(cloudDocumentCommentEvent('evt-doc-comment-auto-new', {
      file_token: 'doc-auto-new-token',
      file_type: 'docx',
      comment_id: 'comment-auto-new',
      reply_id: 'reply-auto-new',
      operator_id: { open_id: 'ou_user' },
      mention_list: [{ id: { open_id: 'ou_bot' } }],
    }));

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.text, '/new');
    assert.equal(inbound.address.chatId, 'doc:docx:doc-auto-new-token:comment:comment-auto-new');
    assert.equal(inbound.address.cloudDocument?.commentId, 'comment-auto-new');
  });

  it('deduplicates a retried /new cloud document comment after group binding is created', async () => {
    const store = initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    const requests: Array<Record<string, any>> = [];
    (adapter as any).botIds.add('ou_bot');
    (adapter as any).restClient = {
      wiki: {
        v2: {
          space: {
            getNode: async () => {
              throw new Error('not wiki');
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            get: async () => ({
              data: {
                comment_id: 'comment-new',
                reply_list: {
                  replies: [
                    {
                      reply_id: 'reply-new',
                      content: {
                        elements: [
                          { type: 'text_run', text_run: { text: '&#x2F;new 需求评审' } },
                        ],
                      },
                    },
                  ],
                },
              },
            }),
          },
        },
      },
      request: async (payload: Record<string, any>) => {
        requests.push(payload);
        return { code: 0, data: {} };
      },
    };
    const event = {
      header: { event_id: 'evt-doc-new-1' },
      event: {
        file_token: 'doc-new-token',
        file_type: 'docx',
        comment_id: 'comment-new',
        reply_id: 'reply-new',
        operator_id: { open_id: 'ou_user' },
        mention_list: [{ id: { open_id: 'ou_bot' } }],
      },
    };

    await (adapter as any).processCloudDocumentCommentEvent(event);

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.text, '/new');
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/open-apis\/drive\/v2\/files\/doc-new-token\/comments\/reaction\?file_type=docx/);

    const session = store.createSession('Doc group chat', 'test-model');
    store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'oc_doc_group',
      chatKind: 'group',
      bridgeSessionId: session.id,
      cloudDocumentChat: {
        provider: 'feishu',
        fileToken: 'doc-new-token',
        fileType: 'docx',
      },
    });

    await (adapter as any).processCloudDocumentCommentEvent(event);

    assert.equal(((adapter as any).inboundQueue || []).length, 0);
    assert.equal(requests.length, 1);
  });

  it('logs an error and rejects cloud document comment events without event_id', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('ou_bot');

    const errors: any[][] = [];
    const originalError = console.error;
    console.error = (...args: any[]) => {
      errors.push(args);
    };
    try {
      await (adapter as any).processCloudDocumentCommentEvent({
        file_token: 'doc-token',
        file_type: 'docx',
        comment_id: 'comment-1',
        reply_id: 'reply-1',
        operator_id: { open_id: 'ou_user' },
        mention_list: [{ id: { open_id: 'ou_bot' } }],
      });
    } finally {
      console.error = originalError;
    }

    assert.equal(((adapter as any).inboundQueue || []).length, 0);
    const missingEventIdError = errors.find((entry) => (
      entry[0] === '[feishu-adapter] Cloud document comment event rejected: missing event_id'
    ));
    assert.ok(missingEventIdError);
    assert.equal(missingEventIdError[1].fileToken, 'doc-token');
    assert.equal(missingEventIdError[1].commentId, 'comment-1');
    assert.equal(missingEventIdError[1].replyId, 'reply-1');
  });

  it('redirects cloud document comments to the group after doc-as-chat is enabled', async () => {
    const store = initBridgeTestContext();
    const session = store.createSession('Doc group chat', 'test-model');
    store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'oc_doc_group',
      chatKind: 'group',
      bridgeSessionId: session.id,
      cloudDocumentChat: {
        provider: 'feishu',
        fileToken: 'doc-group-token',
        fileType: 'docx',
      },
    });
    const requests: Array<Record<string, any>> = [];
    const groupMessages: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('ou_bot');
    (adapter as any).restClient = {
      wiki: {
        v2: {
          space: {
            getNode: async () => {
              throw new Error('not wiki');
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            get: async () => ({
              data: {
                comment_id: 'comment-3',
                is_whole: true,
                reply_list: {
                  replies: [
                    {
                      reply_id: 'reply-3',
                      content: {
                        elements: [
                          { type: 'text_run', text_run: { text: '继续整理这个 TODO' } },
                        ],
                      },
                    },
                  ],
                },
              },
            }),
          },
        },
      },
      im: {
        message: {
          create: async (payload: Record<string, any>) => {
            groupMessages.push(payload);
            return { data: { message_id: `om_notice_${groupMessages.length}` } };
          },
        },
      },
      request: async (payload: Record<string, any>) => {
        requests.push(payload);
        return { code: 0, data: {} };
      },
    };

    await (adapter as any).processCloudDocumentCommentEvent(cloudDocumentCommentEvent('evt-doc-comment-redirect', {
      file_token: 'doc-group-token',
      file_type: 'docx',
      comment_id: 'comment-3',
      reply_id: 'reply-3',
      operator_id: { open_id: 'ou_user' },
      mention_list: [{ id: { open_id: 'ou_bot' } }],
    }));

    assert.equal(groupMessages.length, 1);
    assert.equal(groupMessages[0].data.receive_id, 'oc_doc_group');
    assert.match(JSON.parse(groupMessages[0].data.content).text, /收到一条云文档评论/);
    assert.match(JSON.parse(groupMessages[0].data.content).text, /继续整理这个 TODO/);
    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.address.chatId, 'oc_doc_group');
    assert.match(inbound.text, /从已绑定云文档评论转发到群聊/);
    assert.match(inbound.text, /用户的问题：继续整理这个 TODO/);
    assert.deepEqual(requests, []);
  });

  it('forwards later comments from the same cloud document to the bound group', async () => {
    const store = initBridgeTestContext();
    const session = store.createSession('Doc group chat', 'test-model');
    store.upsertChannelChat({
      channelType: 'feishu-default',
      chatId: 'oc_doc_group',
      chatKind: 'group',
      bridgeSessionId: session.id,
      cloudDocumentChat: {
        provider: 'feishu',
        fileToken: 'doc-group-token',
        fileType: 'docx',
      },
    });
    const requests: Array<Record<string, any>> = [];
    const groupMessages: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('ou_bot');
    (adapter as any).restClient = {
      wiki: {
        v2: {
          space: {
            getNode: async () => {
              throw new Error('not wiki');
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            get: async () => ({
              data: {
                comment_id: 'comment-other',
                is_whole: true,
                reply_list: {
                  replies: [
                    {
                      reply_id: 'reply-other',
                      content: {
                        elements: [
                          { type: 'text_run', text_run: { text: '没有 @ 的另一个评论' } },
                        ],
                      },
                    },
                  ],
                },
              },
            }),
          },
        },
      },
      im: {
        message: {
          create: async (payload: Record<string, any>) => {
            groupMessages.push(payload);
            return { data: { message_id: `om_notice_${groupMessages.length}` } };
          },
        },
      },
      request: async (payload: Record<string, any>) => {
        requests.push(payload);
        return { code: 0, data: {} };
      },
    };

    await (adapter as any).processCloudDocumentCommentEvent(cloudDocumentCommentEvent('evt-doc-comment-other', {
      file_token: 'doc-group-token',
      file_type: 'docx',
      comment_id: 'comment-other',
      reply_id: 'reply-other',
      operator_id: { open_id: 'ou_user' },
      mention_list: [{ id: { open_id: 'ou_someone_else' } }],
    }));

    assert.equal(groupMessages.length, 1);
    assert.equal(groupMessages[0].data.receive_id, 'oc_doc_group');
    assert.match(JSON.parse(groupMessages[0].data.content).text, /没有 @ 的另一个评论/);
    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.address.chatId, 'oc_doc_group');
    assert.match(inbound.text, /用户的问题：没有 @ 的另一个评论/);
    assert.deepEqual(requests, []);
  });

  it('ignores cloud document comments authored by the bot to avoid reply loops', async () => {
    initBridgeTestContext();
    let fetchedComment = false;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('ou_bot');
    (adapter as any).restClient = {
      wiki: {
        v2: {
          space: {
            getNode: async () => {
              throw new Error('not wiki');
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            get: async () => {
              fetchedComment = true;
              return { data: {} };
            },
          },
        },
      },
    };

    await (adapter as any).processCloudDocumentCommentEvent(cloudDocumentCommentEvent('evt-doc-comment-bot', {
      file_token: 'doc-bot-token',
      file_type: 'docx',
      comment_id: 'comment-bot',
      operator_id: { open_id: 'ou_bot' },
      mention_list: [{ id: { open_id: 'ou_bot' } }],
    }));

    assert.equal(fetchedComment, false);
  });

  it('falls back to cloud document comment content mentions when the event omits mention_list', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('ou_bot');
    (adapter as any).restClient = {
      wiki: {
        v2: {
          space: {
            getNode: async () => {
              throw new Error('not wiki');
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            get: async () => ({
              data: {
                comment_id: 'comment-1',
                is_whole: true,
                reply_list: {
                  replies: [
                    {
                      reply_id: 'reply-1',
                      content: {
                        elements: [
                          { type: 'person', person: { user_id: 'ou_bot' } },
                          { type: 'text_run', text_run: { text: ' 看看这段' } },
                        ],
                      },
                    },
                  ],
                },
              },
            }),
          },
        },
      },
      request: async () => ({ code: 0, data: {} }),
    };

    await (adapter as any).processCloudDocumentCommentEvent(cloudDocumentCommentEvent('evt-doc-comment-content-mention', {
      file_token: 'doc-token',
      file_type: 'docx',
      comment_id: 'comment-1',
      operator_id: { open_id: 'ou_user' },
    }));

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.address.chatId, 'doc:docx:doc-token:comment:comment-1');
    assert.equal(inbound.address.cloudDocument?.commentId, 'comment-1');
    assert.equal(inbound.address.cloudDocument?.typingReactionReplyId, 'reply-1');
    assert.equal(inbound.text, '/new');
  });

  it('logs content mention diagnostics when event and comment content do not mention the bot', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).botIds.add('ou_bot');
    (adapter as any).restClient = {
      wiki: {
        v2: {
          space: {
            getNode: async () => {
              throw new Error('not wiki');
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            get: async () => ({
              data: {
                comment_id: 'comment-1',
                reply_list: {
                  replies: [
                    {
                      reply_id: 'reply-1',
                      content: {
                        elements: [
                          { type: 'person', person: { user_id: 'ou_someone_else' } },
                          { type: 'text_run', text_run: { text: ' hello' } },
                        ],
                      },
                    },
                  ],
                },
              },
            }),
          },
        },
      },
    };

    const logs: any[][] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args);
    };
    try {
      await (adapter as any).processCloudDocumentCommentEvent(cloudDocumentCommentEvent('evt-doc-comment-content-no-mention', {
        file_token: 'doc-token-unbound',
        file_type: 'docx',
        comment_id: 'comment-1',
      }));
    } finally {
      console.log = originalLog;
    }

    const ignoredLog = logs.find((entry) => entry[0] === '[feishu-adapter] Cloud document comment ignored: bot not mentioned');
    assert.ok(ignoredLog);
    assert.equal(ignoredLog[1].mentionDiagnostics.mentionListSource, null);
    assert.equal(ignoredLog[1].contentMentionDiagnostics.targetReplyId, 'reply-1');
    assert.equal(ignoredLog[1].contentMentionDiagnostics.elementCount, 2);
    assert.equal(ignoredLog[1].contentMentionDiagnostics.personCandidates[0].path, 'reply.content.elements[0].person.user_id');
    assert.equal(ignoredLog[1].contentMentionDiagnostics.personCandidates[0].matchedBotId, false);
    assert.match(ignoredLog[1].contentMentionDiagnostics.personCandidates[0].sha256, /^[a-f0-9]{12}$/);
  });

  it('replies to cloud document comments through Drive comment replies', async () => {
    const requests: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).restClient = {
      request: async (payload: Record<string, any>) => {
        requests.push(payload);
        return { code: 0, data: {} };
      },
    };

    const result = await adapter.sendCloudDocumentReply({
      provider: 'feishu',
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
    }, '**回答**：可以继续');

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.match(requests[0].url, /\/open-apis\/drive\/v1\/files\/doc-token\/comments\/comment-1\/replies\?file_type=docx/);
    assert.equal(requests[0].data.content.elements[0].text_run.text, '回答：可以继续');
  });

  it('surfaces Feishu cloud document reply permission errors', async () => {
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    const error = new Error('Request failed with status code 400') as Error & {
      response?: { status?: number; data?: { code?: number; msg?: string; error?: { log_id?: string } } };
    };
    error.response = {
      status: 400,
      data: {
        code: 99991672,
        msg: 'Access denied. One of the following scopes is required: [docs:document.comment:create, docs:document.comment:write_only]',
        error: { log_id: 'log-1' },
      },
    };
    (adapter as any).restClient = {
      request: async () => {
        throw error;
      },
    };

    const result = await adapter.sendCloudDocumentReply({
      provider: 'feishu',
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
    }, '已处理');

    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 400);
    assert.match(result.error || '', /code=99991672/);
    assert.match(result.error || '', /docs:document\.comment:create/);
    assert.match(result.error || '', /log_id=log-1/);
  });

  it('surfaces nested Feishu SDK cloud document errors', async () => {
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).restClient = {
      request: async () => {
        throw [
          new Error('Request failed with status code 400'),
          {
            code: 99991672,
            msg: 'Access denied. One of the following scopes is required: [docs:document.comment:create]',
            error: { log_id: 'nested-log-1' },
          },
        ];
      },
    };

    const result = await adapter.sendCloudDocumentReply({
      provider: 'feishu',
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
    }, '已处理');

    assert.equal(result.ok, false);
    assert.match(result.error || '', /code=99991672/);
    assert.match(result.error || '', /docs:document\.comment:create/);
    assert.match(result.error || '', /log_id=nested-log-1/);
  });

  it('does not create fallback top-level comments for inline cloud document reply parameter errors', async () => {
    const requests: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    const error = new Error('Request failed with status code 400') as Error & {
      response?: { status?: number; data?: { code?: number; msg?: string; error?: { log_id?: string } } };
    };
    error.response = {
      status: 400,
      data: {
        code: 1069302,
        msg: 'Invalid or missing parameters in the request.',
        error: { log_id: 'reply-param-log-1' },
      },
    };
    (adapter as any).restClient = {
      request: async (payload: Record<string, any>) => {
        requests.push(payload);
        throw error;
      },
      drive: {
        v1: {
          fileComment: {
            create: async () => {
              throw new Error('inline comments should not fall back to top-level comments');
            },
          },
        },
      },
    };

    const result = await adapter.sendCloudDocumentReply({
      provider: 'feishu',
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
      isWhole: false,
    }, '已处理');

    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 400);
    assert.equal(requests.length, 1);
    assert.match(result.error || '', /code=1069302/);
    assert.match(result.error || '', /log_id=reply-param-log-1/);
  });

  it('creates fallback top-level comments that mention the original user only for whole-document cloud comments', async () => {
    const requests: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    const error = new Error('Request failed with status code 400') as Error & {
      response?: { status?: number; data?: { code?: number; msg?: string; error?: { log_id?: string } } };
    };
    error.response = {
      status: 400,
      data: {
        code: 1069302,
        msg: 'Invalid or missing parameters in the request.',
        error: { log_id: 'whole-reply-param-log-1' },
      },
    };
    (adapter as any).restClient = {
      request: async (payload: Record<string, any>) => {
        requests.push(payload);
        if (payload.url.includes('/replies?')) throw error;
        return { code: 0, data: {} };
      },
    };

    const result = await adapter.sendCloudDocumentReply({
      provider: 'feishu',
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
      operatorId: 'ou_comment_author',
      isWhole: true,
    }, '已处理');

    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/open-apis\/drive\/v1\/files\/doc-token\/comments\/comment-1\/replies\?file_type=docx/);
    assert.match(requests[1].url, /\/open-apis\/drive\/v1\/files\/doc-token\/new_comments$/);
    assert.deepEqual(requests[1].data, {
      file_type: 'docx',
      reply_elements: [
        { type: 'mention_user', mention_user: 'ou_comment_author' },
        { type: 'text', text: ' 已处理' },
      ],
    });
  });

  it('removes cloud document Typing reactions after replying', async () => {
    const requests: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).restClient = {
      request: async (payload: Record<string, any>) => {
        requests.push(payload);
        return { code: 0, data: {} };
      },
    };

    const result = await adapter.sendCloudDocumentReply({
      provider: 'feishu',
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
      typingReactionReplyId: 'reply-1',
    }, '已处理');

    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/open-apis\/drive\/v1\/files\/doc-token\/comments\/comment-1\/replies\?file_type=docx/);
    assert.match(requests[1].url, /\/open-apis\/drive\/v2\/files\/doc-token\/comments\/reaction\?file_type=docx/);
    assert.deepEqual(requests[1].data, {
      action: 'delete',
      reply_id: 'reply-1',
      reaction_type: 'Typing',
    });
  });

  it('does not create Feishu IM streaming cards for cloud document comments', async () => {
    const requests: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).lastIncomingMessageId.set(
      'doc:docx:doc-token',
      'doc-comment:doc-token:comment-1:reply-1',
    );
    (adapter as any).restClient = {
      card: {
        create: async (payload: Record<string, any>) => {
          requests.push({ target: 'card.create', payload });
          return { data: { card_id: 'card-1' } };
        },
        update: async (payload: Record<string, any>) => {
          requests.push({ target: 'card.update', payload });
          return {};
        },
        settings: async (payload: Record<string, any>) => {
          requests.push({ target: 'card.settings', payload });
          return {};
        },
        element: {
          content: async (payload: Record<string, any>) => {
            requests.push({ target: 'card.element.content', payload });
            return {};
          },
        },
      },
      im: {
        message: {
          create: async (payload: Record<string, any>) => {
            requests.push({ target: 'im.message.create', payload });
            return { data: { message_id: 'msg-1' } };
          },
          reply: async (payload: Record<string, any>) => {
            requests.push({ target: 'im.message.reply', payload });
            return { data: { message_id: 'msg-1' } };
          },
        },
        messageReaction: {
          create: async (payload: Record<string, any>) => {
            requests.push({ target: 'im.messageReaction.create', payload });
            return {};
          },
        },
      },
    };

    assert.equal(adapter.supportsStructuredStreamingUi?.('doc:docx:doc-token'), false);

    adapter.onMessageStart('doc:docx:doc-token', 'stream-1');
    adapter.onStreamText('doc:docx:doc-token', 'partial', 'stream-1');
    adapter.onToolEvent('doc:docx:doc-token', [], 'stream-1');
    adapter.onTaskEvent('doc:docx:doc-token', [], 'stream-1');
    adapter.onStreamStatus('doc:docx:doc-token', 'running', 'stream-1');
    adapter.onStreamMetadata('doc:docx:doc-token', { title: 'doc' }, 'stream-1');
    adapter.onStreamActions('doc:docx:doc-token', [], 'stream-1');
    adapter.onMirrorStreamStart('doc:docx:doc-token', 'stream-1');
    const finalized = await adapter.onStreamEnd('doc:docx:doc-token', 'completed', 'final', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(finalized, false);
    assert.deepEqual(requests, []);
  });

  it('refuses plain IM sends to cloud document virtual chat ids', async () => {
    const requests: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).restClient = {
      im: {
        message: {
          create: async (payload: Record<string, any>) => {
            requests.push(payload);
            return { data: { message_id: 'msg-1' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: {
        channelType: 'feishu-default',
        chatId: 'doc:docx:doc-token',
      },
      text: 'must not go to im.message.create',
      parseMode: 'Markdown',
    });

    assert.equal(result.ok, false);
    assert.match(result.error || '', /Refusing to send Feishu IM message/);
    assert.deepEqual(requests, []);
  });

  it('accepts unmentioned group messages when the Feishu channel disables mention requirement', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        requireMention: false,
      },
    });

    await (adapter as any).processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'user-1' },
      },
      message: {
        message_id: 'msg-group-no-mention-accepted',
        chat_id: 'oc_group_1',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"hello group"}',
        create_time: '1780209968114',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.address.channelType, 'feishu-default');
    assert.equal(inbound.address.chatId, 'oc_group_1');
    assert.equal(inbound.text, 'hello group');
  });

  it('accepts unmentioned group messages by default', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {},
    });

    await (adapter as any).processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'user-1' },
      },
      message: {
        message_id: 'msg-group-no-mention-filtered',
        chat_id: 'oc_group_1',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"hello group"}',
        create_time: '1780209968114',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.text, 'hello group');
  });

  it('turns chat removal events into internal lifecycle messages', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {},
    });

    (adapter as any).processChatRemovedEvent({
      header: { event_id: 'evt-bot-deleted', create_time: '1780209968114' },
      event: { chat_id: 'oc_removed_1' },
    }, 'bot_removed', 'im.chat.member.bot.deleted_v1');
    (adapter as any).processChatRemovedEvent({
      chat_id: 'oc_removed_2',
    }, 'chat_disbanded', 'im.chat.disbanded_v1');

    const first = await adapter.consumeOne();
    const second = await adapter.consumeOne();

    assert.ok(first);
    assert.equal(first.messageId, 'im.chat.member.bot.deleted_v1:evt-bot-deleted');
    assert.equal(first.address.chatId, 'oc_removed_1');
    assert.equal(first.address.chatKind, 'group');
    assert.deepEqual(first.channelEvent, {
      type: 'chat_removed',
      reason: 'bot_removed',
      eventType: 'im.chat.member.bot.deleted_v1',
    });
    assert.ok(second);
    assert.equal(second.address.chatId, 'oc_removed_2');
    assert.deepEqual(second.channelEvent, {
      type: 'chat_removed',
      reason: 'chat_disbanded',
      eventType: 'im.chat.disbanded_v1',
    });
  });

  it('forwards standalone interactive card messages with raw card JSON', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {},
    });

    await (adapter as any).processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'user-1' },
      },
      message: {
        message_id: 'msg-interactive-1',
        chat_id: 'oc_p2p_1',
        chat_type: 'p2p',
        message_type: 'interactive',
        content: JSON.stringify({
          schema: '2.0',
          body: {
            elements: [
              { tag: 'markdown', content: '请选择发布策略' },
            ],
          },
        }),
        create_time: '1780209968114',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.match(inbound.text, /用户发送了一张飞书交互卡片/);
    assert.match(inbound.text, /<interactive_card>/);
    assert.match(inbound.text, /请选择发布策略/);
    assert.match(inbound.text, /<\/interactive_card>/);
  });

  it('adds quoted interactive card JSON as model-only context', async () => {
    initBridgeTestContext();
    const getCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {},
    });
    (adapter as any).restClient = {
      im: {
        message: {
          get: async (payload: Record<string, any>) => {
            getCalls.push(payload);
            const isFullCardRequest = payload?.params?.card_msg_content_type === 'user_card_content';
            return {
              data: {
                items: [
                  {
                    message_id: 'card-parent-1',
                    msg_type: 'interactive',
                    body: {
                      content: isFullCardRequest
                        ? JSON.stringify({
                            data: {
                              user_dsl: {
                                schema: '2.0',
                                body: {
                                  elements: [
                                    { tag: 'markdown', content: '发布窗口：今晚 22:00' },
                                  ],
                                },
                              },
                            },
                          })
                        : JSON.stringify({ text: '发布窗口预览' }),
                    },
                  },
                ],
              },
            };
          },
        },
      },
    };

    await (adapter as any).processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'user-1' },
      },
      message: {
        message_id: 'msg-reply-card-1',
        parent_id: 'card-parent-1',
        chat_id: 'oc_p2p_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"按这个窗口发"}',
        create_time: '1780209968114',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.text, '按这个窗口发');
    assert.equal(getCalls[0]?.path?.message_id, 'card-parent-1');
    assert.equal(getCalls[0]?.params?.card_msg_content_type, 'user_card_content');
    assert.match(inbound.contextText || '', /<quoted_message platform="feishu" message_id="card-parent-1" message_type="interactive">/);
    assert.match(inbound.contextText || '', /<interactive_card>/);
    assert.match(inbound.contextText || '', /发布窗口：今晚 22:00/);
    assert.doesNotMatch(inbound.contextText || '', /发布窗口预览/);
    assert.match(inbound.contextText || '', /<\/interactive_card>/);
    assert.match(inbound.contextText || '', /<\/quoted_message>/);
  });

  it('filters unmentioned group messages when the Feishu channel requires mentions', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        requireMention: true,
      },
    });

    await (adapter as any).processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'user-1' },
      },
      message: {
        message_id: 'msg-group-require-mention-filtered',
        chat_id: 'oc_group_1',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"hello group"}',
        create_time: '1780209968114',
      },
    });

    assert.equal(await adapter.consumeOne(), null);
  });

  it('passes an HTTPS proxy agent to the Feishu WS client options', () => {
    const httpInstance = {} as any;
    const options = _testOnly.buildWsClientOptions(
      'app-id',
      'app-secret',
      'https://open.feishu.cn',
      'feishu',
      { HTTPS_PROXY: 'http://proxy.example.test:8118' },
      httpInstance,
    );

    assert.equal(options.appId, 'app-id');
    assert.equal(options.appSecret, 'app-secret');
    assert.equal(options.httpInstance, httpInstance);
    assert.ok(options.agent, 'expected WS proxy agent');
    assert.equal(typeof (options.agent as { addRequest?: unknown }).addRequest, 'function');
  });

  it('respects NO_PROXY per Feishu proxy target', () => {
    const env = {
      HTTPS_PROXY: 'http://proxy.example.test:8118',
      NO_PROXY: 'open.feishu.cn',
    };

    assert.equal(_testOnly.getProxyUrlForUrl('https://open.feishu.cn/open-apis/bot/v3/info', env), undefined);
    assert.equal(
      _testOnly.getProxyUrlForUrl('wss://pbbot-ws.feishu.cn/ws', env),
      'http://proxy.example.test:8118',
    );
  });

  it('respects wildcard NO_PROXY when resolving the Feishu WS proxy', () => {
    const proxyUrl = _testOnly.getWsProxyUrl('feishu', {
      HTTPS_PROXY: 'http://proxy.example.test:8118',
      NO_PROXY: '.feishu.cn',
    });

    assert.equal(proxyUrl, undefined);
  });

  it('prefers WSS_PROXY for Feishu websocket targets', () => {
    const proxyUrl = _testOnly.getWsProxyUrl('feishu', {
      HTTPS_PROXY: 'http://https-proxy.example.test:8118',
      WSS_PROXY: 'http://wss-proxy.example.test:8118',
    });

    assert.equal(proxyUrl, 'http://wss-proxy.example.test:8118');
  });

  it('adds proxy agents to Feishu SDK HTTP requests', async () => {
    const requests: Array<Record<string, any>> = [];
    const baseHttpInstance = {
      request: async (options: Record<string, any>) => {
        requests.push(options);
        return { ok: true };
      },
    } as any;
    const httpInstance = _testOnly.buildHttpInstanceWithEnvProxy(
      'feishu',
      { HTTPS_PROXY: 'http://proxy.example.test:8118' },
      baseHttpInstance,
    );

    await httpInstance.request({
      method: 'post',
      url: 'https://open.feishu.cn/callback/ws/endpoint',
      data: {},
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].proxy, false);
    assert.equal(typeof requests[0].httpsAgent?.addRequest, 'function');
  });

  it('does not add HTTP proxy agents when NO_PROXY matches the request target', async () => {
    const requests: Array<Record<string, any>> = [];
    const baseHttpInstance = {
      request: async (options: Record<string, any>) => {
        requests.push(options);
        return { ok: true };
      },
    } as any;
    const httpInstance = _testOnly.buildHttpInstanceWithEnvProxy(
      'feishu',
      {
        HTTPS_PROXY: 'http://proxy.example.test:8118',
        NO_PROXY: '.feishu.cn',
      },
      baseHttpInstance,
    );

    await httpInstance.request({
      method: 'post',
      url: 'https://open.feishu.cn/callback/ws/endpoint',
      data: {},
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].proxy, undefined);
    assert.equal(requests[0].httpsAgent, undefined);
  });

  it('masks proxy credentials in logs', () => {
    assert.equal(
      _testOnly.maskProxyUrl('http://user:secret@proxy.example.test:8118/path?token=abc'),
      'http://***:***@proxy.example.test:8118/path?token=abc',
    );
  });

  it('preserves Feishu post code blocks as fenced markdown', () => {
    const parsed = _testOnly.parseFeishuPostContent(JSON.stringify({
      title: '',
      content: [
        [{ tag: 'text', text: 'before', style: [] }],
        [{ tag: 'code_block', language: 'rust', text: 'KEY=AHAHAHAH' }],
        [{ tag: 'text', text: 'after', style: [] }],
      ],
    }));

    assert.equal(parsed.imageKeys.length, 0);
    assert.equal(parsed.warnings.length, 0);
    assert.match(parsed.extractedText, /before/);
    assert.match(parsed.extractedText, /```rust\nKEY=AHAHAHAH\n```/);
    assert.match(parsed.extractedText, /after/);
  });

  it('renders Feishu post titles as markdown H1 headings', () => {
    const parsed = _testOnly.parseFeishuPostContent(JSON.stringify({
      title: '标题',
      content: [
        [{ tag: 'text', text: 'bridge已启动那句，能不能带个标题', style: [] }],
      ],
    }));

    assert.equal(parsed.imageKeys.length, 0);
    assert.equal(parsed.warnings.length, 0);
    assert.equal(parsed.extractedText, '# 标题\n\nbridge已启动那句，能不能带个标题');
  });

  it('keeps unsupported Feishu post elements visible and reports parse warnings', () => {
    const parsed = _testOnly.parseFeishuPostContent(JSON.stringify({
      title: '',
      content: [
        [{ tag: 'text', text: 'before', style: [] }],
        [{ tag: 'unsupported_widget', value: 'secret' }],
      ],
    }));

    assert.match(parsed.extractedText, /before/);
    assert.match(parsed.extractedText, /\[unsupported Feishu post element: unsupported_widget\]/);
    assert.deepEqual(parsed.warnings, ['暂不支持飞书富文本元素：unsupported_widget']);
  });

  it('downloads Feishu post images concurrently before enqueuing the inbound message', async () => {
    initBridgeTestContext();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {},
    });
    const first = createDeferred<FileAttachment | null>();
    const second = createDeferred<FileAttachment | null>();
    const started: string[] = [];
    (adapter as any).downloadResource = async (
      _messageId: string,
      fileKey: string,
      resourceType: string,
    ): Promise<FileAttachment | null> => {
      started.push(fileKey);
      const result = fileKey === 'img-first' ? await first.promise : await second.promise;
      return result && { ...result, type: resourceType === 'image' ? 'image/png' : result.type };
    };

    const processing = (adapter as any).processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'user-1' },
      },
      message: {
        message_id: 'msg-post-images-concurrent',
        chat_id: 'oc_p2p_1',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({
          content: [[
            { tag: 'text', text: '看这两张图' },
            { tag: 'img', image_key: 'img-first' },
            { tag: 'img', image_key: 'img-second' },
          ]],
        }),
        create_time: '1780209968114',
      },
    }) as Promise<void>;

    await waitForCondition(() => started.length === 2);
    assert.deepEqual(started, ['img-first', 'img-second']);
    first.resolve({
      id: 'att-first',
      name: 'first.png',
      type: 'image/png',
      size: 5,
      data: Buffer.from('first').toString('base64'),
    });
    second.resolve({
      id: 'att-second',
      name: 'second.png',
      type: 'image/png',
      size: 6,
      data: Buffer.from('second').toString('base64'),
    });
    await processing;

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound.text, '看这两张图');
    assert.equal(inbound.attachments?.length, 2);
    assert.deepEqual(inbound.attachments?.map((attachment) => attachment.id), ['att-first', 'att-second']);
  });

  it('coalesces concurrent tenant token requests', async () => {
    const originalFetch = globalThis.fetch;
    const tokenResponse = createDeferred<Response>();
    let fetchCount = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/tenant_access_token/internal')) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      assert.equal(init?.method, 'POST');
      fetchCount += 1;
      return tokenResponse.promise;
    }) as typeof fetch;

    try {
      const firstToken = (adapter as any).getTenantAccessToken() as Promise<string>;
      const secondToken = (adapter as any).getTenantAccessToken() as Promise<string>;
      await waitForCondition(() => fetchCount === 1);
      tokenResponse.resolve(Response.json({
        code: 0,
        tenant_access_token: 'tenant-token',
        expire: 7200,
      }));

      assert.deepEqual(await Promise.all([firstToken, secondToken]), ['tenant-token', 'tenant-token']);
      assert.equal(fetchCount, 1);
      assert.equal(await (adapter as any).getTenantAccessToken(), 'tenant-token');
      assert.equal(fetchCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('replies with a user-visible notice for unsupported Feishu message types', async () => {
    const replies: Array<Record<string, any>> = [];
    const noticeAck = createDeferred<{ data: { message_id: string } }>();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {},
    });
    (adapter as any).restClient = {
      im: {
        message: {
          reply: (payload: Record<string, any>) => {
            replies.push(payload);
            return noticeAck.promise;
          },
        },
      },
    };

    const processing = (adapter as any).processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'user-1' },
      },
      message: {
        message_id: 'msg-sticker-1',
        chat_id: 'chat-1',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: '{"sticker_key":"sticker-1"}',
        create_time: '1780209968114',
      },
    });
    await waitForCondition(() => replies.length === 1);
    await resolvesWithin(processing);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].path.message_id, 'msg-sticker-1');
    assert.equal(replies[0].data.msg_type, 'text');
    const content = JSON.parse(replies[0].data.content);
    assert.match(content.text, /暂不支持飞书消息类型：sticker/);
    assert.match(content.text, /不会转发给 Codex/);
    assert.equal(await adapter.consumeOne(), null);
    noticeAck.resolve({ data: { message_id: 'notice-1' } });
    await _testOnlyWaitForDeliveryQueuesForTests(adapter);
  });

  it('does not add typing reactions while starting or ending a stream', async () => {
    const reactionCreateCalls: Array<Record<string, any>> = [];
    const reactionDeleteCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).lastIncomingMessageId.set('chat-1', 'incoming-1');
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'card-message-1' } }),
          reply: async () => ({ data: { message_id: 'card-message-1' } }),
        },
        messageReaction: {
          create: async (payload: Record<string, any>) => {
            reactionCreateCalls.push(payload);
            return { data: { reaction_id: `reaction-${reactionCreateCalls.length}` } };
          },
          delete: async (payload: Record<string, any>) => {
            reactionDeleteCalls.push(payload);
            return {};
          },
        },
      },
    };

    adapter.onMessageStart('chat-1', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    adapter.onMessageEnd('chat-1', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(reactionCreateCalls.length, 0);
    assert.equal(reactionDeleteCalls.length, 0);
  });

  it('adds a completed reaction to the finalized streaming card message', async () => {
    const reactionCreateCalls: Array<Record<string, any>> = [];
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const logs: unknown[][] = [];
    const originalLog = console.log;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'card-message-1' } }),
          reply: async () => ({ data: { message_id: 'card-message-1' } }),
        },
        messageReaction: {
          create: async (payload: Record<string, any>) => {
            reactionCreateCalls.push(payload);
            return {};
          },
        },
      },
    };

    console.log = (...args: unknown[]) => {
      logs.push(args);
      originalLog(...args);
    };
    let finalized = false;
    try {
      await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
      adapter.onStreamStatus('chat-1', '已运行 3秒，125k(63%) · ↑125k ↓4.6k', 'stream-1');
      adapter.onStreamStatus('chat-1', '✅ Completed · 3.0s', 'stream-1');
      finalized = await adapter.onStreamEnd('chat-1', 'completed', '最终回复', 'stream-1');
    } finally {
      console.log = originalLog;
    }

    assert.equal(finalized, true);
    const finalCard = String(cardUpdateCalls.at(-1)?.data?.card?.data || '');
    assert.match(finalCard, /125k\(63%\) · ↑125k ↓4\.6k/);
    assert.doesNotMatch(finalCard, /Completed|Success/);
    assert.deepEqual(reactionCreateCalls, [{
      path: { message_id: 'card-message-1' },
      data: { reaction_type: { emoji_type: 'DONE' } },
    }]);
    const perfSummary = logs.find((entry) => entry[0] === '[feishu-adapter] Streaming card perf summary:')?.[1] as any;
    assert.equal(perfSummary?.streamKey, 'stream-1');
    assert.equal(perfSummary?.event, 'perf.card.lifecycle');
    assert.equal(perfSummary?.stream_key, 'stream-1');
    assert.equal(perfSummary?.terminalStatus, 'completed');
    assert.equal(perfSummary?.terminal_status, 'completed');
    assert.equal(perfSummary?.flushAttempts, 1);
    assert.equal(perfSummary?.flush_attempts, 1);
    assert.ok(perfSummary?.apiTop?.some((entry: any) => entry.target === 'card.update'));

    const cardUpdateRequest = logs.find((entry) => (
      entry[0] === '[feishu-adapter] Request success:'
        && (entry[1] as any)?.target === 'card.update'
    ))?.[1] as any;
    assert.equal(cardUpdateRequest?.event, 'perf.feishu.request');
    assert.equal(cardUpdateRequest?.operation, 'card.update');
    assert.equal(cardUpdateRequest?.stream_key, 'stream-1');
    assert.equal(typeof cardUpdateRequest?.duration_ms, 'number');
  });

  it('adds an error reaction to the finalized streaming card message on failure', async () => {
    const reactionCreateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'card-message-1' } }),
          reply: async () => ({ data: { message_id: 'card-message-1' } }),
        },
        messageReaction: {
          create: async (payload: Record<string, any>) => {
            reactionCreateCalls.push(payload);
            return {};
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const finalized = await adapter.onStreamEnd('chat-1', 'error', '执行失败', 'stream-1');

    assert.equal(finalized, true);
    assert.deepEqual(reactionCreateCalls, [{
      path: { message_id: 'card-message-1' },
      data: { reaction_type: { emoji_type: 'WAIL' } },
    }]);
  });

  it('creates the streaming card with dedicated content, tasks, tools, and status elements', async () => {
    const createdCards: Array<Record<string, any>> = [];
    const createCalls: Array<Record<string, any>> = [];
    const replyCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async ({ data }: { data: { data: string } }) => {
              const parsed = JSON.parse(data.data);
              createdCards.push(parsed);
              return { data: { card_id: 'card-1' } };
            },
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async (payload: Record<string, any>) => {
            createCalls.push(payload);
            return { data: { message_id: 'msg-1' } };
          },
          reply: async (payload: Record<string, any>) => {
            replyCalls.push(payload);
            return { data: { message_id: 'msg-1' } };
          },
        },
      },
    };

    const created = await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    assert.equal(created, true);
    assert.equal(createCalls.length, 0);
    assert.equal(replyCalls.length, 1);
    assert.deepEqual(replyCalls[0]?.path, { message_id: 'reply-1' });

    const elements = createdCards[0]?.body?.elements || [];
    assert.equal(elements.length, 3);
    assert.equal(elements[0]?.element_id, 'stream_history');
    assert.equal(elements[0]?.tag, 'collapsible_panel');
    assert.equal(elements[0]?.expanded, true);
    assert.equal((elements[0]?.elements || [])[0]?.element_id, 'streaming_content');
    assert.equal(elements[1]?.element_id, 'streaming_tasks');
    assert.equal(elements[1]?.content, '');
    assert.equal(elements[2]?.element_id, 'streaming_status');
    assert.equal(elements[2]?.content, '处理中');
  });

  it('logs markdown previews for streaming card diagnostics', async () => {
    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    try {
      await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    } finally {
      console.log = originalLog;
    }

    const payload = logs.find((entry) => entry[0] === '[feishu-adapter] Streaming card create payload:')?.[1] as any;
    assert.ok(payload, 'expected streaming card payload diagnostic log');
    assert.deepEqual(payload.markdownPreviews.slice(0, 6), [
      { elementId: undefined, preview: '历史记录' },
      { elementId: 'streaming_content', preview: '💭 Thinking...' },
      { elementId: 'streaming_tasks', preview: '' },
      { elementId: 'streaming_status', preview: '处理中' },
    ]);
    assert.doesNotMatch(JSON.stringify(payload.markdownPreviews), /等待工具调用|工具调用/);
  });

  it('updates the dedicated status element without mutating the main content area', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamStatus('chat-1', '已运行 10秒，上次响应距今 10秒', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(elementUpdates.some((update) =>
      update.path?.element_id === 'streaming_status'
      && update.data?.content === '已运行 10秒，上次响应距今 10秒'));
    assert.ok(elementUpdates.every((update) =>
      update.path?.element_id !== 'streaming_content'
      && update.path?.element_id !== 'streaming_tools'));
  });

  it('periodically refreshes the whole streaming card without sending a new message', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const createCalls: Array<Record<string, any>> = [];
    const replyCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardFullRefreshIntervalMs = 1;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async (payload: Record<string, any>) => {
            createCalls.push(payload);
            return { data: { message_id: 'msg-1' } };
          },
          reply: async (payload: Record<string, any>) => {
            replyCalls.push(payload);
            return { data: { message_id: 'msg-1' } };
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const state = (adapter as any).activeCards.get('stream-1');
    state.lastFullRefreshAttemptAt = Date.now() - 10;

    adapter.onStreamStatus('chat-1', '已运行 5分，上次响应距今 2分', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(createCalls.length, 0);
    assert.equal(replyCalls.length, 1);
    assert.equal(cardUpdateCalls.length, 1);
    assert.equal(elementUpdates.length, 0);

    const body = JSON.parse(cardUpdateCalls[0]?.data?.card?.data || '{}');
    const elements = body.body?.elements || [];
    assert.equal(body.config?.streaming_mode, true);
    assert.equal(elements[0]?.element_id, 'stream_history');
    assert.equal(elements[0]?.tag, 'collapsible_panel');
    assert.equal((elements[0]?.elements || [])[0]?.element_id, 'streaming_content');
    assert.equal(elements[2]?.element_id, 'streaming_status');
    assert.equal(elements[2]?.content, '已运行 5分，上次响应距今 2分');
    assert.equal(state.renderedStatusText, '已运行 5分，上次响应距今 2分');
  });

  it('opens a continuation card instead of trimming rendered streaming history', async () => {
    const createdCards: Array<Record<string, any>> = [];
    const settingsCalls: Array<Record<string, any>> = [];
    const batchUpdates: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const replyCalls: Array<Record<string, any>> = [];
    const operations: Array<{ kind: string; cardId?: string; elementId?: string; content?: string }> = [];
    let cardIndex = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardFlushBaseIntervalMs = 1;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async ({ data }: { data: { data: string } }) => {
              createdCards.push(JSON.parse(data.data));
              cardIndex += 1;
              operations.push({ kind: 'card.create', cardId: `card-${cardIndex}` });
              return { data: { card_id: `card-${cardIndex}` } };
            },
            settings: async (payload: Record<string, any>) => {
              settingsCalls.push(payload);
              operations.push({ kind: 'card.settings', cardId: payload.path?.card_id });
              return {};
            },
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              operations.push({ kind: 'card.update', cardId: payload.path?.card_id });
              return {};
            },
            batchUpdate: async (payload: Record<string, any>) => {
              batchUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              operations.push({
                kind: 'cardElement.content',
                cardId: payload.path?.card_id,
                elementId: payload.path?.element_id,
                content: payload.data?.content,
              });
              return {};
            },
            create: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: `msg-${cardIndex}` } }),
          reply: async (payload: Record<string, any>) => {
            replyCalls.push(payload);
            return { data: { message_id: `msg-${cardIndex}` } };
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const historyItemsBeforeRolloverAt160Components = 140;
    const firstBatch = Array.from({ length: historyItemsBeforeRolloverAt160Components }, (_, index) => ({
      type: 'markdown' as const,
      role: 'assistant' as const,
      content: `模型输出 ${index + 1}`,
    }));
    adapter.onStreamHistory('chat-1', firstBatch, 'stream-1');
    await waitForCondition(() => batchUpdates.length >= 1);

    const secondBatch = Array.from({ length: historyItemsBeforeRolloverAt160Components + 25 }, (_, index) => ({
      type: 'markdown' as const,
      role: 'assistant' as const,
      content: `模型输出 ${index + 1}`,
    }));
    adapter.onStreamHistory('chat-1', secondBatch, 'stream-1');
    await waitForCondition(() => createdCards.length >= 2);

    assert.equal(replyCalls.length, 2);
    assert.ok(settingsCalls.some((call) => call.path?.card_id === 'card-1'));
    assert.equal(cardUpdates.length, 1);
    const rolloverSettingsCall = settingsCalls.find((call) => call.path?.card_id === 'card-1');
    assert.deepEqual(JSON.parse(rolloverSettingsCall?.data?.settings || '{}'), { streaming_mode: false });
    const rolloverStatusIndex = operations.findIndex((operation) =>
      operation.kind === 'cardElement.content'
      && operation.cardId === 'card-1'
      && operation.elementId === 'streaming_status'
      && String(operation.content || '').includes('已续接到下一条'));
    const rolloverFinalizeIndex = operations.findIndex((operation, index) =>
      index > rolloverStatusIndex
      && operation.kind === 'card.settings'
      && operation.cardId === 'card-1');
    const rolloverStaticUpdateIndex = operations.findIndex((operation, index) =>
      index > rolloverFinalizeIndex
      && operation.kind === 'card.update'
      && operation.cardId === 'card-1');
    assert.ok(rolloverStatusIndex >= 0);
    assert.ok(rolloverFinalizeIndex > rolloverStatusIndex);
    assert.ok(rolloverStaticUpdateIndex > rolloverFinalizeIndex);
    const rolloverStaticCard = JSON.parse(cardUpdates[0]?.data?.card?.data || '{}');
    assert.notEqual(rolloverStaticCard.config?.streaming_mode, true);
    assert.equal(rolloverStaticCard.config?.wide_screen_mode, true);
    assert.ok(_testOnly.countFeishuCardComponents(rolloverStaticCard) <= 160);
    const rolloverStaticJson = JSON.stringify(rolloverStaticCard);
    assert.match(rolloverStaticJson, /模型输出 1/);
    assert.match(rolloverStaticJson, /模型输出 140/);
    assert.equal(rolloverStaticJson.includes('模型输出 141'), false);
    const continuationCard = createdCards.at(-1) || {};
    assert.ok(_testOnly.countFeishuCardComponents(continuationCard) <= 160);
    const continuationJson = JSON.stringify(continuationCard);
    assert.match(continuationJson, /stream_history/);
    assert.equal(continuationJson.includes('"content":"模型输出 1"'), false);
    assert.match(continuationJson, /模型输出 141/);
    assert.match(continuationJson, /模型输出 165/);
    const activeState = (adapter as any).activeCards.get('stream-1');
    assert.equal(activeState.cardId, 'card-2');
    assert.equal(activeState.historyItemOffset, historyItemsBeforeRolloverAt160Components);
    assert.ok(activeState.renderedComponentCount <= 160);
  });

  it('uses an individual tool call as the continuation cursor inside one canonical tool group', async () => {
    const createdCards: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const settingsCalls: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    let cardIndex = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async ({ data }: { data: { data: string } }) => {
              createdCards.push(JSON.parse(data.data));
              cardIndex += 1;
              return { data: { card_id: `card-${cardIndex}` } };
            },
            settings: async (payload: Record<string, any>) => {
              settingsCalls.push(payload);
              return {};
            },
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: `msg-${cardIndex}` } }),
          reply: async () => ({ data: { message_id: `msg-${cardIndex}` } }),
        },
      },
    };

    const tools = Array.from({ length: 17 }, (_, index) => {
      const toolNumber = index + 1;
      const filler = Array.from({ length: 18 }, (__, lineIndex) => `+tool-${toolNumber}-line-${lineIndex + 1}-${'x'.repeat(22)}`).join('\n');
      return {
        id: `tool-${toolNumber}`,
        name: 'apply_patch',
        status: 'complete' as const,
        detail: {
          kind: 'patch_apply' as const,
          patchText: [
            '*** Begin Patch',
            `*** Update File: src/tool-${toolNumber}.ts`,
            '@@',
            filler,
            `+TOOL_${toolNumber}_END`,
            '*** End Patch',
          ].join('\n'),
          files: [{ path: `src/tool-${toolNumber}.ts`, action: 'update' as const }],
        },
      };
    });
    const firstRenderedToolCount = 10;
    const firstRenderedTools = tools.slice(0, firstRenderedToolCount);

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const textItems = [
      { type: 'markdown' as const, role: 'user' as const, content: '检查工具卡完整性' },
      { type: 'markdown' as const, role: 'assistant' as const, content: '开始检查' },
    ];
    adapter.onStreamHistory('chat-1', textItems, 'stream-1');
    await waitForCondition(() => cardUpdates.length >= 1);

    adapter.onStreamHistory('chat-1', [
      ...textItems,
      { type: 'tool_panel', tools: firstRenderedTools },
    ], 'stream-1');
    await waitForCondition(() => elementCreates.length >= 1);

    adapter.onStreamHistory('chat-1', [
      ...textItems,
      { type: 'tool_panel', tools },
    ], 'stream-1');
    await waitForCondition(() => createdCards.length >= 2, 1000);

    assert.ok(settingsCalls.some((call) => call.path?.card_id === 'card-1'));
    const sourceCardJson = String(cardUpdates.at(-1)?.data?.card?.data || '');
    const continuationCardJson = JSON.stringify(createdCards.at(-1));
    assert.ok(Buffer.byteLength(sourceCardJson, 'utf8') < 18_000);
    assert.ok(Buffer.byteLength(continuationCardJson, 'utf8') < 18_000);
    assert.match(sourceCardJson, /TOOL_1_END[\s\S]*\*\*\* End Patch/);
    assert.doesNotMatch(sourceCardJson, new RegExp(`TOOL_${tools.length}_END`));
    assert.doesNotMatch(continuationCardJson, /TOOL_1_END/);
    assert.match(continuationCardJson, new RegExp(`TOOL_${tools.length}_END[\\s\\S]*\\*\\*\\* End Patch`));
    assert.match(sourceCardJson, new RegExp(`工具调用 · ${firstRenderedToolCount}`));
    assert.match(continuationCardJson, new RegExp(`工具调用 · ${tools.length - firstRenderedToolCount}`));
    const sourcePatch = findCardElement(JSON.parse(sourceCardJson), (element) => (
      element.tag === 'markdown'
      && typeof element.content === 'string'
      && element.content.includes('TOOL_1_END')
    ));
    const continuationPatch = findCardElement(createdCards.at(-1), (element) => (
      element.tag === 'markdown'
      && typeof element.content === 'string'
      && element.content.includes(`TOOL_${tools.length}_END`)
    ));
    assert.match(sourcePatch?.content || '', /```typescript\n\*\*\* Begin Patch\n\*\*\* Update File:/);
    assert.match(continuationPatch?.content || '', /```typescript\n\*\*\* Begin Patch\n\*\*\* Update File:/);
    assert.match(sourcePatch?.content || '', /\n\*\*\* End Patch\n```$/);
    assert.match(continuationPatch?.content || '', /\n\*\*\* End Patch\n```$/);
    const activeState = (adapter as any).activeCards.get('stream-1');
    assert.equal(activeState.historyItems.length, 3, 'the canonical history keeps one tool_panel item');
    assert.equal(activeState.historyItems[2]?.type, 'tool_panel');
    assert.equal(activeState.historyItems[2]?.tools.length, tools.length);
    assert.equal(activeState.historyItemOffset, 2);
    assert.equal(activeState.historyToolCallOffset, firstRenderedToolCount);
  });

  it('keeps the shadow untrusted when periodic whole-card refresh fails', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardFullRefreshIntervalMs = 1;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              throw new Error('whole-card refresh failed');
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const state = (adapter as any).activeCards.get('stream-1');
    state.lastFullRefreshAttemptAt = Date.now() - 10;

    adapter.onStreamStatus('chat-1', '已运行 5分，上次响应距今 2分', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(cardUpdateCalls.length, 1);
    assert.equal(elementUpdates.length, 0);
    assert.equal(state.renderedStatusText, '处理中');
    assert.equal(state.shadowTrust, 'unknown');
  });

  it('appends new streaming tool panels without refreshing the whole card', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
            update: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onToolEvent('chat-1', [{ id: 'tool-1', name: 'shell_command', status: 'running' }], 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(cardUpdates.length, 0);
    assert.equal(elementCreates.length, 1);
    assert.equal(elementCreates[0]?.data?.type, 'append');
    assert.equal(elementCreates[0]?.data?.target_element_id, 'stream_history');
    assert.match(String(elementCreates[0]?.data?.elements || ''), /shell_command/);
    assert.match(String(elementCreates[0]?.data?.elements || ''), /stream_tool_1/);
    assert.ok(elementUpdates.every((update) =>
      update.path?.element_id !== 'streaming_content'
      && update.path?.element_id !== 'streaming_status'));
  });

  it('refreshes the full card for existing streaming tool updates', async () => {
    const cardUpdates: Array<Record<string, any>> = [];
    const elementUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamText('chat-1', '**codex:** 正在读取文件', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    adapter.onToolEvent('chat-1', [{ id: 'tool-1', name: 'shell_command', status: 'running' }], 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    adapter.onToolEvent('chat-1', [{ id: 'tool-1', name: 'shell_command', status: 'complete', output: 'done' }], 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(cardUpdates.length, 1);
    assert.equal(elementCreates.length, 1);
    assert.equal(elementCreates[0]?.data?.type, 'append');
    assert.equal(elementCreates[0]?.data?.target_element_id, 'stream_history');
    assert.match(String(cardUpdates[0]?.data?.card?.data || ''), /shell_command/);
    assert.doesNotMatch(String(cardUpdates[0]?.data?.card?.data || ''), /done/);
    assert.doesNotMatch(String(cardUpdates[0]?.data?.card?.data || ''), /stream_tool_1_e2/);
    assert.ok(elementUpdates.every((update) => update.path?.element_id !== 'stream_tool_1'));
  });

  it('does not grow component count for repeated tool status refreshes', async () => {
    const createdCards: Array<Record<string, any>> = [];
    const settingsCalls: Array<Record<string, any>> = [];
    const elementUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const replyCalls: Array<Record<string, any>> = [];
    let cardIndex = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async ({ data }: { data: { data: string } }) => {
              createdCards.push(JSON.parse(data.data));
              cardIndex += 1;
              return { data: { card_id: `card-${cardIndex}` } };
            },
            settings: async (payload: Record<string, any>) => {
              settingsCalls.push(payload);
              return {};
            },
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: `msg-${cardIndex}` } }),
          reply: async (payload: Record<string, any>) => {
            replyCalls.push(payload);
            return { data: { message_id: `msg-${cardIndex}` } };
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onToolEvent('chat-1', [{ id: 'tool-1', name: 'shell_command', status: 'running' }], 'stream-1');
    await waitForCondition(() => elementCreates.length >= 1);

    for (let index = 0; index < 8; index += 1) {
      adapter.onToolEvent('chat-1', [{
        id: 'tool-1',
        name: 'shell_command',
        status: 'complete',
        output: `done ${index}`,
      }], 'stream-1');
      await waitForCondition(() => cardUpdates.length >= index + 1, 1000);
    }

    assert.equal(replyCalls.length, 1);
    assert.equal(settingsCalls.some((call) => call.path?.card_id === 'card-1'), false);
    assert.equal(elementCreates.length, 1);
    assert.equal(createdCards.length, 1);
    assert.ok(cardUpdates.every((update) => !String(update.data?.card?.data || '').includes('stream_tool_1_e2')));
    const activeState = (adapter as any).activeCards.get('stream-1');
    assert.equal(activeState.cardId, 'card-1');
    assert.ok(activeState.renderedComponentCount < 160);
    assert.ok(elementUpdates.every((update) =>
      update.path?.element_id !== 'streaming_status'
      || !String(update.data?.content || '').includes('已续接到下一条')));
  });

  it('keeps repeated tool refreshes on the same card without installing a continuation', async () => {
    const createdCards: Array<Record<string, any>> = [];
    const settingsCalls: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const replyCalls: Array<Record<string, any>> = [];
    let cardIndex = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async ({ data }: { data: { data: string } }) => {
              createdCards.push(JSON.parse(data.data));
              cardIndex += 1;
              return { data: { card_id: `card-${cardIndex}` } };
            },
            settings: async (payload: Record<string, any>) => {
              settingsCalls.push(payload);
              return {};
            },
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: `msg-${cardIndex}` } }),
          reply: async (payload: Record<string, any>) => {
            replyCalls.push(payload);
            return { data: { message_id: `msg-${cardIndex}` } };
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onToolEvent('chat-1', [{ id: 'tool-1', name: 'shell_command', status: 'running' }], 'stream-1');
    await waitForCondition(() => elementCreates.length >= 1);

    for (let index = 0; index < 8; index += 1) {
      adapter.onToolEvent('chat-1', [{
        id: 'tool-1',
        name: 'shell_command',
        status: 'complete',
        output: `done ${index}`,
      }], 'stream-1');
      await waitForCondition(() => cardUpdates.length >= index + 1, 1000);
    }

    assert.equal(replyCalls.length, 1);
    assert.equal(settingsCalls.length, 0);
    assert.equal(createdCards.length, 1);
    assert.equal(elementCreates.length, 1);
  });

  it('opens a continuation card when Feishu rejects a new tool panel with element limit', async () => {
    const createdCards: Array<Record<string, any>> = [];
    const settingsCalls: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const replyCalls: Array<Record<string, any>> = [];
    let cardIndex = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async ({ data }: { data: { data: string } }) => {
              createdCards.push(JSON.parse(data.data));
              cardIndex += 1;
              return { data: { card_id: `card-${cardIndex}` } };
            },
            settings: async (payload: Record<string, any>) => {
              settingsCalls.push(payload);
              return {};
            },
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              if (String(payload.data?.card?.data || '').includes('st_1_t_13')) {
                return { code: 300315, msg: 'ErrMsg: msg: [element exceeds the limit], code: 300305;' };
              }
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: `msg-${cardIndex}` } }),
          reply: async (payload: Record<string, any>) => {
            replyCalls.push(payload);
            return { data: { message_id: `msg-${cardIndex}` } };
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    let lastUpdateCount = cardUpdates.length;
    let lastCreateCount = elementCreates.length;
    for (let index = 1; index <= 13 && createdCards.length < 2; index += 1) {
      const tools = Array.from({ length: index }, (_, toolIndex) => ({
        id: `tool-${toolIndex + 1}`,
        name: `tool_${toolIndex + 1}`,
        status: 'running' as const,
      }));
      adapter.onToolEvent('chat-1', tools, 'stream-1');
      await waitForCondition(() => (
        cardUpdates.length > lastUpdateCount
        || elementCreates.length > lastCreateCount
        || createdCards.length >= 2
      ), 1000);
      lastUpdateCount = cardUpdates.length;
      lastCreateCount = elementCreates.length;
    }

    assert.equal(replyCalls.length, 2);
    assert.ok(settingsCalls.some((call) => call.path?.card_id === 'card-1'));
    assert.ok(cardUpdates.some((update) => String(update.data?.card?.data || '').includes('st_1_t_13')));
    const activeState = (adapter as any).activeCards.get('stream-1');
    assert.equal(activeState.cardId, 'card-2');
    assert.equal(activeState.toolCallOffset, 12);
    assert.match(JSON.stringify(createdCards.at(-1)), /tool_13/);
    assert.doesNotMatch(JSON.stringify(createdCards.at(-1)), /tool_12/);
  });

  it('opens a continuation card immediately when Feishu returns 200850 for a history append', async () => {
    const createdCards: Array<Record<string, any>> = [];
    const settingsCalls: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const elementUpdates: Array<Record<string, any>> = [];
    const replyCalls: Array<Record<string, any>> = [];
    let cardIndex = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async ({ data }: { data: { data: string } }) => {
              createdCards.push(JSON.parse(data.data));
              cardIndex += 1;
              return { data: { card_id: `card-${cardIndex}` } };
            },
            settings: async (payload: Record<string, any>) => {
              settingsCalls.push(payload);
              return {};
            },
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              if (String(payload.data?.elements || '').includes('stream_txt_2')) {
                return { code: 200850, msg: 'card payload exceeds Feishu limit' };
              }
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: `msg-${cardIndex}` } }),
          reply: async (payload: Record<string, any>) => {
            replyCalls.push(payload);
            return { data: { message_id: `msg-${cardIndex}` } };
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamHistory('chat-1', [{
      type: 'markdown' as const,
      role: 'assistant' as const,
      content: '上一轮输出',
    }], 'stream-1');
    await waitForCondition(() => elementUpdates.length >= 1);

    adapter.onStreamHistory('chat-1', [{
      type: 'markdown' as const,
      role: 'assistant' as const,
      content: '上一轮输出',
    }, {
      type: 'markdown' as const,
      role: 'assistant' as const,
      content: '当前输出会触发 200850',
    }], 'stream-1');
    await waitForCondition(() => createdCards.length >= 2, 1000);

    assert.equal(replyCalls.length, 2);
    assert.equal(cardUpdates.length, 1);
    assert.ok(settingsCalls.some((call) => call.path?.card_id === 'card-1'));
    assert.ok(elementCreates.some((create) => String(create.data?.elements || '').includes('stream_txt_2')));
    const rolloverStaticJson = cardUpdates[0]?.data?.card?.data || '';
    assert.notEqual(JSON.parse(rolloverStaticJson).config?.streaming_mode, true);
    assert.match(rolloverStaticJson, /上一轮输出/);
    assert.doesNotMatch(rolloverStaticJson, /当前输出会触发 200850/);
    const continuationJson = JSON.stringify(createdCards.at(-1));
    assert.match(continuationJson, /当前输出会触发 200850/);
    assert.doesNotMatch(continuationJson, /上一轮输出/);
    const activeState = (adapter as any).activeCards.get('stream-1');
    assert.equal(activeState.cardId, 'card-2');
    assert.equal(activeState.historyItemOffset, 1);
  });

  it('opens a continuation card before Feishu rejects oversized streaming card payloads', async () => {
    const createdCards: Array<Record<string, any>> = [];
    const settingsCalls: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const elementUpdates: Array<Record<string, any>> = [];
    const replyCalls: Array<Record<string, any>> = [];
    let cardIndex = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async ({ data }: { data: { data: string } }) => {
              createdCards.push(JSON.parse(data.data));
              cardIndex += 1;
              return { data: { card_id: `card-${cardIndex}` } };
            },
            settings: async (payload: Record<string, any>) => {
              settingsCalls.push(payload);
              return {};
            },
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: `msg-${cardIndex}` } }),
          reply: async (payload: Record<string, any>) => {
            replyCalls.push(payload);
            return { data: { message_id: `msg-${cardIndex}` } };
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const firstLargeGroup = `上一组 ${'a'.repeat(9_500)}`;
    const currentLargeGroup = `当前组 ${'b'.repeat(9_500)}`;
    adapter.onStreamHistory('chat-1', [{
      type: 'markdown' as const,
      role: 'assistant' as const,
      content: firstLargeGroup,
    }], 'stream-1');
    await waitForCondition(() => elementUpdates.length >= 1);

    adapter.onStreamHistory('chat-1', [{
      type: 'markdown' as const,
      role: 'assistant' as const,
      content: firstLargeGroup,
    }, {
      type: 'markdown' as const,
      role: 'assistant' as const,
      content: currentLargeGroup,
    }], 'stream-1');
    await waitForCondition(() => createdCards.length >= 2, 1000);

    assert.equal(replyCalls.length, 2);
    assert.equal(cardUpdates.length, 1);
    assert.equal(elementCreates.length, 0);
    assert.ok(settingsCalls.some((call) => call.path?.card_id === 'card-1'));
    const rolloverStaticJson = cardUpdates[0]?.data?.card?.data || '';
    assert.notEqual(JSON.parse(rolloverStaticJson).config?.streaming_mode, true);
    assert.match(rolloverStaticJson, /上一组/);
    assert.doesNotMatch(rolloverStaticJson, /当前组/);
    const continuationJson = JSON.stringify(createdCards.at(-1));
    assert.match(continuationJson, /当前组/);
    assert.doesNotMatch(continuationJson, /上一组/);
    const activeState = (adapter as any).activeCards.get('stream-1');
    assert.equal(activeState.cardId, 'card-2');
    assert.equal(activeState.historyItemOffset, 1);
    assert.ok(activeState.renderedComponentCount < 160);
  });

  it('renders stream history from reducer items in the visible card order', async () => {
    const cardUpdates: Array<Record<string, any>> = [];
    const elementUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamHistory('chat-1', [
      { type: 'markdown', role: 'user', content: '用户输入' },
      { type: 'markdown', role: 'assistant', content: '模型输出一' },
      { type: 'tool_panel', tools: [{ id: 'tool-1', name: 'exec_command', status: 'complete' }] },
      { type: 'markdown', role: 'assistant', content: '模型输出二' },
      { type: 'tool_panel', tools: [{ id: 'tool-2', name: 'apply_patch', status: 'running' }] },
    ], 'stream-1');
    await waitForCondition(() => cardUpdates.length >= 1);

    assert.equal(elementUpdates.length, 0);
    assert.equal(elementCreates.length, 0);
    const refreshed = String(cardUpdates[0]?.data?.card?.data || '');
    assert.match(refreshed, /用户输入/);
    assert.match(refreshed, /模型输出一/);
    assert.match(refreshed, /exec_command/);
    assert.match(refreshed, /模型输出二/);
    assert.match(refreshed, /apply_patch/);
    assert.ok(refreshed.indexOf('用户输入') < refreshed.indexOf('模型输出一'));
    assert.ok(refreshed.indexOf('模型输出一') < refreshed.indexOf('exec_command'));
    assert.ok(refreshed.indexOf('exec_command') < refreshed.indexOf('模型输出二'));
    assert.ok(refreshed.indexOf('模型输出二') < refreshed.indexOf('apply_patch'));
  });

  it('refreshes the full card for history-driven tool status changes', async () => {
    const cardUpdates: Array<Record<string, any>> = [];
    const elementUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    const runningHistory = [
      { type: 'markdown' as const, role: 'user' as const, content: '用户输入' },
      { type: 'markdown' as const, role: 'assistant' as const, content: '模型输出一' },
      { type: 'tool_panel' as const, tools: [{ id: 'tool-1', name: 'exec_command', status: 'running' as const }] },
    ];

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamHistory('chat-1', runningHistory, 'stream-1');
    await waitForCondition(() => cardUpdates.length >= 1);

    adapter.onStreamHistory('chat-1', [
      runningHistory[0]!,
      runningHistory[1]!,
      {
        type: 'tool_panel',
        tools: [{ id: 'tool-1', name: 'exec_command', status: 'complete', output: 'done' }],
      },
    ], 'stream-1');
    await waitForCondition(() => cardUpdates.length >= 2);

    assert.equal(elementUpdates.length, 0);
    assert.equal(elementCreates.length, 0);
    assert.doesNotMatch(String(cardUpdates.at(-1)?.data?.card?.data || ''), /done/);
    assert.match(String(cardUpdates.at(-1)?.data?.card?.data || ''), /工具调用 · 1/);
    assert.doesNotMatch(String(cardUpdates.at(-1)?.data?.card?.data || ''), /stream_tool_1_e2/);
  });

  it('uses the changed inner tool title when refreshing grouped history tool updates', async () => {
    const cardUpdates: Array<Record<string, any>> = [];
    const elementUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    const groupedTools = [
      { id: 'tool-1', name: 'exec_command', status: 'complete' as const, output: 'done' },
      { id: 'tool-2', name: 'apply_patch', status: 'running' as const },
    ];

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamHistory('chat-1', [
      { type: 'markdown' as const, role: 'assistant' as const, content: '模型输出' },
      { type: 'tool_panel' as const, tools: groupedTools },
    ], 'stream-1');
    await waitForCondition(() => elementCreates.some((create) =>
      create.data?.target_element_id === 'stream_history'
      && String(create.data?.elements || '').includes('工具调用 · 2')));

    adapter.onStreamHistory('chat-1', [
      { type: 'markdown' as const, role: 'assistant' as const, content: '模型输出' },
      {
        type: 'tool_panel',
        tools: [
          groupedTools[0]!,
          { id: 'tool-2', name: 'apply_patch', status: 'complete' as const, output: 'patched' },
        ],
      },
    ], 'stream-1');
    await waitForCondition(() => cardUpdates.length >= 1);

    const refreshed = String(cardUpdates.at(-1)?.data?.card?.data || '');
    assert.match(refreshed, /🛠️ 修改 1 个文件/);
    assert.match(refreshed, /工具调用 · 2/);
    assert.doesNotMatch(refreshed, /完成|Success/);
    assert.doesNotMatch(refreshed, /stream_tool_1_e2/);
  });

  it('refreshes the shared tool group when a second inner tool panel is added', async () => {
    const cardUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const batchUpdates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
            batchUpdate: async (payload: Record<string, any>) => {
              batchUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamHistory('chat-1', [
      { type: 'markdown' as const, role: 'assistant' as const, content: '模型输出' },
      { type: 'tool_panel' as const, tools: [{ id: 'tool-1', name: 'exec_command', status: 'running' as const }] },
    ], 'stream-1');
    await waitForCondition(() => elementCreates.some((create) =>
      create.data?.target_element_id === 'stream_history'
      && String(create.data?.elements || '').includes('stream_tool_1')));

    adapter.onStreamHistory('chat-1', [
      { type: 'markdown' as const, role: 'assistant' as const, content: '模型输出' },
      {
        type: 'tool_panel',
        tools: [
          { id: 'tool-1', name: 'exec_command', status: 'running' as const },
          { id: 'tool-2', name: 'apply_patch', status: 'running' as const },
        ],
      },
    ], 'stream-1');
    await waitForCondition(() => cardUpdates.length >= 1);

    assert.equal(batchUpdates.length, 0);
    const refreshedGroup = String(cardUpdates.at(-1)?.data?.card?.data || '');
    assert.match(refreshedGroup, /工具调用 · 2/);
    assert.match(refreshedGroup, /st_1_t_1/);
    assert.match(refreshedGroup, /st_1_t_2/);
    assert.match(refreshedGroup, /apply_patch/);
    assert.equal(elementCreates.some((create) =>
      create.data?.target_element_id === 'stream_tool_1'
      && String(create.data?.elements || '').includes('stream_tool_1_e2')), false);
  });

  it('appends terminal status for history-driven cards when the final full-card update hits a Feishu API error code', async () => {
    const cardUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const reactionCreates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return { code: 300305, msg: 'ErrMsg: element exceeds the limit;' };
            },
          },
          cardElement: {
            content: async () => ({}),
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
        messageReaction: {
          create: async (payload: Record<string, any>) => {
            reactionCreates.push(payload);
            return {};
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamHistory('chat-1', [
      { type: 'markdown' as const, role: 'assistant' as const, content: '模型输出' },
      { type: 'tool_panel' as const, tools: [{ id: 'tool-1', name: 'exec_command', status: 'complete' as const }] },
    ], 'stream-1');
    adapter.onStreamStatus('chat-1', '已运行 3秒，125k(63%) · ↑125k ↓4.6k', 'stream-1');
    adapter.onStreamStatus('chat-1', '✅ Completed · 3.0s', 'stream-1');
    await waitForCondition(() => elementCreates.length >= 1);

    const finalized = await adapter.onStreamEnd('chat-1', 'completed', '', 'stream-1');

    assert.equal(finalized, true);
    assert.ok(cardUpdates.length >= 1);
    assert.equal(elementCreates.at(-1)?.data?.target_element_id, undefined);
    assert.match(String(elementCreates.at(-1)?.data?.elements || ''), /stream_done/);
    assert.doesNotMatch(String(elementCreates.at(-1)?.data?.elements || ''), /Completed|Success/);
    assert.match(String(elementCreates.at(-1)?.data?.elements || ''), /125k\(63%\) · ↑125k ↓4\.6k/);
    assert.deepEqual(reactionCreates, [{
      path: { message_id: 'msg-1' },
      data: { reaction_type: { emoji_type: 'DONE' } },
    }]);
  });

  it('keeps a closed streaming card finalized when both final update and status append exceed Feishu limits', async () => {
    const cardUpdates: Array<Record<string, any>> = [];
    const elementUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const reactionCreates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return { code: 300305, msg: 'ErrMsg: element exceeds the limit;' };
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return { code: 300315, msg: 'ErrMsg: msg: [element exceeds the limit], code: 300305;' };
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
        messageReaction: {
          create: async (payload: Record<string, any>) => {
            reactionCreates.push(payload);
            return {};
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamHistory('chat-1', [
      { type: 'markdown' as const, role: 'assistant' as const, content: '模型输出' },
    ], 'stream-1');
    adapter.onStreamText('chat-1', '模型输出', 'stream-1');
    await waitForCondition(() => elementUpdates.length >= 1);

    const finalized = await adapter.onStreamEnd('chat-1', 'completed', '', 'stream-1');

    assert.equal(finalized, true);
    const finalUpdate = cardUpdates.find((payload) => {
      const cardData = payload?.data?.card?.data;
      if (typeof cardData !== 'string') return false;
      return JSON.parse(cardData).config?.streaming_mode !== true;
    });
    assert.ok(finalUpdate, 'expected final card.update to be attempted');
    assert.equal(elementCreates.at(-1)?.data?.target_element_id, undefined);
    assert.deepEqual(reactionCreates, [{
      path: { message_id: 'msg-1' },
      data: { reaction_type: { emoji_type: 'DONE' } },
    }]);
  });

  it('returns false for invalid card id finalization so mirror delivery can fall back', async () => {
    const cardUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const reactionCreates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return { code: 99991663, msg: 'cardid is invalid' };
            },
          },
          cardElement: {
            content: async () => ({}),
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return { code: 99991663, msg: 'cardid is invalid' };
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
        messageReaction: {
          create: async (payload: Record<string, any>) => {
            reactionCreates.push(payload);
            return {};
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamHistory('chat-1', [
      { type: 'markdown' as const, role: 'user' as const, content: '用户消息' },
      { type: 'markdown' as const, role: 'assistant' as const, content: 'Kimi 最终回复' },
    ], 'stream-1');

    const finalized = await adapter.onStreamEnd('chat-1', 'completed', '', 'stream-1');

    assert.equal(finalized, false);
    assert.ok(cardUpdates.length >= 1);
    assert.ok(elementCreates.length >= 1);
    assert.equal(reactionCreates.length, 0);
    assert.equal((adapter as any).activeCards.has('stream-1'), false);
  });

  it('keeps tool attach payloads much smaller than whole-card refresh payloads', async () => {
    const buildAdapter = (options: { failAttach?: boolean }) => {
      const cardUpdates: Array<Record<string, any>> = [];
      const elementCreates: Array<Record<string, any>> = [];
      const adapter = new FeishuAdapter({
        id: 'feishu-default',
        provider: 'feishu',
        enabled: true,
        alias: '飞书',
        config: {
          appId: 'app-id',
          appSecret: 'app-secret',
          streamingEnabled: true,
        },
      });
      (adapter as any).cardFlushBaseIntervalMs = 1;
      (adapter as any).restClient = {
        cardkit: {
          v1: {
            card: {
              create: async () => ({ data: { card_id: 'card-1' } }),
              settings: async () => ({}),
              update: async (payload: Record<string, any>) => {
                cardUpdates.push(payload);
                return {};
              },
            },
            cardElement: {
              content: async () => ({}),
              create: async (payload: Record<string, any>) => {
                elementCreates.push(payload);
                if (options.failAttach) throw new Error('attach unavailable');
                return {};
              },
              update: async () => ({}),
            },
          },
        },
        im: {
          message: {
            create: async () => ({ data: { message_id: 'msg-1' } }),
            reply: async () => ({ data: { message_id: 'msg-1' } }),
          },
        },
      };
      return { adapter, cardUpdates, elementCreates };
    };

    const text = [
      '**我:** 帮我排查 streaming card payload',
      '',
      '**codex:** 我会先读取实现并定位刷新路径。',
    ].join('\n');
    const tool = {
      id: 'tool-1',
      name: 'exec_command',
      status: 'running' as const,
      input: 'sed -n "2200,2300p" src/channels/feishu/adapter.ts',
    };

    const optimized = buildAdapter({});
    await (optimized.adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    optimized.adapter.onStreamText('chat-1', text, 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    optimized.adapter.onToolEvent('chat-1', [tool], 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const fallback = buildAdapter({ failAttach: true });
    await (fallback.adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    fallback.adapter.onStreamText('chat-1', text, 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    fallback.adapter.onToolEvent('chat-1', [tool], 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const attachPayloadBytes = Buffer.byteLength(JSON.stringify(optimized.elementCreates.at(-1) || {}));
    const refreshPayloadBytes = Buffer.byteLength(JSON.stringify(fallback.cardUpdates.at(-1) || {}));

    assert.equal(optimized.cardUpdates.length, 0);
    assert.equal(optimized.elementCreates.length, 1);
    assert.equal(fallback.cardUpdates.length, 1);
    assert.ok(attachPayloadBytes > 0);
    assert.ok(refreshPayloadBytes > 0);
    assert.ok(
      attachPayloadBytes < refreshPayloadBytes * 0.55,
      `expected attach payload (${attachPayloadBytes} bytes) to be much smaller than refresh payload (${refreshPayloadBytes} bytes)`,
    );
  });

  it('updates task progress in the dedicated tasks region instead of the main content area', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onTaskEvent('chat-1', [
      { text: '拆分 bridge manager', status: 'in_progress' },
      { text: '补一期回归测试', status: 'pending' },
    ], 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(elementUpdates.some((update) =>
      update.path?.element_id === 'streaming_tasks'
      && String(update.data?.content || '').includes('拆分 bridge manager')));
    assert.ok(elementUpdates.every((update) =>
      update.path?.element_id !== 'streaming_content'
      && update.path?.element_id !== 'streaming_status'));
  });

  it('leaves later regions pending when one element update fails', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const contentFailure = createDeferred<Record<string, any>>();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushFirstFailureIntervalMs = 1;
    (adapter as any).cardFlushMaxFailureIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              if (payload.path?.element_id === 'streaming_content') {
                return contentFailure.promise;
              }
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const state = (adapter as any).activeCards.get('stream-1');
    state.pendingText = '新的流式内容';
    state.pendingStatusText = '已运行 10秒，上次响应距今 10秒';
    state.renderedText = '旧内容';
    state.lastFullRefreshAttemptAt = Date.now();

    await (adapter as any).flushCardUpdate('stream-1');

    assert.deepEqual(
      elementUpdates.map((update) => update.path?.element_id),
      ['streaming_content'],
    );
    assert.equal(state.renderedText, '旧内容');
    assert.equal(state.renderedStatusText, '处理中');
    assert.ok(state.backgroundFlushInFlight);
    assert.equal(cardUpdates.length, 0);

    contentFailure.reject(new Error('content failed'));
    await waitForCondition(() => cardUpdates.length === 1);
    assert.match(String(cardUpdates[0]?.data?.card?.data || ''), /新的流式内容/);
    assert.match(String(cardUpdates[0]?.data?.card?.data || ''), /已运行 10秒/);
  });

  it('queues a new planning round instead of sending stale snapshot updates after desired changes mid-request', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              if (payload.path?.element_id === 'streaming_content') {
                const state = (adapter as any).activeCards.get('stream-1');
                state.pendingStatusText = '状态 2';
                (adapter as any).markStreamingDesiredDirty(state);
              }
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const state = (adapter as any).activeCards.get('stream-1');
    state.pendingText = '新的流式内容';
    state.pendingStatusText = '状态 1';
    state.renderedText = '旧内容';
    state.lastFullRefreshAttemptAt = Date.now();
    (adapter as any).markStreamingDesiredDirty(state);

    await (adapter as any).flushCardUpdate('stream-1');

    assert.deepEqual(
      elementUpdates.map((update) => update.path?.element_id),
      ['streaming_content'],
    );
    assert.equal(state.renderedStatusText, '处理中');
    assert.equal(state.flushQueued, true);
  });

  it('appends one shared group for small-card tool updates', async () => {
    const batchUpdates: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const elementCreates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
            batchUpdate: async (payload: Record<string, any>) => {
              batchUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
            create: async (payload: Record<string, any>) => {
              elementCreates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const state = (adapter as any).activeCards.get('stream-1');
    state.toolCalls = [
      { id: 'tool-1', name: 'read_file', status: 'running' as const, input: 'a.txt' },
      { id: 'tool-2', name: 'run_tests', status: 'running' as const, input: 'npm test' },
    ];
    (adapter as any).markStreamingDesiredDirty(state);

    await (adapter as any).flushCardUpdate('stream-1');

    assert.equal(batchUpdates.length, 0);
    assert.equal(cardUpdates.length, 0);
    assert.equal(elementCreates.length, 1);
    assert.equal(state.perf.fullRefreshReasons.direct_refresh_small_card || 0, 0);
    const toolGroup = String(elementCreates[0]?.data?.elements || '');
    assert.match(toolGroup, /工具调用 · 2/);
    assert.match(toolGroup, /读取 文件/);
    assert.match(toolGroup, /a\.txt/);
    assert.match(toolGroup, /run_tests/);
  });

  it('downgrades slow batchUpdate shadow trust and corrects it with the next full refresh', async () => {
    const batchUpdates: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    let now = 1_000_000;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      (adapter as any).restClient = {
        cardkit: {
          v1: {
            card: {
              create: async () => ({ data: { card_id: 'card-1' } }),
              settings: async () => ({}),
              update: async (payload: Record<string, any>) => {
                cardUpdates.push(payload);
                return {};
              },
              batchUpdate: async (payload: Record<string, any>) => {
                batchUpdates.push(payload);
                now += 5_001;
                return {};
              },
            },
            cardElement: {
              content: async () => ({}),
              create: async () => ({}),
            },
          },
        },
        im: {
          message: {
            create: async () => ({ data: { message_id: 'msg-1' } }),
            reply: async () => ({ data: { message_id: 'msg-1' } }),
          },
        },
      };

      await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
      const state = (adapter as any).activeCards.get('stream-1');
      state.lastFullRefreshAttemptAt = now;
      state.historyDriven = true;
      state.historyItems = Array.from({ length: 25 }, (_, index) => ({
        type: 'markdown' as const,
        role: index === 0 ? 'thinking' as const : 'assistant' as const,
        content: index === 0 ? '💭 Thinking...' : `history line ${index + 1}`,
      }));
      (adapter as any).markStreamingDesiredDirty(state);

      await (adapter as any).flushCardUpdate('stream-1');

      for (let attempt = 0; attempt < 20 && batchUpdates.length === 0; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(batchUpdates.length, 1);
      assert.equal(cardUpdates.length, 0);
      assert.equal(state.shadowTrust, 'weak');

      await (adapter as any).flushCardUpdate('stream-1');

      for (let attempt = 0; attempt < 20 && cardUpdates.length === 0; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(cardUpdates.length, 1);
      assert.equal(state.shadowTrust, 'trusted');
    } finally {
      Date.now = originalNow;
    }
  });

  it('releases the flush queue after a timed-out update so later refreshes can continue', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const blocked = createDeferred<Record<string, any>>();
    let callCount = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardRequestTimeoutMs = 5;
    (adapter as any).cardFlushBaseIntervalMs = 1;
    (adapter as any).cardFlushFirstFailureIntervalMs = 1;
    (adapter as any).cardFlushMaxFailureIntervalMs = 1;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              callCount += 1;
              if (callCount === 1) {
                return blocked.promise;
              }
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamText('chat-1', '第一段输出', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    adapter.onStreamStatus('chat-1', '已运行 0分20秒', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const state = (adapter as any).activeCards.get('stream-1');
    assert.equal(Boolean(state.flushInFlight), false);
    assert.ok(elementUpdates.some((update) =>
      update.path?.element_id === 'streaming_status'
      && update.data?.content === '已运行 0分20秒'));
    assert.equal(state.lastFlushError, null);
    assert.equal(state.consecutiveFlushFailures, 0);

    blocked.resolve({});
  });

  it('coalesces streaming card updates behind a per-card congestion window', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardFlushBaseIntervalMs = 30;
    (adapter as any).cardFlushFirstFailureIntervalMs = 50;
    (adapter as any).cardFlushMaxFailureIntervalMs = 100;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamText('chat-1', '第一段输出', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    adapter.onStreamStatus('chat-1', '已运行 1秒', 'stream-1');
    adapter.onStreamStatus('chat-1', '已运行 2秒', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(elementUpdates.length, 1);
    assert.equal(elementUpdates[0]?.path?.element_id, 'streaming_content');

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(elementUpdates.length, 2);
    assert.equal(elementUpdates[1]?.path?.element_id, 'streaming_status');
    assert.equal(elementUpdates[1]?.data?.content, '已运行 2秒');
  });

  it('backs off failed streaming card updates to at most the configured cap and recovers with full refresh', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const cardUpdates: Array<Record<string, any>> = [];
    const blocked = createDeferred<Record<string, any>>();
    let callCount = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardRequestTimeoutMs = 5;
    (adapter as any).cardFlushBaseIntervalMs = 2;
    (adapter as any).cardFlushFirstFailureIntervalMs = 5;
    (adapter as any).cardFlushMaxFailureIntervalMs = 10;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              callCount += 1;
              if (callCount === 1) return blocked.promise;
              if (callCount === 2) throw new Error('temporary Feishu congestion');
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamText('chat-1', '第一段输出', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    adapter.onStreamText('chat-1', '拥塞中 1', 'stream-1');
    await waitForCondition(() => cardUpdates.length === 1);
    assert.equal(elementUpdates.length, 1);
    assert.match(String(cardUpdates[0]?.data?.card?.data || ''), /拥塞中 1/);

    adapter.onStreamText('chat-1', '恢复中', 'stream-1');
    await waitForCondition(() => elementUpdates.length === 2);
    assert.equal(elementUpdates.length, 2);
    assert.equal(elementUpdates[1]?.data?.content, '恢复中');

    await waitForCondition(() => cardUpdates.length === 2);
    assert.equal(elementUpdates.length, 2);
    assert.equal(elementUpdates[1]?.data?.content, '恢复中');
    assert.equal(cardUpdates.length, 2);
    assert.match(String(cardUpdates[1]?.data?.card?.data || ''), /恢复中/);

    const state = (adapter as any).activeCards.get('stream-1');
    assert.equal(state.consecutiveFlushFailures, 0);

    adapter.onStreamText('chat-1', '已恢复正常节拍', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 8));
    assert.equal(elementUpdates.length, 3);
    assert.equal(elementUpdates[2]?.data?.content, '已恢复正常节拍');

    blocked.resolve({});
  });

  it('finalizes a streaming card instead of hanging behind a stuck flush', async () => {
    const blocked = createDeferred<Record<string, any>>();
    const cardSettingsCalls: Array<Record<string, any>> = [];
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardRequestTimeoutMs = 5;
    (adapter as any).cardFinalizeFlushWaitExtraMs = 5;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async (payload: Record<string, any>) => {
              cardSettingsCalls.push(payload);
              return {};
            },
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const state = (adapter as any).activeCards.get('stream-1');
    state.flushInFlight = blocked.promise;
    state.flushQueued = true;

    const finalized = await adapter.onStreamEnd('chat-1', 'interrupted', '用户执行 /stop，已停止当前任务。', 'stream-1');

    assert.equal(finalized, true);
    assert.equal(cardSettingsCalls.length, 1);
    assert.equal(cardUpdateCalls.length, 1);
    assert.equal((adapter as any).activeCards.has('stream-1'), false);

    blocked.resolve({});
  });

  it('caps stream finalization with a total blocking budget while a slow Feishu card update continues in the background', async () => {
    const blockedUpdate = createDeferred<Record<string, any>>();
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const errors: unknown[][] = [];
    const oldError = console.error;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardRequestTimeoutMs = 1_000;
    (adapter as any).cardFinalizeBlockingBudgetMs = 5;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return blockedUpdate.promise;
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
        messageReaction: {
          create: async () => ({}),
        },
      },
    };

    console.error = (...args: unknown[]) => {
      errors.push(args);
      oldError(...args);
    };
    try {
      await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
      const startedAt = Date.now();
      const finalized = await adapter.onStreamEnd('chat-1', 'completed', '最终回复', 'stream-1');

      assert.equal(finalized, true);
      assert.ok(Date.now() - startedAt < 200);
      assert.equal(cardUpdateCalls.length, 1);
      assert.equal((adapter as any).activeCards.has('stream-1'), true);
      assert.ok(errors.some((entry) =>
        entry[0] === '[feishu-adapter] Streaming card finalize exceeded blocking budget; continuing in background:'));

      blockedUpdate.resolve({});
      await waitForCondition(() => !(adapter as any).activeCards.has('stream-1'));
    } finally {
      console.error = oldError;
    }
  });

  it('renders action buttons on streaming cards and keeps them disabled after finalization', async () => {
    const cardCreateCalls: Array<Record<string, any>> = [];
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const logs: unknown[][] = [];
    const oldLog = console.log;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    console.log = (...args: unknown[]) => {
      logs.push(args);
      oldLog(...args);
    };
    try {
      (adapter as any).restClient = {
        cardkit: {
          v1: {
            card: {
              create: async (payload: Record<string, any>) => {
                cardCreateCalls.push(payload);
                return { data: { card_id: 'card-1' } };
              },
              settings: async () => ({}),
              update: async (payload: Record<string, any>) => {
                cardUpdateCalls.push(payload);
                return {};
              },
            },
            cardElement: {
              content: async () => ({}),
            },
          },
        },
        im: {
          message: {
            create: async () => ({ data: { message_id: 'msg-1' } }),
            reply: async () => ({ data: { message_id: 'msg-1' } }),
          },
        },
      };

      adapter.onStreamActions('chat-1', [[{
        text: '停止',
        callbackData: 'tmux-screen:stop:session-1',
        type: 'danger',
      }]], 'stream-1');
      await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');

      const initialCardJson = String(cardCreateCalls[0]?.data?.data || '');
      const initialCard = JSON.parse(initialCardJson);
      const initialButton = findCardElement(initialCard, (element) => element.tag === 'button' && element.text?.content === '停止');
      assert.match(initialCardJson, /"tag":"button"/);
      assert.match(initialCardJson, /"content":"停止"/);
      assert.match(initialCardJson, /"callback_data":"tmux-screen:stop:session-1"/);
      assert.equal(initialButton?.behaviors?.[0]?.type, 'callback');
      assert.equal(initialButton?.behaviors?.[0]?.value?.callback_data, 'tmux-screen:stop:session-1');

      adapter.onStreamActions('chat-1', [[{
        text: '已停止',
        callbackData: 'tmux-screen:stop:session-1',
        type: 'default',
        disabled: true,
      }]], 'stream-1');

      const finalized = await adapter.onStreamEnd('chat-1', 'interrupted', '已停止 tmux 屏幕定时刷新。', 'stream-1');
      const finalCardJson = String(cardUpdateCalls.at(-1)?.data?.card?.data || '');
      const finalCard = JSON.parse(finalCardJson);
      const finalButton = findCardElement(finalCard, (element) => element.tag === 'button' && element.text?.content === '已停止');

      assert.equal(finalized, true);
      assert.match(finalCardJson, /"content":"已停止"/);
      assert.match(finalCardJson, /"callback_data":"tmux-screen:stop:session-1"/);
      assert.match(finalCardJson, /"disabled":true/);
      assert.equal(finalButton?.behaviors?.[0]?.type, 'callback');
      assert.equal(finalButton?.behaviors?.[0]?.value?.callback_data, 'tmux-screen:stop:session-1');
      assert.ok(logs.some((entry) => entry[0] === '[feishu-adapter] Streaming card actions updated:'));
      assert.ok(logs.some((entry) => entry[0] === '[feishu-adapter] Creating streaming card with actions:'));
      assert.ok(logs.some((entry) => entry[0] === '[feishu-adapter] Streaming card full refresh included actions:'));
    } finally {
      console.log = oldLog;
    }
  });

  it('applies stream actions that arrive while the thinking card is being created', async () => {
    const cardCreateCalls: Array<Record<string, any>> = [];
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const createBlocked = createDeferred<{ data: { card_id: string } }>();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async (payload: Record<string, any>) => {
              cardCreateCalls.push(payload);
              return createBlocked.promise;
            },
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    const createPromise = (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    await Promise.resolve();
    adapter.onStreamActions('chat-1', [[{
      text: '停止',
      callbackData: 'clk-command:session-1:%2Fstop',
      type: 'danger',
    }]], 'stream-1');
    createBlocked.resolve({ data: { card_id: 'card-1' } });

    assert.equal(await createPromise, true);
    const initialCardJson = String(cardCreateCalls[0]?.data?.data || '');
    assert.doesNotMatch(initialCardJson, /"content":"停止"/);

    const state = (adapter as any).activeCards.get('stream-1');
    assert.ok(state?.flushInFlight);
    await state.flushInFlight;

    const refreshCardJson = String(cardUpdateCalls.at(-1)?.data?.card?.data || '');
    assert.match(refreshCardJson, /"content":"停止"/);
    assert.match(refreshCardJson, /"callback_data":"clk-command:session-1:%2Fstop"/);
  });

  it('applies early stream state that arrives while the thinking card is being created or sent', async () => {
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const createBlocked = createDeferred<{ data: { card_id: string } }>();
    const sendBlocked = createDeferred<{ data: { message_id: string } }>();
    let sendStarted = false;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFlushBaseIntervalMs = 1;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => createBlocked.promise,
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
            create: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => {
            sendStarted = true;
            return sendBlocked.promise;
          },
          reply: async () => {
            sendStarted = true;
            return sendBlocked.promise;
          },
        },
      },
    };

    const createPromise = (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    await Promise.resolve();
    adapter.onStreamStatus('chat-1', '正在读取项目结构', 'stream-1');
    adapter.onTaskEvent('chat-1', [
      { text: '读取代码', status: 'in_progress' },
    ], 'stream-1');
    createBlocked.resolve({ data: { card_id: 'card-1' } });
    await waitForCondition(() => sendStarted);
    adapter.onStreamText('chat-1', '我会先检查相关代码。', 'stream-1');
    adapter.onToolEvent('chat-1', [
      { id: 'tool-1', name: 'exec_command', status: 'running', input: 'pwd' },
    ], 'stream-1');
    adapter.onStreamHistory('chat-1', [
      { type: 'markdown', role: 'user', content: '先读一下代码' },
      { type: 'tool_panel', tools: [{ id: 'tool-1', name: 'exec_command', status: 'running', input: 'pwd' }] },
    ], 'stream-1');
    sendBlocked.resolve({ data: { message_id: 'msg-1' } });

    assert.equal(await createPromise, true);
    const state = (adapter as any).activeCards.get('stream-1');
    assert.ok(state?.flushInFlight);
    await state.flushInFlight;

    const refreshCardJson = String(cardUpdateCalls[0]?.data?.card?.data || '');
    assert.match(refreshCardJson, /先读一下代码/);
    assert.match(refreshCardJson, /正在读取项目结构/);
    assert.match(refreshCardJson, /读取代码/);
    assert.match(refreshCardJson, /运行 `pwd`/);
    assert.match(refreshCardJson, /stream_tool_1/);
    assert.equal(state.pendingText, '我会先检查相关代码。');
  });

  it('renders final cards without waiting tasks or running tools after completion', async () => {
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onTaskEvent('chat-1', [
      { text: '读取日志', status: 'completed' },
      { text: '补测试', status: 'pending' },
    ], 'stream-1');
    adapter.onToolEvent('chat-1', [
      { id: 'tool-1', name: 'shell_command', status: 'running' },
    ], 'stream-1');

    const finalized = await adapter.onStreamEnd('chat-1', 'completed', '最终回复', 'stream-1');
    const finalCardJson = String(cardUpdateCalls.at(-1)?.data?.card?.data || '');

    assert.equal(finalized, true);
    assert.doesNotMatch(finalCardJson, /等待中|运行中/);
    assert.match(finalCardJson, /补测试（已结束）/);
    assert.match(finalCardJson, /🔧 调用 `shell_command`/);
    assert.doesNotMatch(finalCardJson, /`shell_command` · 完成|Success|Completed/);
  });

  it('backs off lazy card creation after a timeout and coalesces retry attempts', async () => {
    const blocked = createDeferred<Record<string, any>>();
    let createCallCount = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardRequestTimeoutMs = 5;
    (adapter as any).cardFlushBaseIntervalMs = 2;
    (adapter as any).cardFlushFirstFailureIntervalMs = 20;
    (adapter as any).cardFlushMaxFailureIntervalMs = 40;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => {
              createCallCount += 1;
              if (createCallCount === 1) {
                return blocked.promise;
              }
              return { data: { card_id: `card-${createCallCount}` } };
            },
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    const first = await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    assert.equal(first, false);
    assert.equal((adapter as any).cardCreatePromises.size, 0);
    assert.equal(createCallCount, 1);

    const secondPromise = (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const thirdPromise = (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    assert.strictEqual(secondPromise, thirdPromise);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(createCallCount, 1);

    const second = await secondPromise;
    assert.equal(second, true);
    assert.equal(createCallCount, 2);
    assert.equal((adapter as any).activeCards.has('stream-1'), true);
    assert.equal((adapter as any).cardCreateConsecutiveFailures.size, 0);

    blocked.resolve({});
  });

  it('sends the first updatable rich command card as a reply', async () => {
    const cardCreateCalls: Array<Record<string, any>> = [];
    const messageCreateCalls: Array<Record<string, any>> = [];
    const messageReplyCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async (payload: Record<string, any>) => {
              cardCreateCalls.push(payload);
              return { data: { card_id: 'card-rich-1' } };
            },
            update: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async (payload: Record<string, any>) => {
            messageCreateCalls.push(payload);
            return { data: { message_id: 'msg-rich-create' } };
          },
          reply: async (payload: Record<string, any>) => {
            messageReplyCalls.push(payload);
            return { data: { message_id: 'msg-rich-reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '最近本地 Codex 会话',
      parseMode: 'Markdown',
      replyToMessageId: 'incoming-1',
      richCard: {
        title: '最近 1 条本地 Codex 会话',
        sections: [],
        updateKey: 'thread-card:global:feishu:chat-1',
        updateTtlMs: null,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(cardCreateCalls.length, 1);
    assert.equal(messageCreateCalls.length, 0);
    assert.equal(messageReplyCalls.length, 1);
    assert.deepEqual(messageReplyCalls[0]?.path, { message_id: 'incoming-1' });
    assert.equal(messageReplyCalls[0]?.data?.msg_type, 'interactive');
  });

  it('recovers an updatable rich command card by callback message id before updating it', async () => {
    const idConvertCalls: Array<Record<string, any>> = [];
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const messageCreateCalls: Array<Record<string, any>> = [];
    const messageReplyCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            idConvert: async (payload: Record<string, any>) => {
              idConvertCalls.push(payload);
              return { data: { card_id: 'card-recovered' } };
            },
            create: async () => {
              throw new Error('should not create a new card');
            },
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async (payload: Record<string, any>) => {
            messageCreateCalls.push(payload);
            return { data: { message_id: 'msg-create' } };
          },
          reply: async (payload: Record<string, any>) => {
            messageReplyCalls.push(payload);
            return { data: { message_id: 'msg-reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '当前线程已切换',
      parseMode: 'Markdown',
      replyToMessageId: 'card-message-1',
      richCardUpdateMessageId: 'card-message-1',
      richCard: {
        title: '当前聊天绑定（1）',
        sections: [],
        updateKey: 'thread-card:bound:feishu:chat-1',
        updateTtlMs: null,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'card-message-1');
    assert.deepEqual(idConvertCalls[0]?.data, { message_id: 'card-message-1' });
    assert.equal(cardUpdateCalls.length, 1);
    assert.deepEqual(cardUpdateCalls[0]?.path, { card_id: 'card-recovered' });
    assert.equal(Number.isInteger(cardUpdateCalls[0]?.data?.sequence), true);
    assert.equal(cardUpdateCalls[0]?.data?.sequence > 0, true);
    assert.equal(cardUpdateCalls[0]?.data?.sequence <= 2_147_483_647, true);
    assert.equal(messageCreateCalls.length, 0);
    assert.equal(messageReplyCalls.length, 0);
  });

  it('keeps /t rich card update state eligible when local TTL is disabled', async () => {
    const idConvertCalls: Array<Record<string, any>> = [];
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).richCardUpdates.set('thread-card:bound:feishu:chat-1', {
      cardId: 'card-old',
      messageId: 'card-message-1',
      lastInteractionAt: Date.now() - 24 * 60 * 60_000,
      sequence: 3,
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            idConvert: async (payload: Record<string, any>) => {
              idConvertCalls.push(payload);
              return { data: { card_id: 'card-recovered' } };
            },
            create: async () => {
              throw new Error('should not create a new card');
            },
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-create' } }),
          reply: async () => ({ data: { message_id: 'msg-reply' } }),
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '当前线程已切换',
      parseMode: 'Markdown',
      replyToMessageId: 'card-message-1',
      richCardUpdateMessageId: 'card-message-1',
      richCard: {
        title: '当前聊天绑定（1）',
        sections: [],
        updateKey: 'thread-card:bound:feishu:chat-1',
        updateTtlMs: null,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'card-message-1');
    assert.equal(idConvertCalls.length, 0);
    assert.equal(cardUpdateCalls.length, 1);
    assert.deepEqual(cardUpdateCalls[0]?.path, { card_id: 'card-old' });
  });

  it('creates a replacement /t rich card when callback card recovery fails', async () => {
    const cardCreateCalls: Array<Record<string, any>> = [];
    const messageCreateCalls: Array<Record<string, any>> = [];
    const messageReplyCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            idConvert: async () => ({ data: {} }),
            create: async (payload: Record<string, any>) => {
              cardCreateCalls.push(payload);
              return { data: { card_id: 'new-card' } };
            },
            update: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async (payload: Record<string, any>) => {
            messageCreateCalls.push(payload);
            return { data: { message_id: 'msg-create' } };
          },
          reply: async (payload: Record<string, any>) => {
            messageReplyCalls.push(payload);
            return { data: { message_id: 'msg-reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '当前线程已切换',
      parseMode: 'Markdown',
      replyToMessageId: 'card-message-1',
      richCardUpdateMessageId: 'card-message-1',
      richCard: {
        title: '当前聊天绑定（1）',
        sections: [],
        updateKey: 'thread-card:bound:feishu:chat-1',
        updateTtlMs: null,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'msg-reply');
    assert.equal(cardCreateCalls.length, 1);
    assert.equal(messageCreateCalls.length, 0);
    assert.equal(messageReplyCalls.length, 1);
    assert.equal(messageReplyCalls[0]?.data?.msg_type, 'interactive');
    assert.deepEqual(messageReplyCalls[0]?.path, { message_id: 'card-message-1' });
  });

  it('sends form submit buttons inside a CardKit form container', async () => {
    const messageReplyCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).restClient = {
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-create' } }),
          reply: async (payload: Record<string, any>) => {
            messageReplyCalls.push(payload);
            return { data: { message_id: 'msg-reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '创建群聊会话',
      parseMode: 'Markdown',
      replyToMessageId: 'card-message-1',
      richCard: {
        title: '创建群聊会话',
        sections: [],
        form: {
          optionElementId: 'clk_new_session_option',
          inputElementId: 'clk_input',
          inputLabel: '群聊名称',
          inputPlaceholder: '例如 merge',
          extraInputs: [{
            elementId: 'clk_path',
            label: '工作目录',
            placeholder: '项目目录',
            defaultValue: '/repo/current',
          }],
          submitText: '创建',
          submitCallbackData: 'clk-command::%2Fnew',
          options: [],
        },
      },
    });

    assert.equal(result.ok, true);
    const content = JSON.parse(messageReplyCalls[0]?.data?.content || '{}');
    const form = content.body.elements.find((element: any) => element.tag === 'form');
    const submitButton = form.elements.find((element: any) => element.tag === 'button' && element.form_action_type === 'submit');
    assert.equal(form.name, 'clk_form');
    assert.equal(form.elements.some((element: any) => element.tag === 'input' && element.name === 'clk_input'), true);
    assert.equal(form.elements.find((element: any) => element.tag === 'input' && element.name === 'clk_path')?.default_value, '/repo/current');
    assert.equal(submitButton.value.callback_data, 'clk-command::%2Fnew');
  });

  it('renders rich card form fields as direct form elements when layout is requested', async () => {
    const messageReplyCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });
    (adapter as any).restClient = {
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-create' } }),
          reply: async (payload: Record<string, any>) => {
            messageReplyCalls.push(payload);
            return { data: { message_id: 'msg-reply' } };
          },
        },
      },
    };

    await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '当前会话',
      parseMode: 'Markdown',
      replyToMessageId: 'card-message-1',
      richCard: {
        title: 'Codex Card title',
        template: 'green',
        tags: ['codex', 'thread-1'],
        sections: [],
        form: {
          optionElementId: 'clk_current_option',
          inputElementId: 'clk_name',
          inputLabel: 'name',
          inputPlaceholder: 'rename',
          layout: 'two_column',
          selects: [{
            elementId: 'clk_runtime',
            label: 'runtime',
            selectedCallbackData: 'codex',
            options: [{ text: 'codex', callbackData: 'codex' }],
          }],
          extraInputs: [{
            elementId: 'clk_cwd',
            label: 'cwd',
            placeholder: 'cwd',
            defaultValue: '/repo/current',
          }],
          submitText: '保存配置',
          submitCallbackData: 'clk-command::%2Fcurrent-config',
          options: [],
        },
      },
    });

    const content = JSON.parse(messageReplyCalls[0]?.data?.content || '{}');
    assert.equal(content.header.template, 'green');
    assert.equal(content.header.text_tag_list[0].text.content, 'codex');
    const form = content.body.elements.find((element: any) => element.tag === 'form');
    assert.equal(form.elements.some((element: any) => element.tag === 'select_static' && element.name === 'clk_runtime'), true);
    assert.equal(form.elements.some((element: any) => element.tag === 'input' && element.name === 'clk_name'), true);
    assert.equal(form.elements.some((element: any) => element.tag === 'input' && element.name === 'clk_cwd'), true);
    const submitButton = form.elements.find((element: any) => element.tag === 'button' && element.form_action_type === 'submit');
    assert.equal(submitButton.value.callback_data, 'clk-command::%2Fcurrent-config');
  });

  it('does not fall back to post or plain text when a markdown interactive card fails', async () => {
    const messageCreateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });

    (adapter as any).restClient = {
      im: {
        message: {
          create: async (payload: Record<string, any>) => {
            messageCreateCalls.push(payload);
            if (payload.data?.msg_type === 'interactive') {
              throw new Error('timeout after 60000ms');
            }
            return { data: { message_id: 'unexpected-fallback' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '```text\nhello\n```',
      parseMode: 'Markdown',
    });

    assert.equal(result.ok, false);
    assert.match(result.error || '', /timeout after 60000ms/);
    assert.equal(messageCreateCalls.length, 1);
    assert.equal(messageCreateCalls[0]?.data?.msg_type, 'interactive');
  });

  it('does not fall back to plain text when a rich command card fails', async () => {
    const messageReplyCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });

    (adapter as any).restClient = {
      im: {
        message: {
          reply: async (payload: Record<string, any>) => {
            messageReplyCalls.push(payload);
            throw new Error('invalid card json');
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '本地会话纯文本兜底不应发送',
      parseMode: 'Markdown',
      replyToMessageId: 'incoming-1',
      richCard: {
        title: '本地会话',
        sections: [],
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error || '', /invalid card json/);
    assert.equal(messageReplyCalls.length, 1);
    assert.equal(messageReplyCalls[0]?.data?.msg_type, 'interactive');
  });

  it('returns an error instead of hanging forever when plain text sending times out', async () => {
    const blocked = createDeferred<Record<string, any>>();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardRequestTimeoutMs = 5;
    (adapter as any).restClient = {
      im: {
        message: {
          create: async () => blocked.promise,
        },
      },
    };

    const result = await (adapter as any).sendAsPlainText('chat-1', 'hello');
    assert.equal(result.ok, false);
    assert.match(result.error || '', /timeout/i);

    blocked.resolve({});
  });

  it('extracts the original Feishu resource filename from message content', () => {
    const info = _testOnly.extractFeishuResourceInfo(JSON.stringify({
      file_key: 'file_v3_abc',
      file_name: '需求说明 2026.pdf',
    }));

    assert.deepEqual(info, {
      fileKey: 'file_v3_abc',
      name: '需求说明 2026.pdf',
    });
  });

  it('preserves the original filename for downloaded Feishu file messages', async () => {
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });

    (adapter as any).restClient = {
      im: {
        messageResource: {
          get: async () => ({
            getReadableStream: async function* () {
              yield Buffer.from('hello');
            },
          }),
        },
      },
    };

    const attachment = await (adapter as any).downloadResource(
      'message-1',
      'file_v3_abc',
      'file',
      '需求说明 2026.pdf',
    );

    assert.ok(attachment);
    assert.equal(attachment.name, '需求说明 2026.pdf');
    assert.equal(attachment.type, 'application/octet-stream');
    assert.equal(attachment.data, Buffer.from('hello').toString('base64'));
  });

  it('sends small local files as direct Feishu file messages', async () => {
    largeFileUploadTestOnly.clear();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-small-file-'));
    const filePath = path.join(tempDir, 'small.txt');
    fs.writeFileSync(filePath, 'hello', 'utf-8');
    const sentMessages: any[] = [];
    let uploadedFile: any = null;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });

    (adapter as any).restClient = {
      im: {
        file: {
          create: async (payload: any) => {
            uploadedFile = payload.data;
            uploadedFile.file.destroy();
            return { file_key: 'file-key-small' };
          },
        },
        message: {
          create: async (payload: any) => {
            sentMessages.push(payload.data);
            return { data: { message_id: 'msg-small-file' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      attachments: [{ kind: 'file', path: filePath, name: 'small.txt' }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'msg-small-file');
    assert.equal(uploadedFile.file_type, 'stream');
    assert.equal(uploadedFile.file_name, 'small.txt');
    assert.ok(uploadedFile.file instanceof fs.ReadStream);
    assert.deepEqual(sentMessages, [{
      receive_id: 'chat-1',
      msg_type: 'file',
      content: JSON.stringify({ file_key: 'file-key-small' }),
    }]);
    assert.equal(largeFileUploadTestOnly.pendingCount(), 0);
  });

  it('routes large local files to a confirmation card instead of direct IM upload', async () => {
    largeFileUploadTestOnly.clear();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-large-file-'));
    const filePath = path.join(tempDir, 'large.bin');
    fs.closeSync(fs.openSync(filePath, 'w'));
    fs.truncateSync(filePath, LARGE_FILE_UPLOAD_THRESHOLD_BYTES + 1);
    const sentMessages: any[] = [];
    let fileUploadCalled = false;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });

    (adapter as any).restClient = {
      im: {
        file: {
          create: async () => {
            fileUploadCalled = true;
            throw new Error('large file should not use IM file upload');
          },
        },
        message: {
          create: async (payload: any) => {
            sentMessages.push(payload.data);
            return { data: { message_id: 'msg-large-card' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1', chatKind: 'group' },
      text: '',
      attachments: [{ kind: 'file', path: filePath, name: 'large.bin' }],
    });

    assert.equal(result.ok, true);
    assert.equal(fileUploadCalled, false);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].receive_id, 'chat-1');
    assert.equal(sentMessages[0].msg_type, 'interactive');
    const cardJson = JSON.stringify(JSON.parse(sentMessages[0].content));
    assert.match(cardJson, /确认上传大文件/);
    assert.match(cardJson, /上传并发链接/);
    assert.match(cardJson, /%2Ffile%20--confirm-large%20/);
    assert.match(cardJson, /%2Ffile%20--cancel-large%20/);
    assert.equal(largeFileUploadTestOnly.pendingCount(), 1);
    largeFileUploadTestOnly.clear();
  });

  it('starts confirmed large file uploads in the background and sends the Drive link', async () => {
    largeFileUploadTestOnly.clear();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-large-confirm-'));
    const filePath = path.join(tempDir, 'confirmed.bin');
    fs.closeSync(fs.openSync(filePath, 'w'));
    fs.truncateSync(filePath, LARGE_FILE_UPLOAD_THRESHOLD_BYTES + 1);
    const prepareStarted = createDeferred<void>();
    const allowPrepare = createDeferred<void>();
    const uploadedParts: Array<{ seq: number; size: number }> = [];
    const sentMessages: any[] = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });

    (adapter as any).restClient = {
      drive: {
        v1: {
          file: {
            uploadPrepare: async () => {
              prepareStarted.resolve();
              await allowPrepare.promise;
              return {
                code: 0,
                data: {
                  upload_id: 'upload-1',
                  block_size: 10 * 1024 * 1024,
                  block_num: 3,
                },
              };
            },
            uploadPart: async (payload: any) => {
              uploadedParts.push({
                seq: payload.data.seq,
                size: payload.data.size,
              });
              payload.data.file.destroy();
              return {};
            },
            uploadFinish: async () => ({
              code: 0,
              data: { file_token: 'drive-file-token' },
            }),
          },
          meta: {
            batchQuery: async () => ({
              code: 0,
              data: {
                metas: [{
                  doc_token: 'drive-file-token',
                  doc_type: 'file',
                  title: 'confirmed.bin',
                  owner_id: 'owner',
                  create_time: '0',
                  latest_modify_user: 'owner',
                  latest_modify_time: '0',
                  url: 'https://example.feishu.cn/file/drive-file-token',
                }],
              },
            }),
          },
          permissionPublic: {
            patch: async () => ({ code: 0, data: {} }),
          },
          permissionMember: {
            create: async () => ({ code: 0, data: {} }),
          },
        },
      },
      im: {
        message: {
          create: async (payload: any) => {
            sentMessages.push(payload.data);
            return { data: { message_id: `msg-${sentMessages.length}` } };
          },
        },
      },
    };

    const result = adapter.startLargeFileUpload(
      { channelType: 'feishu', chatId: 'chat-1', chatKind: 'group' },
      { kind: 'file', path: filePath, name: 'confirmed.bin' },
    );

    assert.equal(result.ok, true);
    await prepareStarted.promise;
    assert.equal(sentMessages.length, 0);
    allowPrepare.resolve();
    await waitForCondition(() => sentMessages.length === 1);

    assert.deepEqual(uploadedParts, [
      { seq: 0, size: 10 * 1024 * 1024 },
      { seq: 1, size: 10 * 1024 * 1024 },
      { seq: 2, size: 1 },
    ]);
    assert.equal(sentMessages[0].msg_type, 'post');
    assert.match(sentMessages[0].content, /https:\/\/example\.feishu\.cn\/file\/drive-file-token/);
  });
});
