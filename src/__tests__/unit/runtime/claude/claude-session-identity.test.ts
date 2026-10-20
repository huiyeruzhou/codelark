import '../../../setup/test-setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeLaunchSessionId } from '../../../../runtime/claude/session-identity.js';
import { buildClaudePtyCommand, streamClaudePtyTui, _testOnlyClaudePty } from '../../../../runtime/claude/pty-provider.js';
import { getClaudeProjectDir, getClaudeSessionJsonlById } from '../../../../runtime/claude/session-jsonl.js';

const id = '7b2e7d9d-688a-4697-bf54-2bfdcfec85e9';
test('reads only a unique explicit Claude launch UUID, including shell quoting', () => {
  for (const command of [
    `claude --session-id ${id}`,
    `ccr code --resume '${id}'`,
    `zsh -lc 'source snapshot; exec claude --session-id ${id}'`,
    `cmd /c "claude.cmd --resume ${id}"`,
    `claude --session-id=${id}`,
  ]) assert.equal(parseClaudeLaunchSessionId(command), id, command);
  for (const command of ['claude', `echo ${id}`, 'claude --resume named-session',
    `claude --resume ${id} --session-id ${id}`]) assert.equal(parseClaudeLaunchSessionId(command), null, command);
});
test('launches new Claude and CCR processes with a chosen ID and resumes with the original ID', () => {
  for (const executable of ['claude', 'ccr'] as const) {
    const env = { CODELARK_CLAUDE_CLI_PATH: process.execPath, CODELARK_CCR_CLI_PATH: process.execPath };
    assert.deepEqual(buildClaudePtyCommand(executable, { newSessionId: id, env }).args,
      [...(executable === 'ccr' ? ['code'] : []), '--session-id', id]);
    assert.deepEqual(buildClaudePtyCommand(executable, { claudeSessionId: id, newSessionId: id, env }).args,
      [...(executable === 'ccr' ? ['code'] : []), '--resume', id]);
  }
});
test('rejects a matching filename whose JSONL declares a different Claude identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-id-check-'));
  try {
    const project = getClaudeProjectDir(root, root);
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${id}.jsonl`), JSON.stringify({
      sessionId: '9e55ad25-ffac-4edb-b539-3da7e8d459cc', cwd: root,
      type: 'user', message: { role: 'user', content: 'wrong session' },
    }) + '\n');
    assert.equal(getClaudeSessionJsonlById(id, root, root), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a reused PTY without a caller-supplied ID keeps its own process identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-claude-pty-identity-'));
  const saved = { ...process.env };
  const writes: string[] = [];
  try {
    Object.assign(process.env, {
      CODELARK_CLAUDE_HOME: root,
      CODELARK_CLAUDE_PTY_PROMPT_DELAY_MS: '0', CODELARK_CLAUDE_PTY_SUBMIT_DELAY_MS: '0',
      CODELARK_CLAUDE_PTY_RESPONSE_QUIET_MS: '250', CODELARK_CLAUDE_PTY_RESPONSE_TIMEOUT_MS: '1000',
      CODELARK_CLAUDE_PTY_TRUST_PROMPT_TIMEOUT_MS: '0', CODELARK_CLAUDE_PTY_INPUT_READY_TIMEOUT_MS: '0',
    });
    const project = getClaudeProjectDir(root, root);
    fs.mkdirSync(project, { recursive: true });
    for (const sessionId of [id, '9e55ad25-ffac-4edb-b539-3da7e8d459cc']) {
      const file = path.join(project, `${sessionId}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ sessionId, cwd: root, type: 'user', message: { role: 'user', content: 'task' } }) + '\n');
      fs.utimesSync(file, new Date(), new Date(Date.now() + (sessionId === id ? 1000 : 2000)));
    }
    _testOnlyClaudePty.registerSession('owned-pty', {
      claudeSessionId: id, cwd: root, buffer: 'Claude Code\n❯ \n? for shortcuts',
      child: { write: (text: string) => writes.push(text), kill() {} },
    });
    for (const prompt of ['first prompt', 'follow-up prompt']) {
      let output = '';
      for await (const chunk of streamClaudePtyTui({ sessionId: 'owned-pty', prompt, workingDirectory: root })) output += chunk;
      assert.match(output, new RegExp(id));
      assert.doesNotMatch(output, /9e55ad25-ffac-4edb-b539-3da7e8d459cc|"type":"error"/);
      assert(writes.join('').includes(prompt));
    }
  } finally {
    _testOnlyClaudePty.clear();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
