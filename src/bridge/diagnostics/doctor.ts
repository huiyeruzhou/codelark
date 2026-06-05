const BRIDGE_LOG_PATH_FOR_PROMPT = '$HOME/.codelark/logs/bridge.log';

export interface DoctorPromptSpec {
  notice: string;
  prompt: string;
  description: string;
  logPath: string;
  targetId: string | null;
}

const EXPLICIT_TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,}$/;
const BARE_TARGET_ID_PATTERN = /^[A-Fa-f0-9]{6,}$/;
const TARGET_ID_PREFIX_PATTERN = /^bridge_id:(.+)$/i;

interface DoctorArgs {
  description: string;
  targetId: string | null;
}

function parseDoctorArgs(args: string): DoctorArgs {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      description: '用户没有补充故障描述或目标 id，请直接根据结构化 JSONL bridge.log 判断最可能的问题。',
      targetId: null,
    };
  }

  const [firstToken = '', ...restTokens] = trimmed.split(/\s+/);
  const prefixedMatch = firstToken.match(TARGET_ID_PREFIX_PATTERN);
  const candidateId = prefixedMatch ? prefixedMatch[1].trim() : firstToken;
  const isTargetId = prefixedMatch
    ? EXPLICIT_TARGET_ID_PATTERN.test(candidateId)
    : BARE_TARGET_ID_PATTERN.test(candidateId);
  const targetId = isTargetId ? candidateId : null;

  if (!targetId) {
    return {
      description: trimmed,
      targetId: null,
    };
  }

  const description = restTokens.join(' ').trim()
    || '用户没有补充故障描述或时间点，请围绕目标 id 在日志中定位最可能的问题。';

  return {
    description,
    targetId,
  };
}

export function buildDoctorPromptFromLogs(args: string): DoctorPromptSpec {
  const parsed = parseDoctorArgs(args);
  const targetLines = parsed.targetId
    ? [
      `用户指定的目标 id：${parsed.targetId}`,
      `建议优先搜索的日志关键词：${parsed.targetId}`,
      '请先用这个 id 在结构化 JSONL bridge.log 中搜索相关日志，不要搜索 bridge_id: 前缀；再结合相邻时间窗口和用户补充的时间点判断上下游事件。',
    ]
    : [
      '用户没有指定目标 id；请根据用户描述中的时间点、现象关键词和日志级别自行定位相关日志。',
    ];
  const prompt = [
    '请作为 codelark 的诊断助手，自行读取本地 Bridge 日志并诊断问题。',
    '',
    '日志格式：',
    'bridge.log 当前是一行一条 JSON 的结构化日志（JSONL）；每行可先尝试 JSON.parse，重点字段包括 time、level、msg、name、event、duration_ms、lane、channel、chat、category、message、text。',
    '历史日志或外部进程日志可能仍是纯文本；如果某行不是 JSON，请按普通文本日志处理。',
    '',
    '定位要求：',
    ...targetLines,
    '特别优先关注 level 为 ERROR/WARN 的结构化日志；如果 ERROR/WARN 很少，再查看同一时间窗口内的 INFO/DEBUG 日志补充上下文。',
    '遇到 event 字段时优先用 event 聚类同类问题；adapter 慢处理日志可重点查看 adapter.message.wait 和 adapter.message.handler 的 duration_ms、lane、chat、category。',
    '请结合用户指定或描述中的时间点，不要只看最后几行日志。',
    '',
    '输出要求：',
    '## 可能原因',
    '列出 1-3 条，引用具体 time、level、event/msg、目标 id 或相关文件位置。',
    '',
    '## 关键日志',
    '从日志文件中摘出 3-5 条最关键日志并解释意义，优先选择 ERROR/WARN；摘录 JSON 日志时只保留关键字段，不要整行粘贴过长 JSON。',
    '',
    '## 建议下一步',
    '给出具体可执行的检查或修复动作。',
    '',
    `Bridge 日志文件：${BRIDGE_LOG_PATH_FOR_PROMPT}`,
    '请直接读取该文件，不要要求用户粘贴日志。',
    '注意日志时间戳可能包含时区，也可能不包含时区；请先根据时间戳格式判断时区，不要默认它一定是本地时间或 UTC。',
    `用户补充：${parsed.description}`,
  ].join('\n');
  return {
    notice: parsed.targetId
      ? `🔍 已把诊断请求、目标 id ${parsed.targetId} 和结构化 JSONL bridge.log 路径交给当前会话。`
      : `🔍 已把诊断请求和结构化 JSONL bridge.log 路径交给当前会话。`,
    prompt,
    description: parsed.description,
    logPath: BRIDGE_LOG_PATH_FOR_PROMPT,
    targetId: parsed.targetId,
  };
}
