export interface NodeTestSummary {
  tests: number;
  suites: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
  durationMs: number;
}

export function parseNodeTestSummary(text: string): NodeTestSummary;

export function runtimeShardFailureReason(result: {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutMs?: number;
  error?: Error;
  summary: NodeTestSummary;
}): string | null;

export function runRuntimeShardsSerially<TShard, TResult>(
  shards: readonly TShard[],
  runShard: (shard: TShard) => Promise<TResult>,
): Promise<TResult[]>;
