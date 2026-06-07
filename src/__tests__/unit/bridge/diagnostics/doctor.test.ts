import '../../../setup/test-setup.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { buildDoctorPromptFromLogs } from '../../../../bridge/diagnostics/doctor.js';

describe('doctor prompt builder', () => {
  afterEach(() => {
    fs.rmSync(path.join(CODELARK_HOME, 'logs', 'bridge.log'), { force: true });
  });

  it('passes the user description and bridge.log path without embedding log contents', () => {
    const logsDir = path.join(CODELARK_HOME, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'bridge.log'),
      JSON.stringify({
        time: '2026-06-02T01:23:45.000Z',
        level: 'ERROR',
        msg: 'recent failure token=secret',
      }) + '\n',
      'utf-8',
    );

    const spec = buildDoctorPromptFromLogs('飞书卡片无法提交，怀疑是昨晚热更新后出现的');

    assert.equal(spec.description, '飞书卡片无法提交，怀疑是昨晚热更新后出现的');
    assert.equal(spec.logPath, '$HOME/.codelark/logs/bridge.log');
    assert.equal(spec.targetId, null);
    assert.match(spec.notice, /结构化 JSONL bridge\.log 路径/);
    assert.match(spec.prompt, /Bridge 日志文件：\$HOME\/\.codelark\/logs\/bridge\.log/);
    assert.match(spec.prompt, /一行一条 JSON 的结构化日志/);
    assert.match(spec.prompt, /time、level、msg、name、event、duration_ms/);
    assert.match(spec.prompt, /JSON\.parse/);
    assert.match(spec.prompt, /注意日志时间戳可能包含时区/);
    assert.match(spec.prompt, /飞书卡片无法提交/);
    assert.match(spec.prompt, /level 为 ERROR\/WARN/);
    assert.doesNotMatch(spec.prompt, /recent failure/);
    assert.doesNotMatch(spec.prompt, /secret/);
  });

  it('parses a bridge_id-prefixed target id and asks the model to search logs by id', () => {
    const spec = buildDoctorPromptFromLogs('bridge_id:d3c20e05 2026-06-04 17:48 后卡片没刷新');

    assert.equal(spec.targetId, 'd3c20e05');
    assert.equal(spec.description, '2026-06-04 17:48 后卡片没刷新');
    assert.match(spec.notice, /目标 id d3c20e05/);
    assert.match(spec.prompt, /用户指定的目标 id：d3c20e05/);
    assert.match(spec.prompt, /建议优先搜索的日志关键词：d3c20e05/);
    assert.match(spec.prompt, /不要搜索 bridge_id: 前缀/);
    assert.match(spec.prompt, /相邻时间窗口/);
    assert.match(spec.prompt, /特别优先关注 level 为 ERROR\/WARN/);
    assert.match(spec.prompt, /adapter\.message\.handler/);
    assert.match(spec.prompt, /2026-06-04 17:48/);
  });

  it('parses a bare target id while keeping the argument optional', () => {
    const withBareId = buildDoctorPromptFromLogs('d3c20e05');

    assert.equal(withBareId.targetId, 'd3c20e05');
    assert.match(withBareId.prompt, /目标 id：d3c20e05/);
    assert.match(withBareId.prompt, /用户没有补充故障描述或时间点/);

    const withoutArgs = buildDoctorPromptFromLogs('');
    assert.equal(withoutArgs.targetId, null);
    assert.match(withoutArgs.prompt, /用户没有指定目标 id/);
    assert.match(withoutArgs.prompt, /用户没有补充故障描述或目标 id/);
    assert.match(withoutArgs.prompt, /结构化 JSONL bridge\.log/);
  });

  it('keeps non-hex bare text as a free-form description', () => {
    const spec = buildDoctorPromptFromLogs('mirror clk_ask');

    assert.equal(spec.targetId, null);
    assert.equal(spec.description, 'mirror clk_ask');
    assert.match(spec.prompt, /用户没有指定目标 id/);
    assert.match(spec.prompt, /mirror clk_ask/);
  });
});
