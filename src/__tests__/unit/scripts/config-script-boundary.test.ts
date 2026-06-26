import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

function readScript(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'scripts', name), 'utf-8');
}

describe('config script boundaries', () => {
  it('keeps daemon shell startup from sourcing legacy config.env', () => {
    const daemon = readScript('daemon.sh');

    assert.doesNotMatch(daemon, /source\s+["']?\$CODELARK_HOME\/config\.env/);
    assert.doesNotMatch(daemon, /set\s+-a\s+&&\s+source/);
  });

  it('keeps Windows supervisor startup from projecting legacy config.env', () => {
    const supervisor = readScript('supervisor-windows.ps1');

    assert.doesNotMatch(supervisor, /config\.env/);
    assert.doesNotMatch(supervisor, /Get-ConfigEnvironment/);
    assert.doesNotMatch(supervisor, /foreach\s*\(\$entry\s+in\s+\$configEnv/);
    assert.match(supervisor, /Install Node\.js >= 24/);
  });

  it('keeps doctor diagnostics on config.toml and migration-only legacy inputs', () => {
    const doctor = readScript('doctor.sh');

    assert.match(doctor, /CONFIG_TOML=/);
    assert.match(doctor, /legacy config\.env\/config\.json are migration inputs only/);
    assert.match(doctor, /Skipping Codex CLI\/auth checks for runtime agent/);
    assert.match(doctor, /Kimi CLI available/);
    assert.match(doctor, /tmux available for Kimi provider/);
    assert.doesNotMatch(doctor, /get_config\(\)/);
    assert.doesNotMatch(doctor, /grep\s+["']?\^\$1=/);
  });

  it('keeps edited shell scripts syntactically valid', () => {
    execFileSync('bash', ['-n', path.join(process.cwd(), 'scripts', 'daemon.sh')]);
    execFileSync('bash', ['-n', path.join(process.cwd(), 'scripts', 'doctor.sh')]);
  });

  it('keeps real Feishu E2E isolated bridge config on current TOML writes', () => {
    const realFeishu = readScript('real-feishu-e2e.ts');

    assert.match(realFeishu, /createConfigService/);
    assert.match(realFeishu, /replace\(\{ kind: 'home' \}/);
    assert.doesNotMatch(realFeishu, /session:\s*\{\s*workspace:/);
    assert.doesNotMatch(realFeishu, /path\.join\(codelarkHome,\s*'config\.env'\)/);
    assert.doesNotMatch(realFeishu, /path\.join\(codelarkHome,\s*'config\.json'\)/);
    assert.doesNotMatch(realFeishu, /path\.join\(options\.codelarkHome,\s*'config\.json'\)/);
  });

  it('keeps real Feishu E2E lark-cli calls out of the live Lark Channel config', () => {
    const realFeishu = readScript('real-feishu-e2e.ts');

    assert.match(realFeishu, /delete env\.LARK_CHANNEL;/);
    assert.match(realFeishu, /delete env\.LARK_CHANNEL_HOME;/);
    assert.match(realFeishu, /delete env\.LARK_CHANNEL_CONFIG;/);
    assert.match(realFeishu, /delete env\.LARKSUITE_CLI_CONFIG_DIR;/);
  });
});
