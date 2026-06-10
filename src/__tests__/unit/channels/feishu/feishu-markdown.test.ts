import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFinalCardJson,
  buildCardContent,
  buildPostContent,
  buildRichCardContent,
  buildStreamingHistoryElements,
  buildStreamingHistoryElementsFromItems,
  buildStreamingTextContent,
  buildStreamingTextElements,
  buildStreamingTextLayoutSignature,
  buildStreamingToolsElements,
  buildTaskProgressMarkdown,
  buildToolProgressMarkdown,
  DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE,
  preprocessFeishuMarkdown,
} from '../../../../channels/feishu/markdown.js';
import {
  buildCodexToolDetailFromInput,
  buildCodexToolDetailFromOutput,
  mergeCodexToolDetail,
} from '../../../../shared/progress/tool-call-details.js';
import { buildFencedCodeBlock } from '../../../../shared/markdown/fence.js';

function collectElementIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectElementIds(item));
  const record = value as Record<string, unknown>;
  const ownId = typeof record.element_id === 'string' ? [record.element_id] : [];
  const children = Object.values(record).flatMap((child) => collectElementIds(child));
  return [...ownId, ...children];
}

function assertFeishuElementIdsAreValid(value: unknown): void {
  for (const elementId of collectElementIds(value)) {
    assert.match(elementId, /^[A-Za-z][A-Za-z0-9_]*$/);
    assert.ok(elementId.length <= 20, `${elementId} exceeds Feishu's 20-character element_id limit`);
  }
}

describe('preprocessFeishuMarkdown', () => {
  it('guards embedded code fences inside plaintext fenced blocks', () => {
    const rendered = preprocessFeishuMarkdown(buildFencedCodeBlock([
      'line 1',
      '```',
      'line 3',
    ].join('\n'), 'text'));

    assert.equal(rendered, [
      '```text',
      'line 1',
      '`\u200B``',
      'line 3',
      '```',
    ].join('\n'));
  });

  it('guards embedded code fences inside apply_patch diff fenced blocks', () => {
    const rendered = preprocessFeishuMarkdown(buildFencedCodeBlock([
      '*** Begin Patch',
      '*** Update File: a.md',
      '@@',
      '+```bash',
      '+echo nested',
      '+```',
      '*** End Patch',
    ].join('\n'), 'diff'));

    assert.equal(rendered, [
      '```diff',
      '*** Begin Patch',
      '*** Update File: a.md',
      '@@',
      '+`\u200B``bash',
      '+echo nested',
      '+`\u200B``',
      '*** End Patch',
      '```',
    ].join('\n'));
  });
});

describe('Feishu markdown payload builders', () => {
  it('guards embedded fences in direct card and post markdown payloads', () => {
    const markdown = buildFencedCodeBlock(['before', '```', 'after'].join('\n'), 'text');
    const card = JSON.parse(buildCardContent(markdown)) as any;
    const post = JSON.parse(buildPostContent(markdown)) as any;

    assert.match(card.body.elements[0].content, /```text\nbefore\n`\u200B``\nafter\n```/);
    assert.match(post.zh_cn.content[0][0].text, /```text\nbefore\n`\u200B``\nafter\n```/);
  });

  it('does not pass invalid card template values into collapsible panel border colors', () => {
    const cardJson = buildRichCardContent({
      title: 'Panel colors',
      sections: [],
      panels: [{
        title: 'Invalid border color',
        template: 'color',
        subtitle: 'This used to make Feishu reject the card.',
      }, {
        title: 'Valid border color',
        template: 'turquoise',
        subtitle: 'This is a documented Feishu color enum.',
      }],
    } as any);

    const parsed = JSON.parse(cardJson) as any;
    const panels = parsed.body.elements.filter((element: any) => element.tag === 'collapsible_panel');
    assert.equal(panels.length, 2);
    assert.equal(panels[0].border, undefined);
    assert.equal(panels[1].border.color, 'turquoise');
    assert.doesNotMatch(JSON.stringify(parsed), /"color":"color"/);
  });
});

