import type { OutboundRichCard } from '../../../domain/index.js';
import { buildCommandCallbackData } from '../../command/callbacks.js';

export function buildClearConfirmationCard(commandText: string, scopeSessionId: string): OutboundRichCard {
  return {
    title: '确认清空当前对话',
    sections: [
      {
        text: '当前对话可能还有未结束的任务。点击“终止并新建”后会结束旧任务并新建对话，保留当前配置，无需等待状态检测或再次执行命令。',
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
