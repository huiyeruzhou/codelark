import type { StreamingHistoryItem } from '../../domain/index.js';
import { buildToolProgressBlocks } from '../../shared/progress/tool-rendering.js';

export interface HistoryPageCursor {
  historyItemOffset: number;
  historyToolCallOffset: number;
  historyTextOffset?: number;
}

// 页游标始终指向原始历史；分页不能通过删除前部记录来满足容量限制。
export function buildHistoryPage(
  history: StreamingHistoryItem[],
  start: HistoryPageCursor,
  fits: (items: StreamingHistoryItem[]) => boolean,
): { items: StreamingHistoryItem[]; next: HistoryPageCursor; hasMore: boolean } {
  let next = { ...start, historyTextOffset: start.historyTextOffset || 0 };
  let items: StreamingHistoryItem[] = [];
  let lastSourceItem = -1;
  while (next.historyItemOffset < history.length) {
    const source = history[next.historyItemOffset]!;
    const tool = source.type === 'tool_panel' ? source.tools[next.historyToolCallOffset] : undefined;
    if (source.type === 'tool_panel' && !tool) {
      next = { historyItemOffset: next.historyItemOffset + 1, historyToolCallOffset: 0, historyTextOffset: 0 };
      continue;
    }
    const atom: StreamingHistoryItem = tool ? { type: 'tool_panel', tools: [tool] } : source;
    const previous = items.at(-1);
    const mergeTool = atom.type === 'tool_panel' && previous?.type === 'tool_panel'
      && next.historyItemOffset === lastSourceItem;
    const candidate = mergeTool && atom.type === 'tool_panel' && previous?.type === 'tool_panel'
      ? [...items.slice(0, -1), { ...previous, tools: [...previous.tools, ...atom.tools] }]
      : [...items, atom];
    if (!next.historyTextOffset && fits(candidate)) {
      items = candidate;
      lastSourceItem = next.historyItemOffset;
    } else {
      if (items.length) break;
      const textItem = historyAtomText(atom);
      const offset = next.historyTextOffset;
      let low = offset;
      let high = textItem.content.length;
      while (low < high) {
        const end = Math.ceil((low + high) / 2);
        const part = { ...textItem, content: fencedSlice(textItem.content, offset, end) };
        if (fits([part])) low = end;
        else high = end - 1;
      }
      const newline = textItem.content.lastIndexOf('\n', low - 1);
      if (low < textItem.content.length && newline > offset + (low - offset) / 2) low = newline + 1;
      // 不拆开UTF-16代理对。
      if (low < textItem.content.length && /[\uD800-\uDBFF]/u.test(textItem.content[low - 1] || '')) low -= 1;
      if (low <= offset) throw new Error('Streaming card metadata leaves no room for history');
      items = [{ ...textItem, content: fencedSlice(textItem.content, offset, low) }];
      if (low < textItem.content.length) {
        next = { ...next, historyTextOffset: low };
        break;
      }
    }
    if (source.type === 'tool_panel' && next.historyToolCallOffset + 1 < source.tools.length) {
      next = { ...next, historyToolCallOffset: next.historyToolCallOffset + 1, historyTextOffset: 0 };
    } else {
      next = { historyItemOffset: next.historyItemOffset + 1, historyToolCallOffset: 0, historyTextOffset: 0 };
    }
  }
  return { items, next, hasMore: next.historyItemOffset < history.length };
}

function historyAtomText(item: StreamingHistoryItem): Extract<StreamingHistoryItem, { type: 'markdown' }> {
  if (item.type === 'markdown') return item;
  if (item.type === 'tool_panel') {
    const block = buildToolProgressBlocks(item.tools, { maxItems: null })[0]!;
    return { type: 'markdown', role: 'assistant', collapseTitle: block.presentation.title, content: block.detail };
  }
  if (item.type === 'runtime_notice') {
    return { type: 'markdown', role: 'system', content: `${item.notice.title}\n${item.notice.message}` };
  }
  return { type: 'markdown', role: 'assistant', collapseTitle: `✉️ 已发送 · ${item.event.targetChatName}`, content: item.event.messageText };
}

// 长Markdown跨卡时重新打开/闭合代码围栏；原文的位置不包含补入的围栏。
function fencedSlice(text: string, start: number, end: number): string {
  const fenceAt = (offset: number): { marker: string; opening: string } | null => {
    let fence: { marker: string; opening: string } | null = null;
    for (const match of text.slice(0, offset).matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)\n/gm)) {
      if (!fence) fence = { marker: match[1]!, opening: match[0]!.trimEnd() };
      else if (match[1]![0] === fence.marker[0] && match[1]!.length >= fence.marker.length && !match[2]!.trim()) fence = null;
    }
    return fence;
  };
  const before = fenceAt(start);
  const after = fenceAt(end);
  return `${before ? `${before.opening}\n` : ''}${text.slice(start, end)}${after ? `\n${after.marker}` : ''}`;
}
