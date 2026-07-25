/** @deprecated Tool lifecycle is runtime-neutral; import from shared/progress/tool-events. */
export {
  applyToolCallEventToTools as applyCodexTurnEventToTools,
  toolCallEventFromMirrorRecord as codexTurnEventFromMirrorRecord,
  toolCallEventFromSdk as codexTurnEventFromSdkToolEvent,
} from '../../shared/progress/tool-events.js';
export type { ToolCallEvent as CodexTurnEvent } from '../../shared/progress/tool-events.js';
