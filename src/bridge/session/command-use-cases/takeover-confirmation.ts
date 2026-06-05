import type { ChannelChat, OutboundRichCard } from '../../../domain/index.js';
import { buildCommandCallbackData } from '../../command/callbacks.js';
import { formatCommandPath } from '../../command/presentation.js';
import { formatBindingChatLabel } from '../display/channel-label.js';
import type { CommandThreadDisplay } from '../../command/thread-display.js';

export function buildTakeoverConfirmationCard(params: {
  commandText: string;
  conflict: ChannelChat;
  threadDisplay: CommandThreadDisplay;
}): OutboundRichCard {
  const display = params.threadDisplay.binding(params.conflict);
  return {
    title: '确认接管会话',
    sections: [
      {
        fields: [
          ['当前绑定', formatBindingChatLabel(params.conflict)],
          ['会话', display.title],
          ['目录', formatCommandPath(display.cwd)],
          ['thread_id', display.threadId || '-'],
        ],
      },
      {
        text: '确认后会先解绑上面的聊天，再把这个会话绑定到当前聊天。正在运行的会话不能被接管。',
      },
    ],
    actions: [[
      {
        text: '确认接管',
        type: 'danger',
        callbackData: buildCommandCallbackData(params.commandText),
      },
      {
        text: '取消',
        callbackData: buildCommandCallbackData('/t takeover-cancel'),
      },
    ]],
    template: 'orange',
  };
}
