export const AGENT_QUESTION_CALLBACK_PREFIX = 'clk-agent-question:';

export interface AgentQuestionCallbackPayload {
  question: string;
  answer: string;
}

export function buildAgentQuestionCallbackData(payload: AgentQuestionCallbackPayload): string {
  const normalized = {
    question: payload.question.slice(0, 500),
    answer: payload.answer.slice(0, 500),
  };
  return `${AGENT_QUESTION_CALLBACK_PREFIX}${encodeURIComponent(JSON.stringify(normalized))}`;
}

export function parseAgentQuestionCallbackData(callbackData: string): AgentQuestionCallbackPayload | null | undefined {
  if (!callbackData.startsWith(AGENT_QUESTION_CALLBACK_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(callbackData.slice(AGENT_QUESTION_CALLBACK_PREFIX.length)));
    if (!parsed || typeof parsed !== 'object') return null;
    const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
    const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
    if (!question || !answer) return null;
    return { question, answer };
  } catch {
    return null;
  }
}
