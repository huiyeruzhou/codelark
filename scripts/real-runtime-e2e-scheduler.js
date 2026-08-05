export async function runRuntimeE2eShards(shards, runShard, platform = process.platform) {
  if (platform !== 'darwin') return Promise.all(shards.map(runShard));

  const results = [];
  for (const shard of shards) {
    results.push(await runShard(shard));
  }
  return results;
}
