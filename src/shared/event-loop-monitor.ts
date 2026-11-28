import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export interface EventLoopStall {
  event: 'perf.event_loop.stall';
  max_delay_ms: number;
  p99_delay_ms: number;
  timer_delay_ms: number;
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
  const intervalMs = options.intervalMs ?? 5_000;
  let sampledAt = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const timerDelayMs = Math.max(0, now - sampledAt - intervalMs);
    sampledAt = now;
    const current = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(current, utilization);
    utilization = current;
    // Timer and native histogram callbacks can become runnable together after
    // a stall. Preserve timer lateness even if reset runs before the native
    // histogram has recorded that delayed sample (notably on macOS).
    const maxMs = Math.max(histogram.max / 1e6, timerDelayMs);
    if (maxMs >= (options.thresholdMs ?? 500)) {
      options.onStall({
        event: 'perf.event_loop.stall',
        max_delay_ms: Math.round(maxMs),
        p99_delay_ms: Math.round(histogram.percentile(99) / 1e6),
        timer_delay_ms: Math.round(timerDelayMs),
        utilization: delta.utilization,
      });
    }
    histogram.reset();
  }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); histogram.disable(); };
}
