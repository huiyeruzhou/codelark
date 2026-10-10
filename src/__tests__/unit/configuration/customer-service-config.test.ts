import '../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { configPatchSchema, configToTomlShape, tomlToConfigPatch } from '../../../configuration/schema.js';
import { parseUiChannelPayload } from '../../../operator-ui/application/channel.js';

it('roundtrips enable/disable and validates user-only control IDs', () => {
  const patch = { channels: [{ id: 'feishu-default', config: { customerServiceChats: ['oc_group'], customerServiceControlUsers: ['ou_user'] } }] };
  assert.deepEqual(tomlToConfigPatch(configToTomlShape(patch)), patch);
  assert.deepEqual(parseUiChannelPayload({ provider: 'feishu', customerServiceChats: 'oc_group, oc_other', customerServiceControlUsers: 'ou_user' }).customerServiceChats, ['oc_group', 'oc_other']);
  assert.deepEqual(parseUiChannelPayload({ provider: 'feishu', customerServiceChats: '', customerServiceControlUsers: '' }).customerServiceChats, []);
  assert.throws(() => configPatchSchema.parse({ channels: [{ id: 'feishu-default', config: { customerServiceControlUsers: ['oc_group'] } }] }));
});


it('renders valid configuration-page JavaScript with service controls', async () => {
  const { renderUiShellHtml } = await import('../../../operator-ui/shell.js');
  const html = renderUiShellHtml();
  assert.match(html, /channelCustomerServiceChats/);
  assert.match(html, /channelCustomerServiceControlUsers/);
  for (const script of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (script[1].trim()) assert.doesNotThrow(() => new Function(script[1]));
  }
});
