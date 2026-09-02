import { describe, it, expect, vi } from "vitest";
import { ReportingService, type MetricSource } from "../src/reporting/collector.js";
import { makeSample } from "../src/reporting/metrics.js";
import type { MetricSample } from "../src/providers/provider.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
} as unknown as Parameters<typeof ReportingService.prototype.constructor>[1];

function source(id: string, samples: MetricSample[] | (() => Promise<MetricSample[]>)): MetricSource {
  return {
    id,
    displayName: id,
    getMetrics: typeof samples === "function" ? samples : async () => samples
  };
}

function cpu(providerId: string, value: number): MetricSample {
  return makeSample({ providerId, substrate: "physical", entity: providerId, entityType: "machine", metric: "cpu", value });
}

function service(): ReportingService {
  return new ReportingService(
    { pollIntervalMs: 60_000, retentionMinutes: 60, maxSamples: 1000 },
    silentLogger
  );
}

describe("ReportingService", () => {
  it("collects from all sources into the store", async () => {
    const svc = service();
    svc.setSources([source("a", [cpu("a", 10)]), source("b", [cpu("b", 20)])]);
    const result = await svc.collectOnce();
    expect(result.samples).toHaveLength(2);
    expect(svc.store.size()).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("isolates a failing source via allSettled", async () => {
    const svc = service();
    svc.setSources([
      source("ok", [cpu("ok", 5)]),
      source("bad", async () => {
        throw new Error("graph down");
      })
    ]);
    const result = await svc.collectOnce();
    expect(result.samples).toHaveLength(1);
    expect(result.errors).toEqual([{ providerId: "bad", error: "graph down" }]);
  });

  it("evaluates alerts and emits an update event", async () => {
    const svc = service();
    svc.setSources([source("a", [cpu("a", 95)])]);
    svc.alerts.define({ metric: "cpu", condition: ">", threshold: 90 });
    const onUpdate = vi.fn();
    svc.onUpdate(onUpdate);
    const result = await svc.collectOnce();
    expect(result.firedAlerts).toHaveLength(1);
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(svc.alerts.listActive()).toHaveLength(1);
  });

  it("dispatches newly-fired alerts to registered sinks", async () => {
    const svc = service();
    svc.setSources([source("a", [cpu("a", 95)])]);
    svc.alerts.define({ metric: "cpu", condition: ">", threshold: 90 });
    const received: number[] = [];
    svc.addAlertSink({ id: "test-sink", onAlerts: async (alerts) => received.push(alerts.length) });
    await svc.collectOnce();
    // Sink delivery is fire-and-forget; allow the microtask queue to drain.
    await new Promise((r) => setImmediate(r));
    expect(received).toEqual([1]);
    // A second tick sustains (does not re-fire) the alert, so the sink is not called again.
    await svc.collectOnce();
    await new Promise((r) => setImmediate(r));
    expect(received).toEqual([1]);
  });

  it("produces a snapshot with provider availability", async () => {
    const svc = service();
    svc.setSources([
      source("a", [cpu("a", 1)]),
      source("bad", async () => {
        throw new Error("nope");
      })
    ]);
    const snap = await svc.snapshot();
    expect(snap.providers).toHaveLength(2);
    expect(snap.providers.find((p) => p.providerId === "a")?.available).toBe(true);
    expect(snap.providers.find((p) => p.providerId === "bad")?.available).toBe(false);
  });
});
