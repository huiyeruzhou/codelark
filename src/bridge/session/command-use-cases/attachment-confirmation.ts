import type { ChannelChat, OutboundRichCard } from '../../../domain/index.js';
import { buildCommandCallbackData } from '../../command/callbacks.js';
import type { CommandThreadDisplay } from '../../command/thread-display.js';

export function buildAttachmentStopConfirmationCard(options: {
  confirmedCommand: string;
  currentBinding: ChannelChat;
  threadDisplay: CommandThreadDisplay;
}): OutboundRichCard {
  return {
    title: '确认停止并切换会话',
    sections: [{
      text: `当前会话「${options.threadDisplay.binding(options.currentBinding).title}」仍在运行。确认后会先停止并等待当前任务结束，再切换到所选会话。`,
    }],
    actions: [[
      {
        text: '停止并切换',
        type: 'danger',
        callbackData: buildCommandCallbackData(options.confirmedCommand),
      },
      {
        text: '取消',
        callbackData: buildCommandCallbackData('/t takeover-cancel'),
      },
    ]],
    template: 'orange',
  };
}
