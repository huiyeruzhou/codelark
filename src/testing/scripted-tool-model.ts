import type { LLMProvider, StreamChatParams } from '../runtime/contracts.js';
import { sseEvent } from '../runtime/sse.js';

export type ScriptedToolModelStep =
  | { type: 'status'; data: Record<string, unknown> }
  | { type: 'reasoning'; text: string; label?: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError?: boolean }
  | { type: 'text'; text: string }
  | { type: 'result'; data?: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'delay'; ms: number };

export interface ScriptedToolModelOptions {
  steps: ScriptedToolModelStep[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Deterministic LLMProvider used to exercise complete tool lifecycles. */
export class ScriptedToolModelProvider implements LLMProvider {
  readonly requests: StreamChatParams[] = [];
  readonly emittedSteps: ScriptedToolModelStep[] = [];
  lastError: unknown = null;

  constructor(private readonly options: ScriptedToolModelOptions) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    this.requests.push(params);
    return new ReadableStream<string>({
      start: (controller) => {
        void (async () => {
          try {
            for (const step of this.options.steps) {
              this.emittedSteps.push(step);
              if (step.type === 'delay') {
                await sleep(step.ms);
              } else if (step.type === 'status') {
                controller.enqueue(sseEvent('status', step.data));
              } else if (step.type === 'reasoning') {
                controller.enqueue(sseEvent('status', {
                  reasoning: step.label || '思考',
                  thinking: step.text,
                }));
              } else if (step.type === 'tool_start') {
                controller.enqueue(sseEvent('tool_use', {
                  id: step.id,
                  name: step.name,
                  input: step.input,
                }));
              } else if (step.type === 'tool_result') {
                controller.enqueue(sseEvent('tool_result', {
                  tool_use_id: step.id,
                  content: step.output,
                  is_error: step.isError === true,
                }));
              } else if (step.type === 'text') {
                controller.enqueue(sseEvent('text', step.text));
              } else if (step.type === 'result') {
                controller.enqueue(sseEvent('result', step.data || {}));
              } else if (step.type === 'error') {
                controller.enqueue(sseEvent('error', step.message));
              }
            }
            controller.close();
          } catch (error) {
            this.lastError = error;
            controller.error(error);
          }
        })();
      },
    });
  }
}

export function scriptedToolCall(
  id: string,
  name: string,
  input: unknown,
  output: string,
  options: { isError?: boolean } = {},
): ScriptedToolModelStep[] {
  return [
    { type: 'tool_start', id, name, input },
    { type: 'tool_result', id, output, ...(options.isError ? { isError: true } : {}) },
  ];
}
