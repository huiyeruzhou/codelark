import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidOptionArgumentError as InvalidArgumentError } from 'commander';
import { parseConfigCliOverrides } from '../../../configuration/cli-overrides.js';

describe('parseConfigCliOverrides', () => {
  it('parses --set and --unset overrides while ignoring unrelated command arguments', () => {
    const parsed = parseConfigCliOverrides([
      'start',
      '--verbose',
      'run',
      '--set', 'runtime.agent=claude',
      '--set', 'runtime.codex.reasoningEffort=high',
      '--set', 'runtime.codex.networkAccess=false',
      '--set', 'runtime.codex.sandboxMode=read-only',
      '--set', 'bridge.uiAllowLan=true',
      '--set', 'session.tmuxCaptureLines=120',
      '--unset', 'runtime.codex.model',
      '--unset', 'session.workspace',
      'extra-arg',
    ]);

    assert.deepEqual(parsed, {
      patch: {
        runtime: {
          agent: 'claude',
          codex: {
            reasoningEffort: 'high',
            networkAccess: false,
            sandboxMode: 'read-only',
          },
        },
        bridge: {
          uiAllowLan: true,
        },
        session: {
          tmuxCaptureLines: 120,
        },
      },
      unset: ['runtime.codex.model', 'session.workspace'],
    });
  });

  it('parses Kimi runtime overrides through the same CLI path', () => {
    const parsed = parseConfigCliOverrides([
      '--set', 'runtime.agent=kimi',
      '--set', 'runtime.kimi.model=moonshot-v1-test',
      '--set', 'runtime.kimi.provider=tmux',
      '--unset', 'runtime.kimi.model',
    ]);

    assert.deepEqual(parsed, {
      patch: {
        runtime: {
          agent: 'kimi',
          kimi: {
            model: 'moonshot-v1-test',
            provider: 'tmux',
          },
        },
      },
      unset: ['runtime.kimi.model'],
    });
  });

  it('rejects unknown fields, malformed assignments, and invalid values', () => {
    assert.throws(
      () => parseConfigCliOverrides(['--set', 'runtime.codex.unknown=value']),
      /未知配置字段：runtime\.codex\.unknown/,
    );
    assert.throws(
      () => parseConfigCliOverrides(['--set', 'runtime.codex.model']),
      /--set 需要使用 path=value 格式/,
    );
    assert.throws(
      () => parseConfigCliOverrides(['--set', 'runtime.codex.reasoningEffort=extreme']),
      InvalidArgumentError,
    );
    assert.throws(
      () => parseConfigCliOverrides(['--set', 'runtime.kimi.provider=sdk']),
      InvalidArgumentError,
    );
    assert.throws(
      () => parseConfigCliOverrides(['--set', 'channels[].enabled=true']),
      /配置字段 channels\[\]\.enabled 不能通过 CLI 设置/,
    );
  });
});
