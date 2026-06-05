import type { SSEEvent } from './contracts.js';

function extractCompleteLines(buffer: string): { lines: string[]; trailing: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  const trailing = parts.pop() ?? '';
  return {
    lines: parts,
    trailing,
  };
}

function parseDataLine(line: string): SSEEvent | null {
  if (!line.startsWith('data: ')) return null;
  try {
    return JSON.parse(line.slice(6)) as SSEEvent;
  } catch {
    return null;
  }
}

export async function consumeSseEvents(
  stream: ReadableStream<string>,
  onEvent: (event: SSEEvent) => void | Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  let pending = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    pending += value;
    const { lines, trailing } = extractCompleteLines(pending);
    pending = trailing;

    for (const line of lines) {
      const event = parseDataLine(line);
      if (event) {
        await onEvent(event);
      }
    }
  }

  if (!pending) return;
  const trailingEvent = parseDataLine(pending);
  if (trailingEvent) {
    await onEvent(trailingEvent);
  }
}
