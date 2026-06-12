import * as router from '../session/channel-router.js';
import { deliverBridgeNotice } from '../../channels/delivery/feedback.js';
import type { BaseChannelAdapter, StructuredStreamingUiActionButton } from '../../channels/contracts.js';
import type { BridgeStore, ChannelChat, InboundMessage, OutboundRichCard } from '../../domain/index.js';
import {
  finalizeStreamFeedback,
  pushStreamFeedbackActions,
  pushStreamFeedbackStatus,
  pushStreamFeedbackText,
  type StreamFeedbackTarget,
} from '../../channels/delivery/stream-feedback.js';
import { handlePtyScreenCommand } from './pty.js';
import { handleShellCommand, type ShellCommandRunner } from './shell.js';
import { handleTmuxBridgeCommand } from './tmux.js';
import { requestCodexTuiSelectionViaPermissionBroker } from './codex-tui-selection.js';

const TMUX_SCREEN_STOP_CALLBACK_PREFIX = 'tmux-screen:stop:';
const PTY_SCREEN_STOP_CALLBACK_PREFIX = 'pty-screen:stop:';

const TMUX_COMMANDS = new Set([
  '/tmux',
  '/tmux-key',
  '/tmux-switch',
  '/tmux-attach',
  '/tmux-new',
  '/tmux-status',
  '/tmux-screen',
  '/tmux-set',
]);

export interface TerminalDispatchDeps {
  reconcileMirrorSubscriptions?(): Promise<void>;
  shellRunner?: ShellCommandRunner;
  tmuxProviderAutoForward?: boolean;
  onTmuxProviderAutoForwarded?: () => Promise<void> | void;
}

export interface TerminalDispatchParams {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  command: string;
  args: string;
  store: BridgeStore;
  currentBinding: ChannelChat | null;
  commandBinding: ChannelChat | null;
  deps: TerminalDispatchDeps;
  markdown: boolean;
}

export interface TerminalDispatchResult {
  response: string;
  richCard?: OutboundRichCard;
}

export function isTerminalRawInputCommand(command: string): boolean {
  return TMUX_COMMANDS.has(command) || command === '/pty-screen' || command === '/shell';
}

export async function handleTerminalDispatchCommand(params: TerminalDispatchParams): Promise<TerminalDispatchResult> {
  if (TMUX_COMMANDS.has(params.command)) return handleTmuxDispatchCommand(params);
  if (params.command === '/pty-screen') return handlePtyScreenDispatchCommand(params);
  if (params.command === '/shell') return handleShellDispatchCommand(params);
  return { response: '' };
}

async function handleTmuxDispatchCommand(params: TerminalDispatchParams): Promise<TerminalDispatchResult> {
  const { adapter, args, command, currentBinding, deps, markdown, msg, store } = params;
  const binding = currentBinding || router.resolve(msg.address);
  const session = store.getSession(binding.bridgeSessionId);
  if (!session) return { response: '当前会话不存在，无法维护 tmux 状态。' };
  let richCard: OutboundRichCard | undefined;
  const tmuxScreenTarget: StreamFeedbackTarget = {
    adapter,
    channelType: adapter.channelType,
    chatId: msg.address.chatId,
    streamKey: `tmux-screen:${msg.address.channelType}:${msg.address.chatId}:${binding.bridgeSessionId}`,
  };
  const tmuxScreenCard = (
    command === '/tmux-screen'
    && adapter.supportsStructuredStreamingUi?.(msg.address.chatId)
    && typeof adapter.onStreamText === 'function'
  )
    ? {
        update: (text: string, statusText: string) => {
          pushStreamFeedbackText(tmuxScreenTarget, text);
          pushStreamFeedbackStatus(tmuxScreenTarget, statusText);
        },
        actions: (actions: StructuredStreamingUiActionButton[][]) => {
          pushStreamFeedbackActions(tmuxScreenTarget, actions);
        },
        finish: (status: 'completed' | 'interrupted' | 'error', text: string) => (
          finalizeStreamFeedback(tmuxScreenTarget, status, text)
        ),
      }
    : undefined;
  const response = await handleTmuxBridgeCommand({
    command,
    args,
    store,
    binding,
    session,
    markdown,
    autoRecoverProviderSession: deps.tmuxProviderAutoForward === true || (command === '/tmux' && args.trim().length > 0),
    suppressSuccessfulResponse: deps.tmuxProviderAutoForward === true && command === '/tmux',
    tmuxProviderAutoForward: deps.tmuxProviderAutoForward,
    onTmuxProviderAutoForwarded: deps.onTmuxProviderAutoForwarded,
    reconcileMirrorSubscriptions: deps.reconcileMirrorSubscriptions,
    requestCodexTuiSelection: async (selectionPrompt, requestOptions) => {
      return requestCodexTuiSelectionViaPermissionBroker({
        adapter,
        msg,
        selectionPrompt,
        sessionId: requestOptions.sessionId,
        requestScope: deps.tmuxProviderAutoForward === true ? 'provider-auto-forward-startup' : 'tmux-command-startup',
        reasonContext: deps.tmuxProviderAutoForward === true
          ? 'while starting or recovering the tmux provider session before forwarding a user message'
          : 'during /tmux startup or recovery',
      });
    },
    notifyBackgroundOperation: async (message: string) => {
      if (deps.tmuxProviderAutoForward === true && command === '/tmux') {
        return;
      }
      await deliverBridgeNotice(adapter, msg.address, message, {
        replyToMessageId: msg.messageId,
        audit: false,
      });
    },
    screenMonitor: command === '/tmux-screen'
      ? {
          key: `${msg.address.channelType}:${msg.address.chatId}:${binding.bridgeSessionId}`,
          stopCallbackData: `${TMUX_SCREEN_STOP_CALLBACK_PREFIX}${encodeURIComponent(binding.bridgeSessionId)}`,
          card: tmuxScreenCard,
          deliver: async (text) => {
            await deliverBridgeNotice(adapter, msg.address, text, {
              sessionId: binding.bridgeSessionId,
              audit: true,
            });
          },
        }
      : undefined,
    richCard: (card) => {
      richCard = card;
    },
  });
  return { response, richCard };
}

