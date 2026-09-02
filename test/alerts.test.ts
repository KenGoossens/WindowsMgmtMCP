import { describe, it, expect } from "vitest";
import { AlertEngine } from "../src/reporting/alerts.js";
import { makeSample } from "../src/reporting/metrics.js";
import type { MetricSample } from "../src/providers/provider.js";

function cpu(value: number, entity = "PC-1"): MetricSample {
  return makeSample({ providerId: "local", substrate: "physical", entity, entityType: "machine", metric: "cpu", value });
}

describe("AlertEngine", () => {
  it("defines and lists rules", () => {
    const engine = new AlertEngine();
    const rule = engine.define({ metric: "cpu", condition: ">", threshold: 90 });
    expect(rule.id).toBeTruthy();
    expect(engine.listRules()).toHaveLength(1);
  });

  it("fires an alert when a threshold is breached", () => {
    const engine = new AlertEngine();
    engine.define({ metric: "cpu", condition: ">", threshold: 90 });
    const fired = engine.evaluate([cpu(95)]);
    expect(fired).toHaveLength(1);
    expect(engine.listActive()).toHaveLength(1);
    expect(engine.listActive()[0].value).toBe(95);
  });

  it("does not double-fire while a breach is sustained", () => {
    const engine = new AlertEngine();
    engine.define({ metric: "cpu", condition: ">", threshold: 90 });
    engine.evaluate([cpu(95)]);
    const secondFired = engine.evaluate([cpu(97)]);
    expect(secondFired).toHaveLength(0);
    expect(engine.listActive()).toHaveLength(1);
    expect(engine.listActive()[0].value).toBe(97);
  });

  it("clears an active alert when the condition recovers", () => {
    const engine = new AlertEngine();
    engine.define({ metric: "cpu", condition: ">", threshold: 90 });
    engine.evaluate([cpu(95)]);
    engine.evaluate([cpu(50)]);
    expect(engine.listActive()).toHaveLength(0);
  });

  it("respects provider/entity scope", () => {
    const engine = new AlertEngine();
    engine.define({ metric: "cpu", condition: ">", threshold: 90, scope: { entity: "PC-2" } });
    engine.evaluate([cpu(99, "PC-1")]);
    expect(engine.listActive()).toHaveLength(0);
    engine.evaluate([cpu(99, "PC-2")]);
    expect(engine.listActive()).toHaveLength(1);
  });

  it("acknowledges an active alert", () => {
    const engine = new AlertEngine();
    engine.define({ metric: "cpu", condition: ">=", threshold: 90 });
    engine.evaluate([cpu(90)]);
    const alert = engine.listActive()[0];
    expect(engine.acknowledge(alert.id)).toBe(true);
    expect(engine.listActive()[0].acknowledged).toBe(true);
  });

  it("removes a rule and its active alerts", () => {
    const engine = new AlertEngine();
    const rule = engine.define({ metric: "cpu", condition: ">", threshold: 1 });
    engine.evaluate([cpu(50)]);
    expect(engine.listActive()).toHaveLength(1);
    expect(engine.removeRule(rule.id)).toBe(true);
    expect(engine.listActive()).toHaveLength(0);
    expect(engine.listRules()).toHaveLength(0);
  });
});
