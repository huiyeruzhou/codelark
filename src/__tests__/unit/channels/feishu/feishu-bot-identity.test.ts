import '../../../setup/test-setup.js';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFeishuBotChatAppLink,
  fetchFeishuBotIdentity,
} from '../../../../channels/feishu/bot-identity.js';

test('fetches bot identity with tenant credentials without exposing the secret in the URL', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'tenant-token' });
    }
    return Response.json({
      code: 0,
      bot: {
        open_id: 'ou_bot_demo',
        bot_id: 'cli_bot_demo',
        app_name: 'CodeLark Demo',
      },
    });
  };

  const identity = await fetchFeishuBotIdentity({
    appId: 'cli_demo',
    appSecret: 'secret_demo',
    site: 'feishu',
  }, { fetchImpl });

  assert.deepEqual(identity, {
    openId: 'ou_bot_demo',
    botId: 'cli_bot_demo',
    name: 'CodeLark Demo',
  });
  assert.equal(requests[0]?.url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
  assert.equal(requests[1]?.url, 'https://open.feishu.cn/open-apis/bot/v3/info/');
  assert.equal(requests[1]?.init?.headers && (requests[1].init.headers as Record<string, string>).Authorization, 'Bearer tenant-token');
  assert.ok(!requests.some((request) => request.url.includes('secret_demo')));
});

test('builds site-specific bot private-chat AppLinks', () => {
  assert.equal(
    buildFeishuBotChatAppLink('feishu', 'ou_bot_demo'),
    'https://applink.feishu.cn/client/chat/open?openId=ou_bot_demo',
  );
  assert.equal(
    buildFeishuBotChatAppLink('lark', 'ou bot/demo'),
    'https://applink.larksuite.com/client/chat/open?openId=ou+bot%2Fdemo',
  );
});
