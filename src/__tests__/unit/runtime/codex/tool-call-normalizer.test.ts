import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatOrchestratorSource,
  normalizeCodexToolCall,
} from '../../../../runtime/codex/session-index/tool-call-normalizer.js';

describe('normalizeCodexToolCall', () => {
  it('unwraps a GPT-5.6 exec_command orchestration call without evaluating JavaScript', () => {
    const normalized = normalizeCodexToolCall('exec', [
      'const r = await tools.exec_command({"cmd":"npm test","workdir":"/tmp/project","yield_time_ms":10000});',
      'text(r.output);',
    ].join('\n'));

    assert.deepEqual(normalized, {
      name: 'exec_command',
      input: {
        cmd: 'npm test',
        workdir: '/tmp/project',
        yield_time_ms: 10000,
      },
    });
  });

  it('resolves a static patch variable from a GPT-5.6 apply_patch orchestration call', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '+const enabled = true;',
      '*** End Patch',
    ].join('\n');
    const normalized = normalizeCodexToolCall('exec', [
      `const patch = ${JSON.stringify(patch)};`,
      'text(await tools.apply_patch(patch));',
    ].join('\n'));

    assert.deepEqual(normalized, { name: 'apply_patch', input: patch });
  });

  it('extracts multiple calls in source order, including Promise.all orchestration', () => {
    const multiple = [
      'const patch = "*** Begin Patch\\n*** Update File: a.ts\\n@@\\n+ok\\n*** End Patch";',
      'const results = await Promise.all([',
      '  tools.exec_command({ cmd: "pwd", workdir: "/tmp/project" }),',
      '  tools.apply_patch(patch),',
      ']);',
      'text(results.length);',
    ].join('\n');
    assert.deepEqual(normalizeCodexToolCall('exec', multiple), {
      name: 'tools × 2',
      input: multiple,
      subcalls: [
        {
          name: 'exec_command',
          input: { cmd: 'pwd', workdir: '/tmp/project' },
          inputResolved: true,
        },
        {
          name: 'apply_patch',
          input: '*** Begin Patch\n*** Update File: a.ts\n@@\n+ok\n*** End Patch',
          inputResolved: true,
        },
      ],
    });
  });

  it('resolves static template interpolation and JSON.stringify used by real exec wrappers', () => {
    const source = [
      'const pod = "worker-3";',
      'const probe = `tail -n 12 /tmp/${pod}.log`;',
      'const payload = JSON.stringify({ pod_name: pod, exec: probe });',
      'const r = await tools.exec_command({ cmd: `remote-exec --json \'${payload}\'`, workdir: "/tmp/project" });',
      'text(r.output);',
    ].join('\n');

    assert.deepEqual(normalizeCodexToolCall('exec', source), {
      name: 'exec_command',
      input: {
        cmd: 'remote-exec --json \'{"pod_name":"worker-3","exec":"tail -n 12 /tmp/worker-3.log"}\'',
        workdir: '/tmp/project',
      },
    });
  });

  it('formats unresolved orchestration by top-level statement instead of one line', () => {
    const source = 'const value = dynamic(); text(value);';
    assert.equal(formatOrchestratorSource(source), 'const value = dynamic();\ntext(value);');
    assert.deepEqual(normalizeCodexToolCall('exec', source), {
      name: 'exec',
      input: 'const value = dynamic();\ntext(value);',
    });
  });

  it('ignores tool-call lookalikes inside strings', () => {
    const lookalike = 'const example = "tools.apply_patch(patch)"; text(example);';
    assert.deepEqual(normalizeCodexToolCall('exec', lookalike), {
      name: 'exec',
      input: 'const example = "tools.apply_patch(patch)";\ntext(example);',
    });
  });

  it('does not treat prototype properties as resolved command input', () => {
    const source = 'await tools.exec_command({ __proto__: { cmd: "not-an-own-command" } });';
    assert.deepEqual(normalizeCodexToolCall('exec', source), { name: 'exec', input: source });
  });

  it('leaves old direct tool calls unchanged', () => {
    const input = { command: 'pwd' };
    assert.deepEqual(normalizeCodexToolCall('exec_command', input), { name: 'exec_command', input });
  });
});
