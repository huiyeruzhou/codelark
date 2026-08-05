export function runRuntimeE2eShards<TShard, TResult>(
  shards: readonly TShard[],
  runShard: (shard: TShard) => Promise<TResult>,
  platform?: NodeJS.Platform,
): Promise<TResult[]>;
