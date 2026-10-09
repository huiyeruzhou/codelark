import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CodexRoutingProvider } from '../../../../runtime/codex/routing-provider.js';
import { CursorTmuxProvider } from '../../../../runtime/cursor/provider.js';

function streamWithText(text: string): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<string>): Promise<string> {
  let output = '';
  for await (const chunk of stream) {
    output += chunk;
  }
  return output;
}

describe('CodexRoutingProvider', () => {
  it('keeps one Cursor tmux provider while dispatching to the bound transport with no fallback', async () => {
    const provider = new CursorTmuxProvider() as any;
    const routes: string[] = [];
    provider.cli = { streamChat: () => { routes.push('cli'); return streamWithText('cli'); } };
    provider.desktop = { streamChat: () => { routes.push('desktop'); return streamWithText('desktop'); } };
    const base = { prompt: 'hello', sessionId: 'same-session', runtime: 'cursor' as const, cursorProvider: 'tmux' as const };
    assert.equal(await readStream(provider.streamChat({ ...base, cursorTransport: 'cli' })), 'cli');
    assert.equal(await readStream(provider.streamChat({ ...base, cursorTransport: 'desktop' })), 'desktop');
    provider.desktop = { streamChat: () => { throw new Error('Desktop unavailable'); } };
    assert.throws(() => provider.streamChat({ ...base, cursorTransport: 'desktop' }), /Desktop unavailable/);
    assert.deepEqual(routes, ['cli', 'desktop']);
  });

  it('routes Codex only through the tmux fallback while preserving other runtimes', async () => {
    const provider = new CodexRoutingProvider(undefined, 'tmux') as any;
    const routed: string[] = [];
    provider.tmuxProvider = {
      streamChat() {
        routed.push('tmux');
        return streamWithText('tmux-stream');
      },
    };
    provider.claudeSdkProvider = {
      streamChat() {
        routed.push('claude-sdk');
        return streamWithText('claude-sdk-stream');
      },
    };
    provider.claudeTmuxProvider = {
      streamChat() {
        routed.push('claude-tmux');
        return streamWithText('claude-tmux-stream');
      },
    };
    provider.kimiTmuxProvider = {
      streamChat() {
        routed.push('kimi-tmux');
        return streamWithText('kimi-tmux-stream');
      },
    };
    provider.cursorTmuxProvider = {
      streamChat() {
        routed.push('cursor-tmux');
        return streamWithText('cursor-tmux-stream');
      },
    };


    const sdkOutput = await readStream(provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-sdk',
      codexProvider: 'sdk',
    }));
    const tmuxOutput = await readStream(provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-tmux',
      codexProvider: 'tmux',
    }));
    const defaultOutput = await readStream(provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-default',
    }));
    const claudeOutput = await readStream(provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-claude',
      runtime: 'claude',
      codexProvider: 'tmux',
      claudeExecutable: 'ccr',
    }));
    const claudeSdkOutput = await readStream(provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-claude-sdk',
      runtime: 'claude',
      claudeProvider: 'sdk',
      claudeExecutable: 'ccr',
    }));
    const claudeTmuxOutput = await readStream(provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-claude-tmux',
      runtime: 'claude',
      claudeProvider: 'tmux',
      claudeExecutable: 'ccr',
    }));
    const kimiOutput = await readStream(provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-kimi',
      runtime: 'kimi',
      codexProvider: 'sdk',
      claudeProvider: 'tmux',
    }));
    const cursorOutput = await readStream(provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-cursor',
      runtime: 'cursor',
      cursorProvider: 'tmux',
    }));
    const cursorDesktopOutput = await readStream(provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-cursor-desktop',
      runtime: 'cursor',
      cursorProvider: 'tmux',
      cursorTransport: 'desktop',
      cursorSessionId: '11111111-1111-4111-8111-111111111111',
    }));

    assert.deepEqual(routed, ['tmux', 'tmux', 'tmux', 'claude-tmux', 'claude-sdk', 'claude-tmux', 'kimi-tmux', 'cursor-tmux', 'cursor-tmux']);
    assert.equal(sdkOutput, 'tmux-stream');
    assert.equal(tmuxOutput, 'tmux-stream');
    assert.equal(defaultOutput, 'tmux-stream');
    assert.equal(claudeOutput, 'claude-tmux-stream');
    assert.equal(claudeSdkOutput, 'claude-sdk-stream');
    assert.equal(claudeTmuxOutput, 'claude-tmux-stream');
    assert.equal(kimiOutput, 'kimi-tmux-stream');
    assert.equal(cursorOutput, 'cursor-tmux-stream');
    assert.equal(cursorDesktopOutput, 'cursor-tmux-stream');
  });

});
