import { describe, it, expect } from "vitest";
import {
  summarizeTemplate,
  summarizeVm,
  summarizeImage
} from "../src/providers/horizonCloud/tools.js";
import { hasHorizonCloudConfig } from "../src/providers/horizonCloud/cloudClient.js";
import { HorizonCloudProvider } from "../src/providers/horizonCloud/cloudProvider.js";
import type { AppConfig } from "../src/config/schema.js";
import type { HorizonCloudTemplate, HorizonCloudVm } from "../src/providers/horizonCloud/cloudClient.js";

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
    horizonCloudCspUrl: "https://connect.omnissa.com",
    auditLogPath: "./logs/audit.log",
    logLevel: "info",
    ...over
  } as AppConfig;
}

describe("hasHorizonCloudConfig", () => {
  it("requires an API base plus an API token or OAuth-app credentials", () => {
    expect(hasHorizonCloudConfig(baseConfig())).toBe(false);
    expect(hasHorizonCloudConfig(baseConfig({ horizonCloudApiBase: "https://cloud-sg.horizon.omnissa.com" }))).toBe(false);
    expect(
      hasHorizonCloudConfig(
        baseConfig({ horizonCloudApiBase: "https://cloud-sg.horizon.omnissa.com", horizonCloudApiToken: "tok" })
      )
    ).toBe(true);
    expect(
      hasHorizonCloudConfig(
        baseConfig({
          horizonCloudApiBase: "https://cloud-sg.horizon.omnissa.com",
          horizonCloudClientId: "id",
          horizonCloudClientSecret: "secret"
        })
      )
    ).toBe(true);
  });
});

describe("Horizon Cloud summarizers", () => {
  it("summarizes a template (pool)", () => {
    expect(
      summarizeTemplate({ id: "t1", name: "Sales", templateType: "DEDICATED", imageId: "img-1", sessionsPerVm: 1 })
    ).toMatchObject({ id: "t1", name: "Sales", templateType: "DEDICATED", sessionsPerVm: 1 });
  });

  it("summarizes a VM with lifecycle + agent status", () => {
    expect(
      summarizeVm({ id: "vm1", templateId: "t1", lifecycleStatus: "PROVISIONED", powerState: "PoweredOn", agentStatus: "AVAILABLE" })
    ).toMatchObject({ id: "vm1", templateId: "t1", lifecycleStatus: "PROVISIONED", agentStatus: "AVAILABLE" });
  });

  it("summarizes an image", () => {
    expect(summarizeImage({ id: "i1", name: "Win11" })).toEqual({ id: "i1", name: "Win11" });
  });
});

describe("HorizonCloudProvider", () => {
  it("advertises daas substrate as a failover target", () => {
    const provider = new HorizonCloudProvider(
      baseConfig({ horizonCloudApiBase: "https://cloud-sg.horizon.omnissa.com", horizonCloudApiToken: "tok" }),
      silentLogger
    );
    const caps = provider.capabilities();
    expect(caps.substrate).toBe("daas");
    expect(caps.operations).toEqual(expect.arrayContaining(["SESSION_CONTROL", "POWER"]));
    expect(caps.canBeFailoverTarget).toBe(true);
  });

  it("derives per-template sessionCount (ready VMs) and loadIndex (not-ready VMs)", async () => {
    const provider = new HorizonCloudProvider(
      baseConfig({ horizonCloudApiBase: "https://cloud-sg.horizon.omnissa.com", horizonCloudApiToken: "tok" }),
      silentLogger
    );
    const templates: HorizonCloudTemplate[] = [{ id: "t1", name: "Sales" }];
    const vms: HorizonCloudVm[] = [
      { id: "v1", lifecycleStatus: "PROVISIONED" },
      { id: "v2", lifecycleStatus: "PROVISIONED" },
      { id: "v3", lifecycleStatus: "ERROR" }
    ];
    (
      provider as unknown as {
        gw: { listTemplates: () => Promise<HorizonCloudTemplate[]>; listVms: () => Promise<HorizonCloudVm[]> };
      }
    ).gw = {
      listTemplates: async () => templates,
      listVms: async () => vms
    };
    const samples = await provider.getMetrics();
    const sales = samples.filter((s) => s.entity === "Sales");
    expect(sales.find((s) => s.metric === "sessionCount")?.value).toBe(2);
    expect(sales.find((s) => s.metric === "loadIndex")?.value).toBe(1);
  });
});
