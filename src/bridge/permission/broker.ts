/**
 * Permission Broker — forwards LLM permission requests to IM channels
 * and handles user responses via inline buttons.
 *
 * When the provider needs tool approval, the broker:
 * 1. Formats a permission prompt with inline keyboard buttons
 * 2. Sends it via the delivery layer
 * 3. Records the link between permission ID and IM message
 * 4. When a callback arrives, resolves the permission via the gateway
 */

import type { ChannelAddress, OutboundMessage, OutboundRichCard, PermissionLinkRecord, SendResult } from '../../domain/index.js';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import { deliver } from '../../channels/delivery/deliver.js';
import { getBridgeContext } from '../host/context.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Dedup recent permission forwards to prevent duplicate cards.
 * Key: permissionRequestId, value: timestamp. Entries expire after 30s.
 */
const recentPermissionForwards = new Map<string, number>();
type PermissionUpdate = Record<string, unknown>;
const CODEX_TRUST_TOOL_NAME = 'Codex Trust Directory';
const CODEX_UPDATE_TOOL_NAME = 'Codex Update Prompt';
const CODEX_SELECTION_TOOL_NAME = 'Codex TUI Selection Prompt';
const CODEX_UPDATE_CALLBACK_PREFIX = 'codex-update-choice:';
const CODEX_SELECTION_CALLBACK_PREFIX = 'codex-tui-selection-choice:';

export type CodexSelectionChoice =
  | 'update_now'
  | 'skip'
  | 'skip_until_next_version'
  | 'replace_current_goal'
  | 'cancel'
  | 'yes_proceed'
  | 'yes_always'
  | 'no'
  | 'not_selection'
  | `option_${number}`;

export type CodexSelectionCallbackClaim = {
  permissionRequestId: string;
  choice: CodexSelectionChoice;
  link: PermissionLinkRecord;
  handledBy: 'waiter' | 'pending_permission' | 'orphan';
};

type CodexSelectionWaiter = {
  resolve: (choice: CodexSelectionChoice) => void;
  timer: NodeJS.Timeout;
};

const codexSelectionWaiters = new Map<string, CodexSelectionWaiter>();

function isCodexTrustPermission(permissionRequestId: string, toolName: string): boolean {
  return toolName === CODEX_TRUST_TOOL_NAME || permissionRequestId.startsWith('codex-trust:');
}

function isCodexUpdatePermission(permissionRequestId: string, toolName: string): boolean {
  return toolName === CODEX_UPDATE_TOOL_NAME || permissionRequestId.startsWith('codex-update:');
}

function isCodexSelectionPermission(permissionRequestId: string, toolName: string): boolean {
  return toolName === CODEX_SELECTION_TOOL_NAME || permissionRequestId.startsWith('codex-selection:');
}

function formatCodexTrustSummary(toolInput: Record<string, unknown>): string {
  const provider = typeof toolInput.provider === 'string' ? toolInput.provider : '';
  const workingDirectory = typeof toolInput.workingDirectory === 'string' ? toolInput.workingDirectory : '';
  const inspect = typeof toolInput.inspect === 'string' ? toolInput.inspect : '';
  return [
    'Codex TUI is asking whether to trust this working directory before it can continue.',
    provider ? `Provider: ${provider}` : '',
    workingDirectory ? `Directory: ${workingDirectory}` : '',
    inspect ? `Inspect current screen: ${inspect}` : '',
  ].filter(Boolean).join('\n');
}

function formatCodexSelectionContext(toolInput: Record<string, unknown>): string {
  const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt.trim() : '';
  return prompt || JSON.stringify(toolInput, null, 2);
}

