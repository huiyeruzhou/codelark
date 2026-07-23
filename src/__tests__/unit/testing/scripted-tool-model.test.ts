import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ScriptedToolModelProvider,
  scriptedToolCall,
} from '../../../testing/scripted-tool-model.js';

async function collect(stream: ReadableStream<string>): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text;
}

describe('ScriptedToolModelProvider', () => {
  it('emits caller-selected tool lifecycles in a deterministic order', async () => {
    const provider = new ScriptedToolModelProvider({
      steps: [
        { type: 'reasoning', text: 'inspect files' },
        ...scriptedToolCall('read-1', 'Read', { path: 'src/app.ts' }, 'line 1\nline 2'),
        ...scriptedToolCall('grep-1', 'Grep', { pattern: 'TODO', path: 'src' }, 'src/app.ts:2:TODO'),
        { type: 'text', text: 'done' },
        { type: 'result', data: { session_id: 'mock-session' } },
      ],
    });

    const raw = await collect(provider.streamChat({
      prompt: 'ignored by scripted model',
      sessionId: 'bridge-session',
    }));
    const eventTypes = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { type: string })
      .map((event) => event.type);

    assert.deepEqual(eventTypes, [
      'status',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'text',
      'result',
    ]);
    assert.match(raw, /src\/app\.ts/);
    assert.match(raw, /mock-session/);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.emittedSteps.length, 7);
    assert.equal(provider.lastError, null);
  });
});
