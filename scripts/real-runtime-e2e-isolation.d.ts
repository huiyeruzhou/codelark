export interface RuntimeShardIsolation {
  env: NodeJS.ProcessEnv;
  tmuxTmpDir: string | undefined;
  cleanup(): void;
}

export function createRuntimeShardIsolation(
  shardName: string,
  shardEnv: NodeJS.ProcessEnv,
  baseEnv?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): RuntimeShardIsolation;
