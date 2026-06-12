import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { InboundMessage } from '../../domain/index.js';
import type {
  CodexTuiSelectionPromptChoice,
} from '../../runtime/codex/tmux-provider.js';
import type {
  RuntimeTmuxSelectionPrompt,
} from '../tmux/runtime.js';
import * as permissionBroker from '../permission/broker.js';

function defaultChoiceForSelectionPrompt(
  selectionPrompt: Extract<RuntimeTmuxSelectionPrompt, { runtime: 'codex' }>,
): CodexTuiSelectionPromptChoice {
  if (selectionPrompt.kind === 'update') return 'skip';
  if (selectionPrompt.kind === 'goal') return 'cancel';
  if (selectionPrompt.kind === 'generic') return 'not_selection';
  return 'yes_proceed';
}

function reasonForSelectionPrompt(
  selectionPrompt: Extract<RuntimeTmuxSelectionPrompt, { runtime: 'codex' }>,
  context: string,
): string {
  const suffix = context ? ` ${context}` : '';
  if (selectionPrompt.kind === 'update') {
    return `Codex TUI is waiting at a CLI update selection prompt${suffix}.`;
  }
  if (selectionPrompt.kind === 'goal') {
    return `Codex TUI is waiting at a goal replacement selection prompt${suffix}.`;
  }
  if (selectionPrompt.kind === 'generic') {
    return `Codex TUI may be waiting at an unrecognized numbered selection prompt${suffix}.`;
  }
  return `Codex TUI is waiting at an interactive selection prompt${suffix}.`;
}

export async function requestCodexTuiSelectionViaPermissionBroker(params: {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  selectionPrompt: RuntimeTmuxSelectionPrompt;
  sessionId: string;
  requestScope: string;
  reasonContext: string;
  inspectCommand?: string;
  replyToMessageId?: string;
}): Promise<CodexTuiSelectionPromptChoice | null> {
  if (params.selectionPrompt.runtime !== 'codex') return null;
  const selectionPrompt = params.selectionPrompt;
  const permissionRequestId = `codex-selection:${selectionPrompt.kind}:${params.requestScope}:${params.sessionId}:${Date.now()}`;
  const defaultChoice = defaultChoiceForSelectionPrompt(selectionPrompt);
  const choicePromise = permissionBroker.waitForCodexTuiSelectionPermission(permissionRequestId);
  const replyToMessageId = params.replyToMessageId || params.msg.messageId;
  console.log('[bridge-command] Codex TUI selection prompt forwarding to IM:', {
    event: 'tmux.startup.selection.forward',
    scope: params.requestScope,
    bridge_session_id: params.sessionId,
    chat_id: params.msg.address.chatId,
    message_id: params.msg.messageId,
    permission_request_id: permissionRequestId,
    prompt_kind: selectionPrompt.kind,
    default_choice: defaultChoice,
    prompt_summary: selectionPrompt.summary,
  });
  await permissionBroker.forwardPermissionRequest(
    params.adapter,
    params.msg.address,
    permissionRequestId,
    'Codex TUI Selection Prompt',
    {
      provider: 'tmux',
      reason: reasonForSelectionPrompt(selectionPrompt, params.reasonContext),
      inspect: params.inspectCommand || '/tmux-screen 80',
      promptKind: selectionPrompt.kind,
      defaultChoice,
      prompt: selectionPrompt.summary,
      choices: [
        ...selectionPrompt.prompt.options.map((option) => ({
          choice: option.choice,
          label: option.label,
          selected: option.selected,
        })),
        ...(selectionPrompt.kind === 'generic' ? [{ choice: 'not_selection', label: '这不是TUI选择' }] : []),
      ],
    },
    params.sessionId,
    [],
    replyToMessageId,
  );
  console.log('[bridge-command] Codex TUI selection prompt forwarded to IM:', {
    event: 'tmux.startup.selection.forwarded',
    scope: params.requestScope,
    bridge_session_id: params.sessionId,
    chat_id: params.msg.address.chatId,
    permission_request_id: permissionRequestId,
    prompt_kind: selectionPrompt.kind,
  });
  const choice = await choicePromise;
  console.log('[bridge-command] Codex TUI selection prompt resolved from IM:', {
    event: 'tmux.startup.selection.resolved',
    scope: params.requestScope,
    bridge_session_id: params.sessionId,
    chat_id: params.msg.address.chatId,
    permission_request_id: permissionRequestId,
    prompt_kind: selectionPrompt.kind,
    choice: choice || null,
    timed_out: choice === null,
  });
  return choice;
}