async function handlePtyScreenDispatchCommand(params: TerminalDispatchParams): Promise<TerminalDispatchResult> {
  const { adapter, args, currentBinding, markdown, msg, store } = params;
  const binding = currentBinding || router.resolve(msg.address);
  const session = store.getSession(binding.bridgeSessionId);
  if (!session) return { response: '当前会话不存在，无法读取 pty 屏幕。' };
  const ptyScreenTarget: StreamFeedbackTarget = {
    adapter,
    channelType: adapter.channelType,
    chatId: msg.address.chatId,
    streamKey: `pty-screen:${msg.address.channelType}:${msg.address.chatId}:${binding.bridgeSessionId}`,
  };
  const ptyScreenCard = (
    adapter.supportsStructuredStreamingUi?.(msg.address.chatId)
    && typeof adapter.onStreamText === 'function'
  )
    ? {
        update: (text: string, statusText: string) => {
          pushStreamFeedbackText(ptyScreenTarget, text);
          pushStreamFeedbackStatus(ptyScreenTarget, statusText);
        },
        actions: (actions: StructuredStreamingUiActionButton[][]) => {
          pushStreamFeedbackActions(ptyScreenTarget, actions);
        },
        finish: (status: 'completed' | 'interrupted' | 'error', text: string) => (
          finalizeStreamFeedback(ptyScreenTarget, status, text)
        ),
      }
    : undefined;
  const response = await handlePtyScreenCommand({
    args,
    session,
    binding,
    markdown,
    screenMonitor: {
      key: `${msg.address.channelType}:${msg.address.chatId}:${binding.bridgeSessionId}`,
      stopCallbackData: `${PTY_SCREEN_STOP_CALLBACK_PREFIX}${encodeURIComponent(binding.bridgeSessionId)}`,
      card: ptyScreenCard,
      deliver: async (text) => {
        await deliverBridgeNotice(adapter, msg.address, text, {
          sessionId: binding.bridgeSessionId,
          audit: true,
        });
      },
    },
  });
  return { response };
}

async function handleShellDispatchCommand(params: TerminalDispatchParams): Promise<TerminalDispatchResult> {
  const { adapter, args, commandBinding, deps, markdown, msg } = params;
  const shellTarget: StreamFeedbackTarget = {
    adapter,
    channelType: adapter.channelType,
    chatId: msg.address.chatId,
    streamKey: `shell:${msg.address.channelType}:${msg.address.chatId}:${commandBinding?.bridgeSessionId || 'none'}:${msg.messageId}`,
  };
  const shellCard = (
    adapter.supportsStructuredStreamingUi?.(msg.address.chatId)
    && typeof adapter.onStreamText === 'function'
  )
    ? {
        update: (cardText: string, statusText: string) => {
          pushStreamFeedbackText(shellTarget, cardText);
          pushStreamFeedbackStatus(shellTarget, statusText);
        },
        finish: (status: 'completed' | 'interrupted' | 'error', cardText: string) => (
          finalizeStreamFeedback(shellTarget, status, cardText)
        ),
      }
    : undefined;
  const response = await handleShellCommand({
    args,
    binding: commandBinding,
    card: shellCard,
    markdown,
    runner: deps.shellRunner,
  });
  return { response };
}
