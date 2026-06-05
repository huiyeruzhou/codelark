import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('claude-code-router status messages', () => {
  it('emits only the final Router env injection status to the user stream', () => {
    const codeRouterPath = join(__dirname, '../../../../runtime/claude/code-router.ts');
    const sourceCode = readFileSync(codeRouterPath, 'utf-8');

    assert.ok(
      sourceCode.includes("const CCR_ENV_READY_STATUS = '已为Claude Code sdk 注入 Router 环境。';"),
      'Should use the concise final CCR status wording',
    );

    const userStatusMessages = [
      '正在检查 Claude Code Router 环境变量。',
      '已读取 Claude Code Router 环境变量，准备启动 Claude Code。',
      '正在检查 Claude Code Router 服务状态。',
      'Claude Code Router 未运行，正在自动启动。',
      'Claude Code Router 已启动，正在启动 Claude Code。',
      'Claude Code Router 已就绪，正在启动 Claude Code。',
    ];
    for (const message of userStatusMessages) {
      assert.doesNotMatch(
        sourceCode,
        new RegExp(`sseEvent\\('status', \\{ reasoning: '${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' \\}\\)`),
        `Should not emit verbose CCR status: ${message}`,
      );
    }
  });

  it('documents the condensed status sequence', () => {
    const caseRouterStarted = ['已为Claude Code sdk 注入 Router 环境。'];
    const caseRouterAlreadyRunning = ['已为Claude Code sdk 注入 Router 环境。'];

    assert.deepEqual(
      caseRouterStarted,
      ['已为Claude Code sdk 注入 Router 环境。'],
      'Starting CCR should still end with one user-facing status',
    );
    assert.deepEqual(
      caseRouterAlreadyRunning,
      ['已为Claude Code sdk 注入 Router 环境。'],
      'Already-running CCR should emit the same one user-facing status',
    );
  });
});

describe('claude-code-router status message formatting', () => {
  it('keeps the final visible CCR status concise', () => {
    const messages = ['已为Claude Code sdk 注入 Router 环境。'];
    const subsequentContent = '已运行 11秒，↑22k ↓0.0k';

    assert.equal(messages.length, 1);
    assert.equal(messages[0], '已为Claude Code sdk 注入 Router 环境。');
    assert.equal(subsequentContent, '已运行 11秒，↑22k ↓0.0k');
  });
});
