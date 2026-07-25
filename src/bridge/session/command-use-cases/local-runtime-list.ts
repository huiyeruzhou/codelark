import type { InboundMessage } from '../../../domain/index.js';
import {
  DEFAULT_LOCAL_SESSION_LIST_LIMIT,
  MAX_LOCAL_SESSION_LIST_LIMIT,
  parseLocalSessionListArgs,
} from '../../command/aliases.js';
import {
  buildLocalRuntimeSessionsCommandResponse,
  buildLocalRuntimeSessionLimitNotice,
} from '../../command/presentation.js';
import type { CommandThreadDisplay } from '../../command/thread-display.js';
import { listCommandLocalRuntimeSessions } from './source.js';
import type { LocalRuntimeFilter } from './source.js';
import type { SessionCommandResult } from './types.js';

const LOCAL_RUNTIME_FALLBACK_ORDER: LocalRuntimeFilter[] = ['codex', 'claude', 'kimi', 'cursor'];

export function handleLocalRuntimeSessionsCommand(options: {
  msg: InboundMessage;
  args: string;
  threadDisplay: CommandThreadDisplay;
  markdown: boolean;
}): SessionCommandResult {
  const listArgs = parseLocalSessionListArgs(options.args);
  if (!listArgs) {
    return { response: `用法：/threads、/threads all、/threads n 100（最多 ${MAX_LOCAL_SESSION_LIST_LIMIT} 条）` };
  }
  const { showAll, limit } = listArgs;
  let runtime = listArgs.runtime || options.threadDisplay.activeRuntimeForChat(options.msg.address.channelType, options.msg.address.chatId);
  let textLocalSessions = listCommandLocalRuntimeSessions(limit, runtime);
  if (!listArgs.runtime && textLocalSessions?.length === 0) {
    for (const fallbackRuntime of LOCAL_RUNTIME_FALLBACK_ORDER) {
      if (fallbackRuntime === runtime) continue;
      const fallbackSessions = listCommandLocalRuntimeSessions(limit, fallbackRuntime);
      if (fallbackSessions && fallbackSessions.length > 0) {
        runtime = fallbackRuntime;
        textLocalSessions = fallbackSessions;
        break;
      }
    }
  }
  if (!textLocalSessions) {
    return { response: '读取本地会话列表失败，请稍后重试。' };
  }
  const isDefaultListRequest = options.args.trim() === '';
  const cardShowAll = isDefaultListRequest || showAll;
  const cardLimit = isDefaultListRequest ? DEFAULT_LOCAL_SESSION_LIST_LIMIT : limit;
  const cardLocalSessions = cardLimit === limit
    ? textLocalSessions
    : listCommandLocalRuntimeSessions(cardLimit, runtime);
  const bindingStates = options.threadDisplay.threadBindingStates(options.msg.address.channelType, options.msg.address.chatId);
  const decoratedTextSessions = options.threadDisplay.decorateLocalRuntimeSessions(textLocalSessions, options.msg.address.channelType, options.msg.address.chatId);
  const decoratedCardSessions = cardLocalSessions
    ? options.threadDisplay.decorateLocalRuntimeSessions(cardLocalSessions, options.msg.address.channelType, options.msg.address.chatId)
    : null;
  const cardLimitNotice = decoratedCardSessions && cardLimit !== limit
    ? buildLocalRuntimeSessionLimitNotice(decoratedCardSessions.length, cardLimit)
    : null;
  const richCard = options.threadDisplay.refreshedLocalRuntimeSessionsCard(
    decoratedCardSessions || [],
    cardShowAll,
    cardLimit,
    options.msg.address.channelType,
    options.msg.address.chatId,
    undefined,
    [],
    runtime,
  );
  return {
    response: buildLocalRuntimeSessionsCommandResponse(
      decoratedTextSessions,
      options.markdown,
      showAll,
      limit,
      bindingStates,
      [],
      cardLimitNotice ? [cardLimitNotice] : [],
    ),
    richCard,
    threadTableCardScope: richCard ? 'global' : undefined,
  };
}
