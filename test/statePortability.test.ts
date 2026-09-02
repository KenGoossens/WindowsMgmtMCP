import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../src/state/store.js";
import { StatePortabilityService, StateError } from "../src/state/statePortability.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import type { RawCapture } from "../src/state/capture.js";
import type { StateScope } from "../src/state/bundle.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

const SAMPLE_RAW: RawCapture = {
  os: { timeZoneId: "UTC", culture: "en-US", powerPlan: "Balanced", wifiProfiles: ["Net"] },
  apps: { mappedDrives: [{ localPath: "Z:", remotePath: "\\\\s\\h" }], printers: [], defaultPrinter: "" },
  user: { oneDriveConfigured: true, knownFolders: [], envVars: {} }
};

/** A fake settings-capable provider — no real PowerShell. */
function fakeProvider(id: string, opts: { capable?: boolean } = {}) {
  const base = {
    id,
    displayName: id,
    isAvailable: async () => true,
    registerTools: () => {},
    capabilities: () => ({
      substrate: "physical" as const,
      operations: [],
      canBeMigrationSource: true,
      canBeMigrationTarget: false,
      canBeFailoverTarget: false
    })
  };
  if (opts.capable === false) return base;
  return {
    ...base,
    lastRestore: undefined as Record<string, unknown> | undefined,
    captureSettings: async (_scope: StateScope, entity?: string) => ({ entity: entity ?? "HOST", raw: SAMPLE_RAW }),
    restoreSettings: async (data: Record<string, unknown>) => ({ applied: true, keys: Object.keys(data).length })
  };
}

function service(dir: string) {
  const registry = new ProviderRegistry(silentLogger);
  const capable = fakeProvider("local");
  const incapable = fakeProvider("windows365", { capable: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry.register(capable as any).register(incapable as any);
  const store = new StateStore(dir, "secret", 30);
  return { svc: new StatePortabilityService(store, registry, silentLogger), store };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wmcp-svc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("StatePortabilityService", () => {
  it("captures, persists, and lists a bundle with a fidelity manifest", async () => {
    const { svc } = service(dir);
    const manifest = await svc.capture({ providerId: "local" }, {}, "alice");
    expect(manifest.subject).toBe("alice");
    expect(manifest.items.length).toBeGreaterThan(0);
    expect(["full", "partial", "referenced"]).toContain(manifest.fidelity.overall);

    const list = await svc.list("alice");
    expect(list.map((m) => m.id)).toContain(manifest.id);
  });

  it("exports inline without persisting", async () => {
    const { svc, store } = service(dir);
    const bundle = await svc.exportSettings({ providerId: "local" }, { osSettings: true, appSettings: false, userData: false });
    expect(bundle.data["os.timeZone"]).toBe("UTC");
    expect(await store.list()).toHaveLength(0);
  });

  it("restores a stored bundle onto a target", async () => {
    const { svc } = service(dir);
    const manifest = await svc.capture({ providerId: "local" }, {}, "bob");
    const { outcome } = await svc.restore({ providerId: "local" }, manifest.id);
    expect(outcome.applied).toBe(true);
  });

  it("rejects an unknown provider", async () => {
    const { svc } = service(dir);
    await expect(svc.capture({ providerId: "nope" })).rejects.toBeInstanceOf(StateError);
  });

  it("rejects a provider that is not settings-capable", async () => {
    const { svc } = service(dir);
    await expect(svc.capture({ providerId: "windows365" })).rejects.toBeInstanceOf(StateError);
  });
});
