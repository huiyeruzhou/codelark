import assert from 'node:assert/strict';
import { it } from 'node:test';
import { startFixtureModel } from './codex-app-server-lifecycle.js';

const titleInput = [{ role: 'user', content: [{ type: 'input_text', text: 'Generate a concise, single-line task title of at most 36 characters.\n\nUser prompt:\nfixture' }] }];
const titleFormat = { format: { type: 'json_schema', name: 'codex_output_schema', strict: true,
  schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } };

it('keeps native title requests separate without consuming or accepting quoted user requests', async () => {
  const model = await startFixtureModel({ respondToThreadTitles: true });
  const post = (body: unknown) => fetch(`${model.baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    model.enqueue({ text: 'USER_TURN_RESULT' });
    const title = await post({ input: titleInput, text: titleFormat });
    assert.equal(title.status, 200);
    assert((await title.text()).includes('CodeLark compatibility test'));
    assert.equal(model.auxiliaryRequests.length, 1);
    assert.equal(model.requests.length, 0);
    const quoted = await post({ input: titleInput });
    assert((await quoted.text()).includes('USER_TURN_RESULT'));
    assert.equal(model.requests.length, 1);
    const unexpected = await post({ input: titleInput, text: { format: { ...titleFormat.format, strict: false } } });
    assert.equal(unexpected.status, 500);
    assert.equal(model.auxiliaryRequests.length, 1);
    assert.equal(model.unexpected.length, 1);
  } finally { await model.close(); }
});

it('keeps the default protocol fixture strict for unplanned title requests', async () => {
  const model = await startFixtureModel();
  try {
    const response = await fetch(`${model.baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: titleInput, text: titleFormat }) });
    assert.equal(response.status, 500);
    assert.equal(model.auxiliaryRequests.length, 0);
    assert.equal(model.requests.length, 1);
    assert.equal(model.unexpected.length, 1);
  } finally { await model.close(); }
});


it('preserves whitespace-only chunks in streamed fixture responses', async () => {
  const model = await startFixtureModel();
  try {
    const chunks = ['This sample', ' ', 'keeps', '\n    ', 'indentation.'];
    model.enqueue({ text: chunks.join(''), chunks, chunkDelayMs: 1 });
    const response = await fetch(`${model.baseUrl}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: [] }),
    });
    const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.find(event => event.type === 'response.output_item.added').item.content[0].text, '', 'the first event must not reveal the final answer before streaming');
    assert.deepEqual(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta), chunks);
    assert.equal(events.at(-1).response.output[0].content[0].text, chunks.join(''));
    assert.deepEqual(model.unexpected, []);
  } finally { await model.close(); }
});
