export function toUserVisibleBindingError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message) return message;
  }
  return fallback;
}

export function toUserVisibleCommandError(command: string, error: unknown): string {
  if (command === '/history') {
    return '读取历史记录失败，请稍后重试。';
  }
  if (command === '/new') {
    return '新建会话失败。请检查目录是否可写，或改用 /new 绝对路径。';
  }

  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message && /一个会话只能绑定一个聊天|已绑定到/.test(message)) {
      return message;
    }
    if (message && (command === '/provider' || command === '/tmux' || command === '/tmux-key' || command.startsWith('/tmux-') || command.startsWith('/pty-'))) {
      return `${command} 执行失败：${message}`;
    }
  }

  const message = String(error || '').trim();
  return message && (command === '/provider' || command === '/tmux' || command === '/tmux-key' || command.startsWith('/tmux-') || command.startsWith('/pty-'))
    ? `${command} 执行失败：${message}`
    : `${command} 执行失败，请稍后重试。`;
}
