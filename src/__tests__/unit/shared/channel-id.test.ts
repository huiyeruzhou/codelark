import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeChannelId } from '../../../shared/channel-id.js';

describe('channel-id', () => {
  it('normalizes channel ids consistently', () => {
    assert.equal(normalizeChannelId(' Feishu Default '), 'feishu-default');
    assert.equal(normalizeChannelId('feishu@main'), 'feishu-main');
    assert.equal(normalizeChannelId('***'), 'channel');
  });
});