function formatCodexUpdateSummary(toolInput: Record<string, unknown>): string {
  const provider = typeof toolInput.provider === 'string' ? toolInput.provider : '';
  const inspect = typeof toolInput.inspect === 'string' ? toolInput.inspect : '';
  const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
  const promptKind = typeof toolInput.promptKind === 'string' ? toolInput.promptKind : '';
  const firstLine = promptKind === 'goal'
    ? 'Codex TUI appears to be waiting at a goal replacement selection prompt.'
    : promptKind === 'generic'
      ? 'Codex TUI appears to be waiting at a numbered selection prompt.'
      : promptKind === 'permission'
        ? 'Codex TUI appears to be waiting at an interactive selection prompt.'
        : 'Codex TUI appears to be waiting at an update selection prompt.';
  return [
    firstLine,
    provider ? `Provider: ${provider}` : '',
    inspect ? `Inspect current screen: ${inspect}` : '',
    prompt ? `Prompt:\n${prompt}` : '',
  ].filter(Boolean).join('\n');
}

function codexSelectionChoiceLabel(choice: CodexSelectionChoice): string {
  switch (choice) {
    case 'update_now': return 'Update now';
    case 'skip': return 'Skip';
    case 'skip_until_next_version': return 'Skip until next version';
    case 'replace_current_goal': return 'Replace current goal';
    case 'cancel': return 'Cancel';
    case 'yes_proceed': return 'Yes, proceed';
    case 'yes_always': return "Yes, and don't ask again";
    case 'no': return 'No';
    case 'not_selection': return '这不是TUI选择';
    default: {
      const match = choice.match(/^option_(\d+)$/);
      return match ? `选择第 ${match[1]} 项` : choice;
    }
  }
}

function buildCodexSelectionChoiceCallbackData(permissionRequestId: string, choice: CodexSelectionChoice): string {
  return `${CODEX_SELECTION_CALLBACK_PREFIX}${encodeURIComponent(permissionRequestId)}:${choice}`;
}

export function parseCodexSelectionChoiceCallbackData(callbackData: string): {
  permissionRequestId: string;
  choice: CodexSelectionChoice;
} | null | undefined {
  const prefix = callbackData.startsWith(CODEX_SELECTION_CALLBACK_PREFIX)
    ? CODEX_SELECTION_CALLBACK_PREFIX
    : callbackData.startsWith(CODEX_UPDATE_CALLBACK_PREFIX)
      ? CODEX_UPDATE_CALLBACK_PREFIX
      : '';
  if (!prefix) return undefined;
  const raw = callbackData.slice(prefix.length);
  const separator = raw.lastIndexOf(':');
  if (separator <= 0) return null;
  const choice = raw.slice(separator + 1) as CodexSelectionChoice;
  if (![
    'update_now',
    'skip',
    'skip_until_next_version',
    'replace_current_goal',
    'cancel',
    'yes_proceed',
    'yes_always',
    'no',
    'not_selection',
  ].includes(choice) && !/^option_\d+$/.test(choice)) {
    return null;
  }
  try {
    const permissionRequestId = decodeURIComponent(raw.slice(0, separator));
    return permissionRequestId ? { permissionRequestId, choice } : null;
  } catch {
    return null;
  }
}

function extractCodexSelectionChoices(
  toolInput: Record<string, unknown>,
  fallbackKind: 'update' | 'permission' | 'goal' | 'generic',
): CodexSelectionChoice[] {
  const rawChoices = Array.isArray(toolInput.choices) ? toolInput.choices : [];
  const choices = rawChoices
    .map((item) => typeof item === 'object' && item
      ? (item as { choice?: unknown }).choice
      : item)
    .filter((choice): choice is CodexSelectionChoice =>
      choice === 'update_now'
      || choice === 'skip'
      || choice === 'skip_until_next_version'
      || choice === 'replace_current_goal'
      || choice === 'cancel'
      || choice === 'yes_proceed'
      || choice === 'yes_always'
      || choice === 'no'
      || choice === 'not_selection'
      || (typeof choice === 'string' && /^option_\d+$/.test(choice)),
    );
  if (choices.length > 0) return Array.from(new Set(choices));
  const promptKind = typeof toolInput.promptKind === 'string' ? toolInput.promptKind : '';
  if ((promptKind || fallbackKind) === 'generic') return ['option_1', 'not_selection'];
  if ((promptKind || fallbackKind) === 'update') return ['update_now', 'skip', 'skip_until_next_version'];
  if ((promptKind || fallbackKind) === 'goal') return ['replace_current_goal', 'cancel'];
  return ['yes_proceed', 'yes_always', 'no'];
}

