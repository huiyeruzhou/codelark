export const CODEX_ENVIRONMENT_CONTEXT_LOADED_NOTICE = '> ⚙️ 环境上下文已加载';
export const TURN_ABORTED_NOTICE = '任务已中断。';

export type CodexInternalControlEvent =
  | {
      kind: 'goal_context';
      display: 'hidden';
      content: '';
    }
  | {
      kind: 'environment_context';
      display: 'notice';
      content: typeof CODEX_ENVIRONMENT_CONTEXT_LOADED_NOTICE;
    }
  | {
      kind: 'turn_aborted';
      display: 'notice';
      content: typeof TURN_ABORTED_NOTICE;
    };

export type CodexJsonlDisplayText =
  | {
      kind: 'hidden';
      content: '';
    }
  | {
      kind: 'notice';
      content: string;
    }
  | {
      kind: 'text';
      content: string;
    };

function isFullXmlLikeBlock(text: string, tagName: string): boolean {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^<${escaped}\\b[\\s\\S]*<\\/${escaped}>\\s*$`, 'i').test(text.trim());
}

function isCodexAgentsEnvironmentContextBlock(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('# AGENTS.md instructions for ')
    && trimmed.includes('<INSTRUCTIONS>')
    && trimmed.includes('<environment_context>');
}

function isCodexGoalContextBlock(text: string): boolean {
  const trimmed = text.trim();
  if (isFullXmlLikeBlock(trimmed, 'goal_context')) return true;
  if (!isFullXmlLikeBlock(trimmed, 'codex_internal_context')) return false;
  const openTag = trimmed.match(/^<codex_internal_context\b([^>]*)>/i)?.[1] || '';
  return /\bsource\s*=\s*["']goal["']/i.test(openTag);
}

export function parseCodexInternalControlEvent(text: string): CodexInternalControlEvent | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  if (isCodexGoalContextBlock(trimmed)) {
    return {
      kind: 'goal_context',
      display: 'hidden',
      content: '',
    };
  }

  if (isFullXmlLikeBlock(trimmed, 'environment_context')) {
    return {
      kind: 'environment_context',
      display: 'notice',
      content: CODEX_ENVIRONMENT_CONTEXT_LOADED_NOTICE,
    };
  }

  if (isFullXmlLikeBlock(trimmed, 'turn_aborted') || isFullXmlLikeBlock(trimmed, 'turn_anorted')) {
    return {
      kind: 'turn_aborted',
      display: 'notice',
      content: TURN_ABORTED_NOTICE,
    };
  }

  return null;
}

export function resolveCodexJsonlDisplayText(text: string): CodexJsonlDisplayText {
  const normalized = String(text || '');
  const event = parseCodexInternalControlEvent(normalized);
  if (event?.display === 'hidden') return { kind: 'hidden', content: '' };
  if (event?.display === 'notice') return { kind: 'notice', content: event.content };
  if (isCodexAgentsEnvironmentContextBlock(normalized)) {
    return { kind: 'notice', content: CODEX_ENVIRONMENT_CONTEXT_LOADED_NOTICE };
  }
  return { kind: 'text', content: normalized };
}

export function renderCodexInternalTextForDisplay(text: string): string {
  const display = resolveCodexJsonlDisplayText(text);
  return display.content;
}
