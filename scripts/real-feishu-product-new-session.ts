#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { FeishuAdapter } from '../src/channels/feishu/adapter.js';
import type { AdapterRuntimeInstance } from '../src/channels/contracts.js';
import { feishuSiteToApiBaseUrl } from '../src/channels/feishu/site.js';
import { createConfigService } from '../src/configuration/service.js';
import { initBridgeContext } from '../src/bridge/host/context.js';
import { handleNewSessionCommand } from '../src/bridge/session/command-use-cases/new-session.js';
import { CommandThreadDisplay } from '../src/bridge/command/thread-display.js';
import { JsonFileStore } from '../src/storage/json-store.js';
import { exportRuntimeSettings } from '../src/runtime/config-projections.js';

function valueArg(args: string[], name: string, fallback = ''): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1] || fallback;
}

function requireArg(args: string[], name: string): string {
  const value = valueArg(args, name).trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function fetchBotIdentity(options: {
  appId: string;
  appSecret: string;
  site: 'feishu' | 'lark';
}): Promise<{ botId: string; openId: string; name: string }> {
  const baseUrl = feishuSiteToApiBaseUrl(options.site);
  const tokenResponse = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: options.appId,
      app_secret: options.appSecret,
    }),
  });
  const tokenData = await tokenResponse.json() as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
  };
  if (!tokenResponse.ok || tokenData.code !== 0 || !tokenData.tenant_access_token) {
    throw new Error(tokenData.msg || `tenant_access_token failed: HTTP ${tokenResponse.status}`);
  }

  const botResponse = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
  });
  const botData = await botResponse.json() as {
    code?: number;
    msg?: string;
    bot?: {
      bot_id?: string;
      open_id?: string;
      app_name?: string;
      name?: string;
    };
  };
  if (!botResponse.ok || botData.code !== 0) {
    throw new Error(botData.msg || `bot info failed: HTTP ${botResponse.status}`);
  }
  return {
    botId: botData.bot?.bot_id || '',
    openId: botData.bot?.open_id || '',
    name: botData.bot?.app_name || botData.bot?.name || 'bot',
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const channelType = requireArg(argv, '--channel-type');
  const channelAlias = valueArg(argv, '--channel-alias', 'Real Feishu E2E');
  const userOpenId = requireArg(argv, '--user-open-id');
  const groupName = requireArg(argv, '--group-name');
  const workDir = requireArg(argv, '--workdir');
  const runId = requireArg(argv, '--run-id');
  const outputPath = requireArg(argv, '--output');

  const configService = createConfigService({ migrate: false });
  const config = configService.snapshot().config;
  const channel = config.channels.find((item) => item.id === channelType);
  if (!channel || channel.provider !== 'feishu') {
    throw new Error(`No enabled Feishu channel config found for ${channelType}.`);
  }
  const channelConfig = channel.config as {
    appId?: string;
    appSecret?: string;
    site?: 'feishu' | 'lark';
  };
  const appId = channelConfig.appId?.trim() || '';
  const appSecret = channelConfig.appSecret?.trim() || '';
  const site = channelConfig.site === 'lark' ? 'lark' : 'feishu';
  if (!appId || !appSecret) throw new Error('Feishu app id/secret are required in isolated CODELARK_HOME config.');

  const store = new JsonFileStore(exportRuntimeSettings(config), { dynamicSettings: true });
  initBridgeContext({
    store,
    llm: {
      streamChat() {
        throw new Error('real-feishu product new-session helper does not run model turns.');
      },
    },
    permissions: {
      resolvePendingPermission() {
        return false;
      },
    },
    lifecycle: {},
  });

  const adapter = new FeishuAdapter({
    id: channelType,
    alias: channelAlias,
    enabled: true,
    provider: 'feishu',
    config: channel.config,
  } satisfies AdapterRuntimeInstance);
  const botIdentity = await fetchBotIdentity({ appId, appSecret, site });
  const mutableAdapter = adapter as unknown as {
    botId: string | null;
    botOpenId: string | null;
    botName: string | null;
    botIds: Set<string>;
  };
  mutableAdapter.botId = botIdentity.botId;
  mutableAdapter.botOpenId = botIdentity.openId || null;
  mutableAdapter.botName = botIdentity.name;
  if (botIdentity.botId) mutableAdapter.botIds.add(botIdentity.botId);
  if (botIdentity.openId) mutableAdapter.botIds.add(botIdentity.openId);

  const args = `${groupName} ${workDir}`;
  const result = await handleNewSessionCommand({
    adapter,
    msg: {
      messageId: `om_real_feishu_e2e_new_${runId}`,
      address: {
        channelType,
        channelProvider: 'feishu',
        channelAlias,
        chatId: `real-feishu-e2e-new:${runId}`,
        chatKind: 'p2p',
        userId: userOpenId,
        displayName: 'Real Feishu E2E',
      },
      text: `/new ${args}`,
      timestamp: Date.now(),
    },
    args,
    commandBinding: null,
    store,
    deps: {
      getActiveTask: () => undefined,
    },
    threadDisplay: new CommandThreadDisplay(store),
    markdown: true,
  });

  const responseAddress = result.responseAddress || result.postDeliveryCurrentAddress;
  const chatId = responseAddress?.chatId || '';
  if (!chatId.startsWith('oc_')) {
    throw new Error(`new-session use case did not return a Feishu group chat id. response=${result.response}`);
  }
  const binding = store.getChannelChat(channelType, chatId);
  const session = binding ? store.getSession(binding.bridgeSessionId) : null;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    chatId,
    groupName: responseAddress?.displayName || groupName,
    requestedGroupName: groupName,
    response: result.response,
    responseMessageId: null,
    bindingId: binding?.id || null,
    sessionId: binding?.bridgeSessionId || null,
    workingDirectory: session?.working_directory || workDir,
    botId: botIdentity.botId,
    botOpenId: botIdentity.openId || null,
    deliveryCompleted: false,
  }, null, 2) + '\n', 'utf-8');

  fs.writeFileSync(outputPath, JSON.stringify({
    chatId,
    groupName: responseAddress?.displayName || groupName,
    requestedGroupName: groupName,
    response: result.response,
    responseMessageId: null,
    bindingId: binding?.id || null,
    sessionId: binding?.bridgeSessionId || null,
    workingDirectory: session?.working_directory || workDir,
    botId: botIdentity.botId,
    botOpenId: botIdentity.openId || null,
    deliveryCompleted: false,
    deliverySkipped: 'helper creates the group through the product /new use case but leaves message delivery to the isolated bridge run',
  }, null, 2) + '\n', 'utf-8');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
