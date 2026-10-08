import '../../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTmuxCliCore, _testOnlyTmuxCore } from '../../../../bridge/tmux/core.js';
import { injectPromptIntoTmuxPane } from '../../../../runtime/codex/tmux-provider.js';

// Model the documented Windows delivery boundary, not a native Windows run:
// psmux 3.3.8 converts paste LF to CR; ConPTY can expose those as key events.
// With the Codex paste-burst window expired, CR submits and Ctrl+J inserts LF.
// Captures include history, so a suffix ack alone cannot detect early submits.
function createWindowsEditor() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-windows-codex-input-'));
  const statePath = path.join(root, 'state.json');
  const scriptPath = path.join(root, 'psmux.cjs');
  fs.writeFileSync(statePath, JSON.stringify({ editor: '', turns: [], calls: [] }));
  fs.writeFileSync(scriptPath, String.raw`
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
function submit() {
  if (state.editor) state.turns.push(state.editor);
  state.editor = '';
}
if (args[0] === 'send-paste') {
  const text = Buffer.from(args.at(-1), 'base64').toString('utf8').replace(/\r\n|\n/g, '\r');
  for (const char of text) {
    if (char === '\r') submit();
    else state.editor += char;
  }
} else if (args[0] === 'send-keys') {
  if (args.includes('-l')) state.editor += args.at(-1);
  else if (args.at(-1) === 'C-j') state.editor += '\n';
  else if (args.at(-1) === 'Enter') submit();
} else if (args[0] === 'capture-pane') {
  process.stdout.write([...state.turns, state.editor].join('\n'));
}
fs.writeFileSync(statePath, JSON.stringify(state));
`);
  const core = createTmuxCliCore({ executable: process.execPath, prefixArgs: [scriptPath], psmuxServerSidePaste: true });
  return {
    core,
    read: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as { editor: string; turns: string[]; calls: string[][] },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const mediumPrompt = [
  'clk-medium-cjk-start 我想和你讨论《庄子逍遥游》中宋人卖章甫的故事。',
  '',
  '请结合无用之用、真知视野与小大之辩，说明它为什么出现在尧见四子之前。'.repeat(7),
  'clk-medium-cjk-end',
].join('\n');

for (const entry of ['actions', 'provider'] as const) {
  it(`keeps a Windows Codex multiline prompt in one turn via ${entry} even without paste-burst detection`, async () => {
    const fixture = createWindowsEditor();
    try {
      if (entry === 'actions') {
        await fixture.core.sendActions('owned-codex-pane', [
          { type: 'literal', text: mediumPrompt }, { type: 'key', key: 'Enter' },
        ], { forcePasteLiterals: true, pasteNewlineKey: 'C-j' });
      } else {
        _testOnlyTmuxCore.replace(fixture.core);
        await injectPromptIntoTmuxPane('owned-codex-pane', mediumPrompt);
      }
      const state = fixture.read();
      assert.deepEqual(state.turns, [mediumPrompt], 'all original lines and blank lines must be submitted exactly once');
      assert.equal(state.editor, '');
      assert.equal(state.calls.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter').length, 1);
    } finally {
      if (entry === 'provider') _testOnlyTmuxCore.reset();
      fixture.close();
    }
  });
}

it('preserves Unicode, whitespace-only lines and CRLF through multiple Windows paste chunks', async () => {
  const fixture = createWindowsEditor();
  const prompt = `first\r\n \t\r\n${'中文🙂'.repeat(1_500)}\r\nlast`;
  try {
    await fixture.core.injectPromptIntoPane('owned-codex-pane', prompt, { pasteNewlineKey: 'C-j' });
    assert.deepEqual(fixture.read().turns, [prompt.replace(/\r\n/g, '\n')]);
  } finally {
    fixture.close();
  }
});

it('preserves leading, blank and trailing editor newlines without submitting any of them', async () => {
  const fixture = createWindowsEditor();
  const prompt = '\nfirst\n\nlast\n\n';
  try {
    await fixture.core.sendActions('owned-codex-pane', [{ type: 'literal', text: prompt }], {
      forcePasteLiterals: true, pasteNewlineKey: 'C-j',
    });
    assert.deepEqual(fixture.read().turns, []);
    assert.equal(fixture.read().editor, prompt, 'the editor must receive every newline before submit');
    await fixture.core.sendActions('owned-codex-pane', [{ type: 'key', key: 'Enter' }]);
    assert.deepEqual(fixture.read().turns, [prompt]);
  } finally {
    fixture.close();
  }
});
