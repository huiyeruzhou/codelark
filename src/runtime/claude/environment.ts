// CodeLark starts independent, persistent Claude sessions, even when its own
// launcher was a Claude child. These flags belong to the parent session only.
export const CLAUDE_PARENT_SESSION_ENV = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION'] as const;

export function clearClaudeParentSessionEnv<T extends NodeJS.ProcessEnv>(env: T): T {
  for (const key of CLAUDE_PARENT_SESSION_ENV) delete env[key];
  return env;
}
