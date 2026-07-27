import type { OutboundRichCard } from '../../../domain/index.js';
import { buildCommandCallbackData } from '../../command/callbacks.js';

export function buildClearConfirmationCard(commandText: string, scopeSessionId: string): OutboundRichCard {
  return {
    title: '确认清空当前对话',
    sections: [
      {
        text: '当前对话仍在运行。确认后会先终止当前任务，然后把当前聊天绑定到一个新的 BridgeSession。',
      },
    ],
    actions: [[
      {
        text: '终止并新建',
        type: 'danger',
        callbackData: buildCommandCallbackData(commandText, scopeSessionId),
      },
      {
        text: '取消',
        callbackData: buildCommandCallbackData('/clear-cancel', scopeSessionId),
      },
    ]],
    template: 'orange',
  };
}
