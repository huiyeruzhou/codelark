export function readPathEnv(
  env: NodeJS.ProcessEnv | Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.PATH !== undefined) return env.PATH;
  if (platform !== 'win32') return '';
  return Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
}

export function writeCanonicalPathEnv(
  env: Record<string, string>,
  value: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key !== 'PATH' && key.toLowerCase() === 'path') delete env[key];
    }
  }
  env.PATH = value;
}
