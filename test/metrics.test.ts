import { describe, it, expect } from "vitest";
import { makeSample, aggregate, seriesKey, METRIC_UNITS } from "../src/reporting/metrics.js";

describe("makeSample", () => {
  it("fills the canonical unit and a timestamp", () => {
    const s = makeSample({ providerId: "local", substrate: "physical", entity: "PC-1", metric: "cpu", value: 42 });
    expect(s.unit).toBe(METRIC_UNITS.cpu);
    expect(s.entityType).toBe("substrate");
    expect(Date.parse(s.ts)).not.toBeNaN();
  });

  it("honours an explicit unit and entityType", () => {
    const s = makeSample({
      providerId: "windows365",
      substrate: "cloud",
      entity: "windows365",
      entityType: "machine",
      metric: "sessionCount",
      value: 5,
      unit: "count"
    });
    expect(s.unit).toBe("count");
    expect(s.entityType).toBe("machine");
  });
});

describe("seriesKey", () => {
  it("is stable across providerId + entity + metric", () => {
    const key = seriesKey({ providerId: "local", entity: "PC-1", metric: "cpu" });
    expect(key).toBe("local::PC-1::cpu");
  });
});

describe("aggregate", () => {
  it("computes count/min/max/avg/last per series", () => {
    const base = { providerId: "local", substrate: "physical" as const, entity: "PC-1", metric: "cpu" as const };
    const samples = [
      makeSample({ ...base, value: 10, ts: "2026-06-11T10:00:00.000Z" }),
      makeSample({ ...base, value: 30, ts: "2026-06-11T10:00:15.000Z" }),
      makeSample({ ...base, value: 20, ts: "2026-06-11T10:00:30.000Z" })
    ];
    const [agg] = aggregate(samples);
    expect(agg.count).toBe(3);
    expect(agg.min).toBe(10);
    expect(agg.max).toBe(30);
    expect(agg.avg).toBe(20);
    expect(agg.last).toBe(20);
    expect(agg.lastTs).toBe("2026-06-11T10:00:30.000Z");
  });

  it("separates distinct series", () => {
    const aggs = aggregate([
      makeSample({ providerId: "local", substrate: "physical", entity: "PC-1", metric: "cpu", value: 1 }),
      makeSample({ providerId: "local", substrate: "physical", entity: "PC-1", metric: "memory", value: 2 })
    ]);
    expect(aggs).toHaveLength(2);
  });
});
