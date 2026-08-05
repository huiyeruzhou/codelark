export function runRuntimeShardsSerially<TShard, TResult>(
  shards: readonly TShard[],
  runShard: (shard: TShard) => Promise<TResult>,
): Promise<TResult[]>;
