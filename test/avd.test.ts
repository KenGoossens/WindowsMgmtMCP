import { describe, it, expect } from "vitest";
import {
  summarizeHostPool,
  summarizeSessionHost,
  summarizeUserSession
} from "../src/providers/avd/tools.js";
import { hasAvdConfig, lastSegment, parseUserSessionName } from "../src/providers/avd/avdClient.js";
import { AvdProvider } from "../src/providers/avd/avdProvider.js";
import type { AppConfig } from "../src/config/schema.js";
import type { HostPool, SessionHost, UserSession } from "@azure/arm-desktopvirtualization";

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
    auditLogPath: "./logs/audit.log",
    logLevel: "info",
    ...over
  } as AppConfig;
}

const fullAvdConfig = baseConfig({
  avdSubscriptionId: "sub-1",
  avdResourceGroup: "rg-1",
  graphTenantId: "t",
  graphClientId: "c",
  graphClientSecret: "s"
});

describe("hasAvdConfig", () => {
  it("requires subscription, resource group and Entra creds", () => {
    expect(hasAvdConfig(baseConfig())).toBe(false);
    expect(hasAvdConfig(baseConfig({ avdSubscriptionId: "s", avdResourceGroup: "r" }))).toBe(false);
    expect(hasAvdConfig(fullAvdConfig)).toBe(true);
  });

  it("allows delegated mode without a client secret", () => {
    expect(
      hasAvdConfig(
        baseConfig({
          avdSubscriptionId: "s",
          avdResourceGroup: "r",
          graphTenantId: "t",
          graphClientId: "c",
          graphAuthMode: "delegated"
        })
      )
    ).toBe(true);
  });
});

describe("AVD name parsing", () => {
  it("lastSegment extracts the trailing resource-name segment", () => {
    expect(lastSegment("pool1/host1.contoso.com")).toBe("host1.contoso.com");
    expect(lastSegment("pool1")).toBe("pool1");
    expect(lastSegment(undefined)).toBe("");
  });

  it("parseUserSessionName splits host and session id", () => {
    expect(parseUserSessionName("pool1/host1/42")).toEqual({ sessionHost: "host1", userSessionId: "42" });
    expect(parseUserSessionName("42")).toEqual({ sessionHost: "", userSessionId: "42" });
  });
});

describe("AVD summarizers", () => {
  it("summarizes a host pool", () => {
    const hp = { name: "rg/pool1", friendlyName: "Pool One", hostPoolType: "Pooled", loadBalancerType: "BreadthFirst", maxSessionLimit: 10 } as HostPool;
    expect(summarizeHostPool(hp)).toMatchObject({ name: "pool1", type: "Pooled", loadBalancer: "BreadthFirst", maxSessionLimit: 10 });
  });

  it("derives inMaintenance from allowNewSession=false", () => {
    const draining = summarizeSessionHost({ name: "pool/host1", allowNewSession: false, sessions: 0, status: "Available" } as SessionHost);
    expect(draining.inMaintenance).toBe(true);
    const active = summarizeSessionHost({ name: "pool/host2", allowNewSession: true, sessions: 3, status: "Available" } as SessionHost);
    expect(active.inMaintenance).toBe(false);
    expect(active.sessions).toBe(3);
  });

  it("exposes session id and host for session control", () => {
    const us = summarizeUserSession({ name: "pool/host1/7", userPrincipalName: "alice@contoso.com", sessionState: "Active" } as UserSession);
    expect(us).toMatchObject({ userSessionId: "7", sessionHost: "host1", userPrincipalName: "alice@contoso.com", sessionState: "Active" });
  });
});

describe("AvdProvider", () => {
  it("advertises vdi substrate with session-control + maintenance ops", () => {
    const provider = new AvdProvider(fullAvdConfig, silentLogger);
    const caps = provider.capabilities();
    expect(caps.substrate).toBe("vdi");
    expect(caps.operations).toContain("SESSION_CONTROL");
    expect(caps.operations).toContain("MAINTENANCE");
  });

  it("derives per-pool sessionCount and loadIndex telemetry", async () => {
    const provider = new AvdProvider(fullAvdConfig, silentLogger);
    (provider as unknown as { gw: unknown }).gw = {
      listHostPools: async () => [{ name: "rg/poolA" }],
      listSessionHosts: async () => [
        { name: "poolA/h1", sessions: 2, status: "Available" },
        { name: "poolA/h2", sessions: 3, status: "Unavailable" },
        { name: "poolA/h3", sessions: 0, status: "Shutdown" }
      ]
    };
    const samples = await provider.getMetrics();
    const byMetric = Object.fromEntries(samples.map((s) => [s.metric, s.value]));
    expect(byMetric.sessionCount).toBe(5); // 2 + 3 + 0
    expect(byMetric.loadIndex).toBe(2); // Unavailable + Shutdown
    expect(samples[0].entity).toBe("poolA");
    expect(samples[0].substrate).toBe("vdi");
  });
});
