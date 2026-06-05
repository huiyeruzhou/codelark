import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const schemasDir = path.join(rootDir, 'schemas');

function listJsonFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsonFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.json') ? [fullPath] : [];
  });
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

describe('published JSON schemas', () => {
  it('are valid JSON documents', () => {
    const files = listJsonFiles(schemasDir);
    assert.ok(files.length > 0);
    for (const file of files) {
      assert.doesNotThrow(() => readJson(file), path.relative(rootDir, file));
    }
  });

  it('has a manifest whose schema entries point to files in the package', () => {
    const manifest = readJson(path.join(schemasDir, 'manifest.json')) as {
      files?: Array<{ id?: string; schema?: string; current?: boolean }>;
    };
    assert.ok(Array.isArray(manifest.files));
    assert.ok(manifest.files.length > 0);

    for (const entry of manifest.files) {
      assert.equal(typeof entry.id, 'string');
      assert.equal(entry.current, true);
      const schemaPath = entry.schema;
      if (typeof schemaPath !== 'string') {
        assert.fail(`manifest entry ${entry.id || '(unknown)'} is missing schema`);
      }
      assert.ok(fs.existsSync(path.join(rootDir, schemaPath)));
    }

    const pkg = readJson(path.join(rootDir, 'package.json')) as { files?: string[] };
    assert.ok(pkg.files?.includes('schemas/'));
  });

  it('documents the retired thread identity fields', () => {
    const manifest = readJson(path.join(schemasDir, 'manifest.json')) as {
      validationPolicy?: { forbiddenThreadIdentityFields?: string[] };
    };
    assert.deepEqual(
      manifest.validationPolicy?.forbiddenThreadIdentityFields,
      [
        'sdk_session_id',
        'sdkSessionId',
        'desktop_thread_id',
        'desktopThreadId',
        'thread_origin',
        'threadOrigin',
        'thread_id',
        'threadId',
      ],
    );

    const channelChatsSchema = fs.readFileSync(path.join(schemasDir, 'data', 'channel-chats.v1.schema.json'), 'utf-8');
    assert.match(channelChatsSchema, /desktop_thread_id/);
    assert.match(channelChatsSchema, /sdkSessionId/);
    assert.match(channelChatsSchema, /desktopThreadId/);
    assert.match(channelChatsSchema, /codepilotSessionId/);
  });

  it('documents runtime config grouping', () => {
    const configSchema = fs.readFileSync(path.join(schemasDir, 'config.v1.schema.json'), 'utf-8');
    assert.match(configSchema, /codexRuntimeDefaults/);
    assert.match(configSchema, /claudeRuntimeDefaults/);
    assert.match(configSchema, /bridgeControlConfig/);
    assert.match(configSchema, /globalBridgeConfig/);
    assert.match(configSchema, /defaultCodexProvider/);
    const parsed = JSON.parse(configSchema) as any;
    assert.equal(parsed.$defs.runtime.properties.defaultModel, undefined);
    assert.equal(parsed.$defs.runtime.properties.defaultProvider, undefined);
    assert.equal(parsed.$defs.runtime.properties.historyMessageLimit, undefined);
    assert.deepEqual(parsed.$defs.claudeRuntimeDefaults.properties.executable.enum, ['claude', 'ccr']);
    assert.equal(parsed.$defs.codexRuntimeDefaults.properties.executable, undefined);
    assert.deepEqual(parsed.$defs.bridgeControlConfig.properties.defaultCodexProvider.enum, ['sdk', 'pty', 'tmux']);
  });

  it('documents the BridgeSession runtime storage schema', () => {
    const sessionsSchema = readJson(path.join(schemasDir, 'data', 'sessions.v1.schema.json')) as any;
    const bridgeSession = sessionsSchema.$defs.bridgeSession;
    assert.equal(bridgeSession.properties.codex_thread_id, undefined);
    assert.equal(bridgeSession.properties.model, undefined);
    assert.equal(bridgeSession.properties.runtime.$ref, '#/$defs/sessionRuntime');
    assert.equal(sessionsSchema.$defs.sessionRuntime.oneOf.length, 2);
    assert.equal(sessionsSchema.$defs.codexSessionRuntime.properties.codex.properties.threadId.type, 'string');
    assert.equal(sessionsSchema.$defs.codexSessionRuntime.properties.codex.properties.model.type, 'string');
    assert.deepEqual(sessionsSchema.$defs.claudeSessionRuntime.required, ['activeRuntime']);
    assert.equal(sessionsSchema.$defs.claudeSessionRuntime.properties.activeRuntime.const, 'claude');
    assert.deepEqual(sessionsSchema.$defs.claudeSessionRuntime.properties.codex, { not: {} });
    assert.equal(sessionsSchema.$defs.sessionRuntimeGeneral.properties.tmuxSessionName.type, 'string');
    assert.ok(JSON.stringify(sessionsSchema.$defs.noRetiredRuntimeTopLevelFields).includes('codex_thread_id'));
  });
});
