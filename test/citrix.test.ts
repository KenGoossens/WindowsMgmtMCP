import { describe, it, expect } from "vitest";
import { summarizeDeliveryGroup, summarizeMachine, summarizeSession } from "../src/providers/citrix/tools.js";
import { hasCitrixConfig } from "../src/providers/citrix/citrixClient.js";
import { CitrixProvider } from "../src/providers/citrix/citrixProvider.js";
import type { AppConfig } from "../src/config/schema.js";
import type { CitrixMachine } from "../src/providers/citrix/citrixClient.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 3000,
    authMode: "bearer",
    multiTenant: false,
    psDefaultTimeoutMs: 60000,
    graphAuthMode: "app",
    reportingEnabled: false,
    reportingPollIntervalMs: 15000,
    reportingRetentionMinutes: 360,
    reportingMaxSamples: 50000,
    remoteDefaultTimeoutMs: 90000,
    horizonInsecureTls: false,
    auditLogPath: "./logs/audit.log",
    logLevel: "info",
    ...over
  } as AppConfig;
}

describe("hasCitrixConfig", () => {
  it("requires customer id, client id and secret", () => {
    expect(hasCitrixConfig(baseConfig())).toBe(false);
    expect(hasCitrixConfig(baseConfig({ citrixCustomerId: "c", citrixClientId: "i" }))).toBe(false);
    expect(hasCitrixConfig(baseConfig({ citrixCustomerId: "c", citrixClientId: "i", citrixClientSecret: "s" }))).toBe(true);
  });
});

describe("Citrix summarizers", () => {
  it("summarizes a delivery group", () => {
    const s = summarizeDeliveryGroup({ Id: "dg1", Name: "Sales", DeliveryType: "DesktopsAndApps", Enabled: true, InMaintenanceMode: false, TotalMachines: 12 });
    expect(s).toMatchObject({ id: "dg1", name: "Sales", inMaintenance: false, totalMachines: 12 });
  });

  it("summarizes a machine with load and registration", () => {
    const s = summarizeMachine({ Id: "m1", Name: "VDA-01", PowerState: "On", RegistrationState: "Registered", SessionCount: 2, LoadIndex: 4500, DeliveryGroup: { Name: "Sales" } });
    expect(s).toMatchObject({ id: "m1", powerState: "On", registrationState: "Registered", sessionCount: 2, deliveryGroup: "Sales" });
  });

  it("summarizes a session, preferring UserName then UPN", () => {
    expect(summarizeSession({ Id: "s1", UserName: "DOM\\alice", State: "Active" }).user).toBe("DOM\\alice");
    expect(summarizeSession({ Id: "s2", UserUPN: "bob@x.com", State: "Active" }).user).toBe("bob@x.com");
  });
});

describe("CitrixProvider", () => {
  it("advertises daas substrate with session-control + power + maintenance", () => {
    const provider = new CitrixProvider(baseConfig({ citrixCustomerId: "c", citrixClientId: "i", citrixClientSecret: "s" }), silentLogger);
    const caps = provider.capabilities();
    expect(caps.substrate).toBe("daas");
    expect(caps.operations).toEqual(expect.arrayContaining(["SESSION_CONTROL", "POWER", "MAINTENANCE"]));
    expect(caps.canBeFailoverTarget).toBe(true);
  });

  it("derives per-delivery-group sessionCount and loadIndex telemetry", async () => {
    const provider = new CitrixProvider(baseConfig({ citrixCustomerId: "c", citrixClientId: "i", citrixClientSecret: "s" }), silentLogger);
    const machines: CitrixMachine[] = [
      { Id: "m1", SessionCount: 2, RegistrationState: "Registered", DeliveryGroup: { Name: "Sales" } },
      { Id: "m2", SessionCount: 1, RegistrationState: "Unregistered", DeliveryGroup: { Name: "Sales" } },
      { Id: "m3", SessionCount: 5, RegistrationState: "Registered", DeliveryGroup: { Name: "Devs" } }
    ];
    (provider as unknown as { gw: { listMachines: () => Promise<CitrixMachine[]> } }).gw = {
      listMachines: async () => machines
    };
    const samples = await provider.getMetrics();
    const sales = samples.filter((s) => s.entity === "Sales");
    const devs = samples.filter((s) => s.entity === "Devs");
    expect(sales.find((s) => s.metric === "sessionCount")?.value).toBe(3);
    expect(sales.find((s) => s.metric === "loadIndex")?.value).toBe(1);
    expect(devs.find((s) => s.metric === "sessionCount")?.value).toBe(5);
    expect(devs.find((s) => s.metric === "loadIndex")?.value).toBe(0);
  });

  it("creates an alert sink that forwards fired alerts to Citrix notifications", async () => {
    const provider = new CitrixProvider(
      baseConfig({ citrixCustomerId: "c", citrixClientId: "i", citrixClientSecret: "s" }),
      silentLogger
    );
    const sent: Array<{ title: string; description: string; severity?: string }> = [];
    (provider as unknown as { gw: { sendNotification: (n: never) => Promise<void> } }).gw = {
      sendNotification: async (n) => {
        sent.push(n);
      }
    };
    const sink = provider.createAlertSink();
    expect(sink.id).toBe("citrix-notifications");
    await sink.onAlerts([
      {
        id: "a1",
        ruleId: "r1",
        metric: "loadIndex",
        condition: ">",
        threshold: 5,
        providerId: "citrix",
        entity: "Sales",
        value: 9,
        firedAt: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-01-01T00:00:00.000Z",
        acknowledged: false
      }
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("loadIndex > 5");
    expect(sent[0].description).toContain("Sales");
    expect(sent[0].severity).toBe("Warning");
  });
});
