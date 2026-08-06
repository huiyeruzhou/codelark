export function parseNodeTestSummary(text) {
  const summary = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = text.match(new RegExp(`^ℹ ${key} (\\d+)$`, 'mu'));
    summary[key] = match ? Number(match[1]) : 0;
  }
  const duration = text.match(/^ℹ duration_ms ([\d.]+)$/mu);
  summary.durationMs = duration ? Number(duration[1]) : 0;
  return summary;
}

export function runtimeShardFailureReason(result) {
  if (result.timedOut) return `timeout after ${result.timeoutMs}ms`;
  if (result.error) return result.error.message || String(result.error);
  if (result.signal) return `exit=${result.code} signal=${result.signal}`;
  if (result.code !== 0) return `exit=${result.code} signal=none`;
  if (result.summary.tests === 0) return 'tests=0';
  if (result.summary.skipped > 0) return `skipped=${result.summary.skipped}`;
  if (result.summary.fail > 0) return `fail=${result.summary.fail}`;
  if (result.summary.pass !== result.summary.tests) {
    return `pass=${result.summary.pass} tests=${result.summary.tests}`;
  }
  return null;
}

export async function runRuntimeShardsSerially(shards, runShard) {
  const results = [];
  for (const shard of shards) results.push(await runShard(shard));
  return results;
}