function extractCodexSelectionLabelByChoice(
  toolInput: Record<string, unknown>,
  choice: CodexSelectionChoice,
): string {
  const rawChoices = Array.isArray(toolInput.choices) ? toolInput.choices : [];
  for (const item of rawChoices) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { choice?: unknown; label?: unknown };
    if (record.choice === choice && typeof record.label === 'string' && record.label.trim()) {
      return record.label.trim();
    }
  }
  return codexSelectionChoiceLabel(choice);
}

function buildCodexSelectionPromptCard(
  permissionRequestId: string,
  summary: string,
  toolInput: Record<string, unknown>,
  fallbackKind: 'update' | 'permission' | 'goal' | 'generic',
): OutboundRichCard {
  const choices = extractCodexSelectionChoices(toolInput, fallbackKind);
  const defaultChoice = typeof toolInput.defaultChoice === 'string'
    && choices.includes(toolInput.defaultChoice as CodexSelectionChoice)
    ? toolInput.defaultChoice as CodexSelectionChoice
    : choices[0];
  return {
    title: 'Codex TUI Selection',
    template: 'yellow',
    sections: [
      {
        markdown: [
          'Codex tmux 可能停在 TUI 选择界面，请选择要执行的选项。',
          '可以用 `/tmux-screen 20`核实。',
          '',
          summary,
        ].join('\n'),
      },
    ],
    selects: [
      {
        id: 'clk_codex_tui_selection',
        placeholder: '选择 Codex TUI 操作',
        selectedCallbackData: buildCodexSelectionChoiceCallbackData(permissionRequestId, defaultChoice),
        options: choices.map((choice) => ({
          text: extractCodexSelectionLabelByChoice(toolInput, choice),
          callbackData: buildCodexSelectionChoiceCallbackData(permissionRequestId, choice),
        })),
      },
    ],
    footer: ['选择后 CodeLark 会向 tmux 发送方向键并回车确认。'],
  };
}

export function waitForCodexTuiSelectionPermission(
  permissionRequestId: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<CodexSelectionChoice | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      codexSelectionWaiters.delete(permissionRequestId);
      resolve(null);
    }, timeoutMs);
    codexSelectionWaiters.set(permissionRequestId, { resolve, timer });
  });
}

export function claimCodexSelectionCallback(
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
): CodexSelectionCallbackClaim | null | undefined {
  const { store, permissions } = getBridgeContext();

  const codexSelectionChoice = parseCodexSelectionChoiceCallbackData(callbackData);
  if (codexSelectionChoice === undefined) return undefined;
  if (!codexSelectionChoice) return null;
  const { permissionRequestId, choice } = codexSelectionChoice;
  const link = store.getPermissionLink(permissionRequestId);
  if (!link) {
    console.warn(`[permission-broker] No permission link found for ${permissionRequestId}`);
    return null;
  }
  if (link.chatId !== callbackChatId) {
    console.warn(`[permission-broker] Chat ID mismatch: expected ${link.chatId}, got ${callbackChatId}`);
    return null;
  }
  if (callbackMessageId && link.messageId !== callbackMessageId) {
    console.warn(`[permission-broker] Message ID mismatch: expected ${link.messageId}, got ${callbackMessageId}`);
    return null;
  }
  if (link.resolved) {
    console.warn(`[permission-broker] Permission ${permissionRequestId} already resolved`);
    return null;
  }
  let claimed: boolean;
  try {
    claimed = store.markPermissionLinkResolved(permissionRequestId);
  } catch {
    return null;
  }
  if (!claimed) return null;

  const waiter = codexSelectionWaiters.get(permissionRequestId);
  if (waiter) {
    clearTimeout(waiter.timer);
    codexSelectionWaiters.delete(permissionRequestId);
    waiter.resolve(choice);
    permissions.resolvePendingPermission(permissionRequestId, {
      behavior: 'allow',
      message: choice,
    });
    return { permissionRequestId, choice, link, handledBy: 'waiter' };
  }

  const resolvedPending = permissions.resolvePendingPermission(permissionRequestId, {
    behavior: 'allow',
    message: choice,
  });
  return {
    permissionRequestId,
    choice,
    link,
    handledBy: resolvedPending ? 'pending_permission' : 'orphan',
  };
}

