import { getGlobalRuntimeAgent } from '../session/global-config.js';

export function buildInteractiveStreamKey(sessionId: string, messageId: string): string {
  return `im:${sessionId}:${messageId}`;
}

export function buildMirrorStreamKey(sessionId: string, turnId: string | null | undefined, startedAt: string): string {
  return `mirror:${sessionId}:${turnId || startedAt}`;
}

function getMirrorAssistantRuntimeLabel(): string {
  return getGlobalRuntimeAgent();
}

export function buildMirrorTitle(threadTitle: string | null, markdown = false): string {
  const title = threadTitle?.trim() || '本地会话';
  const rendered = markdown ? `\`<${title}>\`` : `<${title}>`;
  return markdown ? `**${rendered}**` : rendered;
}

function buildMirrorSpeakerLabel(label: string, markdown = false): string {
  return markdown ? `**${label}:**` : `${label}:`;
}

function formatGoalStatusLabel(status: string | null | undefined): string {
  const normalized = (status || '').replace(/[_-]+/g, ' ').trim();
  if (!normalized) return 'Goal';
  return `Goal ${normalized.replace(/\b\w/g, (char) => char.toUpperCase())}`;
}

export function formatMirrorGoalStatus(
  status: string | null | undefined,
  objective: string | null | undefined,
  markdown = false,
): string {
  const label = formatGoalStatusLabel(status);
  const normalizedObjective = (objective || '').replace(/\s+/g, ' ').trim();
  const line = normalizedObjective
    ? `${label}: ${normalizedObjective}`
    : label;
  return markdown ? `> ⚙️ **${label}**: ${normalizedObjective || ''}`.trimEnd() : `⚙️ ${line}`;
}

const MIRROR_USER_WRAPPER_LABELS = new Map<string, string>([
  ['# Review findings:', 'Review findings'],
  ['# Context from my IDE setup:', 'IDE setup'],
  ['# Files mentioned by the user:', 'Files'],
]);

const MIRROR_USER_REQUEST_MARKER = '## My request for Codex:';

export function formatMirrorUserText(text: string | null | undefined): string | null {
  const normalized = (text || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return null;

  const lines = normalized.split('\n');
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmptyIndex < 0) return null;

  const wrapperLabel = MIRROR_USER_WRAPPER_LABELS.get(lines[firstNonEmptyIndex].trim());
  if (!wrapperLabel) return normalized;

  const requestMarkerIndex = lines.findIndex(
    (line, index) => index > firstNonEmptyIndex && line.trim() === MIRROR_USER_REQUEST_MARKER,
  );
  if (requestMarkerIndex < 0) return normalized;

  const requestBody = lines.slice(requestMarkerIndex + 1).join('\n').trim();
  if (!requestBody) return normalized;

  return `（基于 ${wrapperLabel}）\n${requestBody}`;
}

function formatMirrorSpeakerBlock(
  label: string,
  text: string | null | undefined,
  markdown = false,
  forceLabel = false,
): string {
  const normalized = (text || '').trim();
  if (!normalized) {
    return forceLabel ? buildMirrorSpeakerLabel(label, markdown) : '';
  }
  const speaker = buildMirrorSpeakerLabel(label, markdown);
  return normalized.includes('\n')
    ? `${speaker}\n${normalized}`
    : `${speaker} ${normalized}`;
}

export function formatMirrorMessage(
  threadTitle: string | null,
  userText: string | null | undefined,
  assistantText: string | null | undefined,
  markdown = false,
  forceAssistantLabel = false,
  includeTitle = true,
  goalStatus?: { status?: string | null; objective?: string | null } | null,
  assistantLabel = getMirrorAssistantRuntimeLabel(),
): string {
  const sections: string[] = [];
  if (goalStatus) {
    const goalBlock = formatMirrorGoalStatus(goalStatus.status, goalStatus.objective, markdown);
    if (goalBlock) sections.push(goalBlock);
  }
  const userBlock = formatMirrorSpeakerBlock('我', userText, markdown);
  if (userBlock) {
    sections.push(userBlock);
  }
  const assistantBlock = formatMirrorSpeakerBlock(
    assistantLabel,
    assistantText,
    markdown,
    forceAssistantLabel,
  );
  if (assistantBlock) {
    sections.push(assistantBlock);
  }
  if (sections.length === 0) {
    return '';
  }
  if (includeTitle) {
    const title = buildMirrorTitle(threadTitle, markdown);
    if (goalStatus) {
      sections.splice(1, 0, title);
    } else {
      sections.unshift(title);
    }
  }
  return sections.join('\n\n').trim();
}

function buildMirrorTimeoutNotice(markdown = false): string {
  return markdown
    ? '> 超时提醒：长时间没有收到新的本地会话输出，本次流式同步已先结束；如果本地会话后续继续产出内容，会重新开始新一轮同步。'
    : '超时提醒：长时间没有收到新的本地会话输出，本次流式同步已先结束；如果本地会话后续继续产出内容，会重新开始新一轮同步。';
}

export function appendMirrorTimeoutNotice(text: string, markdown = false): string {
  const notice = buildMirrorTimeoutNotice(markdown);
  const normalized = text.trim();
  return normalized ? `${normalized}\n\n${notice}` : notice;
}
