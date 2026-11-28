import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export interface EventLoopStall {
  event: 'perf.event_loop.stall';
  max_delay_ms: number;
  p99_delay_ms: number;
  utilization: number;
}

/** Report blocked event-loop time separately from RPC/network failures. */
export function startEventLoopMonitor(options: {
  onStall(report: EventLoopStall): void;
  intervalMs?: number;
  thresholdMs?: number;
}): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let utilization = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const current = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(current, utilization);
    utilization = current;
    const maxMs = histogram.max / 1e6;
    if (maxMs >= (options.thresholdMs ?? 500)) {
      options.onStall({
        event: 'perf.event_loop.stall',
        max_delay_ms: Math.round(maxMs),
        p99_delay_ms: Math.round(histogram.percentile(99) / 1e6),
        utilization: delta.utilization,
      });
    }
    histogram.reset();
  }, options.intervalMs ?? 5_000);
  timer.unref();
  return () => { clearInterval(timer); histogram.disable(); };
}
