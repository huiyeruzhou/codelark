import {
  handleClearSessionCommand,
} from '../session/command-use-cases/clear-session.js';
import {
  handleNewSessionCommand,
} from '../session/command-use-cases/new-session.js';
import {
  handleLocalRuntimeSessionsCommand,
} from '../session/command-use-cases/local-runtime-list.js';
import {
  handleThreadSwitchCommand,
} from '../session/command-use-cases/thread-switch.js';
import {
  type SessionCommandDeps,
  type SessionCommandResult,
} from '../session/command-use-cases/types.js';
import {
  handleThreadBindingCommand,
} from '../session/command-use-cases/thread-binding.js';

export {
  handleClearSessionCommand,
  handleLocalRuntimeSessionsCommand,
  handleNewSessionCommand,
  handleThreadBindingCommand,
  handleThreadSwitchCommand,
};
export type SessionThreadCommandDeps = SessionCommandDeps;
export type SessionThreadCommandResult = SessionCommandResult;
export type { SessionCommandBackgroundEffect } from '../session/command-use-cases/types.js';

export function buildStartCommandResponse(): string {
  return [
    'CodeLark',
    '',
    '直接发送文本，就会继续当前聊天绑定的会话。',
    '',
    '常用流程',
    '1. /t 查看本地 Codex / Claude Code / Kimi Code / Cursor Agent 会话',
    '2. /t 1 接管第 1 条本地会话并设为当前线程',
    '3. /new name 创建一个新的 IM 群聊会话',
    '4. /t 全局表中绿色是当前聊天绑定，灰色是其他聊天已绑定',
    '',
    '发送 /h 查看完整说明。',
  ].join('\n');
}
