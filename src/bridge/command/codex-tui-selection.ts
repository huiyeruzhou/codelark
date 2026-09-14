import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { InboundMessage } from '../../domain/index.js';
import type {
  CodexTuiSelectionPromptChoice,
} from '../../runtime/codex/tmux-provider.js';
import {
  getCodexTuiSelectionPromptUiDefaultChoice,
} from '../../runtime/codex/tmux-provider.js';
import type {
  RuntimeTmuxSelectionPrompt,
  TmuxSendAction,
} from '../tmux/runtime.js';
import * as permissionBroker from '../permission/broker.js';

export interface TmuxAutoForwardRecoveryPayload {
  kind: 'tmux-provider-auto-forward';
  version: 1;
  target: string;
  actions: TmuxSendAction[];
}

function defaultChoiceForSelectionPrompt(
  selectionPrompt: RuntimeTmuxSelectionPrompt,
): CodexTuiSelectionPromptChoice {
  if (selectionPrompt.runtime === 'claude') return 'no';
  const uiDefault = getCodexTuiSelectionPromptUiDefaultChoice(selectionPrompt.prompt);
  if (uiDefault) return uiDefault;
  if (selectionPrompt.kind === 'update') return 'update_now';
  if (selectionPrompt.kind === 'goal') return 'replace_current_goal';
  if (selectionPrompt.kind === 'generic') return 'not_selection';
  return 'yes_proceed';
}

function reasonForSelectionPrompt(
  selectionPrompt: RuntimeTmuxSelectionPrompt,
  context: string,
): string {
  const suffix = context ? ` ${context}` : '';
  if (selectionPrompt.runtime === 'claude') {
    return `Claude Code is asking whether to enter bypass-permissions mode${suffix}.`;
  }
  if (selectionPrompt.kind === 'update') {
    return `Codex TUI is waiting at a CLI update selection prompt${suffix}.`;
  }
  if (selectionPrompt.kind === 'goal') {
    return `Codex TUI is waiting at a goal replacement selection prompt${suffix}.`;
  }
  if (selectionPrompt.kind === 'model_migration') {
    return `Codex TUI is waiting for a model migration choice${suffix}.`;
  }
  if (selectionPrompt.kind === 'generic') {
    return `Codex TUI may be waiting at an unrecognized numbered selection prompt${suffix}.`;
  }
  return `Codex TUI is waiting at an interactive selection prompt${suffix}.`;
}

export async function requestRuntimeTuiSelectionViaPermissionBroker(params: {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  selectionPrompt: RuntimeTmuxSelectionPrompt;
  sessionId: string;
  requestScope: string;
  reasonContext: string;
  inspectCommand?: string;
  replyToMessageId?: string;
  autoForwardRecovery?: {
    target: string;
    actions: TmuxSendAction[];
  };
}): Promise<CodexTuiSelectionPromptChoice | null> {
  const selectionPrompt = params.selectionPrompt;
  if (selectionPrompt.runtime === 'claude' && selectionPrompt.kind !== 'bypass_permissions') return null;
  const permissionRequestId = `${selectionPrompt.runtime}-selection:${selectionPrompt.kind}:${params.requestScope}:${params.sessionId}:${Date.now()}`;
  const defaultChoice = defaultChoiceForSelectionPrompt(selectionPrompt);
  const choicePromise = permissionBroker.waitForCodexTuiSelectionPermission(permissionRequestId);
  const replyToMessageId = params.replyToMessageId || params.msg.messageId;
  console.log('[bridge-command] Codex TUI selection prompt forwarding to IM:', {
    event: 'tmux.startup.selection.forward',
    runtime: selectionPrompt.runtime,
    scope: params.requestScope,
    bridge_session_id: params.sessionId,
    chat_id: params.msg.address.chatId,
    message_id: params.msg.messageId,
    permission_request_id: permissionRequestId,
    prompt_kind: selectionPrompt.kind,
    default_choice: defaultChoice,
    prompt_summary: selectionPrompt.summary,
  });
  permissionBroker.forwardPermissionRequest(
    params.adapter,
    params.msg.address,
    permissionRequestId,
    selectionPrompt.runtime === 'claude' ? 'Claude TUI Selection Prompt' : 'Codex TUI Selection Prompt',
    {
      runtime: selectionPrompt.runtime,
      provider: 'tmux',
      reason: reasonForSelectionPrompt(selectionPrompt, params.reasonContext),
      inspect: params.inspectCommand || '/tmux-screen 80',
      promptKind: selectionPrompt.kind,
      defaultChoice,
      prompt: selectionPrompt.summary,
      choices: selectionPrompt.runtime === 'claude'
        ? [
            { choice: 'no', label: 'No, exit', selected: true },
            { choice: 'yes_proceed', label: 'Yes, I accept', selected: false },
          ]
        : [
            ...selectionPrompt.prompt.options.map((option) => ({
              choice: option.choice,
              label: option.label,
              selected: option.selected,
            })),
            ...(selectionPrompt.kind === 'generic' ? [{ choice: 'not_selection', label: '这不是TUI选择' }] : []),
          ],
    },
    params.sessionId,
    params.autoForwardRecovery
      ? [{
          kind: 'tmux-provider-auto-forward',
          version: 1,
          target: params.autoForwardRecovery.target,
          actions: params.autoForwardRecovery.actions,
        } satisfies TmuxAutoForwardRecoveryPayload]
      : [],
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

export const requestCodexTuiSelectionViaPermissionBroker = requestRuntimeTuiSelectionViaPermissionBroker;
