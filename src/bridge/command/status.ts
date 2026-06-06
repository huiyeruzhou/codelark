import { createConfigService } from '../../configuration/service.js';
import { getBridgeStatus, getCurrentUiServerUrl, getUiServerStatus } from '../../local-service/manager.js';
import {
  buildCommandFields,
  formatCommandDateTime,
} from './presentation.js';
import type { BridgeStore } from '../../domain/index.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';
import type { ChannelChat } from '../../domain/index.js';

function formatGlobalRunning(running: boolean): string {
  return running ? 'running' : 'stopped';
}

function formatPid(pid: number | undefined): string {
  return Number.isFinite(pid) && (pid as number) > 0 ? String(pid) : '-';
}

export function buildGlobalStatusResponse(
  store: BridgeStore,
  currentBinding: ChannelChat | null,
  markdown: boolean,
): string {
  const channels = createConfigService({ migrate: false }).snapshot().config.channels;
  const bridgeStatus = getBridgeStatus();
  const uiStatus = getUiServerStatus();
  const bindings = store.listChannelChats();
  const activeBindings = bindings;
  const sessions = store.listSessions();
  const runningSessions = sessions.filter((session) => session.runtime_status === 'running' || session.runtime_status === 'queued');
  const adapters = bridgeStatus.adapters || [];
  const enabledChannels = channels.filter((channel) => channel.enabled !== false);
  const uiUrl = getCurrentUiServerUrl();
  const currentChatBindingCount = currentBinding
    ? bindings.filter((binding) => binding.channelType === currentBinding.channelType && binding.chatId === currentBinding.chatId).length
    : 0;

  const channelLines = channels.map((channel) => {
    const adapter = adapters.find((item) => item.channelType === channel.id);
    return [
      channel.id,
      `alias=${channel.alias || '-'}`,
      `provider=${channel.provider}`,
      `enabled=${channel.enabled !== false ? 'yes' : 'no'}`,
      `adapter=${adapter ? formatGlobalRunning(adapter.running) : 'missing'}`,
      adapter?.error ? `error=${adapter.error}` : '',
    ].filter(Boolean).join('  ');
  });
  const bindingLines = activeBindings.map((binding) => {
    const session = store.getSession(binding.bridgeSessionId);
    return [
      binding.channelType,
      binding.channelAlias ? `alias=${binding.channelAlias}` : '',
      `chat=${binding.chatId}`,
      `session=${binding.bridgeSessionId.slice(0, 8)}`,
      session?.runtime_status ? `runtime=${session.runtime_status}` : '',
    ].filter(Boolean).join('  ');
  });

  const main = buildCommandFields(
    '全局状态',
    [
      ['Bridge', formatGlobalRunning(bridgeStatus.running)],
      ['Bridge PID', formatPid(bridgeStatus.pid)],
      ['Bridge Run ID', bridgeStatus.runId || '-'],
      ['Bridge 启动时间', formatCommandDateTime(bridgeStatus.startedAt)],
      ['Bridge 上次退出', bridgeStatus.lastExitReason || '-'],
      ['UI Server', formatGlobalRunning(uiStatus.running)],
      ['UI PID', formatPid(uiStatus.pid)],
      ['UI 地址', uiUrl || '-'],
      ['通道', `${enabledChannels.length}/${channels.length} enabled`],
      ['Adapter', `${adapters.filter((adapter) => adapter.running).length}/${adapters.length} running`],
      ['聊天', `${activeBindings.length} bound`],
      ['会话', `${sessions.length} total, ${runningSessions.length} running/queued`],
      ['当前聊天', currentBinding ? `${currentBinding.channelType}:${currentBinding.chatId} -> ${currentBinding.bridgeSessionId.slice(0, 8)} (${currentChatBindingCount} chat record)` : '未绑定'],
    ],
    [
      '发送 `/` 查看当前聊天/当前会话诊断；发送 `/check` 查看当前会话健康检查。',
    ],
    markdown,
  );

  const sections: string[] = [main];
  if (channelLines.length > 0) {
    sections.push([
      markdown ? '**通道明细**' : '通道明细',
      '',
      markdown ? buildFencedCodeBlock(channelLines.join('\n'), 'text') : channelLines.join('\n'),
    ].join('\n').trim());
  }
  if (bindingLines.length > 0) {
    sections.push([
      markdown ? '**绑定明细**' : '绑定明细',
      '',
      markdown ? buildFencedCodeBlock(bindingLines.join('\n'), 'text') : bindingLines.join('\n'),
    ].join('\n').trim());
  }
  return sections.join('\n\n');
}
