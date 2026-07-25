import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _testOnlyClaudePty } from '../../../../runtime/claude/pty-provider.js';
import { CodexRoutingProvider } from '../../../../runtime/codex/routing-provider.js';

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
  it('routes each request by the per-session provider choice', async () => {
    const provider = new CodexRoutingProvider(undefined, 'sdk') as any;
    const routed: string[] = [];
    provider.sdkProvider = {
      streamChat() {
        routed.push('sdk');
        return streamWithText('sdk-stream');
      },
    };
    provider.tmuxProvider = {
      streamChat() {
        routed.push('tmux');
        return streamWithText('tmux-stream');
      },
    };
    provider.ptyProvider = {
      streamChat() {
        routed.push('pty');
        return streamWithText('pty-stream');
      },
    };
    provider.claudePtyProvider = {
      streamChat() {
        routed.push('claude-pty');
        return streamWithText('claude-pty-stream');
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
    const ptyOutput = await readStream(provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-pty',
      codexProvider: 'pty',
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
      claudeProvider: 'pty',
    }));
    const cursorOutput = await readStream(provider.streamChat({
      prompt: 'hello',
      sessionId: 'session-cursor',
      runtime: 'cursor',
      cursorProvider: 'tmux',
    }));

    assert.deepEqual(routed, ['sdk', 'tmux', 'pty', 'sdk', 'claude-tmux', 'claude-sdk', 'claude-tmux', 'kimi-tmux', 'cursor-tmux']);
    assert.equal(sdkOutput, 'sdk-stream');
    assert.equal(tmuxOutput, 'tmux-stream');
    assert.equal(ptyOutput, 'pty-stream');
    assert.equal(defaultOutput, 'sdk-stream');
    assert.equal(claudeOutput, 'claude-tmux-stream');
    assert.equal(claudeSdkOutput, 'claude-sdk-stream');
    assert.equal(claudeTmuxOutput, 'claude-tmux-stream');
    assert.equal(kimiOutput, 'kimi-tmux-stream');
    assert.equal(cursorOutput, 'cursor-tmux-stream');
  });

  it('builds Claude Code pty commands from the global Claude executable', () => {
    assert.deepEqual(_testOnlyClaudePty.buildClaudePtyCommand('ccr', {
      env: {},
      platform: process.platform,
    }), {
      command: process.platform === 'win32' ? 'ccr.cmd' : 'ccr',
      args: ['code'],
    });
    assert.deepEqual(_testOnlyClaudePty.buildClaudePtyCommand('claude', {
      env: {},
      platform: process.platform,
    }), {
      command: process.platform === 'win32' ? 'claude.cmd' : 'claude',
      args: [],
    });
  });
});