/**
 * Forward a permission request to an IM channel as an interactive message.
 */
export async function forwardPermissionRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Dedup: prevent duplicate forwarding of the same permission request
  const now = Date.now();
  if (recentPermissionForwards.has(permissionRequestId)) {
    console.warn(`[permission-broker] Duplicate forward suppressed for ${permissionRequestId}`);
    return;
  }
  recentPermissionForwards.set(permissionRequestId, now);
  // Clean up old entries
  for (const [id, ts] of recentPermissionForwards) {
    if (now - ts > 30_000) recentPermissionForwards.delete(id);
  }

  console.log(`[permission-broker] Forwarding permission request: ${permissionRequestId} tool=${toolName} channel=${adapter.channelType}`);

  const isTrustPrompt = isCodexTrustPermission(permissionRequestId, toolName);
  const isUpdatePrompt = isCodexUpdatePermission(permissionRequestId, toolName);
  const isSelectionPrompt = isCodexSelectionPermission(permissionRequestId, toolName);
  // Format the input summary (truncated)
  const inputStr = isTrustPrompt
    ? formatCodexTrustSummary(toolInput)
    : isSelectionPrompt
      ? formatCodexSelectionContext(toolInput)
    : isUpdatePrompt
      ? formatCodexUpdateSummary(toolInput)
    : JSON.stringify(toolInput, null, 2);
  const truncatedInput = inputStr.length > 300
    ? inputStr.slice(0, 300) + '...'
    : inputStr;

  let result: SendResult;

  if (isUpdatePrompt || isSelectionPrompt) {
    const message: OutboundMessage = {
      address,
      text: [
        `<b>Codex TUI Selection</b>`,
        ``,
        escapeHtml(truncatedInput),
        ``,
        `Choose the option CodeLark should select in tmux:`,
      ].join('\n'),
      parseMode: 'HTML',
      richCard: buildCodexSelectionPromptCard(
        permissionRequestId,
        truncatedInput,
        toolInput,
        isUpdatePrompt ? 'update' : 'permission',
      ),
      replyToMessageId,
    };
    result = await deliver(adapter, message, { sessionId });
  } else {
    const text = isTrustPrompt
    ? [
      `<b>Codex Trust Confirmation</b>`,
      ``,
      `<pre>${escapeHtml(truncatedInput)}</pre>`,
      ``,
      `Choose whether Codex may trust this directory and continue:`,
    ].join('\n')
    : [
      `<b>Permission Required</b>`,
      ``,
      `Tool: <code>${escapeHtml(toolName)}</code>`,
      `<pre>${escapeHtml(truncatedInput)}</pre>`,
      ``,
      `Choose an action:`,
    ].join('\n');

    const message: OutboundMessage = {
      address,
      text,
      parseMode: 'HTML',
      inlineButtons: isTrustPrompt
        ? [
          [
            { text: 'Trust and continue', callbackData: `perm:allow:${permissionRequestId}` },
            { text: 'Deny', callbackData: `perm:deny:${permissionRequestId}` },
          ],
        ]
        : [
          [
            { text: 'Allow', callbackData: `perm:allow:${permissionRequestId}` },
            { text: 'Allow Session', callbackData: `perm:allow_session:${permissionRequestId}` },
            { text: 'Deny', callbackData: `perm:deny:${permissionRequestId}` },
          ],
        ],
      replyToMessageId,
    };

    result = await deliver(adapter, message, { sessionId });
  }

  // Record the link so we can match callback queries back to this permission
  if (result.ok && result.messageId) {
    try {
      store.insertPermissionLink({
        permissionRequestId,
        channelType: adapter.channelType,
        chatId: address.chatId,
        messageId: result.messageId,
        sessionId,
        toolName,
        suggestions: suggestions ? JSON.stringify(suggestions) : '',
      });
    } catch { /* best effort */ }
  }
}

