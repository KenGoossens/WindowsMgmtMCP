import { describe, it, expect } from "vitest";
import { TelemetryStore } from "../src/reporting/store.js";
import { makeSample } from "../src/reporting/metrics.js";
import type { MetricSample } from "../src/providers/provider.js";

function sample(over: Partial<MetricSample> & { value: number; ts: string }): MetricSample {
  return makeSample({
    providerId: over.providerId ?? "local",
    substrate: over.substrate ?? "physical",
    entity: over.entity ?? "PC-1",
    entityType: over.entityType ?? "machine",
    metric: over.metric ?? "cpu",
    value: over.value,
    ts: over.ts
  });
}

describe("TelemetryStore", () => {
  it("stores and queries samples by metric/provider/entity", () => {
    const store = new TelemetryStore(1000, 60_000);
    const now = Date.now();
    store.append(
      [
        sample({ value: 10, ts: new Date(now).toISOString() }),
        sample({ value: 20, metric: "memory", ts: new Date(now).toISOString() })
      ],
      now
    );
    expect(store.size()).toBe(2);
    expect(store.query({ metric: "cpu" })).toHaveLength(1);
    expect(store.query({ metric: "memory" })).toHaveLength(1);
    expect(store.query({ entity: "PC-1" })).toHaveLength(2);
  });

  it("prunes samples older than the retention window", () => {
    const store = new TelemetryStore(1000, 60_000);
    const now = Date.now();
    store.append([sample({ value: 1, ts: new Date(now - 120_000).toISOString() })], now - 120_000);
    store.append([sample({ value: 2, ts: new Date(now).toISOString() })], now);
    expect(store.size()).toBe(1);
    expect(store.query()[0].value).toBe(2);
  });

  it("evicts oldest samples beyond the capacity cap", () => {
    const store = new TelemetryStore(3, 600_000);
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      store.append([sample({ value: i, ts: new Date(now + i).toISOString() })], now + i);
    }
    expect(store.size()).toBe(3);
    expect(store.query().map((s) => s.value)).toEqual([2, 3, 4]);
  });

  it("returns the latest sample per series", () => {
    const store = new TelemetryStore(1000, 600_000);
    const now = Date.now();
    store.append([sample({ value: 10, ts: new Date(now).toISOString() })], now);
    store.append([sample({ value: 30, ts: new Date(now + 1000).toISOString() })], now + 1000);
    const latest = store.latest({ metric: "cpu" });
    expect(latest).toHaveLength(1);
    expect(latest[0].value).toBe(30);
  });
});
