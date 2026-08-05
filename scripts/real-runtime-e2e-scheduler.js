export async function runRuntimeShardsSerially(shards, runShard) {
  const results = [];
  for (const shard of shards) results.push(await runShard(shard));
  return results;
}
