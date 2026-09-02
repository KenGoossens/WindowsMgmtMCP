import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderRegistry } from "../src/providers/provider.js";
import { StateStore } from "../src/state/store.js";
import { StatePortabilityService } from "../src/state/statePortability.js";
import { JobManager } from "../src/orchestration/jobs.js";
import { ContinuityController, FailoverError } from "../src/orchestration/continuityController.js";
import { ReportingService } from "../src/reporting/collector.js";
import { makeSample } from "../src/reporting/metrics.js";
import type { RawCapture } from "../src/state/capture.js";
import type { StateScope } from "../src/state/bundle.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

const RAW: RawCapture = {
  os: { timeZoneId: "UTC", culture: "en-US", powerPlan: "Balanced", wifiProfiles: [] },
  apps: { mappedDrives: [], printers: [], defaultPrinter: "" },
  user: { oneDriveConfigured: false, knownFolders: [], envVars: {} }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeProvider(id: string, opts: { failoverTarget?: boolean; capable?: boolean; available?: boolean; health?: boolean } = {}): any {
  const base = {
    id,
    displayName: id,
    isAvailable: async () => opts.available ?? true,
    registerTools: () => {},
    capabilities: () => ({
      substrate: "cloud",
      operations: [],
      canBeMigrationSource: false,
      canBeMigrationTarget: true,
      canBeFailoverTarget: opts.failoverTarget ?? true
    })
  };
  const withCapture =
    opts.capable === false
      ? base
      : {
          ...base,
          captureSettings: async (_s: StateScope, entity?: string) => ({ entity: entity ?? "HOST", raw: RAW }),
          restoreSettings: async (data: Record<string, unknown>) => ({ applied: true, keys: Object.keys(data).length })
        };
  return opts.health ? { ...withCapture, health: async () => ({ healthy: true }) } : withCapture;
}

async function settle(ctrl: ContinuityController, jobId: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = ctrl.status(jobId);
    if (job && job.status !== "running" && job.status !== "pending") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("failover did not settle");
}

let dir: string;
function build(opts: { reporting?: ReportingService; register?: (r: ProviderRegistry) => void } = {}) {
  const registry = new ProviderRegistry(silentLogger);
  if (opts.register) opts.register(registry);
  else {
    registry.register(makeProvider("windows365"));
    registry.register(makeProvider("awsworkspaces", { health: true }));
  }
  const store = new StateStore(dir, "secret", 30);
  const state = new StatePortabilityService(store, registry, silentLogger);
  const jobs = new JobManager(silentLogger);
  const ctrl = new ContinuityController(
    registry,
    state,
    jobs,
    silentLogger,
    { primary: "windows365", secondary: "awsworkspaces", mode: "manual" },
    opts.reporting
  );
  return { ctrl, state, registry };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wmcp-fo-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ContinuityController.healthcheck", () => {
  it("reports unhealthy when the provider is unavailable", async () => {
    const { ctrl } = build({
      register: (r) => {
        r.register(makeProvider("windows365", { available: false }));
        r.register(makeProvider("awsworkspaces"));
      }
    });
    const h = await ctrl.healthcheck();
    expect(h.healthy).toBe(false);
    expect(h.score).toBe(0);
    expect(h.source).toBe("availability");
  });

  it("is telemetry-informed: degrades on loadIndex and active alerts", async () => {
    const reporting = new ReportingService({ pollIntervalMs: 60_000, retentionMinutes: 60, maxSamples: 1000 }, silentLogger);
    reporting.store.append([
      makeSample({ providerId: "windows365", substrate: "cloud", entity: "windows365", metric: "loadIndex", value: 3, unit: "count" })
    ]);
    reporting.alerts.define({ metric: "loadIndex", condition: ">", threshold: 0, scope: { providerId: "windows365" } });
    reporting.alerts.evaluate(reporting.store.latest());
    const { ctrl } = build({ reporting });
    const h = await ctrl.healthcheck("windows365");
    expect(h.source).toBe("telemetry");
    expect(h.score).toBeLessThan(100);
    expect(h.activeAlerts).toBeGreaterThan(0);
  });

  it("throws when no primary is configured or passed", async () => {
    const registry = new ProviderRegistry(silentLogger);
    const store = new StateStore(dir, "s", 30);
    const ctrl = new ContinuityController(
      registry,
      new StatePortabilityService(store, registry, silentLogger),
      new JobManager(silentLogger),
      silentLogger,
      { mode: "manual" }
    );
    await expect(ctrl.healthcheck()).rejects.toBeInstanceOf(FailoverError);
  });
});

describe("ContinuityController.initiate", () => {
  it("fails a user over, rehydrating the latest StateBundle", async () => {
    const { ctrl, state } = build();
    // Pre-capture a bundle for the user so there is state to rehydrate.
    await state.capture({ providerId: "windows365", entity: "cpc-1" }, {}, "alice");

    const job = ctrl.initiate({ user: "alice", targetEntity: "ws-1" });
    await settle(ctrl, job.id);
    const final = ctrl.status(job.id)!;
    expect(final.status).toBe("succeeded");
    expect(final.steps.map((s) => s.name)).toEqual(["activate-target", "rehydrate-state", "verify-target", "redirect-user"]);
    const result = final.result as { from: string; to: string; stateRehydrated: boolean };
    expect(result.from).toBe("windows365");
    expect(result.to).toBe("awsworkspaces");
    expect(result.stateRehydrated).toBe(true);
  });

  it("proceeds but notes data-loss risk when no StateBundle exists", async () => {
    const { ctrl } = build();
    const job = ctrl.initiate({ user: "nobody", targetEntity: "ws-9" });
    await settle(ctrl, job.id);
    const final = ctrl.status(job.id)!;
    expect(final.status).toBe("succeeded");
    const result = final.result as { stateRehydrated: boolean; notes: string[] };
    expect(result.stateRehydrated).toBe(false);
    expect(result.notes.join(" ")).toMatch(/data loss risk/i);
  });

  it("rejects a target that does not advertise canBeFailoverTarget", async () => {
    const { ctrl } = build({
      register: (r) => {
        r.register(makeProvider("windows365"));
        r.register(makeProvider("awsworkspaces", { failoverTarget: false }));
      }
    });
    const job = ctrl.initiate({ user: "alice", targetEntity: "ws-1" });
    await settle(ctrl, job.id);
    expect(ctrl.status(job.id)!.status).toBe("failed");
  });
});

describe("ContinuityController.failback", () => {
  it("reverses direction (secondary → primary)", async () => {
    const { ctrl, state } = build();
    await state.capture({ providerId: "windows365", entity: "cpc-1" }, {}, "bob");
    const job = ctrl.failback({ user: "bob", targetEntity: "cpc-2" });
    await settle(ctrl, job.id);
    const final = ctrl.status(job.id)!;
    expect(final.status).toBe("succeeded");
    const result = final.result as { from: string; to: string };
    expect(result.from).toBe("awsworkspaces");
    expect(result.to).toBe("windows365");
  });
});