/**
 * Handle a permission callback from an inline button press.
 * Validates that the callback came from the same chat AND same message that
 * received the permission request, prevents duplicate resolution via atomic
 * DB check-and-set, and implements real allow_session semantics by passing
 * updatedPermissions (suggestions).
 *
 * Returns true if the callback was recognized and handled.
 */
export function handlePermissionCallback(
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
): boolean {
  const { store, permissions } = getBridgeContext();

  const codexSelectionClaim = claimCodexSelectionCallback(callbackData, callbackChatId, callbackMessageId);
  if (codexSelectionClaim !== undefined) {
    return Boolean(codexSelectionClaim && codexSelectionClaim.handledBy !== 'orphan');
  }

  // Parse callback data: perm:action:permId
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'perm') return false;

  const action = parts[1];
  const permissionRequestId = parts.slice(2).join(':'); // permId might contain colons

  // Look up the permission link to validate origin and check dedup
  const link = store.getPermissionLink(permissionRequestId);
  if (!link) {
    console.warn(`[permission-broker] No permission link found for ${permissionRequestId}`);
    return false;
  }
  const isTrustPrompt = isCodexTrustPermission(permissionRequestId, '');

  if (isTrustPrompt && action === 'allow_session') {
    console.warn(`[permission-broker] Trust permission ${permissionRequestId} does not support allow_session`);
    return false;
  }

  // Security: verify the callback came from the same chat that received the request
  if (link.chatId !== callbackChatId) {
    console.warn(`[permission-broker] Chat ID mismatch: expected ${link.chatId}, got ${callbackChatId}`);
    return false;
  }

  // Security: verify the callback came from the original permission message
  if (callbackMessageId && link.messageId !== callbackMessageId) {
    console.warn(`[permission-broker] Message ID mismatch: expected ${link.messageId}, got ${callbackMessageId}`);
    return false;
  }

  // Dedup: reject if already resolved (fast path before expensive resolution)
  if (link.resolved) {
    console.warn(`[permission-broker] Permission ${permissionRequestId} already resolved`);
    return false;
  }

  // Atomically mark as resolved BEFORE calling resolvePendingPermission
  // to prevent race conditions with concurrent button clicks
  let claimed: boolean;
  try {
    claimed = store.markPermissionLinkResolved(permissionRequestId);
  } catch {
    return false;
  }

  if (!claimed) {
    // Another concurrent handler already resolved this permission
    console.warn(`[permission-broker] Permission ${permissionRequestId} already claimed by concurrent handler`);
    return false;
  }

  let resolved: boolean;

  switch (action) {
    case 'allow':
      resolved = permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
      });
      break;

    case 'allow_session': {
      // Parse stored suggestions so subsequent same-tool calls auto-approve
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (link.suggestions) {
        try {
          updatedPermissions = JSON.parse(link.suggestions) as PermissionUpdate[];
        } catch { /* fall through without updatedPermissions */ }
      }

      resolved = permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
        ...(updatedPermissions ? { updatedPermissions } : {}),
      });
      break;
    }

    case 'deny':
      resolved = permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'deny',
        message: 'Denied via IM bridge',
      });
      break;

    default:
      return false;
  }

  return resolved;
}
