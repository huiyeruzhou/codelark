import type { BaseChannelAdapter } from '../../channels/contracts.js';
import { enqueueBridgeNotice } from '../../channels/delivery/feedback.js';
import type { InboundMessage, OutboundRichCard } from '../../domain/index.js';
import {
  compareVersions,
  normalizeVersion,
  type DailyVersionChecker,
  type VersionUpdateNotice,
} from './version-check.js';
import {
  dispatchGlobalCodelarkUpdate,
  type GlobalUpdateDispatcher,
} from './global-update.js';

export const VERSION_UPDATE_CALLBACK_PREFIX = 'clk-version-update:';
export const MANUAL_VERSION_UPDATE_COMMAND = 'npm install -g --yes codelark && codelark stop && codelark start';

type VersionUpdateAction = 'update' | 'ignore';

export interface VersionUpdateCallback {
  action: VersionUpdateAction;
  version: string;
}

export interface DailyVersionUpdateRuntime {
  onFirstUserMessage(adapter: BaseChannelAdapter, msg: InboundMessage): void;
  handleCallback(adapter: BaseChannelAdapter, msg: InboundMessage): boolean;
}

export interface DailyVersionUpdateRuntimeDeps {
  checker: DailyVersionChecker;
  currentVersion: string | null;
  dispatchUpdate?: GlobalUpdateDispatcher;
}

export function buildVersionUpdateCallbackData(action: VersionUpdateAction, version: string): string {
  return `${VERSION_UPDATE_CALLBACK_PREFIX}${action}:${version}`;
}

function versionUpdateCardKey(chatId: string, version: string): string {
  return `version-update:${chatId}:${version}`;
}

export function parseVersionUpdateCallbackData(
  callbackData: string,
): VersionUpdateCallback | null | undefined {
  if (!callbackData.startsWith(VERSION_UPDATE_CALLBACK_PREFIX)) return undefined;
  const raw = callbackData.slice(VERSION_UPDATE_CALLBACK_PREFIX.length);
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;
  const action = raw.slice(0, separator);
  const version = normalizeVersion(raw.slice(separator + 1));
  if ((action !== 'update' && action !== 'ignore') || !version) return null;
  return { action, version };
}

export function buildVersionUpdateCard(
  notice: VersionUpdateNotice,
  chatId = 'global',
): OutboundRichCard {
  return {
    title: `CodeLark v${notice.latestVersion} 可用`,
    template: 'blue',
    updateKey: versionUpdateCardKey(chatId, notice.latestVersion),
    updateTtlMs: null,
    sections: [
      { fields: [['当前版本', `v${notice.currentVersion}`], ['最新版本', `v${notice.latestVersion}`]] },
      {
        text: '也可以复制命令手动更新：',
        code: { text: MANUAL_VERSION_UPDATE_COMMAND, language: 'bash' },
      },
    ],
    actions: [[
      {
        text: '立即更新并重启',
        type: 'primary',
        callbackData: buildVersionUpdateCallbackData('update', notice.latestVersion),
      },
      {
        text: '忽略此版本',
        callbackData: buildVersionUpdateCallbackData('ignore', notice.latestVersion),
      },
    ]],
    footer: ['每天检查一次 · 忽略后仅在发现更高版本时再次提示'],
  };
}

function buildIgnoredCard(chatId: string, version: string): OutboundRichCard {
  return {
    title: `已忽略 v${version}`,
    template: 'grey',
    updateKey: versionUpdateCardKey(chatId, version),
    updateTtlMs: null,
    sections: [{ text: '发现更高版本时会再次提示。' }],
  };
}

function buildDispatchingCard(chatId: string, version: string): OutboundRichCard {
  return {
    title: `正在准备更新到 v${version}`,
    template: 'blue',
    updateKey: versionUpdateCardKey(chatId, version),
    updateTtlMs: null,
    sections: [{ text: '更新会在后台安装，随后重启 CodeLark。' }],
  };
}

function buildUpdatingCard(chatId: string, version: string, logPath: string): OutboundRichCard {
  return {
    title: `正在更新到 v${version}`,
    template: 'blue',
    updateKey: versionUpdateCardKey(chatId, version),
    updateTtlMs: null,
    sections: [
      { text: '后台任务已启动，安装完成后会重启 CodeLark。' },
      { fields: [['日志', logPath]] },
      {
        text: '如果自动更新失败，可以手动执行：',
        code: { text: MANUAL_VERSION_UPDATE_COMMAND, language: 'bash' },
      },
    ],
  };
}

function buildAlreadyCurrentCard(chatId: string, version: string): OutboundRichCard {
  return {
    title: 'CodeLark 已是最新版本',
    template: 'green',
    updateKey: versionUpdateCardKey(chatId, version),
    updateTtlMs: null,
    sections: [{ text: `当前版本：v${version}` }],
  };
}

