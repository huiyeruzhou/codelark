import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  listCursorAvailableModels,
  parseCursorAvailableModels,
} from '../../../../runtime/cursor/models.js';

describe('Cursor Agent model list', () => {
  it('parses current/default markers without including them in model names', () => {
    const models = parseCursorAvailableModels([
      'Available models',
      '',
      'auto - Auto (default)',
      'gpt-5.3-codex - Codex 5.3 (current)',
      'claude-opus-5-thinking-high - Claude Opus 5 1M Thinking',
      'gpt-5.3-codex - duplicate should be ignored',
      '',
      'Tip: use --model <id>',
    ].join('\n'));

    assert.deepEqual(models, [
      { slug: 'auto', name: 'Auto', current: false, default: true },
      { slug: 'gpt-5.3-codex', name: 'Codex 5.3', current: true, default: false },
      { slug: 'claude-opus-5-thinking-high', name: 'Claude Opus 5 1M Thinking', current: false, default: false },
    ]);
  });

  it('runs the Cursor Agent models subcommand and rejects an empty model response', async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const models = await listCursorAvailableModels({
      executable: '/opt/cursor-agent',
      run: async (executable, args) => {
        calls.push({ executable, args });
        return { stdout: 'auto - Auto (default)\ngpt-5.3 - GPT-5.3 (current)\n', stderr: '' };
      },
    });
    assert.deepEqual(calls, [{ executable: '/opt/cursor-agent', args: ['models'] }]);
    assert.equal(models[1]?.current, true);

    await assert.rejects(
      listCursorAvailableModels({
        executable: '/opt/cursor-agent',
        run: async () => ({ stdout: 'Available models\n', stderr: '' }),
      }),
      /没有返回可用模型/,
    );
  });
});
