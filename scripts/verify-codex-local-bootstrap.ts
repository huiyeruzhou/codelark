import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fixtureEnvironment, fixtureModel, startFixtureModel } from './fixtures/codex-app-server-lifecycle.js';

// Real CLI regression: local thread creation must not call a configured model
// service, and its temporary provider override must not leak into the resume.
const execute = promisify(execFile);
const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const executable = option('--cli');
assert(executable && path.isAbsolute(executable), '--cli must name an absolute global Codex executable');
const evidence = path.resolve(option('--evidence') || fs.mkdtempSync(path.join(os.tmpdir(), 'clk-bootstrap-')));
fs.mkdirSync(evidence, { recursive: true });
assert(!fs.existsSync(path.join(evidence, 'codex')), 'use a fresh evidence directory');
const model = await startFixtureModel();
const env = fixtureEnvironment(evidence, model.baseUrl);
Object.assign(env, {
  CODELARK_HOME: path.join(evidence, 'codelark'),
  CODELARK_CODEX_CLI_PATH: executable,
  CODELARK_CODEX_BASE_URL: model.baseUrl,
  CODELARK_CODEX_API_KEY: 'isolated-fixture-key',
});
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
env.USERPROFILE = env.HOME;
env.TEMP = evidence; env.TMP = evidence;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
const { bootstrapLocalCodexThread } = await import('../src/runtime/codex/thread-bootstrap.js');
const { findSessionFileByThreadId } = await import('../src/runtime/codex/tmux-provider.js');
const configPath = path.join(env.CODEX_HOME!, 'config.toml');
const initialConfig = fs.readFileSync(configPath, 'utf8');
const result: Record<string, unknown> = { success: false, executable, evidence };
try {
  result.version = (await execute(executable, ['--version'], { env })).stdout.trim();
  const threadId = await bootstrapLocalCodexThread({
    model: fixtureModel, mode: 'code', sandboxMode: 'read-only',
    workingDirectory: path.join(evidence, 'workspace'), skipGitRepoCheck: true,
  });
  result.threadId = threadId;
  assert.equal(model.requests.length, 0, 'synthetic bootstrap must not call the configured custom provider');
  assert.equal(fs.readFileSync(configPath, 'utf8'), initialConfig, 'bootstrap must not rewrite user configuration');
  const sessionFile = findSessionFileByThreadId(threadId);
  assert(sessionFile);
  assert.doesNotMatch(fs.readFileSync(sessionFile, 'utf8'), /CodeLark local thread bootstrap/);
  model.enqueue({ text: 'CUSTOM_PROVIDER_RESUME_OK' });
  const resumed = await execute(executable, ['exec', 'resume', '--json', '--skip-git-repo-check', threadId, 'REAL_USER_AFTER_LOCAL_BOOTSTRAP'], {
    env, cwd: path.join(evidence, 'workspace'), timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(evidence, 'resume.jsonl'), resumed.stdout);
  fs.writeFileSync(path.join(evidence, 'resume.stderr.log'), resumed.stderr);
  assert.match(resumed.stdout, /CUSTOM_PROVIDER_RESUME_OK/);
  assert.equal(model.requests.length, 1, 'resume must use the original custom provider exactly once');
  assert.match(JSON.stringify(model.requests[0].body.input), /REAL_USER_AFTER_LOCAL_BOOTSTRAP/);
  assert.doesNotMatch(JSON.stringify(model.requests[0].body.input), /CodeLark local thread bootstrap/);
  assert.deepEqual(model.unexpected, []);
  result.success = true;
} catch (error) {
  result.error = String(error);
  process.exitCode = 1;
} finally {
  result.modelRequests = model.requests;
  result.unexpected = model.unexpected;
  await model.close();
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ success: result.success, version: result.version, evidence, error: result.error }));
}
