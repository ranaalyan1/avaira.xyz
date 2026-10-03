/**
 * Latency telemetry.
 *
 * The claim "Monad's 800ms finality makes a pre-execution gate possible" is worth
 * nothing without the measured number next to it. Every `run()` reports its timings
 * here, and the dashboard/README read them back from the metrics API.
 *
 * Reporting is best-effort and never blocks the agent: a dead metrics endpoint must not
 * be able to stop a gated action.
 */
import type { GateTimings } from "./types.js";

export interface RunMetric {
  agentId: string;
  intentHash: string;
  allowed: boolean;
  reason: number;
  score: number;
  timings: GateTimings;
  auditEntries?: number;
  error?: string;
}

export class MetricsReporter {
  constructor(
    private readonly baseUrl: string,
    private readonly chainId: number,
  ) {}

  /** Fire-and-forget: failures are swallowed by design. */
  async record(metric: RunMetric): Promise<void> {
    const payload = {
      ...metric,
      chainId: this.chainId,
      recordedAt: new Date().toISOString(),
      source: "sdk-typescript",
    };
    try {
      await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // never fail a run because telemetry could not be delivered
    }
  }
}

/** Percentile helper used by the benchmark and the dashboard. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function stats(values: number[]): { mean: number; p50: number; p95: number; p99: number; max: number } {
  const mean = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  return { mean, p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), max: Math.max(0, ...values) };
}