function buildUpdateErrorCard(chatId: string, version: string, detail: string): OutboundRichCard {
  return {
    title: '自动更新未能启动',
    template: 'red',
    updateKey: versionUpdateCardKey(chatId, version),
    updateTtlMs: null,
    sections: [
      { text: detail },
      {
        text: '可以手动执行：',
        code: { text: MANUAL_VERSION_UPDATE_COMMAND, language: 'bash' },
      },
    ],
  };
}

function updateOriginalCard(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
  richCard: OutboundRichCard,
): void {
  enqueueBridgeNotice(adapter, msg.address, text, {
    richCard,
    richCardUpdateMessageId: msg.callbackMessageId,
    audit: true,
  });
}

function answerCallback(adapter: BaseChannelAdapter, callbackId: string, text: string): void {
  void adapter.answerCallback?.(callbackId, text).catch((error) => {
    console.warn('[version-update] Failed to answer callback:', error instanceof Error ? error.message : String(error));
  });
}

export function createDailyVersionUpdateRuntime(
  deps: DailyVersionUpdateRuntimeDeps,
): DailyVersionUpdateRuntime {
  const dispatchUpdate = deps.dispatchUpdate || dispatchGlobalCodelarkUpdate;
  const currentVersion = normalizeVersion(deps.currentVersion);
  const updatesInFlight = new Set<string>();

  return {
    onFirstUserMessage(adapter, msg) {
      if (adapter.provider !== 'feishu' || !adapter.isRunning()) return;
      void deps.checker.checkOnFirstMessage().then((notice) => {
        if (!notice) return;
        enqueueBridgeNotice(adapter, msg.address, `CodeLark v${notice.latestVersion} 可用。`, {
          replyToMessageId: msg.messageId,
          richCard: buildVersionUpdateCard(notice, msg.address.chatId),
          audit: true,
        });
      }).catch((error) => {
        console.warn('[version-update] Daily version check failed:', error instanceof Error ? error.message : String(error));
      });
    },

    handleCallback(adapter, msg) {
      const callback = parseVersionUpdateCallbackData(msg.callbackData || '');
      if (callback === undefined) return false;
      if (!callback) {
        answerCallback(adapter, msg.messageId, '这个更新按钮已失效');
        return true;
      }

      const knownLatest = deps.checker.stateSnapshot().latestVersion;
      if (!knownLatest || callback.version !== knownLatest) {
        answerCallback(adapter, msg.messageId, '这个版本提示已过期');
        return true;
      }

      if (callback.action === 'ignore') {
        try {
          deps.checker.ignoreVersion(callback.version);
          answerCallback(adapter, msg.messageId, `已忽略 v${callback.version}`);
          updateOriginalCard(
            adapter,
            msg,
            `已忽略 CodeLark v${callback.version}。`,
            buildIgnoredCard(msg.address.chatId, callback.version),
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          answerCallback(adapter, msg.messageId, '保存忽略设置失败');
          updateOriginalCard(
            adapter,
            msg,
            `保存忽略设置失败：${detail}`,
            buildUpdateErrorCard(msg.address.chatId, callback.version, detail),
          );
        }
        return true;
      }

      if (currentVersion && compareVersions(currentVersion, callback.version) >= 0) {
        answerCallback(adapter, msg.messageId, '当前已经是最新版本');
        updateOriginalCard(
          adapter,
          msg,
          'CodeLark 已是最新版本。',
          buildAlreadyCurrentCard(msg.address.chatId, callback.version),
        );
        return true;
      }
      if (updatesInFlight.has(callback.version)) {
        answerCallback(adapter, msg.messageId, '更新已经在进行中');
        return true;
      }

      updatesInFlight.add(callback.version);
      answerCallback(adapter, msg.messageId, '已开始后台更新');
      updateOriginalCard(
        adapter,
        msg,
        `正在准备更新 CodeLark v${callback.version}。`,
        buildDispatchingCard(msg.address.chatId, callback.version),
      );
      void dispatchUpdate(callback.version).then((dispatched) => {
        updateOriginalCard(
          adapter,
          msg,
          `CodeLark v${callback.version} 更新已启动。`,
          buildUpdatingCard(msg.address.chatId, callback.version, dispatched.logPath),
        );
      }).catch((error) => {
        updatesInFlight.delete(callback.version);
        const detail = error instanceof Error ? error.message : String(error);
        updateOriginalCard(
          adapter,
          msg,
          `自动更新未能启动：${detail}`,
          buildUpdateErrorCard(msg.address.chatId, callback.version, detail),
        );
      });
      return true;
    },
  };
}