describe('buildToolProgressMarkdown', () => {
  it('renders recent tool calls and includes input/output blocks when available', () => {
    const rendered = buildToolProgressMarkdown([
      { id: '1', name: 'shell_command', status: 'running', input: '{\"cmd\":\"ls\"}', output: 'file1\\nfile2' },
      {
        id: '2',
        name: 'apply_patch',
        status: 'error',
        input: '*** Begin Patch\n*** Update File: a.ts\n@@\n+```bash\n+echo nested\n+```\n*** End Patch',
        output: 'patch failed',
      },
    ]);

    assert.match(rendered, /🔄 `shell_command`（运行中）/);
    assert.match(rendered, /输入：/);
    assert.match(rendered, /```bash/);
    assert.match(rendered, /输出：/);
    assert.match(rendered, /```text/);
    assert.match(rendered, /❌ `apply_patch`（异常）/);
    assert.match(rendered, /````diff\n\*\*\* Begin Patch/);
    assert.match(rendered, /\n\+```bash\n\+echo nested\n\+```\n/);
  });

  it('normalizes terminal tool state so final cards do not show running tools', () => {
    const rendered = buildToolProgressMarkdown([
      { id: '1', name: 'shell_command', status: 'running' },
      { id: '2', name: 'apply_patch', status: 'running' },
    ], { terminalStatus: 'completed' });

    assert.doesNotMatch(rendered, /运行中/);
    assert.match(rendered, /✅ `shell_command`（完成）/);
    assert.match(rendered, /✅ `apply_patch`（完成）/);
  });

  it('renders structured Codex exec details from the shared detail model', () => {
    const rendered = buildToolProgressMarkdown([
      {
        id: 'tool-1',
        name: 'Bash',
        status: 'complete',
        input: 'ignored raw json',
        output: 'ignored raw output',
        detail: {
          kind: 'exec_command',
          command: 'npm test',
          workdir: '/tmp/project',
          exitCode: 0,
          durationMs: 1234,
          output: 'tests passed',
        },
      },
    ]);

    assert.match(rendered, /workdir: `\/tmp\/project`/);
    assert.match(rendered, /```bash\nnpm test\n```/);
    assert.match(rendered, /#### ✅ `Bash`（完成 · 1\.2s）/);
    assert.doesNotMatch(rendered, /Success in 1\.2s\./);
    assert.doesNotMatch(rendered, /exit code 0/);
    assert.match(rendered, /```text\ntests passed\n```/);
    assert.doesNotMatch(rendered, /ignored raw/);
  });

  it('parses exec_command text output and shows the aggregated output only', () => {
    const input = buildCodexToolDetailFromInput('exec_command', {
      cmd: 'printf "hello\\n"',
      workdir: '/repo/a',
      yield_time_ms: 1000,
    });
    const output = buildCodexToolDetailFromOutput('exec_command', [
      'Chunk ID: abc123',
      'Wall time: 0.1250 seconds',
      'Process exited with code 0',
      'Original token count: 4',
      'Output:',
      'hello',
      '',
    ].join('\n'), input);
    const detail = mergeCodexToolDetail(input, output);

    const rendered = buildToolProgressMarkdown([
      {
        id: 'tool-text-output',
        name: 'exec_command',
        status: 'complete',
        detail,
      },
    ]);

    assert.match(rendered, /workdir: `\/repo\/a`/);
    assert.match(rendered, /#### ✅ `exec_command`（完成 · 125ms）/);
    assert.match(rendered, /```bash\nprintf "hello\\n"\n```/);
    assert.match(rendered, /```text\nhello\n```/);
    assert.doesNotMatch(rendered, /Chunk ID|Original token count|Wall time|Process exited/);
  });

  it('uses diff fences for apply_patch when the patch arrives inside an input object', () => {
    const detail = buildCodexToolDetailFromInput('apply_patch', {
      diff: '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch',
    });

    const rendered = buildToolProgressMarkdown([
      {
        id: 'tool-patch-object',
        name: 'apply_patch',
        status: 'running',
        detail,
      },
    ]);

    assert.match(rendered, /- update: `a\.ts`/);
    assert.match(rendered, /```diff\n\*\*\* Begin Patch/);
    assert.doesNotMatch(rendered, /```json/);
  });

  it('renders write_stdin polling input with wait time and a Feishu text tag session label', () => {
    const rendered = buildToolProgressMarkdown([
      {
        id: 'tool-stdin',
        name: 'write_stdin',
        status: 'running',
        input: JSON.stringify({ session_id: 23553, chars: '', yield_time_ms: 30000 }),
        detail: {
          kind: 'terminal_stdin',
          sessionId: '23553',
          chars: '',
          isPoll: true,
          waitMs: 30000,
          durationMs: 5000,
          runningSessionId: '23553',
        },
      },
    ]);

    assert.match(rendered, /#### 🔄 `write_stdin`（运行中 · 5\.0s）/);
    assert.match(rendered, /<text_tag color='blue'>session 23553<\/text_tag>/);
    assert.match(rendered, /<text_tag color='green'>wait 30\.0s<\/text_tag>/);
    assert.match(rendered, /<text_tag color='yellow'>Read<\/text_tag>/);
    assert.match(
      rendered,
      /<text_tag color='blue'>session 23553<\/text_tag> <text_tag color='green'>wait 30\.0s<\/text_tag> <text_tag color='yellow'>Read<\/text_tag>/,
    );
    assert.doesNotMatch(rendered, /Read terminal output\./);
  });

  it('renders write_stdin text input with a distinct write tag', () => {
    const rendered = buildToolProgressMarkdown([
      {
        id: 'tool-stdin-write',
        name: 'write_stdin',
        status: 'running',
        detail: {
          kind: 'terminal_stdin',
          sessionId: '23553',
          chars: 'q',
          isPoll: false,
        },
      },
    ]);

    assert.match(rendered, /<text_tag color='blue'>session 23553<\/text_tag>/);
    assert.match(rendered, /<text_tag color='red'>Write<\/text_tag>/);
    assert.match(rendered, /<text_tag color='blue'>session 23553<\/text_tag> <text_tag color='red'>Write<\/text_tag>/);
    assert.match(rendered, /```text\nq\n```/);
  });

  it('renders all tool detail kinds as collapsed notation panels for Feishu cards', () => {
    const elements = buildStreamingToolsElements([
      {
        id: 'tool-1',
        name: 'Bash',
        status: 'complete',
        detail: {
          kind: 'exec_command',
          command: 'npm test',
          workdir: '/repo/a',
          exitCode: 0,
          durationMs: 12,
          output: 'aggregated output\nline 2',
        },
      },
      {
        id: 'tool-2',
        name: 'apply_patch',
        status: 'error',
        detail: {
          kind: 'patch_apply',
          files: [{ path: 'src/a.ts', action: 'update' }],
          output: 'patch failed',
        },
      },
      {
        id: 'tool-3',
        name: 'mcp__server__read',
        status: 'complete',
        detail: {
          kind: 'mcp',
          server: 'server',
          tool: 'read',
          input: { path: '/tmp/a' },
          output: 'mcp output',
        },
      },
    ]);

    assert.equal(elements.length, 3);
    assert.equal(elements[0].tag, 'collapsible_panel');
    assert.equal(elements[0].expanded, false);
    assert.equal(elements[0].element_id, 'stream_tool_1');
    assert.ok(String(elements[0].element_id).length <= 20);
    assert.equal((elements[0].header as any).title.tag, 'markdown');
    assert.equal((elements[0].header as any).title.content, '✅ `Bash` · 完成 · 12ms');
    assert.equal((elements[0].header as any).title.text_size, DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.titleTextSize);
    assert.equal((elements[0].border as any).color, DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.borderColorByStatus.complete);
    assert.equal((elements[1].header as any).title.tag, 'markdown');
    assert.equal((elements[1].header as any).title.text_size, DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.titleTextSize);
    assert.equal((elements[1].border as any).color, DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.borderColorByStatus.error);
    assert.ok(String(elements[1].element_id).length <= 20);
    assert.equal((elements[2].header as any).title.tag, 'markdown');
    assert.equal((elements[2].header as any).title.text_size, DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.titleTextSize);
    assert.equal((elements[2].border as any).color, DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.borderColorByStatus.complete);
    assert.ok(String(elements[2].element_id).length <= 20);
    assert.equal((elements[0].elements as any[])[0].text_size, 'notation');
    const content = JSON.stringify(elements);
    assert.ok(content.includes('workdir: `/repo/a`'));
    assert.ok(!content.includes('Success in 12ms.'));
    assert.doesNotMatch(content, /exit code 0|exit 0/);
    assert.ok(content.includes('aggregated output\\nline 2'));
    assert.ok(content.includes('update: `src/a.ts`'));
    assert.ok(content.includes('mcp: `server/read`'));
  });

  it('caps long tool detail text in Feishu card panels', () => {
    const longOutput = 'read-output-line\n'.repeat(600);
    const elements = buildStreamingToolsElements([
      {
        id: 'tool-long-generic',
        name: 'Read',
        status: 'complete',
        detail: {
          kind: 'generic',
          output: longOutput,
        },
      },
    ]);

    const content = JSON.stringify(elements);
    assert.match(content, /truncated for card preview/);
    assert.ok(
      Buffer.byteLength(content, 'utf8') < Buffer.byteLength(longOutput, 'utf8'),
      'card panel should not embed the full generic tool output',
    );
  });

  it('marks non-zero exec exits with warning and collapses long output in a nested panel', () => {
    const longOutput = 'error line\n'.repeat(500);
    const rendered = buildToolProgressMarkdown([
      {
        id: 'tool-failed-exec',
        name: 'exec_command',
        status: 'error',
        detail: {
          kind: 'exec_command',
          command: 'npm test',
          exitCode: 2,
          durationMs: 1500,
          output: 'short failure',
        },
      },
    ]);

    assert.match(rendered, /#### ⚠️ `exec_command`（异常 · 1\.5s · exit 2）/);
    assert.match(rendered, /⚠️ Fail with exit code 2 in 1\.5s\./);
    assert.match(rendered, /```text\nshort failure\n```/);

    const elements = buildStreamingToolsElements([
      {
        id: 'tool-long-exec',
        name: 'exec_command',
        status: 'error',
        detail: {
          kind: 'exec_command',
          command: 'npm test',
          exitCode: 1,
          output: longOutput,
        },
      },
    ]);

    const panel = elements[0] as any;
    assert.equal(panel.tag, 'collapsible_panel');
    assert.equal(panel.header.title.content, '⚠️ `exec_command` · 异常 · exit 1');
    assert.equal(panel.elements[1].tag, 'collapsible_panel');
    assert.match(panel.elements[1].header.title.content, /输出 · \d+ chars · truncated/);
    assert.doesNotMatch(JSON.stringify(panel.elements[0]), /error line/);
    assert.match(JSON.stringify(panel.elements[1]), /error line/);
    assert.match(JSON.stringify(panel.elements[1]), /truncated for card preview/);
  });
});

describe('buildTaskProgressMarkdown', () => {
  it('keeps waiting state visible while streaming but not after terminal completion', () => {
    const tasks = [
      { text: '读取日志', status: 'completed' as const },
      { text: '分析原因', status: 'in_progress' as const },
      { text: '补测试', status: 'pending' as const },
    ];

    const streaming = buildTaskProgressMarkdown(tasks);
    const terminal = buildTaskProgressMarkdown(tasks, { terminalStatus: 'completed' });

    assert.match(streaming, /分析原因（执行中）/);
    assert.match(streaming, /补测试（等待中）/);
    assert.doesNotMatch(terminal, /执行中|等待中/);
    assert.match(terminal, /分析原因（已结束）/);
    assert.match(terminal, /补测试（已结束）/);
  });
});

describe('buildStreamingTextElements', () => {
  it('guards embedded fences in streaming text content updates', () => {
    const markdown = buildFencedCodeBlock(['before', '```', 'after'].join('\n'), 'text');

    assert.match(buildStreamingTextContent(markdown), /```text\nbefore\n`\u200B``\nafter\n```/);
  });

  it('renders short mirror goal status once as a separate markdown element', () => {
    const text = [
      '> ⚙️ **Goal Active**: 修复 hot-update 卡片重复',
      '',
      '**codex:** 开始处理',
    ].join('\n');

    assert.equal(buildStreamingTextContent(text), '**codex:** 开始处理');

    const elements = buildStreamingTextElements(text);
    assert.equal(elements[0]?.tag, 'markdown');
    assert.match(String(elements[0]?.content), /Goal Active/);
    assert.equal(elements[1]?.tag, 'markdown');
    assert.equal(elements[1]?.element_id, 'streaming_content');
    assert.doesNotMatch(String(elements[1]?.content), /Goal Active/);
  });

  it('renders long mirror goal status as a collapsed Feishu panel', () => {
    const objective = '排查 hot-update 启动青色卡片重复内容，并在日志中找证据，完成修复、验证、合并 master、删除 worktree。'.repeat(3);
    const text = [
      `> ⚙️ **Goal Active**: ${objective}`,
      '',
      '**codex:** 开始处理',
    ].join('\n');

    const elements = buildStreamingTextElements(text);
    assert.equal(elements[0]?.tag, 'collapsible_panel');
    assert.equal(elements[0]?.expanded, false);
    assert.deepEqual((elements[0] as any).header.title.tag, 'markdown');
    assert.match(JSON.stringify(elements[0]), /Goal Active/);
    assert.match(JSON.stringify(elements[0]), /排查 hot-update/);
    assert.equal(elements[1]?.tag, 'markdown');
    assert.doesNotMatch(String(elements[1]?.content), /排查 hot-update/);
    assert.match(buildStreamingTextLayoutSignature(text), /^goal:collapsed:/);
  });
});

describe('buildStreamingHistoryElements', () => {
  it('renders explicit reducer history items without inferring tool positions from markdown text', () => {
    const elements = buildStreamingHistoryElementsFromItems('> ⚙️ **Goal Active**: 保留目标区', [
      { type: 'markdown', role: 'user', content: '用户输入' },
      { type: 'markdown', role: 'assistant', content: '模型输出一' },
      { type: 'tool_panel', tools: [{ id: 'tool-1', name: 'exec_command', status: 'complete' }] },
      { type: 'markdown', role: 'assistant', content: '模型输出二' },
      { type: 'tool_panel', tools: [{ id: 'tool-2', name: 'apply_patch', status: 'running' }] },
      { type: 'markdown', role: 'user', content: '用户补充' },
      { type: 'markdown', role: 'assistant', content: '模型输出三' },
      { type: 'tool_panel', tools: [{ id: 'tool-3', name: 'rg', status: 'complete' }] },
    ]);

    assert.equal(elements[0]?.tag, 'markdown');
    assert.equal(elements[1]?.tag, 'collapsible_panel');
    const historyChildren = (elements[1] as any).elements as any[];
    assert.deepEqual(historyChildren.map((element) => element.tag), [
      'markdown',
      'markdown',
      'collapsible_panel',
      'markdown',
      'collapsible_panel',
      'markdown',
      'markdown',
      'collapsible_panel',
    ]);
    assert.match(historyChildren[0]?.content, /^\*\*用户\*\*：用户输入/);
    assert.match(historyChildren[1]?.content, /模型输出一/);
    assert.doesNotMatch(historyChildren[1]?.content, /\*\*用户\*\*/);
    assert.equal(historyChildren[2]?.element_id, 'stream_tool_1');
    assert.match(JSON.stringify(historyChildren[2]), /tool-1|exec_command/);
    assert.equal(historyChildren[2]?.border, undefined);
    assert.equal(historyChildren[2]?.header?.title?.text_size, DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.outerPanel.titleTextSize);
    assert.equal((historyChildren[2]?.elements as any[])?.[0]?.tag, 'collapsible_panel');
    assert.equal(
      (historyChildren[2]?.elements as any[])?.[0]?.header?.title?.text_size,
      DEFAULT_FEISHU_TOOL_CALL_CARD_STYLE.innerPanel.titleTextSize,
    );
    assert.notEqual((historyChildren[2]?.elements as any[])?.[0]?.border?.color, 'transparent');
    assert.match(historyChildren[3]?.content, /模型输出二/);
    assert.equal(historyChildren[4]?.element_id, 'stream_tool_2');
    assert.equal((historyChildren[4]?.elements as any[])?.[0]?.tag, 'collapsible_panel');
    assert.match(historyChildren[5]?.content, /^\*\*用户\*\*：用户补充/);
    assert.match(historyChildren[6]?.content, /模型输出三/);
    assert.doesNotMatch(historyChildren[6]?.content, /\*\*用户\*\*/);
    assert.equal(historyChildren[7]?.element_id, 'stream_tool_3');
    assert.equal((historyChildren[7]?.elements as any[])?.[0]?.tag, 'collapsible_panel');
    assertFeishuElementIdsAreValid(elements);
  });

  it('keeps the goal separate while interleaving transcript text and tool calls in one history region', () => {
    const elements = buildStreamingHistoryElements([
      '> ⚙️ **Goal Active**: 保留目标区',
      '',
      '**我:** 帮我检查状态',
      '',
      '**codex:** 正在读取文件',
      '',
      '**codex:** 已读取配置',
      '',
      '**我:** 补充检查日志',
      '',
      '**codex:** 正在检查日志',
    ].join('\n'), [
      { id: 'tool-1', name: 'exec_command', status: 'complete' },
      { id: 'tool-2', name: 'apply_patch', status: 'running' },
      { id: 'tool-3', name: 'rg', status: 'complete' },
    ]);

    assert.equal(elements[0]?.tag, 'markdown');
    assert.equal(elements[1]?.tag, 'collapsible_panel');
    assert.equal((elements[1] as any).element_id, 'stream_history');
    assert.equal((elements[1] as any).expanded, true);
    const historyChildren = (elements[1] as any).elements as any[];
    assert.deepEqual(historyChildren.map((element) => element.tag), [
      'markdown',
      'markdown',
      'collapsible_panel',
      'markdown',
      'collapsible_panel',
      'markdown',
      'markdown',
      'collapsible_panel',
    ]);
    assert.equal(historyChildren[0]?.element_id, 'streaming_content');
    assert.match(historyChildren[0]?.content, /帮我检查状态/);
    assert.match(historyChildren[1]?.content, /正在读取文件/);
    assert.equal(historyChildren[2]?.element_id, 'stream_tool_1');
    assert.match(historyChildren[3]?.content, /已读取配置/);
    assert.equal(historyChildren[4]?.element_id, 'stream_tool_2');
    assert.match(historyChildren[5]?.content, /补充检查日志/);
    assert.match(historyChildren[6]?.content, /正在检查日志/);
    assert.equal(historyChildren[7]?.element_id, 'stream_tool_3');
    assertFeishuElementIdsAreValid(elements);
  });

  it('renders the complete tool history instead of truncating to the recent five calls with valid element ids', () => {
    const tools = Array.from({ length: 7 }, (_, index) => ({
      id: `tool-${index + 1}`,
      name: `tool_${index + 1}`,
      status: 'complete' as const,
    }));

    const history = buildStreamingHistoryElements('**codex:** 完成', tools);
    const toolPanels = ((history.at(-1) as any).elements as any[])
      .filter((element) => /^stream_tool_\d+$/.test(String(element.element_id || '')));

    assert.equal(toolPanels.length, 7);
    assert.doesNotMatch(JSON.stringify(toolPanels), /已折叠/);
    assertFeishuElementIdsAreValid(history);
  });

  it('keeps nested tool panel element ids within Feishu limits for double-digit panels', () => {
    const items = Array.from({ length: 11 }, (_, index) => ({
      type: 'tool_panel' as const,
      tools: [
        {
          id: `tool-${index + 1}-a`,
          name: 'exec_command',
          status: 'complete' as const,
          detail: {
            kind: 'exec_command' as const,
            command: 'npm test',
            output: 'output\n'.repeat(index === 10 ? 500 : 1),
          },
        },
        {
          id: `tool-${index + 1}-b`,
          name: 'apply_patch',
          status: 'complete' as const,
        },
      ],
    }));

    const elements = buildStreamingHistoryElementsFromItems('', items);

    assertFeishuElementIdsAreValid(elements);
    assert.match(JSON.stringify(elements), /stream_tool_11/);
    assert.doesNotMatch(JSON.stringify(elements), /stream_tool_panel_/);
  });
});

describe('buildFinalCardJson', () => {
  it('renders terminal task and tool states without active waiting labels', () => {
    const cardJson = buildFinalCardJson(
      '最终回复',
      [
        { text: '读取日志', status: 'completed' },
        { text: '补测试', status: 'pending' },
      ],
      [
        { id: 'tool-1', name: 'shell_command', status: 'running' },
      ],
      { status: '✅ Completed', elapsed: '1m 0s' },
      'completed',
    );

    assert.doesNotMatch(cardJson, /等待中|运行中/);
    assert.match(cardJson, /补测试（已结束）/);
    assert.match(cardJson, /collapsible_panel/);
    assert.match(cardJson, /stream_tool_1/);
    assert.match(cardJson, /`shell_command` · 完成/);
  });

  it('renders legacy quoted mirror goal status in a collapsed panel on final cards', () => {
    const objective = '排查 hot-update 启动青色卡片重复内容，并在日志中找证据，完成修复、验证、合并 master、删除 worktree。'.repeat(3);
    const cardJson = buildFinalCardJson(
      `> **Goal Active**: ${objective}\n\n**codex:** 已完成`,
      [],
      [],
      null,
      'completed',
    );

    const parsed = JSON.parse(cardJson) as any;
    assert.equal(parsed.body.elements[0].tag, 'collapsible_panel');
    assert.equal(parsed.body.elements[0].expanded, false);
    assert.equal(parsed.body.elements[1].tag, 'collapsible_panel');
    assert.equal(parsed.body.elements[1].element_id, 'stream_history');
    assert.doesNotMatch(JSON.stringify(parsed.body.elements[1]), /Goal Active/);
  });

  it('renders geared mirror goal status in a collapsed panel on final cards', () => {
    const objective = '排查 hot-update 启动青色卡片重复内容，并在日志中找证据，完成修复、验证、合并 master、删除 worktree。'.repeat(3);
    const cardJson = buildFinalCardJson(
      `> ⚙️ **Goal Active**: ${objective}\n\n**codex:** 已完成`,
      [],
      [],
      null,
      'completed',
    );

    const parsed = JSON.parse(cardJson) as any;
    assert.equal(parsed.body.elements[0].tag, 'collapsible_panel');
    assert.equal(parsed.body.elements[0].expanded, false);
    assert.equal(parsed.body.elements[1].tag, 'collapsible_panel');
    assert.equal(parsed.body.elements[1].element_id, 'stream_history');
    assert.doesNotMatch(JSON.stringify(parsed.body.elements[1]), /Goal Active/);
  });

  it('renders title metadata as Feishu card header tags', () => {
    const cardJson = buildFinalCardJson(
      '最终回复',
      [],
      [],
      null,
      'completed',
      [],
      'chat-1',
      { title: '当前线程', tags: ['bridge_id:abc12345', 'sdk', 'mirror'] },
    );

    const parsed = JSON.parse(cardJson) as any;
    assert.equal(parsed.header.title.content, '当前线程');
    assert.equal(parsed.header.template, 'blue');
    assert.equal(parsed.header.text_tag_list[0].text.content, 'bridge_id:abc12345');
    assert.equal(parsed.header.text_tag_list[0].color, 'blue');
    assert.equal(parsed.header.text_tag_list[1].text.content, 'sdk');
    assert.equal(parsed.header.text_tag_list[1].color, 'green');
    assert.equal(parsed.header.text_tag_list[2].text.content, 'mirror');
    assert.equal(parsed.header.text_tag_list[2].color, 'yellow');
    assertFeishuElementIdsAreValid(parsed);
  });

  it('renders runtime metadata as body tags while limiting Feishu card header tags', () => {
    const cardJson = buildFinalCardJson(
      '最终回复',
      [],
      [],
      null,
      'completed',
      [],
      'chat-1',
      { title: '当前线程', tags: ['codex', 'effort:medium', 'model:default', 'bridge_id:abc12345', 'sdk', 'mirror'] },
    );

    const parsed = JSON.parse(cardJson) as any;
    assert.equal(parsed.header.text_tag_list.length, 3);
    assert.equal(parsed.header.text_tag_list[0].text.content, 'bridge_id:abc12345');
    assert.equal(parsed.header.text_tag_list[1].text.content, 'sdk');
    assert.equal(parsed.header.text_tag_list[1].color, 'green');
    assert.equal(parsed.header.text_tag_list[2].text.content, 'mirror');
    assert.equal(parsed.body.elements[0].tag, 'markdown');
    assert.equal(parsed.body.elements[0].element_id, 'runtime_meta_tags');
    assert.equal(parsed.body.elements[0].content, "<text_tag color='orange'>codex</text_tag> <text_tag color='green'>effort:medium</text_tag> <text_tag color='turquoise'>model:default</text_tag>");
    assertFeishuElementIdsAreValid(parsed);
  });

  it('keeps terminal context usage visible when final content comes from history items', () => {
    const cardJson = buildFinalCardJson(
      '最终回复\n\nContext: 125k(63%) · ↑125k ↓4.6k',
      [],
      [],
      { status: '✅ Completed', elapsed: '1s' },
      'completed',
      [],
      'chat-1',
      {},
      [
        { type: 'markdown', role: 'user', content: '用户输入' },
        { type: 'markdown', role: 'assistant', content: '最终回复' },
        { type: 'tool_panel', tools: [] },
      ],
    );

    const parsed = JSON.parse(cardJson) as any;
    const body = JSON.stringify(parsed.body.elements);
    assert.match(body, /\*\*用户\*\*：用户输入/);
    assert.match(body, /最终回复/);
    assert.match(body, /Context: 125k\(63%\) · ↑125k ↓4\.6k/);
  });

  it('keeps compact token usage in the final card footer', () => {
    const cardJson = buildFinalCardJson(
      '最终回复',
      [],
      [],
      { status: '✅ Completed', elapsed: '1s', context: '125k(63%) · ↑125k ↓4.6k' },
      'completed',
    );

    const parsed = JSON.parse(cardJson) as any;
    const body = JSON.stringify(parsed.body.elements);
    assert.match(body, /✅ Completed · 1s · 125k\(63%\) · ↑125k ↓4\.6k/);
  });

  it('guards embedded fences in final card exec_command output', () => {
    const detail = buildCodexToolDetailFromOutput('exec_command', [
      'Process exited with code 0',
      'Output:',
      'before',
      '```',
      'after',
    ].join('\n'), buildCodexToolDetailFromInput('exec_command', { cmd: 'cat demo.md' }));
    const cardJson = buildFinalCardJson(
      '最终回复',
      [],
      [{
        id: 'tool-exec-fence',
        name: 'exec_command',
        status: 'complete',
        detail,
      }],
      null,
      'completed',
    );

    const parsed = JSON.parse(cardJson) as any;
    const content = JSON.stringify(parsed.body.elements);
    assert.match(content, /```text\\nbefore\\n`\u200B``\\nafter\\n```/);
    assert.doesNotMatch(content, /````text/);
  });

  it('guards embedded fences in final card apply_patch content', () => {
    const detail = buildCodexToolDetailFromInput('apply_patch', [
      '*** Begin Patch',
      '*** Update File: a.md',
      '@@',
      '+```ts',
      '+const ok = true;',
      '+```',
      '*** End Patch',
    ].join('\n'));
    const cardJson = buildFinalCardJson(
      '最终回复',
      [],
      [{
        id: 'tool-patch-fence',
        name: 'apply_patch',
        status: 'complete',
        detail,
      }],
      null,
      'completed',
    );

    const parsed = JSON.parse(cardJson) as any;
    const content = JSON.stringify(parsed.body.elements);
    assert.match(content, /```diff\\n\*\*\* Begin Patch/);
    assert.match(content, /\\n\+`\u200B``ts\\n\+const ok = true;\\n\+`\u200B``\\n/);
    assert.doesNotMatch(content, /````diff/);
  });
});

describe('buildRichCardContent', () => {
  it('renders command sections and callback buttons', () => {
    const cardJson = buildRichCardContent({
      title: '最近 1 条本地 Codex 会话',
      subtitle: '点击按钮或发送纯文本命令。',
      sections: [{
        title: '1. Project A',
        fields: [
          ['目录', '/repo/a'],
          ['命令', '`/t 1`'],
        ],
        actions: [[{
          text: '接管',
          callbackData: 'clk-command::%2Ft%201',
          type: 'primary',
        }]],
      }],
      footer: ['纯文本命令：`/t 1`'],
    }, 'chat-1');

    const parsed = JSON.parse(cardJson) as any;
    assert.equal(parsed.header.title.content, '最近 1 条本地 Codex 会话');
    const content = JSON.stringify(parsed);
    assert.match(content, /Project A/);
    assert.match(content, /column_set/);
    assert.match(content, /目录/);
    assert.match(content, /\/repo\/a/);
    assert.doesNotMatch(content, /\| 项 \| 值 \|/);
    assert.doesNotMatch(content, /目录\*\*：/);
    assert.match(content, /clk-command::%2Ft%201/);
    assert.match(content, /chat-1/);
  });

  it('preserves raw markdown sections in rich cards', () => {
    const cardJson = buildRichCardContent({
      title: 'Bridge 已启动',
      template: 'turquoise',
      sections: [{
        markdown: '**全局状态**\n\n```text\nAdapter 1/1 running\n```',
      }],
    }, 'chat-1');

    const parsed = JSON.parse(cardJson) as any;
    assert.equal(parsed.header.title.content, 'Bridge 已启动');
    assert.equal(parsed.header.template, 'turquoise');
    const content = JSON.stringify(parsed);
    assert.match(content, /全局状态/);
    assert.match(content, /Adapter 1\/1 running/);
  });

  it('preserves multiline field values for active goal cards', () => {
    const cardJson = buildRichCardContent({
      title: 'Goal Active',
      sections: [{
        fields: [[
          '目标',
          '优化 toolcall 展示\nworkdir: /repo/a\nSuccess with exit code 0 in 0ms.',
        ]],
      }],
    }, 'chat-1');

    const parsed = JSON.parse(cardJson) as any;
    const content = JSON.stringify(parsed);
    assert.ok(content.includes('优化 toolcall 展示\\nworkdir: /repo/a\\nSuccess with exit code 0 in 0ms.'));
  });

  it('compresses long rich-card lists in the card body', () => {
    const cardJson = buildRichCardContent({
      title: '本地 Codex 会话',
      maxSections: 2,
      sections: [
        { title: '1. A', fields: [['目录', '/repo/a']] },
        { title: '2. B', fields: [['目录', '/repo/b']] },
        { title: '3. C', fields: [['目录', '/repo/c']] },
      ],
    });

    const parsed = JSON.parse(cardJson) as any;
    const content = JSON.stringify(parsed);
    assert.match(content, /1\. A/);
    assert.match(content, /2\. B/);
    assert.doesNotMatch(content, /3\. C/);
    assert.match(content, /已压缩显示前 2 条，折叠 1 条/);
  });

  it('renders native table components for command cards', () => {
    const cardJson = buildRichCardContent({
      title: 'tmux session 选择',
      subtitle: '点击按钮或发送纯文本命令。',
      table: {
        pageSize: 10,
        freezeFirstColumn: true,
        columns: [
          { name: 'session', displayName: 'session', width: '260px' },
          { name: 'command', displayName: '命令', width: '320px' },
          { name: 'windows', displayName: '窗口', width: '72px', horizontalAlign: 'right' },
        ],
        rows: [{
          session: '1. very-long-session-name',
          command: '/tmux-attach very-long-session-name',
          windows: 3,
        }],
      },
      sections: [],
      selects: [{
        id: 'tmux_select',
        placeholder: '选择要绑定的 tmux session',
        selectedCallbackData: 'clk-command::%2Ftmux-attach%20very-long-session-name',
        options: [{
          text: '1. very-long-session-name',
          callbackData: 'clk-command::%2Ftmux-attach%20very-long-session-name',
        }],
      }],
    }, 'chat-1');

    const parsed = JSON.parse(cardJson) as any;
    const table = parsed.body.elements.find((element: any) => element.tag === 'table');
    const select = parsed.body.elements.find((element: any) => element.tag === 'select_static');
    assert.equal(table.freeze_first_column, true);
    assert.equal(table.page_size, 10);
    assert.equal(table.columns[1].width, '320px');
    assert.equal(table.columns[2].width, '80px');
    assert.equal(table.rows[0].command, '/tmux-attach very-long-session-name');
    assert.equal(select.element_id, 'tmux_select');
    assert.equal(select.width, 'fill');
    assert.equal(select.initial_option, 'clk-command::%2Ftmux-attach%20very-long-session-name');
    assert.equal(select.options[0].value, 'clk-command::%2Ftmux-attach%20very-long-session-name');
    assert.equal(select.behaviors[0].value.chatId, 'chat-1');
  });

  it('renders rich-card runtime table blocks as top-level tables', () => {
    const cardJson = buildRichCardContent({
      title: '本地会话',
      sections: [],
      tableBlocks: [{
        title: 'Codex 会话（1）',
        table: {
          columns: [{ name: 'title', displayName: '标题' }],
          rows: [{ title: 'codex thread' }],
        },
        selects: [{
          id: 'codex_select',
          placeholder: '选择 Codex 会话',
          options: [{ text: '1. codex thread', callbackData: 'cti-thread-select:codex-thread' }],
        }],
        actions: [[{ text: '接管', callbackData: 'cti-thread-action:global:switch', type: 'primary' }]],
      }, {
        title: 'Claude Code 会话（1）',
        table: {
          columns: [{ name: 'title', displayName: '标题' }],
          rows: [{ title: 'claude thread' }],
        },
      }],
    }, 'chat-1');

    const parsed = JSON.parse(cardJson) as any;
    assert.equal(parsed.body.elements.some((element: any) => element.tag === 'collapsible_panel'), false);
    const tables = parsed.body.elements.filter((element: any) => element.tag === 'table');
    assert.equal(tables.length, 2);
    assert.match(JSON.stringify(parsed.body.elements), /Codex 会话/);
    assert.match(JSON.stringify(parsed.body.elements), /Claude Code 会话/);
    assert.equal(JSON.stringify(parsed.body.elements).includes('codex_select'), true);
    assert.equal(JSON.stringify(parsed.body.elements).includes('cti-thread-action:global:switch'), true);

    const elementIds: string[] = [];
    const collectElementIds = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(collectElementIds);
        return;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.element_id === 'string') elementIds.push(record.element_id);
      Object.values(record).forEach(collectElementIds);
    };
    collectElementIds(parsed);
    assert.equal(new Set(elementIds).size, elementIds.length);
  });

  it('renders CardKit form controls with names for submitted form_value', () => {
    const cardJson = buildRichCardContent({
      title: '需要确认',
      sections: [{ markdown: '请选择环境，也可以补充说明。' }],
      form: {
        optionElementId: 'clk_choice',
        inputElementId: 'clk_input',
        inputLabel: '补充说明',
        inputPlaceholder: '可留空',
        inputDefaultValue: '默认补充',
        extraInputs: [{
          elementId: 'clk_path',
          label: '工作目录',
          placeholder: '项目目录',
          defaultValue: '/repo/current',
        }, {
          elementId: 'claudeIdleTimeoutMinutes',
          formName: 'cld_idle_min',
          label: 'Claude 空闲超时',
          placeholder: '分钟',
          defaultValue: '15',
        }],
        selects: [{
          elementId: 'claudeReasoningEffort',
          formName: 'cld_rsn_eft',
          label: 'Claude reasoning',
          selectedCallbackData: 'max',
          options: [{ text: 'max', callbackData: 'max' }],
        }],
        submitText: '提交',
        submitCallbackData: 'clk-agent-question:payload',
        options: [
          { text: '测试', callbackData: '测试' },
          { text: '生产', callbackData: '生产' },
        ],
      },
    }, 'chat-1');

    const parsed = JSON.parse(cardJson) as any;
    const form = parsed.body.elements.find((element: any) => element.tag === 'form');
    const select = form.elements.find((element: any) => element.tag === 'select_static');
    const input = form.elements.find((element: any) => element.tag === 'input');
    const pathInput = form.elements.find((element: any) => element.tag === 'input' && element.name === 'clk_path');
    const reasoningSelect = JSON.stringify(form).includes('"name":"cld_rsn_eft"');
    const idleInput = form.elements.find((element: any) => element.tag === 'input' && element.name === 'cld_idle_min');
    const submitColumnSet = form.elements.find((element: any) =>
      element.tag === 'column_set'
      && JSON.stringify(element).includes('clk-agent-question:payload'),
    );

    assert.equal(form.name, 'clk_form');
    assert.equal(select.name, 'clk_choice');
    assert.equal(select.element_id, undefined);
    assert.equal(select.options[0].value, '测试');
    assert.equal(input.name, 'clk_input');
    assert.equal(input.default_value, '默认补充');
    assert.equal(pathInput.default_value, '/repo/current');
    assert.equal(reasoningSelect, true);
    assert.equal(idleInput.default_value, '15');
    assert.doesNotMatch(JSON.stringify(form), /claudeReasoningEffor|claudeIdleTimeoutMin/);
    assert.equal(submitColumnSet.columns[0].elements[0].form_action_type, 'submit');
    assert.equal(submitColumnSet.columns[0].elements[0].behaviors[0].value.callback_data, 'clk-agent-question:payload');
    assert.equal(submitColumnSet.columns[0].elements[0].behaviors[0].value.chatId, 'chat-1');
  });

  it('renders form control bar actions beside the bottom submit button', () => {
    const cardJson = buildRichCardContent({
      title: '当前会话',
      sections: [],
      form: {
        optionElementId: 'clk_current_option',
        inputElementId: 'clk_name',
        inputLabel: 'name',
        inputPlaceholder: '可留空',
        submitText: '保存',
        submitCallbackData: 'clk-command::%2Fcurrent-config',
        options: [],
        controlBar: {
          actions: [
            { text: '刷新', callbackData: 'clk-command::%2Fcurrent' },
          ],
        },
      },
    }, 'chat-1');

    const parsed = JSON.parse(cardJson) as any;
    const form = parsed.body.elements.find((element: any) => element.tag === 'form');
    const buttonRow = form.elements.at(-1);
    const saveButton = buttonRow.columns[0].elements[0];
    const refreshButton = buttonRow.columns[1].elements[0];
    const buttons = form.elements
      .flatMap((element: any) => element.columns || [])
      .flatMap((column: any) => column.elements || [])
      .filter((element: any) => element.tag === 'button');
    assert.equal(saveButton.form_action_type, 'submit');
    assert.equal(saveButton.behaviors[0].value.callback_data, 'clk-command::%2Fcurrent-config');
    assert.equal(refreshButton.form_action_type, undefined);
    assert.equal(refreshButton.behaviors[0].value.callback_data, 'clk-command::%2Fcurrent');
    assert.deepEqual(buttons.map((button: any) => button.text.content), ['保存', '刷新']);
  });
});
