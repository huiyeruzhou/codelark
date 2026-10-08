import '../../../setup/test-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeCodexAppServerError } from '../../../../runtime/codex/app-server-local.js';

test('service failure explanations classify errno and known failures without copying secrets', () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ code: 'ENOENT' }, /找不到.*CLI/],
    [{ code: 'ENOENT', syscall: 'connect' }, /尚未建立监听 socket/],
    [{ code: 'EADDRINUSE' }, /地址已被占用/],
    [{ code: 'ENOTSOCK' }, /不是 socket/],
    [{ code: 'EACCES' }, /权限不足/],
    [{ message: '地址已被另一份 CODEX_HOME 使用' }, /CODEX_HOME.*不一致/],
    [{ code: -32601 }, /不支持.*协议/],
    [{ message: 'app-server request timed out: thread/start' }, /超时/],
    [{ code: 'ECONNREFUSED' }, /拒绝连接/],
    [{ message: 'mock login rejected' }, /认证失败/],
    [{ stderr: 'mock invalid configuration' }, /配置无效/],
    [{ code: -32000 }, /拒绝.*协议请求/],
  ];
  for (const [error, pattern] of cases) {
    const withSecret = { ...(error as object), cause: { message: 'https://secret-user:secret-key@host/?token=secret-token' } };
    const result = describeCodexAppServerError(withSecret);
    assert.match(result, pattern); assert(!result.includes('secret'));
  }
  assert.match(describeCodexAppServerError(new Error('arbitrary secret'), '会话准备'), /^会话准备失败/);
  assert(!describeCodexAppServerError(new Error('arbitrary secret')).includes('secret'));
});
