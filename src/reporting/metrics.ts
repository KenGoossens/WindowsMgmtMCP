import type { MetricKind, MetricSample, Substrate } from "../providers/provider.js";

/** Default unit for each normalized metric kind. */
export const METRIC_UNITS: Record<MetricKind, string> = {
  cpu: "%",
  memory: "%",
  disk: "%",
  gpu: "%",
  logonDuration: "s",
  protocolLatency: "ms",
  sessionCount: "count",
  loadIndex: "index"
};

/** Human-friendly labels for metric kinds (used in summaries). */
export const METRIC_LABELS: Record<MetricKind, string> = {
  cpu: "CPU utilisation",
  memory: "Memory utilisation",
  disk: "Disk utilisation",
  gpu: "GPU utilisation",
  logonDuration: "Logon duration",
  protocolLatency: "Protocol latency",
  sessionCount: "Session count",
  loadIndex: "Load index"
};

export interface SampleInput {
  providerId: string;
  substrate: Substrate;
  entity: string;
  entityType?: MetricSample["entityType"];
  metric: MetricKind;
  value: number;
  unit?: string;
  ts?: string;
}

/**
 * Build a normalized {@link MetricSample}, filling in the canonical unit and a
 * timestamp when omitted. Providers use this so every reading shares one shape.
 */
export function makeSample(input: SampleInput): MetricSample {
  return {
    providerId: input.providerId,
    substrate: input.substrate,
    entityType: input.entityType ?? "substrate",
    entity: input.entity,
    metric: input.metric,
    value: input.value,
    unit: input.unit ?? METRIC_UNITS[input.metric],
    ts: input.ts ?? new Date().toISOString()
  };
}

/** Stable key identifying a unique metric series (provider + entity + metric). */
export function seriesKey(s: Pick<MetricSample, "providerId" | "entity" | "metric">): string {
  return `${s.providerId}::${s.entity}::${s.metric}`;
}

export interface SeriesAggregate {
  providerId: string;
  entity: string;
  metric: MetricKind;
  unit?: string;
  count: number;
  last: number;
  min: number;
  max: number;
  avg: number;
  lastTs: string;
}

/** Aggregate a flat list of samples into per-series statistics. */
export function aggregate(samples: MetricSample[]): SeriesAggregate[] {
  const groups = new Map<string, MetricSample[]>();
  for (const s of samples) {
    const key = seriesKey(s);
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }

  const out: SeriesAggregate[] = [];
  for (const arr of groups.values()) {
    const sorted = [...arr].sort((a, b) => a.ts.localeCompare(b.ts));
    const values = sorted.map((s) => s.value);
    const sum = values.reduce((acc, v) => acc + v, 0);
    const head = sorted[sorted.length - 1];
    out.push({
      providerId: head.providerId,
      entity: head.entity,
      metric: head.metric,
      unit: head.unit,
      count: sorted.length,
      last: head.value,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: Math.round((sum / values.length) * 100) / 100,
      lastTs: head.ts
    });
  }
  return out;
}
