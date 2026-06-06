import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidArgumentError } from 'commander';
import { parseConfigCliOverrides } from '../../../configuration/cli-overrides.js';

describe('parseConfigCliOverrides', () => {
  it('parses canonical --set assignments into a config patch', () => {
    const parsed = parseConfigCliOverrides([
      'run',
      '--set', 'runtime.agent=claude',
      '--set', 'runtime.codex.reasoningEffort=high',
      '--set', 'runtime.codex.networkAccess=false',
      '--set', 'bridge.uiAllowLan=true',
      '--set', 'session.tmuxCaptureLines=120',
      '--set', 'channels[].config.allowedUsers=["ou_1","ou_2"]',
    ]);

    assert.deepEqual(parsed, {
      patch: {
        runtime: {
          agent: 'claude',
          codex: {
            reasoningEffort: 'high',
            networkAccess: false,
          },
        },
        bridge: {
          uiAllowLan: true,
        },
        session: {
          tmuxCaptureLines: 120,
        },
        channels: [{
          id: 'feishu-default',
          config: {
            allowedUsers: ['ou_1', 'ou_2'],
          },
        }],
      },
      unset: [],
    });
  });

  it('parses channel enabled and unset paths', () => {
    const parsed = parseConfigCliOverrides([
      '--set', 'channels[].enabled=true',
      '--unset', 'runtime.codex.model',
      '--unset', 'session.workspace',
    ]);

    assert.deepEqual(parsed, {
      patch: {
        channels: [{ id: 'feishu-default', enabled: true }],
      },
      unset: ['runtime.codex.model', 'session.workspace'],
    });
  });

  it('ignores unrelated command arguments while collecting config options', () => {
    const parsed = parseConfigCliOverrides([
      'start',
      '--verbose',
      '--set', 'runtime.codex.sandboxMode=read-only',
      'extra-arg',
    ]);

    assert.deepEqual(parsed.patch, {
      runtime: { codex: { sandboxMode: 'read-only' } },
    });
  });

  it('rejects unknown fields, malformed assignments, and invalid values', () => {
    assert.throws(
      () => parseConfigCliOverrides(['--set', 'runtime.codex.unknown=value']),
      /Unknown config field: runtime\.codex\.unknown/,
    );
    assert.throws(
      () => parseConfigCliOverrides(['--set', 'runtime.codex.model']),
      /Expected --set path=value/,
    );
    assert.throws(
      () => parseConfigCliOverrides(['--set', 'runtime.codex.reasoningEffort=extreme']),
      InvalidArgumentError,
    );
  });
});
