import '../../../setup/test-setup.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  listCodexSessions,
  readCodexSessionJsonlHistoryStreamByFilePath,
  readCodexSessionMessagesByFilePath,
  readCodexSessionEventDeltaByFilePath,
  readCodexSessionEventStreamByFilePath,
  readCodexSessionMirrorRecordDeltaByFilePath,
  readCodexSessionMirrorRecordStreamByFilePath,
} from '../../../../runtime/codex/session-index.js';

const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
});

describe('listCodexSessions', () => {
  it('falls back to the first real user message when session_index has no title', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '03', '24');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const threadId = '019d08ea-d078-7940-bafa-ae28ae13b3fc';
    const cwd = 'D:\\codex\\crm';
    const rolloutPath = path.join(sessionsDir, `rollout-2026-03-24T10-00-00-${threadId}.jsonl`);
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-03-24T02:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-03-24T02:00:00.000Z',
            cwd,
            originator: 'Codex Desktop',
            source: 'vscode',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-24T02:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '这是一套crm工程，请仔细阅读文档和代码，熟悉整个项目的架构和细节。',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const sessions = listCodexSessions(10);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.threadId, threadId);
    assert.match(sessions[0]?.title || '', /^这是一套crm工程/);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not use AGENTS environment context as a fallback title', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '06', '02');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const threadId = '019e8867-2656-7061-afdc-f4d8795381fb';
    const cwd = '/repo/project';
    const rolloutPath = path.join(sessionsDir, `rollout-2026-06-02T20-55-21-${threadId}.jsonl`);
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-06-02T12:55:21.000Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-06-02T12:55:21.000Z',
            cwd,
            originator: 'Codex Desktop',
            source: 'vscode',
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-02T12:55:22.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '# AGENTS.md instructions for /repo/project\n\n<INSTRUCTIONS>\nread docs\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>/repo/project</cwd>\n</environment_context>',
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-02T12:55:23.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '真正的用户请求',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const sessions = listCodexSessions(10);

    assert.equal(sessions[0]?.title, '真正的用户请求');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('includes Desktop exec sessions in the local Codex session list', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '03', '24');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const rolloutPath = path.join(
      sessionsDir,
      'rollout-2026-03-24T13-04-00-019d1e3a-74f9-7e43-92ef-e206eec01f80.jsonl',
    );
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-03-24T05:04:17.166Z',
          type: 'session_meta',
          payload: {
            id: '019d1e3a-74f9-7e43-92ef-e206eec01f80',
            timestamp: '2026-03-24T05:04:00.768Z',
            cwd: 'D:\\codex\\Claude-to-IM-skill',
            originator: 'Codex Desktop',
            source: 'exec',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-24T05:04:17.166Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'Write 6 short paragraphs about background services. No tools.',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const sessions = listCodexSessions(10);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.threadId, '019d1e3a-74f9-7e43-92ef-e206eec01f80');
    assert.equal(sessions[0]?.originator, 'Codex Desktop');
    assert.equal(sessions[0]?.source, 'exec');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('shows CLI exec sessions in the Codex session list', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '03', '24');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const threadId = '019d1e3a-74f9-7e43-92ef-e206eec01f81';
    const rolloutPath = path.join(
      sessionsDir,
      `rollout-2026-03-24T13-04-00-${threadId}.jsonl`,
    );
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-03-24T05:04:17.166Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-03-24T05:04:00.768Z',
            cwd: '/work',
            originator: 'codex_cli',
            source: 'exec',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-24T05:04:17.166Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'hello',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const sessions = listCodexSessions(10);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.threadId, threadId);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('shows user-visible codex-tui CLI sessions by default', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '05', '21');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const threadId = '019e46bc-f466-71d3-a186-a2ce89051958';
    const rolloutPath = path.join(
      sessionsDir,
      `rollout-2026-05-21T02-54-09-${threadId}.jsonl`,
    );
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-05-20T18:55:40.794Z',
          type: 'session_meta',
          payload: {
            id: threadId,
            timestamp: '2026-05-20T18:54:09.001Z',
            cwd: '/data00/home/hongli.fish/Codex/yachio',
            originator: 'codex-tui',
            source: 'cli',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-20T18:55:40.794Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'hello from tui',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const sessions = listCodexSessions(10);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.threadId, threadId);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('ignores session_meta source objects from subagent threads instead of throwing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '04', '02');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const rolloutPath = path.join(
      sessionsDir,
      'rollout-2026-04-02T20-01-32-019d4e11-f45a-7970-b568-946693ff750c.jsonl',
    );
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-04-02T12:01:32.019Z',
          type: 'session_meta',
          payload: {
            id: '019d4e11-f45a-7970-b568-946693ff750c',
            timestamp: '2026-04-02T12:01:32.019Z',
            cwd: 'D:\\codex\\Claude-to-IM-skill',
            originator: 'codex_sdk_ts',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: '019d3de4-856e-7dd1-a16e-7a2d84926775',
                  depth: 1,
                  agent_nickname: 'Curie',
                  agent_role: 'explorer',
                },
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-02T12:01:33.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '请分析这个子任务',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const sessions = listCodexSessions(10);

    assert.deepEqual(sessions, []);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('hides Codex threads whose cwd points at the internal skills workspace', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '03', '24');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const rolloutPath = path.join(
      sessionsDir,
      'rollout-2026-03-24T10-13-10-019d1d9e-0be2-7053-886d-ff078ef17084.jsonl',
    );
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-03-24T02:13:10.245Z',
          type: 'session_meta',
          payload: {
            id: '019d1d9e-0be2-7053-886d-ff078ef17084',
            timestamp: '2026-03-24T02:13:10.245Z',
            cwd: path.join(tempRoot, 'skills', 'codelark'),
            originator: 'Codex Desktop',
            source: 'vscode',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-24T02:13:11.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '请阅读和了解这个项目',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const sessions = listCodexSessions(12);

    assert.equal(sessions.length, 0);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not restrict local Codex sessions to Desktop saved workspace roots', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '03', '24');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const visibleThreadId = '019cdc07-1238-7573-a42a-e5f2341f00b9';
    const hiddenThreadId = '019cdb48-d2a3-7821-83dd-14a61f629760';
    for (const [threadId, cwd, title] of [
      [visibleThreadId, 'C:\\Users\\zhangle\\MiniProgramProjects\\miniprogram-1', '保留的Codex 项目'],
      [hiddenThreadId, 'D:\\codex\\dinosaur', '已移除的Codex 项目'],
    ] as const) {
      const rolloutPath = path.join(sessionsDir, `rollout-2026-03-24T10-00-00-${threadId}.jsonl`);
      fs.writeFileSync(
        rolloutPath,
        [
          JSON.stringify({
            timestamp: '2026-03-24T02:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: threadId,
              timestamp: '2026-03-24T02:00:00.000Z',
              cwd,
              originator: 'Codex Desktop',
              source: 'vscode',
            },
          }),
          JSON.stringify({
            timestamp: '2026-03-24T02:00:01.000Z',
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: title,
            },
          }),
        ].join('\n'),
        'utf-8',
      );
    }

    fs.writeFileSync(
      path.join(tempRoot, '.codex-global-state.json'),
      JSON.stringify({
        'electron-saved-workspace-roots': ['C:\\Users\\zhangle\\MiniProgramProjects\\miniprogram-1'],
      }),
      'utf-8',
    );

    const sessions = listCodexSessions();

    assert.deepEqual(
      sessions.map((session) => session.threadId).sort(),
      [hiddenThreadId, visibleThreadId].sort(),
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not restrict local Codex sessions to the Codex state db thread list', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-sessions-'));
    process.env.CODEX_HOME = tempRoot;

    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '03', '26');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const visibleThreadId = '019d2303-06e4-73e2-8857-00444446ceb0';
    const freshThreadId = '019d27aa-5d8d-7ab3-89df-3d28fed5730a';
    const staleThreadId = '019cdb48-d2a3-7821-83dd-14a61f629760';

    for (const [threadId, title] of [
      [visibleThreadId, '当前 Codex 可见会话'],
      [freshThreadId, '测试工程2'],
      [staleThreadId, '已经不在 Codex 列表里的旧会话'],
    ] as const) {
      const rolloutPath = path.join(sessionsDir, `rollout-2026-03-26T09-00-00-${threadId}.jsonl`);
      fs.writeFileSync(
        rolloutPath,
        [
          JSON.stringify({
            timestamp: '2026-03-26T01:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: threadId,
              timestamp: '2026-03-26T01:00:00.000Z',
              cwd: 'D:\\codex\\test',
              originator: 'Codex Desktop',
              source: 'vscode',
            },
          }),
          JSON.stringify({
            timestamp: '2026-03-26T01:00:01.000Z',
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: title,
            },
          }),
        ].join('\n'),
        'utf-8',
      );
    }

    fs.writeFileSync(
      path.join(tempRoot, 'session_index.jsonl'),
      [
        JSON.stringify({
          id: visibleThreadId,
          thread_name: '当前 Codex 可见会话',
          updated_at: '2026-03-26T01:00:00.000Z',
        }),
        JSON.stringify({
          id: staleThreadId,
          thread_name: '已经不在 Codex 列表里的旧会话',
          updated_at: '2026-03-25T01:00:00.000Z',
        }),
        JSON.stringify({
          id: freshThreadId,
          thread_name: '测试工程2',
          updated_at: '2026-03-26T01:03:12.626Z',
        }),
      ].join('\n'),
      'utf-8',
    );

    const db = new DatabaseSync(path.join(tempRoot, 'state_5.sqlite'));
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        archived INTEGER NOT NULL,
        source TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO threads (id, updated_at, archived, source) VALUES (?, ?, 0, 'vscode')`)
      .run(visibleThreadId, Math.floor(Date.parse('2026-03-26T01:00:00.000Z') / 1000));
    db.close();

    const sessions = listCodexSessions(10);
    const threadIds = sessions.map((session) => session.threadId).sort();

    assert.deepEqual(threadIds, [freshThreadId, staleThreadId, visibleThreadId].sort());

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

describe('readCodexSessionEventStreamByFilePath', () => {
  it('builds display messages from the shared JSONL history parser', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-messages-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-28T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'thread-1',
            cwd: '/tmp/project',
            originator: 'Codex CLI',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '用户消息' },
        }),
        JSON.stringify({
          timestamp: '2026-05-28T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: '助手回复' },
        }),
        JSON.stringify({
          timestamp: '2026-05-28T00:00:02.001Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '助手回复' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-28T00:00:03.000Z',
          type: 'event_msg',
          payload: { type: 'agent_reasoning', text: '内部推理摘要' },
        }),
        JSON.stringify({
          timestamp: '2026-05-28T00:00:04.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete', last_agent_message: '最终答案' },
        }),
      ].join('\n'),
      'utf-8',
    );

    const messages = readCodexSessionMessagesByFilePath(filePath, 10);

    assert.deepEqual(messages, [
      { role: 'user', content: '用户消息' },
      { role: 'assistant', content: '助手回复' },
      { role: 'assistant', content: '[commentary]\n内部推理摘要' },
      { role: 'assistant', content: '最终答案' },
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns the newest JSONL messages in chronological order when limited', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-message-limit-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-28T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '第一条' },
        }),
        JSON.stringify({
          timestamp: '2026-05-28T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: '第二条' },
        }),
        JSON.stringify({
          timestamp: '2026-05-28T00:00:03.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '第三条' },
        }),
        JSON.stringify({
          timestamp: '2026-05-28T00:00:04.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: '第四条' },
        }),
      ].join('\n'),
      'utf-8',
    );

    const messages = readCodexSessionMessagesByFilePath(filePath, 2);

    assert.deepEqual(messages, [
      { role: 'user', content: '第三条' },
      { role: 'assistant', content: '第四条' },
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('falls back to task_complete.last_agent_message for final answers', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-events-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'hello',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: 'final answer',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const events = readCodexSessionEventStreamByFilePath(filePath);

    assert.deepEqual(
      events.map((event) => ({ role: event.role, content: event.content })),
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'final answer' },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves markdown-style line breaks from task_complete.last_agent_message', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-events-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: '结论：\n- 第一项\n- 第二项\n\n下一步：继续验证',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const events = readCodexSessionEventStreamByFilePath(filePath);

    assert.deepEqual(
      events.map((event) => ({ role: event.role, content: event.content })),
      [
        {
          role: 'assistant',
          content: '结论：\n- 第一项\n- 第二项\n\n下一步：继续验证',
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves line breaks from Codex user_message events', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-events-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '第一行\n第二行\n\n第三行',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const events = readCodexSessionEventStreamByFilePath(filePath);

    assert.deepEqual(
      events.map((event) => ({ role: event.role, content: event.content })),
      [
        {
          role: 'user',
          content: '第一行\n第二行\n\n第三行',
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reads agent_message event records without duplicating the matching response_item message', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-events-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: '正在检查新版格式',
            phase: 'commentary',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.001Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: '正在检查新版格式' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const events = readCodexSessionEventStreamByFilePath(filePath);

    assert.deepEqual(
      events.map((event) => ({ role: event.role, content: event.content })),
      [{ role: 'commentary', content: '正在检查新版格式' }],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reads only appended complete lines and preserves trailing partial text', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-events-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const firstLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'hello',
      },
    });
    const secondLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        last_agent_message: 'final answer',
      },
    });
    fs.writeFileSync(filePath, `${firstLine}\n${secondLine.slice(0, 40)}`, 'utf-8');

    const firstDelta = readCodexSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);

    assert.deepEqual(
      firstDelta.events.map((event) => ({ role: event.role, content: event.content })),
      [{ role: 'user', content: 'hello' }],
    );
    assert.equal(firstDelta.trailingText, secondLine.slice(0, 40));

    fs.appendFileSync(filePath, `${secondLine.slice(40)}\n`, 'utf-8');
    const secondDelta = readCodexSessionEventDeltaByFilePath(
      filePath,
      firstDelta.nextOffset,
      fs.statSync(filePath).size,
      firstDelta.trailingText,
    );

    assert.deepEqual(
      secondDelta.events.map((event) => ({ role: event.role, content: event.content })),
      [{ role: 'assistant', content: 'final answer' }],
    );
    assert.equal(secondDelta.trailingText, '');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

describe('readCodexSessionMirrorRecordStreamByFilePath', () => {
  it('prefers explicit user_prompt for mirror user records when present', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-user-prompt-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '<codex_internal_context source="goal">wrapped system event</codex_internal_context>',
            user_prompt: '用户原始输入',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(records.map((record) => ({
      type: record.type,
      role: record.role,
      content: record.content,
      userPrompt: record.userPrompt,
    })), [{
      type: 'message',
      role: 'user',
      content: '用户原始输入',
      userPrompt: '用户原始输入',
    }]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves task lifecycle records for mirror delivery', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-1',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell_command',
            call_id: 'call-1',
            arguments: '{"command":"dir"}',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.500Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-1',
            output: 'Exit code: 0',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.700Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'thinking' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'final answer' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            last_agent_message: 'final answer',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        role: record.role,
        content: record.content,
        turnId: record.turnId,
      })),
      [
        { type: 'task_started', role: undefined, content: '', turnId: 'turn-1' },
        { type: 'tool_started', role: undefined, content: '', turnId: 'turn-1' },
        { type: 'tool_finished', role: undefined, content: 'Exit code: 0', turnId: 'turn-1' },
        { type: 'message', role: 'commentary', content: 'thinking', turnId: 'turn-1' },
        { type: 'message', role: 'assistant', content: 'final answer', turnId: 'turn-1' },
        { type: 'task_complete', role: 'assistant', content: 'final answer', turnId: 'turn-1' },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps task_complete records even when last_agent_message is empty', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            last_agent_message: '',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(records, [
      {
        signature: records[0]?.signature,
        type: 'task_complete',
        role: 'assistant',
        content: '',
        timestamp: '2026-03-25T00:00:00.000Z',
        turnId: 'turn-1',
      },
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves markdown-style line breaks in mirror task_complete records', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            last_agent_message: '结论：\n1. 第一项\n2. 第二项',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(records, [
      {
        signature: records[0]?.signature,
        type: 'task_complete',
        role: 'assistant',
        content: '结论：\n1. 第一项\n2. 第二项',
        timestamp: '2026-03-25T00:00:00.000Z',
        turnId: 'turn-1',
      },
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves line breaks in mirror user messages', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '第一行\n第二行\n\n第三行',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(records, [
      {
        signature: records[0]?.signature,
        type: 'message',
        role: 'user',
        content: '第一行\n第二行\n\n第三行',
        timestamp: '2026-03-25T00:00:00.000Z',
      },
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('extracts text from structured function_call_output payloads without crashing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-structured',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-structured',
            output: [
              { type: 'input_text', text: 'App terminal snapshot for this thread:' },
              { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
              { type: 'input_text', text: 'cwd: D:\\codex\\demo' },
            ],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        content: record.content,
        turnId: record.turnId,
        toolId: record.toolId,
      })),
      [
        {
          type: 'task_started',
          content: '',
          turnId: 'turn-structured',
          toolId: undefined,
        },
        {
          type: 'tool_finished',
          content: 'App terminal snapshot for this thread: cwd: D:\\codex\\demo',
          turnId: 'turn-structured',
          toolId: 'call-structured',
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('extracts text from structured task_complete payloads', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-structured-complete',
            last_agent_message: [
              { type: 'output_text', text: '结论：' },
              { type: 'output_text', text: '- 第一项' },
              { type: 'output_text', text: '- 第二项' },
            ],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(records, [
      {
        signature: records[0]?.signature,
        type: 'task_complete',
        role: 'assistant',
        content: '结论：\n\n- 第一项\n\n- 第二项',
        timestamp: '2026-03-25T00:00:00.000Z',
        turnId: 'turn-structured-complete',
      },
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses reasoning, plan updates, and web search completion into mirror records', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-plan',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.500Z',
          type: 'event_msg',
          payload: {
            type: 'agent_reasoning',
            text: '先检查日志，再确认线程状态',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            call_id: 'plan-1',
            arguments: JSON.stringify({
              plan: [
                { step: '检查日志', status: 'completed' },
                { step: '确认线程状态', status: 'in_progress' },
                { step: '补回归测试', status: 'pending' },
              ],
            }),
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.500Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'plan-1',
            output: 'ignored output',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'web_search_end',
            call_id: 'search-1',
            query: 'codex sdk latest',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        content: record.content,
        turnId: record.turnId,
        toolId: record.toolId,
        toolName: record.toolName,
        tasks: record.tasks,
      })),
      [
        {
          type: 'task_started',
          content: '',
          turnId: 'turn-plan',
          toolId: undefined,
          toolName: undefined,
          tasks: undefined,
        },
        {
          type: 'reasoning',
          content: '先检查日志，再确认线程状态',
          turnId: 'turn-plan',
          toolId: undefined,
          toolName: undefined,
          tasks: undefined,
        },
        {
          type: 'plan_update',
          content: '',
          turnId: 'turn-plan',
          toolId: undefined,
          toolName: undefined,
          tasks: [
            { text: '检查日志', status: 'completed' },
            { text: '确认线程状态', status: 'in_progress' },
            { text: '补回归测试', status: 'pending' },
          ],
        },
        {
          type: 'tool_finished',
          content: 'codex sdk latest',
          turnId: 'turn-plan',
          toolId: 'search-1',
          toolName: 'Web Search',
          tasks: undefined,
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('unwraps GPT-5.6 exec orchestration into bash and diff tool displays', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-gpt56-tools-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const patchText = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '+const enabled = true;',
      '*** End Patch',
    ].join('\n');
    fs.writeFileSync(
      filePath,
      [
        {
          timestamp: '2026-07-23T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-gpt56' },
        },
        {
          timestamp: '2026-07-23T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'call-shell',
            input: [
              'const r = await tools.exec_command({"cmd":"npm test","workdir":"/tmp/project","yield_time_ms":10000});',
              'text(r.output);',
            ].join('\n'),
          },
        },
        {
          timestamp: '2026-07-23T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'call-shell',
            output: [
              { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
              { type: 'input_text', text: 'tests passed' },
            ],
          },
        },
        {
          timestamp: '2026-07-23T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'call-patch',
            input: `const patch = ${JSON.stringify(patchText)};\ntext(await tools.apply_patch(patch));`,
          },
        },
        {
          timestamp: '2026-07-23T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'call-patch',
            output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n{}' }],
          },
        },
        {
          timestamp: '2026-07-23T00:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'call-multiple',
            input: [
              `const patch = ${JSON.stringify(patchText)};`,
              'const results = await Promise.all([',
              '  tools.exec_command({ cmd: "pwd", workdir: "/tmp/project" }),',
              '  tools.apply_patch(patch),',
              ']);',
              'text(results.length);',
            ].join('\n'),
          },
        },
        {
          timestamp: '2026-07-23T00:00:06.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'call-multiple',
            output: [{ type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n2' }],
          },
        },
      ].map((line) => JSON.stringify(line)).join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);
    const shellStart = records.find((record) => record.type === 'tool_started' && record.toolId === 'call-shell');
    const shellFinish = records.find((record) => record.type === 'tool_finished' && record.toolId === 'call-shell');
    const patchStart = records.find((record) => record.type === 'tool_started' && record.toolId === 'call-patch');
    const multiStart = records.find((record) => record.type === 'tool_started' && record.toolId === 'call-multiple');
    assert.equal(shellStart?.toolName, 'exec_command');
    assert.deepEqual(shellStart?.toolDetail, {
      kind: 'exec_command',
      command: 'npm test',
      workdir: '/tmp/project',
    });
    assert.equal(shellFinish?.toolName, undefined);
    assert.equal(shellFinish?.content, 'Script completed\nWall time 0.2 seconds\nOutput:\ntests passed');
    assert.equal(patchStart?.toolName, 'apply_patch');
    assert.equal(patchStart?.toolDetail?.kind, 'patch_apply');
    assert.equal(patchStart?.toolDetail?.kind === 'patch_apply' ? patchStart.toolDetail.patchText : '', patchText);
    assert.equal(multiStart?.toolName, 'tools × 2');
    assert.deepEqual(multiStart?.toolDetail, {
      kind: 'orchestration',
      calls: [
        {
          name: 'exec_command',
          detail: { kind: 'exec_command', command: 'pwd', workdir: '/tmp/project' },
        },
        {
          name: 'apply_patch',
          detail: {
            kind: 'patch_apply',
            patchText,
            files: [{ path: 'src/app.ts', action: 'update' }],
          },
        },
      ],
    });

    const history = readCodexSessionJsonlHistoryStreamByFilePath(filePath)
      .map((entry) => entry.content)
      .join('\n\n');
    assert.match(history, /exec_command[\s\S]*```bash\nnpm test\n```/);
    assert.match(history, /apply_patch[\s\S]*```diff\n\*\*\* Begin Patch/);
    assert.match(history, /tools × 2[\s\S]*1\. `exec_command`[\s\S]*```bash\npwd\n```/);
    assert.match(history, /tools × 2[\s\S]*2\. `apply_patch`[\s\S]*```diff\n\*\*\* Begin Patch/);
    assert.doesNotMatch(history, /```json\nconst r = await tools\.exec_command/);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses current Codex Codex tool and reasoning events into mirror records', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-current',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: '先检查新版 Codex 事件格式' }],
            content: null,
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'exec_command_end',
            call_id: 'call-shell',
            turn_id: 'turn-current',
            command: ['pwsh', '-Command', 'npm test'],
            aggregated_output: 'tests passed',
            exit_code: 0,
            status: 'completed',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'patch_apply_end',
            call_id: 'call-patch',
            turn_id: 'turn-current',
            success: true,
            status: 'completed',
            changes: {
              'D:\\codex\\Claude-to-IM-skill\\src\\codex-session-index.ts': {
                type: 'update',
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'tool_search_call',
            call_id: 'call-tool-search',
            status: 'completed',
            execution: 'client',
            arguments: { query: 'browser inspect' },
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'tool_search_output',
            call_id: 'call-tool-search',
            status: 'completed',
            execution: 'client',
            tools: [{ name: 'mcp__playwright__', tools: [{ name: 'browser_snapshot' }] }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:06.000Z',
          type: 'event_msg',
          payload: {
            type: 'dynamic_tool_call_request',
            callId: 'call-dynamic',
            turnId: 'turn-current',
            tool: 'read_thread_terminal',
            arguments: {},
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:07.000Z',
          type: 'event_msg',
          payload: {
            type: 'dynamic_tool_call_response',
            call_id: 'call-dynamic',
            turn_id: 'turn-current',
            tool: 'read_thread_terminal',
            content_items: [{ type: 'inputText', text: 'terminal output' }],
            success: false,
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        content: record.content,
        turnId: record.turnId,
        toolId: record.toolId,
        toolName: record.toolName,
        isError: record.isError,
      })),
      [
        {
          type: 'task_started',
          content: '',
          turnId: 'turn-current',
          toolId: undefined,
          toolName: undefined,
          isError: undefined,
        },
        {
          type: 'reasoning',
          content: '先检查新版 Codex 事件格式',
          turnId: 'turn-current',
          toolId: undefined,
          toolName: undefined,
          isError: undefined,
        },
        {
          type: 'tool_finished',
          content: 'tests passed',
          turnId: 'turn-current',
          toolId: 'call-shell',
          toolName: 'Bash',
          isError: false,
        },
        {
          type: 'tool_finished',
          content: 'update: D:\\codex\\Claude-to-IM-skill\\src\\codex-session-index.ts',
          turnId: 'turn-current',
          toolId: 'call-patch',
          toolName: 'apply_patch',
          isError: false,
        },
        {
          type: 'tool_started',
          content: '',
          turnId: 'turn-current',
          toolId: 'call-tool-search',
          toolName: 'tool_search',
          isError: undefined,
        },
        {
          type: 'tool_finished',
          content: 'Found 1 tools: mcp__playwright__',
          turnId: 'turn-current',
          toolId: 'call-tool-search',
          toolName: 'tool_search',
          isError: false,
        },
        {
          type: 'tool_started',
          content: '',
          turnId: 'turn-current',
          toolId: 'call-dynamic',
          toolName: 'read_thread_terminal',
          isError: undefined,
        },
        {
          type: 'tool_finished',
          content: 'terminal output',
          turnId: 'turn-current',
          toolId: 'call-dynamic',
          toolName: 'read_thread_terminal',
          isError: true,
        },
      ],
    );

    const shell = records.find((record) => record.toolId === 'call-shell');
    assert.deepEqual(shell?.toolDetail, {
      kind: 'exec_command',
      command: 'pwsh -Command npm test',
      exitCode: 0,
      output: 'tests passed',
      rawOutput: 'tests passed',
    });

    const toolSearch = records.find((record) => record.toolId === 'call-tool-search' && record.type === 'tool_finished');
    assert.equal(toolSearch?.toolDetail?.kind, 'tool_search');
    assert.equal(toolSearch?.toolDetail?.foundCount, 1);
    assert.deepEqual(toolSearch?.toolDetail?.namespaces, ['mcp__playwright__']);
    assert.deepEqual(toolSearch?.toolDetail?.toolNames, ['browser_snapshot']);

    const dynamic = records.find((record) => record.toolId === 'call-dynamic' && record.type === 'tool_finished');
    assert.deepEqual(dynamic?.toolDetail, {
      kind: 'dynamic',
      tool: 'read_thread_terminal',
      errorText: 'terminal output',
    });

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves namespaced Codex tool names', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-tool-namespace',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            namespace: 'mcp__playwright__',
            name: 'browser_resize',
            call_id: 'call-namespaced',
            arguments: '{"width":1280,"height":720}',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        toolId: record.toolId,
        toolName: record.toolName,
      })),
      [
        {
          type: 'task_started',
          toolId: undefined,
          toolName: undefined,
        },
        {
          type: 'tool_started',
          toolId: 'call-namespaced',
          toolName: 'mcp__playwright__browser_resize',
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('falls back to reasoning content when summary is empty', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-reasoning-fallback',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'reasoning',
            summary: [],
            content: [{ type: 'summary_text', text: 'fallback reasoning content' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({ type: record.type, content: record.content })),
      [
        { type: 'task_started', content: '' },
        { type: 'reasoning', content: 'fallback reasoning content' },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses custom tool output and clears turn context after turn_aborted', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-abort',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'shell_command',
            call_id: 'custom-1',
            input: '{"command":"dir"}',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.500Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'custom-1',
            output: JSON.stringify({ output: 'Exit code: 0' }),
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'turn_aborted',
            turn_id: 'turn-abort',
            reason: 'user interrupted',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'next turn output' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const records = readCodexSessionMirrorRecordStreamByFilePath(filePath);

    assert.deepEqual(
      records.map((record) => ({
        type: record.type,
        content: record.content,
        turnId: record.turnId,
        toolId: record.toolId,
        toolName: record.toolName,
      })),
      [
        {
          type: 'task_started',
          content: '',
          turnId: 'turn-abort',
          toolId: undefined,
          toolName: undefined,
        },
        {
          type: 'tool_started',
          content: '',
          turnId: 'turn-abort',
          toolId: 'custom-1',
          toolName: 'shell_command',
        },
        {
          type: 'tool_finished',
          content: 'Exit code: 0',
          turnId: 'turn-abort',
          toolId: 'custom-1',
          toolName: undefined,
        },
        {
          type: 'task_aborted',
          content: '任务已中断。',
          turnId: 'turn-abort',
          toolId: undefined,
          toolName: undefined,
        },
        {
          type: 'message',
          content: 'next turn output',
          turnId: undefined,
          toolId: undefined,
          toolName: undefined,
        },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves update_plan special call state across incremental mirror reads', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const firstChunk = [
      JSON.stringify({
        timestamp: '2026-03-25T00:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-plan-split',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          call_id: 'plan-split-1',
          arguments: JSON.stringify({
            plan: [
              { step: '检查日志', status: 'in_progress' },
              { step: '确认线程状态', status: 'pending' },
            ],
          }),
        },
      }),
    ].join('\n');
    fs.writeFileSync(filePath, `${firstChunk}\n`, 'utf-8');

    const firstDelta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(firstDelta.records.map((record) => record.type), ['task_started', 'plan_update']);
    assert.equal(firstDelta.nextTurnId, 'turn-plan-split');
    assert.deepEqual(firstDelta.nextSpecialCallIds, ['plan-split-1']);
    assert.deepEqual(firstDelta.unknownKinds, []);

    fs.appendFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-03-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'plan-split-1',
          output: 'ignored output',
        },
      }),
      JSON.stringify({
        timestamp: '2026-03-25T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '继续执行' }],
        },
      }),
      '',
    ].join('\n'), 'utf-8');

    const secondDelta = readCodexSessionMirrorRecordDeltaByFilePath(
      filePath,
      firstDelta.nextOffset,
      fs.statSync(filePath).size,
      firstDelta.trailingText,
      firstDelta.nextTurnId,
      firstDelta.nextSpecialCallIds,
    );

    assert.deepEqual(
      secondDelta.records.map((record) => ({ type: record.type, content: record.content })),
      [{ type: 'message', content: '继续执行' }],
    );
    assert.deepEqual(secondDelta.nextSpecialCallIds, []);
    assert.deepEqual(secondDelta.unknownKinds, []);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('surfaces unknown Codex mirror event kinds for diagnostics without crashing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-25T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'approval_request_started',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-25T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'approval_request',
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(delta.records, []);
    assert.deepEqual(delta.unknownKinds.sort(), [
      'event_msg:approval_request_started',
      'response_item:approval_request',
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('surfaces Codex Codex context compaction as a commentary notice', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'context_compacted' },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.equal(delta.unknownKinds.length, 0);
    assert.equal(delta.records.length, 1);
    assert.equal(delta.records[0]?.type, 'message');
    assert.equal(delta.records[0]?.role, 'commentary');
    assert.equal(delta.records[0]?.content, '> ⚙️ 上下文已压缩，后续回复会基于压缩后的上下文继续。');

    const eventDelta = readCodexSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.equal(eventDelta.events[0]?.role, 'commentary');
    assert.equal(eventDelta.events[0]?.content, '> ⚙️ 上下文已压缩，后续回复会基于压缩后的上下文继续。');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('rewrites AGENTS environment context user messages to a quoted system notice', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const environmentContext = '# AGENTS.md instructions for /repo/project\n\n<INSTRUCTIONS>\nread docs\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>/repo/project</cwd>\n</environment_context>';
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-06-02T12:55:22.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: environmentContext }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-02T12:55:23.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: environmentContext,
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(delta.records.map((record) => record.role), ['system']);
    assert.deepEqual(delta.records.map((record) => record.content), [
      '> ⚙️ 环境上下文已加载',
    ]);
    assert.doesNotMatch(JSON.stringify(delta.records), /AGENTS\.md instructions/);

    const eventDelta = readCodexSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(eventDelta.events.map((event) => event.role), ['system']);
    assert.deepEqual(eventDelta.events.map((event) => event.content), [
      '> ⚙️ 环境上下文已加载',
    ]);

    const historyEntries = readCodexSessionJsonlHistoryStreamByFilePath(filePath);
    assert.deepEqual(historyEntries.map((entry) => entry.role), ['system', 'system']);
    const history = readCodexSessionMessagesByFilePath(filePath, 10);
    assert.deepEqual(history, []);
    assert.doesNotMatch(JSON.stringify(history), /AGENTS\.md instructions/);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('rewrites standalone environment context user messages to a quoted system notice', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const environmentContext = '<environment_context>\n  <current_date>2026-06-03</current_date>\n  <timezone>PRC</timezone>\n  <filesystem><workspace_roots><root>/repo/project</root></workspace_roots></filesystem>\n</environment_context>';
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-06-03T00:02:42.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: environmentContext }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-03T00:02:43.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: environmentContext,
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(delta.records.map((record) => record.role), ['system']);
    assert.deepEqual(delta.records.map((record) => record.content), [
      '> ⚙️ 环境上下文已加载',
    ]);
    assert.doesNotMatch(JSON.stringify(delta.records), /environment_context/);

    const eventDelta = readCodexSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(eventDelta.events.map((event) => event.role), ['system']);
    assert.deepEqual(eventDelta.events.map((event) => event.content), [
      '> ⚙️ 环境上下文已加载',
    ]);

    const historyEntries = readCodexSessionJsonlHistoryStreamByFilePath(filePath);
    assert.deepEqual(historyEntries.map((entry) => entry.role), ['system', 'system']);
    const history = readCodexSessionMessagesByFilePath(filePath, 10);
    assert.deepEqual(history, []);
    assert.doesNotMatch(JSON.stringify(history), /environment_context/);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('ignores known Codex Codex bookkeeping events without reporting unknown kinds', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: {}, rate_limits: {} },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'thread_name_updated', thread_name: '新标题' },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:03.000Z',
          type: 'event_msg',
          payload: { type: 'thread_rolled_back', num_turns: 1 },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:04.000Z',
          type: 'response_item',
          payload: { type: 'web_search_call', status: 'completed' },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'internal developer instruction' }],
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(delta.records, []);
    assert.deepEqual(delta.unknownKinds, []);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('renders Codex CLI update events without reporting unknown kinds', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-06-03T02:31:52.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-update-1',
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-03T02:31:53.000Z',
          type: 'event_msg',
          payload: {
            type: 'update_cli',
            status: 'in_progress',
            current_version: '0.135.0',
            latest_version: '0.136.0',
            message: 'Updating Codex CLI after user confirmation.',
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(delta.unknownKinds, []);
    assert.deepEqual(delta.records.map((record) => ({
      type: record.type,
      role: record.role,
      content: record.content,
      turnId: record.turnId,
    })), [
      {
        type: 'task_started',
        role: undefined,
        content: '',
        turnId: 'turn-update-1',
      },
      {
        type: 'message',
        role: 'commentary',
        content: [
          'Codex CLI update',
          'Version: 0.135.0 -> 0.136.0',
          'Status: in_progress',
          'Updating Codex CLI after user confirmation.',
        ].join('\n'),
        turnId: 'turn-update-1',
      },
    ]);

    const eventDelta = readCodexSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(eventDelta.events.map((event) => ({
      role: event.role,
      content: event.content,
    })), [
      {
        role: 'commentary',
        content: [
          'Codex CLI update',
          'Version: 0.135.0 -> 0.136.0',
          'Status: in_progress',
          'Updating Codex CLI after user confirmation.',
        ].join('\n'),
      },
    ]);

    const history = readCodexSessionMessagesByFilePath(filePath, 10);
    assert.deepEqual(history.map((message) => ({
      role: message.role,
      content: message.content,
    })), [
      {
        role: 'assistant',
        content: `[commentary]\n${[
          'Codex CLI update',
          'Version: 0.135.0 -> 0.136.0',
          'Status: in_progress',
          'Updating Codex CLI after user confirmation.',
        ].join('\n')}`,
      },
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('turns Codex goal updates into mirror goal status and hides goal context user messages', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-06-02T11:49:50.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: '<codex_internal_context source="goal">\nlong internal context\n</codex_internal_context>',
            }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-02T11:49:51.000Z',
          type: 'event_msg',
          payload: {
            type: 'thread_goal_updated',
            turnId: 'turn-goal-1',
            goal: {
              status: 'active',
              objective: '结合日志分析 mirror goal 事件',
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-02T11:49:52.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '开始分析。' }],
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(delta.unknownKinds, []);
    assert.equal(delta.records.length, 2);
    assert.equal(delta.records[0]?.type, 'goal_status');
    assert.equal(delta.records[0]?.goalStatus, 'active');
    assert.equal(delta.records[0]?.goalObjective, '结合日志分析 mirror goal 事件');
    assert.equal(delta.records[0]?.content, '结合日志分析 mirror goal 事件');
    assert.equal(delta.records[0]?.turnId, 'turn-goal-1');
    assert.equal(delta.records[1]?.type, 'message');
    assert.equal(delta.records[1]?.role, 'assistant');
    assert.doesNotMatch(JSON.stringify(delta.records), /codex_internal_context/);

    const eventDelta = readCodexSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(eventDelta.events.map((event) => event.content), [
      'Goal Active\n\n结合日志分析 mirror goal 事件',
      '开始分析。',
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves long active goal text for Feishu collapsed rendering', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-goal-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const objective = '开发一下：goal active的时候只打印一条提示，任务本体只打印一小段，剩下的用省略号，完成后merge回master并删除worktree';
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        timestamp: '2026-06-02T12:56:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'thread_goal_updated',
          goal: {
            status: 'active',
            objective,
          },
        },
      }) + '\n',
      'utf-8',
    );

    const delta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.equal(delta.records[0]?.type, 'goal_status');
    assert.equal(delta.records[0]?.goalStatus, 'active');
    assert.equal(delta.records[0]?.goalObjective, objective);
    assert.equal(delta.records[0]?.content, objective);

    const eventDelta = readCodexSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.equal(eventDelta.events[0]?.content, `Goal Active\n\n${objective}`);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves multiline active goal text in session event display', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-goal-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        timestamp: '2026-06-02T12:56:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'thread_goal_updated',
          goal: {
            status: 'active',
            objective: '优化 toolcall 展示\nworkdir: /repo/a\nSuccess with exit code 0 in 0ms.',
          },
        },
      }) + '\n',
      'utf-8',
    );

    const eventDelta = readCodexSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.equal(eventDelta.events[0]?.role, 'commentary');
    assert.equal(
      eventDelta.events[0]?.content,
      'Goal Active\n\n优化 toolcall 展示\nworkdir: /repo/a\nSuccess with exit code 0 in 0ms.',
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('filters internal Codex goal context wrappers from event and mirror display', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-goal-context-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-06-02T13:06:48.994Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: '<goal_context>\nContinue working toward the active thread goal.\n</goal_context>',
            }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-02T13:06:49.994Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n</codex_internal_context>',
            }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-02T13:06:50.994Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '<goal_context>\nReloaded task goal context.\n</goal_context>',
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const eventDelta = readCodexSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    const mirrorDelta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(eventDelta.events, []);
    assert.deepEqual(mirrorDelta.records, []);
    assert.deepEqual(mirrorDelta.unknownKinds, []);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('compacts internal turn_aborted wrappers and event reasons to one-line notices', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-turn-aborted-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-06-02T13:07:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: '<turn_aborted>\n' + 'repeat\n'.repeat(20) + '</turn_aborted>',
            }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-02T13:07:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'turn_aborted',
            turn_id: 'turn-aborted',
            reason: '<goal_context>\nlong repeated context\n</goal_context>',
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const eventDelta = readCodexSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    const mirrorDelta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);

    assert.deepEqual(eventDelta.events.map((event) => event.content), ['任务已中断。']);
    assert.deepEqual(
      mirrorDelta.records.map((record) => ({ type: record.type, content: record.content })),
      [
        { type: 'message', content: '任务已中断。' },
        { type: 'task_aborted', content: '任务已中断。' },
      ],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('routes response_item user messages into mirror records without duplicating system messages', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-1',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '请同步这个本地 Codex 输入' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:01.500Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: '请同步这个本地 Codex 输入',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: 'internal system context' }],
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(delta.unknownKinds, []);
    assert.deepEqual(
      delta.records.map((record) => ({
        type: record.type,
        role: record.role,
        content: record.content,
        turnId: record.turnId,
      })),
      [
        { type: 'task_started', role: undefined, content: '', turnId: 'turn-1' },
        { type: 'message', role: 'user', content: '请同步这个本地 Codex 输入', turnId: 'turn-1' },
      ],
    );

    const eventDelta = readCodexSessionEventDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(
      eventDelta.events.map((event) => ({ role: event.role, content: event.content })),
      [{ role: 'user', content: '请同步这个本地 Codex 输入' }],
    );

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses token_count events as mirror context usage records', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-05-14T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-1',
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-14T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              model_context_window: 200_000,
              last_token_usage: {
                input_tokens: 125_300,
                cached_input_tokens: 10_000,
                output_tokens: 4_600,
                reasoning_output_tokens: 600,
                total_tokens: 129_900,
              },
              total_token_usage: {
                input_tokens: 300_000,
                output_tokens: 20_000,
                total_tokens: 320_000,
              },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const delta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.equal(delta.unknownKinds.length, 0);
    assert.equal(delta.records[1]?.type, 'context_usage');
    assert.equal(delta.records[1]?.turnId, 'turn-1');
    assert.equal(delta.records[1]?.contextUsage?.modelContextWindow, 200_000);
    assert.equal(delta.records[1]?.contextUsage?.lastTokenUsage?.inputTokens, 125_300);
    assert.equal(delta.records[1]?.contextUsage?.lastTokenUsage?.outputTokens, 4_600);
    assert.equal(delta.records[1]?.contextUsage?.totalTokenUsage?.totalTokens, 320_000);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reads appended mirror records and preserves trailing partial text', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-codex-mirror-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const firstLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-1',
      },
    });
    const secondLine = JSON.stringify({
      timestamp: '2026-03-25T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        last_agent_message: 'final answer',
      },
    });
    fs.writeFileSync(filePath, `${firstLine}\n${secondLine.slice(0, 48)}`, 'utf-8');

    const firstDelta = readCodexSessionMirrorRecordDeltaByFilePath(filePath, 0, fs.statSync(filePath).size);
    assert.deepEqual(
      firstDelta.records.map((record) => record.type),
      ['task_started'],
    );
    assert.equal(firstDelta.trailingText, secondLine.slice(0, 48));

    fs.appendFileSync(filePath, `${secondLine.slice(48)}\n`, 'utf-8');
    const secondDelta = readCodexSessionMirrorRecordDeltaByFilePath(
      filePath,
      firstDelta.nextOffset,
      fs.statSync(filePath).size,
      firstDelta.trailingText,
    );

    assert.deepEqual(
      secondDelta.records.map((record) => ({ type: record.type, content: record.content })),
      [{ type: 'task_complete', content: 'final answer' }],
    );
    assert.equal(secondDelta.trailingText, '');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
