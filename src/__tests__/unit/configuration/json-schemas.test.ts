import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';

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

  it('documents the current config.toml v2 shape', () => {
    const manifest = readJson(path.join(schemasDir, 'manifest.json')) as {
      files?: Array<Record<string, unknown>>;
    };
    assert.deepEqual(
      manifest.files?.find((entry) => entry.id === 'config.v2'),
      {
        id: 'config.v2',
        path: 'config.toml',
        schema: 'schemas/config.v2.schema.json',
        kind: 'config-toml',
        version: 2,
        versionField: 'schema_version',
        current: true,
        missingFile: 'create-default',
      },
    );

    const schema = readJson(path.join(schemasDir, 'config.v2.schema.json')) as any;
    assert.equal(schema.properties.schema_version.const, 2);
    assert.deepEqual(schema.$defs.runtime.properties.agent.enum, ['codex', 'claude', 'kimi', 'cursor', 'zcode']);
    assert.deepEqual(schema.$defs.codex.properties.provider.enum, ['', 'sdk', 'pty', 'tmux']);
    assert.deepEqual(schema.$defs.codex.properties.reasoning_effort.enum, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.deepEqual(schema.$defs.claude.properties.provider.enum, ['sdk', 'pty', 'tmux']);
    assert.deepEqual(schema.$defs.claude.properties.executable.enum, ['claude', 'ccr']);
    assert.equal(schema.$defs.kimi.properties.provider.const, 'tmux');
    assert.deepEqual(schema.$defs.kimi.properties.thinking_mode.enum, ['default', 'on', 'off']);
    assert.deepEqual(schema.$defs.cursor.properties.reasoning_effort.enum, ['', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(schema.$defs.zcode.properties.provider.const, 'tmux');
    assert.deepEqual(schema.$defs.zcode.properties.mode.enum, ['build', 'edit', 'plan', 'yolo']);
    assert.equal(schema.$defs.channelConfig.properties.stream_status_idle_start_seconds.minimum, 0);
    assert.equal(schema.$defs.channelConfig.properties.group_authorized.type, 'boolean');

    const defaults = parse(fs.readFileSync(path.join(rootDir, 'src', 'configuration', 'defaults.toml'), 'utf-8')) as any;
    assert.equal(defaults.schema_version, 2);
    assert.equal(defaults.runtime.codex.skip_git_repo_check, true);
    assert.equal(defaults.runtime.claude.idle_timeout_minutes, 0);
    assert.equal(defaults.runtime.kimi.provider, 'tmux');
    assert.equal(defaults.runtime.kimi.thinking_mode, 'default');
    assert.equal(defaults.runtime.cursor.reasoning_effort, '');
    assert.equal(defaults.runtime.zcode.provider, 'tmux');
    assert.equal(defaults.runtime.zcode.mode, 'build');
    assert.equal(defaults.channels[0].config.stream_status_check_interval_seconds, 5);
    assert.equal(fs.existsSync(path.join(schemasDir, 'config.v1.schema.json')), false);
  });

  it('documents current audit writes as JSONL entries', () => {
    const manifest = readJson(path.join(schemasDir, 'manifest.json')) as {
      files?: Array<Record<string, unknown>>;
    };
    assert.deepEqual(
      manifest.files?.find((entry) => entry.id === 'data.audit.v1'),
      {
        id: 'data.audit.v1',
        path: 'data/audit.jsonl',
        schema: 'schemas/data/audit.v1.schema.json',
        kind: 'store-jsonl',
        version: 1,
        versionField: null,
        current: true,
        missingFile: 'empty-file',
      },
    );
    const schema = readJson(path.join(schemasDir, 'data', 'audit.v1.schema.json')) as any;
    assert.equal(schema.type, 'object');
    assert.equal(schema.items, undefined);
    assert.deepEqual(
      schema.required,
      ['id', 'createdAt', 'channelType', 'chatId', 'direction', 'messageId', 'summary'],
    );
  });

  it('documents the cached daily version check state', () => {
    const manifest = readJson(path.join(schemasDir, 'manifest.json')) as {
      files?: Array<{ id?: string; path?: string; schema?: string }>;
    };
    assert.deepEqual(
      manifest.files?.find((entry) => entry.id === 'version-check.v1'),
      {
        id: 'version-check.v1',
        path: 'version-check.json',
        schema: 'schemas/version-check.v1.schema.json',
        kind: 'state',
        version: 1,
        versionField: null,
        current: true,
        missingFile: 'empty-object',
      },
    );
    const schema = readJson(path.join(schemasDir, 'version-check.v1.schema.json')) as any;
    assert.deepEqual(schema.required, ['latestVersion', 'ignoredUntilVersion', 'lastCheckedDate']);
    assert.equal(schema.additionalProperties, false);
  });

  it('documents the BridgeSession runtime storage schema', () => {
    const sessionsSchema = readJson(path.join(schemasDir, 'data', 'sessions.v1.schema.json')) as any;
    const bridgeSession = sessionsSchema.$defs.bridgeSession;
    assert.equal(bridgeSession.properties.codex_thread_id, undefined);
    assert.equal(bridgeSession.properties.model, undefined);
    assert.equal(bridgeSession.properties.runtime.$ref, '#/$defs/sessionRuntime');
    assert.equal(sessionsSchema.$defs.sessionRuntime.oneOf.length, 5);
    assert.equal(sessionsSchema.$defs.codexSessionRuntime.properties.codex.properties.threadId.type, 'string');
    assert.equal(sessionsSchema.$defs.codexSessionRuntime.properties.codex.properties.model.type, 'string');
    assert.deepEqual(sessionsSchema.$defs.claudeSessionRuntime.required, ['activeRuntime']);
    assert.equal(sessionsSchema.$defs.claudeSessionRuntime.properties.activeRuntime.const, 'claude');
    assert.deepEqual(sessionsSchema.$defs.claudeSessionRuntime.properties.codex, { not: {} });
    assert.deepEqual(sessionsSchema.$defs.claudeSessionRuntime.properties.claude.properties.provider.enum, ['sdk', 'pty', 'tmux']);
    assert.deepEqual(sessionsSchema.$defs.kimiSessionRuntime.required, ['activeRuntime']);
    assert.equal(sessionsSchema.$defs.kimiSessionRuntime.properties.activeRuntime.const, 'kimi');
    assert.deepEqual(sessionsSchema.$defs.kimiSessionRuntime.properties.codex, { not: {} });
    assert.deepEqual(sessionsSchema.$defs.kimiSessionRuntime.properties.claude, { not: {} });
    assert.deepEqual(sessionsSchema.$defs.kimiSessionRuntime.properties.kimi.properties.provider.enum, ['tmux']);
    assert.equal(sessionsSchema.$defs.cursorSessionRuntime.properties.activeRuntime.const, 'cursor');
    assert.equal(sessionsSchema.$defs.cursorSessionRuntime.properties.cursor.properties.provider.const, 'tmux');
    assert.equal(sessionsSchema.$defs.zcodeSessionRuntime.properties.activeRuntime.const, 'zcode');
    assert.equal(sessionsSchema.$defs.zcodeSessionRuntime.properties.zcode.properties.provider.const, 'tmux');
    assert.deepEqual(sessionsSchema.$defs.zcodeSessionRuntime.properties.zcode.properties.mode.enum, ['build', 'edit', 'plan', 'yolo']);
    assert.equal(sessionsSchema.$defs.sessionRuntimeGeneral.properties.tmuxSessionName.type, 'string');
    assert.ok(JSON.stringify(sessionsSchema.$defs.noRetiredRuntimeTopLevelFields).includes('codex_thread_id'));

    const channelChatsSchema = readJson(path.join(schemasDir, 'data', 'channel-chats.v1.schema.json')) as any;
    assert.equal(channelChatsSchema.$defs.channelChat.properties.runtimeBridgeSessionIds.properties.kimi.type, 'string');
    assert.equal(channelChatsSchema.$defs.channelChat.properties.runtimeBridgeSessionIds.properties.cursor.type, 'string');
    assert.equal(channelChatsSchema.$defs.channelChat.properties.runtimeBridgeSessionIds.properties.zcode.type, 'string');
  });
});
