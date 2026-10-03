import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasCodexTuiInputPrompt, parseCodexTuiSelectionPrompt } from '../../../../runtime/codex/tmux-provider.js';

// Captured from Codex 0.160.0 --remote on the macOS 26 CI runner.
const folderAccess = `
  Folder access
  /tmp/codelark-test/workspace

  Trust this folder? Codex can read, edit, and run files here, subject to your
  permission settings. Folder settings can run code automatically, even
  without a model request. Continue only if you trust these files. Your trust
  decision will be saved.

› 1. Trust and continue
  2. Back to Agent Command Center

  enter continue · esc back`;

test('remote folder trust remains a user selection until explicitly resolved', () => {
  const prompt = parseCodexTuiSelectionPrompt(folderAccess);
  assert(prompt);
  assert.equal(prompt.kind, 'generic');
  assert.deepEqual(prompt.options.map(({ label, choice }) => ({ label, choice })), [
    { label: 'Trust and continue', choice: 'option_1' },
    { label: 'Back to Agent Command Center', choice: 'option_2' },
  ]);
  assert.equal(hasCodexTuiInputPrompt(folderAccess), false);
  assert.equal(parseCodexTuiSelectionPrompt(folderAccess.replace('  enter continue · esc back', 'An explanation of enter continue · esc back in a paragraph.')), null);
  assert.equal(parseCodexTuiSelectionPrompt(folderAccess.replace('›', ' ')), null);
});

test('the compact model introduction remains a selection instead of an input prompt', () => {
  const screen = `Meet GPT-6 Sol\n\n› 1. Try new model\n  2. Use existing model\n\n  enter/esc confirm · ctrl+c quit`;
  const prompt = parseCodexTuiSelectionPrompt(screen);
  assert(prompt);
  assert.deepEqual(prompt.options.map((option) => option.label), ['Try new model', 'Use existing model']);
  assert.equal(hasCodexTuiInputPrompt(screen), false);
  assert.equal(parseCodexTuiSelectionPrompt(screen.replace('  enter/esc confirm · ctrl+c quit', 'This sentence mentions enter/esc confirm · ctrl+c quit.')), null);
});
