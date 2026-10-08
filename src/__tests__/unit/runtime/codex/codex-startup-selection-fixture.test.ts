import assert from 'node:assert/strict';
import test from 'node:test';
import { codexFixtureStartupChoice } from '../../../helpers/runtime/codex-startup-selection.js';

const body = 'Set up the Codex agent sandbox to protect your files and control network access. Learn more\n'
  + '  &lt;https://developers.openai.com/codex/windows&gt;';
const options = [
  ['Set up default sandbox (requires Administrator permissions)', 'option_1'],
  ['Use non-admin sandbox (higher risk if prompt injected)', 'option_2'],
  ['Quit', 'option_3'],
  ['这不是TUI选择', 'not_selection'],
].map(([text, choice]) => ({ text, callbackData: `current-request:${choice}` }));
const select = { placeholder: '', selectedCallbackData: 'current-request:not_selection', options };

test('observed Windows setup explicitly chooses non-admin from both legacy startup paths', () => {
  for (const selectedCallbackData of ['current-request:not_selection', 'current-request:option_1']) {
    assert.equal(codexFixtureStartupChoice(body, { ...select, selectedCallbackData }), 'current-request:option_2');
  }
});

test('unknown generic, partial setup text and changed option sets retain their original choice', () => {
  for (const text of ['Unknown numbered selection', body.replace('https://developers.openai.com/codex/windows', ''),
    body.replace('protect your files and control network access.', '')]) {
    assert.equal(codexFixtureStartupChoice(text, select), select.selectedCallbackData);
  }
  for (const changed of [options.slice(0, 2), [...options, options[0]],
    options.map((option, index) => index === 1 ? { ...option, text: 'Different action' } : option),
    options.map((option, index) => index === 1 ? { ...option, callbackData: 'current-request:option_3' } : option)]) {
    assert.equal(codexFixtureStartupChoice(body, { ...select, options: changed }), select.selectedCallbackData);
  }
});

test('model migration and other known selections keep their existing defaults', () => {
  const migration = { placeholder: '', selectedCallbackData: 'migration:option_2', options: [
    { text: 'Try new model', callbackData: 'migration:option_1' },
    { text: 'Use existing model', callbackData: 'migration:option_2' },
  ] };
  assert.equal(codexFixtureStartupChoice("Choose how you'd like Codex to proceed.", migration), 'migration:option_2');
  assert.equal(codexFixtureStartupChoice('', { placeholder: '', options: [] }), undefined);
});
