import assert from 'node:assert/strict';
import path from 'node:path';
import { fixtureModel } from './codex-app-server-lifecycle.js';

assert.equal(process.env.CODELARK_NATIVE_FIXTURE, '1', '仅允许隔离的验收子进程');
const [endpoint, cwd, action] = process.argv.slice(2);
assert(endpoint && cwd && ['submit', 'resume'].includes(action));
const root = process.env.CODELARK_NATIVE_FIXTURE_ROOT;
assert(root && path.isAbsolute(root));
assert.equal(process.env.HOME, path.join(root, `provider-${action}`, 'home'));
assert.equal(process.env.CODEX_HOME, path.join(root, 'codex'));
assert.equal(process.env.CODELARK_HOME, path.join(root, 'codelark'));
assert.equal(cwd, path.join(root, 'workspace'));
// 先验证隔离路径，再导入会按进程环境确定 registry 路径的生产模块。
const { streamCodexAppServer } = await import('../../src/runtime/codex/app-server-provider.js');
const { prepareCodexAppServerSession, closeCodexAppServerSessions } = await import('../../src/runtime/codex/app-server-registry.js');
const options = { sessionId: 'native-provider-fixture', endpoint, cwd, model: fixtureModel, approvalPolicy: 'never', sandbox: 'read-only' };
try {
  const session = await prepareCodexAppServerSession(options);
  assert(session, '必须选择真正的 app-server backend');
  let output = '';
  if (action === 'submit') {
    const stream = streamCodexAppServer({
      sessionId: options.sessionId, codexThreadId: session.threadId, codexAppServerEndpoint: endpoint,
      workingDirectory: cwd, model: fixtureModel, sandboxMode: 'read-only', permissionMode: 'never',
      runtime: 'codex', prompt: 'NATIVE_PROVIDER_INPUT',
    }, { streamChat() { throw new Error('验收不能退回 legacy/TUI provider'); } });
    for await (const chunk of stream) output += chunk;
    assert(output.includes('NATIVE_PROVIDER_RESPONSE'), 'provider 必须交付真实 CLI 的文本');
    const events = output.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    assert(events.some((event) => event.type === 'done'), 'provider 必须交付完成事件');
    assert(!events.some((event) => event.type === 'error'), output);
  }
  console.log(JSON.stringify({ threadId: session.threadId, endpoint: session.endpoint, action, output }));
} finally {
  closeCodexAppServerSessions();
}
