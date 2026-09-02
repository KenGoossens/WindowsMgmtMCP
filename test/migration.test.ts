import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderRegistry } from "../src/providers/provider.js";
import { StateStore } from "../src/state/store.js";
import { StatePortabilityService } from "../src/state/statePortability.js";
import { JobManager } from "../src/orchestration/jobs.js";
import { MigrationOrchestrator } from "../src/orchestration/migrationOrchestrator.js";
import type { RawCapture } from "../src/state/capture.js";
import type { StateScope } from "../src/state/bundle.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

const RAW: RawCapture = {
  os: { timeZoneId: "UTC", culture: "en-US", powerPlan: "Balanced", wifiProfiles: [] },
  apps: { mappedDrives: [{ localPath: "Z:", remotePath: "\\\\s\\h" }], printers: [], defaultPrinter: "" },
  user: { oneDriveConfigured: false, knownFolders: [], envVars: {} }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeProvider(id: string, opts: { source?: boolean; target?: boolean; capable?: boolean; health?: boolean }): any {
  const base = {
    id,
    displayName: id,
    isAvailable: async () => true,
    registerTools: () => {},
    capabilities: () => ({
      substrate: "physical",
      operations: [],
      canBeMigrationSource: opts.source ?? false,
      canBeMigrationTarget: opts.target ?? false,
      canBeFailoverTarget: false
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
  if (opts.health) {
    return { ...withCapture, health: async () => ({ healthy: true, details: "ok" }) };
  }
  return withCapture;
}

async function settle(orch: MigrationOrchestrator, jobId: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = orch.status(jobId);
    if (job && job.status !== "running" && job.status !== "pending") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("migration did not settle");
}

let dir: string;
function buildOrchestrator(register: (r: ProviderRegistry) => void) {
  const registry = new ProviderRegistry(silentLogger);
  register(registry);
  const store = new StateStore(dir, "secret", 30);
  const state = new StatePortabilityService(store, registry, silentLogger);
  const jobs = new JobManager(silentLogger);
  return new MigrationOrchestrator(registry, state, jobs, silentLogger, true);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wmcp-mig-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MigrationOrchestrator.plan", () => {
  it("produces an executable plan with a fidelity preview for capable source+target", async () => {
    const orch = buildOrchestrator((r) => {
      r.register(makeProvider("local", { source: true, capable: true }));
      r.register(makeProvider("windows365", { target: true, capable: true }));
    });
    const plan = await orch.plan({
      source: { providerId: "local", entity: "PC-1" },
      target: { providerId: "windows365", entity: "cpc-1" },
      user: "alice"
    });
    expect(plan.executable).toBe(true);
    expect(plan.stateItems.length).toBeGreaterThan(0);
    expect(plan.provisioningRequired).toBe(false);
    expect(plan.warnings).toHaveLength(0);
  });

  it("warns and is not executable when the target cannot apply settings", async () => {
    const orch = buildOrchestrator((r) => {
      r.register(makeProvider("local", { source: true, capable: true }));
      r.register(makeProvider("citrix", { target: true, capable: false }));
    });
    const plan = await orch.plan({
      source: { providerId: "local", entity: "PC-1" },
      target: { providerId: "citrix", entity: "vda-1" }
    });
    expect(plan.executable).toBe(false);
    expect(plan.warnings.join(" ")).toMatch(/cannot apply settings/);
  });

  it("flags provisioning required when the target has no entity or provision()", async () => {
    const orch = buildOrchestrator((r) => {
      r.register(makeProvider("local", { source: true, capable: true }));
      r.register(makeProvider("windows365", { target: true, capable: true }));
    });
    const plan = await orch.plan({
      source: { providerId: "local", entity: "PC-1" },
      target: { providerId: "windows365" }
    });
    expect(plan.provisioningRequired).toBe(true);
    expect(plan.executable).toBe(false);
    expect(plan.warnings.join(" ")).toMatch(/no provision\(\) primitive/);
  });
});

describe("MigrationOrchestrator.execute", () => {
  it("runs the full spine onto an existing target and verifies via health()", async () => {
    const orch = buildOrchestrator((r) => {
      r.register(makeProvider("local", { source: true, capable: true }));
      r.register(makeProvider("windows365", { target: true, capable: true, health: true }));
    });
    const job = orch.execute({
      source: { providerId: "local", entity: "PC-1" },
      target: { providerId: "windows365", entity: "cpc-1" },
      user: "bob"
    });
    await settle(orch, job.id);
    const final = orch.status(job.id)!;
    expect(final.status).toBe("succeeded");
    const stepNames = final.steps.map((s) => s.name);
    expect(stepNames).toEqual(["provision-target", "capture-source", "restore-target", "verify", "retain-source"]);
    expect(final.steps[0].status).toBe("skipped"); // existing target → provisioning skipped
    const result = final.result as { sourceRetained: boolean; verified: boolean; bundleId: string };
    expect(result.sourceRetained).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.bundleId).toBeTruthy();
  });

  it("fails the job when the source cannot capture state", async () => {
    const orch = buildOrchestrator((r) => {
      r.register(makeProvider("local", { source: true, capable: false }));
      r.register(makeProvider("windows365", { target: true, capable: true }));
    });
    const job = orch.execute({
      source: { providerId: "local", entity: "PC-1" },
      target: { providerId: "windows365", entity: "cpc-1" }
    });
    await settle(orch, job.id);
    expect(orch.status(job.id)!.status).toBe("failed");
  });
});
