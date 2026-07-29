import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { applyStandardLarkCliEnv, buildStandardLarkCliEnv } from '../../../shared/lark-cli-env.js';

describe('buildStandardLarkCliEnv', () => {
  it('removes inherited private CodeLark overrides without mutating the source env', () => {
    const runtimeBin = path.join(process.env.CODELARK_HOME!, 'runtime', 'bin');
    const source: NodeJS.ProcessEnv = {
      HOME: '/home/tester',
      PATH: ['/usr/bin', runtimeBin, '/bin', runtimeBin].join(path.delimiter),
      LARK_CHANNEL: '1',
      LARK_CHANNEL_HOME: '/tmp/private-home',
      LARK_CHANNEL_CONFIG: '/tmp/private-source/config.json',
      LARK_CHANNEL_CUSTOM: 'legacy-extension',
      LARKSUITE_CLI_CONFIG_DIR: '/tmp/private-config',
      lark_channel_legacy: '/tmp/private-legacy',
      larksuite_cli_config_dir: '/tmp/private-config-lowercase',
      KEEP_ME: 'yes',
    };

    const env = buildStandardLarkCliEnv(source);

    assert.equal(env.HOME, '/home/tester');
    assert.equal(env.PATH, ['/usr/bin', '/bin'].join(path.delimiter));
    assert.equal(env.KEEP_ME, 'yes');
    assert.equal(env.LARK_CHANNEL, undefined);
    assert.equal(env.LARK_CHANNEL_HOME, undefined);
    assert.equal(env.LARK_CHANNEL_CONFIG, undefined);
    assert.equal(env.LARK_CHANNEL_CUSTOM, undefined);
    assert.equal(env.LARKSUITE_CLI_CONFIG_DIR, undefined);
    assert.equal(env.lark_channel_legacy, undefined);
    assert.equal(env.larksuite_cli_config_dir, undefined);

    assert.equal(source.LARK_CHANNEL, '1');
    assert.match(source.PATH || '', /runtime/);
  });

  it('can sanitize the authoritative process-boundary object in place', () => {
    const runtimeBin = path.join(process.env.CODELARK_HOME!, 'runtime', 'bin');
    const target: NodeJS.ProcessEnv = {
      PATH: [runtimeBin, '/usr/bin'].join(path.delimiter),
      LARK_CHANNEL_CONFIG: '/tmp/private-source/config.json',
      KEEP_ME: 'yes',
    };

    const result = applyStandardLarkCliEnv(target);

    assert.equal(result, target);
    assert.equal(target.LARK_CHANNEL_CONFIG, undefined);
    assert.equal(target.PATH, '/usr/bin');
    assert.equal(target.KEEP_ME, 'yes');
  });
});
