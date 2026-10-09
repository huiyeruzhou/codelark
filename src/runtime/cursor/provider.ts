import type { LLMProvider, StreamChatParams } from '../contracts.js';
import { CursorDesktopTransport } from './desktop-provider.js';
import { CursorCliTransport } from './tmux-provider.js';

/** One public tmux provider; the bound conversation determines its internal transport. */
export class CursorTmuxProvider implements LLMProvider {
  private readonly cli: LLMProvider = new CursorCliTransport();
  private readonly desktop: LLMProvider = new CursorDesktopTransport();

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return (params.cursorTransport === 'desktop' ? this.desktop : this.cli).streamChat(params);
  }
}
