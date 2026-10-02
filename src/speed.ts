// How v1 and v2 timings of the same benchmark search are compared and worded.

import type { Benchmark, Timing } from './api';

// Cribl's stock default Datasets. The API's own "internal" flag only covers cribl_logs and cribl_metrics.
const STOCK_DATASET_IDS = new Set(['default_logs', 'default_metrics', 'default_spans', 'default_events']);

/** Whether a Dataset is one of Cribl's own rather than the customer's. `nonInternalIds` comes from the Lake API. */
export function isSystemDataset(id: string, nonInternalIds: Set<string> | null): boolean {
  return STOCK_DATASET_IDS.has(id) || (nonInternalIds != null && !nonInternalIds.has(id));
}

const seconds = (t: Timing) => `${(t.ms / 1000).toFixed(1)} s`;

/** Fraction of v1's run time saved on v2 (0.3 = 30% faster, negative = slower). `null` until both are measured. */
export function speedUp(b: Benchmark | undefined): number | null {
  if (!b?.v1 || !b.v2 || b.v1.ms <= 0) return null;
  // With no events to count, both timings are only start-up cost and say nothing about search speed.
  if (!b.v1.events || !b.v2.events) return null;
  return (b.v1.ms - b.v2.ms) / b.v1.ms;
}

/** Median of a list of numbers: the middle value, or the mean of the two middle values. `null` when empty. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function describeSpeed(b: Benchmark | undefined): string {
  if (!b?.v1 && !b?.v2) return '--';
  if (b.v1 && b.v2) {
    if (speedUp(b) == null) return 'No events in 24 hr to compare';
    const gain = speedUp(b) ?? 0;
    const pct = Math.abs(Math.round(gain * 100));
    return `${seconds(b.v1)} → ${seconds(b.v2)} (${pct === 0 ? 'no change' : `${pct}% ${gain > 0 ? 'faster' : 'slower'}`})`;
  }
  return b.v1 ? `${seconds(b.v1)} on v1` : `${seconds(b.v2!)} on v2 (no v1 baseline)`;
}

export function describeTiming(t: Timing): string {
  return `${seconds(t)} over ${t.events.toLocaleString()} events, measured ${new Date(t.at).toLocaleString()}`;
}
