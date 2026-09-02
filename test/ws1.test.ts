import { describe, it, expect } from "vitest";
import { summarizeDevice } from "../src/providers/ws1uem/tools.js";
import { hasWs1Config } from "../src/providers/ws1uem/ws1Client.js";
import { Ws1Provider } from "../src/providers/ws1uem/ws1Provider.js";
import type { AppConfig } from "../src/config/schema.js";
import type { Ws1Device, Ws1DeviceSearchOptions } from "../src/providers/ws1uem/ws1Client.js";

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
    ws1ApiVersion: "1",
    auditLogPath: "./logs/audit.log",
    logLevel: "info",
    ...over
  } as AppConfig;
}

function fullWs1(): AppConfig {
  return baseConfig({
    ws1ApiHost: "https://as1234.awmdm.com",
    ws1TenantCode: "tenant-code",
    ws1TokenUrl: "https://na.uemauth.vmwservices.com/connect/token",
    ws1ClientId: "id",
    ws1ClientSecret: "secret"
  });
}

describe("hasWs1Config", () => {
  it("requires host, tenant code, token url, client id and secret", () => {
    expect(hasWs1Config(baseConfig())).toBe(false);
    expect(hasWs1Config(baseConfig({ ws1ApiHost: "https://as1234.awmdm.com", ws1TenantCode: "t" }))).toBe(false);
    expect(hasWs1Config(fullWs1())).toBe(true);
  });
});

describe("summarizeDevice", () => {
  it("flattens the nested id and key device fields", () => {
    const d: Ws1Device = {
      Id: { Value: 42 },
      DeviceFriendlyName: "iPhone",
      UserName: "alice",
      Platform: "Apple",
      Model: "iPhone 15",
      OperatingSystem: "17.4",
      ComplianceStatus: "Compliant",
      EnrollmentStatus: "Enrolled"
    };
    expect(summarizeDevice(d)).toMatchObject({
      id: 42,
      friendlyName: "iPhone",
      userName: "alice",
      platform: "Apple",
      complianceStatus: "Compliant"
    });
  });
});

describe("Ws1Provider", () => {
  it("advertises the device substrate and is not a failover/migration target", () => {
    const provider = new Ws1Provider(fullWs1(), silentLogger);
    const caps = provider.capabilities();
    expect(caps.substrate).toBe("device");
    expect(caps.canBeFailoverTarget).toBe(false);
    expect(caps.canBeMigrationSource).toBe(false);
  });

  it("derives enrolled (sessionCount) and non-compliant (loadIndex) telemetry", async () => {
    const provider = new Ws1Provider(fullWs1(), silentLogger);
    (provider as unknown as { gw: { searchDevices: (o: Ws1DeviceSearchOptions) => Promise<Ws1Device[]> } }).gw = {
      searchDevices: async (o) =>
        o.complianceStatus === "NonCompliant"
          ? [{ Id: { Value: 3 } }]
          : [{ Id: { Value: 1 } }, { Id: { Value: 2 } }, { Id: { Value: 3 } }]
    };
    const byMetric = Object.fromEntries((await provider.getMetrics()).map((s) => [s.metric, s.value]));
    expect(byMetric.sessionCount).toBe(3);
    expect(byMetric.loadIndex).toBe(1);
  });
});
