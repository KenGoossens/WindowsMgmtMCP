import type { MetricKind, MetricSample } from "../providers/provider.js";
import { seriesKey } from "./metrics.js";

export interface QueryFilter {
  providerId?: string;
  entity?: string;
  metric?: MetricKind;
  /** Inclusive lower bound (epoch ms). */
  sinceMs?: number;
  /** Inclusive upper bound (epoch ms). */
  untilMs?: number;
}

/**
 * In-memory rolling time-series store for normalized telemetry.
 *
 * Samples are kept in insertion (chronological) order, capped by both a max
 * sample count (oldest evicted first) and a time-based retention window. This is
 * the pluggable MVP store; an external TSDB can replace it behind the same shape.
 */
export class TelemetryStore {
  private samples: MetricSample[] = [];

  constructor(
    private readonly maxSamples: number,
    private readonly retentionMs: number
  ) {}

  /** Append samples and enforce retention + capacity. */
  append(samples: MetricSample[], now: number = Date.now()): void {
    if (samples.length === 0) return;
    for (const s of samples) this.samples.push(s);
    this.prune(now);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  /** Drop samples older than the retention window. */
  prune(now: number = Date.now()): void {
    const cutoff = now - this.retentionMs;
    let i = 0;
    while (i < this.samples.length && Date.parse(this.samples[i].ts) < cutoff) i++;
    if (i > 0) this.samples.splice(0, i);
  }

  /** Return samples matching the filter, in chronological order. */
  query(filter: QueryFilter = {}): MetricSample[] {
    return this.samples.filter((s) => {
      if (filter.providerId && s.providerId !== filter.providerId) return false;
      if (filter.entity && s.entity !== filter.entity) return false;
      if (filter.metric && s.metric !== filter.metric) return false;
      const t = Date.parse(s.ts);
      if (filter.sinceMs !== undefined && t < filter.sinceMs) return false;
      if (filter.untilMs !== undefined && t > filter.untilMs) return false;
      return true;
    });
  }

  /** The most recent sample per series matching the filter. */
  latest(filter: QueryFilter = {}): MetricSample[] {
    const byKey = new Map<string, MetricSample>();
    for (const s of this.query(filter)) {
      const key = seriesKey(s);
      const cur = byKey.get(key);
      if (!cur || s.ts >= cur.ts) byKey.set(key, s);
    }
    return [...byKey.values()];
  }

  size(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples = [];
  }
}
