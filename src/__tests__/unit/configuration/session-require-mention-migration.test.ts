import '../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigService } from '../../../configuration/service.js';
import { runConfigMigrations } from '../../../configuration/migrations/index.js';
import { sessionRequireMentionMigration } from '../../../configuration/migrations/session-require-mention.js';
import { resolveConfigPaths, sessionTomlPath } from '../../../configuration/sources.js';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-mention-alias-migration-'));
  const paths = resolveConfigPaths({ codelarkHome: home });
  const config = createConfigService({ codelarkHome: home, migrate: false, env: {} });
  const bindings = (values: Record<string, string>) => {
    fs.mkdirSync(path.join(home, 'data'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data/channel-chats.json'), JSON.stringify(Object.fromEntries(Object.entries(values).map(([id, channelType]) => [id, { channelType, bridgeSessionId: id }]))));
    fs.writeFileSync(path.join(home, 'data/sessions.json'), JSON.stringify(Object.fromEntries(Object.keys(values).map((id) => [id, {}]))));
  };
  return { home, paths, config, bindings,
    migrate: () => runConfigMigrations({ codelarkHome: home, migrations: [sessionRequireMentionMigration] }),
    value: (id: string) => config.get('session.requireMention', { kind: 'session', sessionId: id }),
    clean: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

for (const homeValue of [true, false]) {
  it(`legacy feishu alias migrates home ${homeValue} from feishu-default, preserving explicit session false`, () => {
    const f = fixture();
    try {
      f.config.set({ kind: 'home' }, { channels: [{ id: 'feishu-default', provider: 'feishu', config: { requireMention: homeValue } }] });
      f.config.set({ kind: 'session', sessionId: 'explicit' }, { session: { requireMention: false, tmuxCaptureLines: 123 } });
      const explicitFile = sessionTomlPath(f.paths, 'explicit');
      const explicitBefore = fs.readFileSync(explicitFile, 'utf8');
      f.bindings({ exact: 'feishu-default', legacy: 'feishu', explicit: 'feishu' });
      assert.equal(f.migrate().warnings.length, 0);
      assert.equal(f.value('exact'), homeValue);
      assert.equal(f.value('legacy'), homeValue);
      assert.equal(f.config.resolve('session.requireMention', { kind: 'session', sessionId: 'legacy' }).source, 'session');
      assert.equal(f.value('explicit'), false);
      assert.equal(fs.readFileSync(explicitFile, 'utf8'), explicitBefore);
      f.config.set({ kind: 'home' }, { channels: [{ id: 'feishu-default', config: { requireMention: !homeValue } }] });
      assert.equal(f.migrate().applied.length, 0);
      assert.equal(f.value('legacy'), homeValue);
    } finally { f.clean(); }
  });
}

it('exact channel id wins over an earlier provider match during migration', () => {
  const f = fixture();
  try {
    f.config.set({ kind: 'home' }, { channels: [
      { id: 'feishu-default', provider: 'feishu', config: { requireMention: true } },
      { id: 'feishu', provider: 'feishu', config: { requireMention: false } },
    ] });
    f.bindings({ exact: 'feishu', normal: 'feishu-default', missing: 'unknown' });
    f.migrate();
    assert.equal(f.value('exact'), false);
    assert.equal(f.value('normal'), true);
    assert.equal(f.config.resolve('session.requireMention', { kind: 'session', sessionId: 'missing' }).source, 'defaults');
  } finally { f.clean(); }
});

it('provider alias follows home channel order without reintroducing the replaced default channel', () => {
  const f = fixture();
  try {
    f.config.set({ kind: 'home' }, { channels: [
      { id: 'custom-first', provider: 'feishu', config: { requireMention: true } },
      { id: 'custom-second', provider: 'feishu', config: { requireMention: false } },
    ] });
    assert.deepEqual(f.config.snapshot().config.channels.map((channel) => channel.id), ['custom-first', 'custom-second']);
    f.bindings({ legacy: 'feishu', second: 'custom-second', removed: 'feishu-default' });
    f.migrate();
    assert.equal(f.value('legacy'), true);
    assert.equal(f.value('second'), false);
    assert.equal(f.config.resolve('session.requireMention', { kind: 'session', sessionId: 'removed' }).source, 'defaults');
  } finally { f.clean(); }
});
