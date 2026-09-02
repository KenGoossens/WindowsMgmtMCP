import { describe, it, expect } from "vitest";
import { summarizePool, summarizeMachine, summarizeSession } from "../src/providers/horizon/tools.js";
import { hasHorizonConfig } from "../src/providers/horizon/horizonClient.js";
import { HorizonProvider } from "../src/providers/horizon/horizonProvider.js";
import type { AppConfig } from "../src/config/schema.js";
import type { HorizonMachine, HorizonSession } from "../src/providers/horizon/horizonClient.js";

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

const fullHorizon = baseConfig({
  horizonApiBase: "https://cs.example.com",
  horizonDomain: "CORP",
  horizonUsername: "svc",
  horizonPassword: "pw"
});

describe("hasHorizonConfig", () => {
  it("requires base URL, domain, username and password", () => {
    expect(hasHorizonConfig(baseConfig())).toBe(false);
    expect(hasHorizonConfig(baseConfig({ horizonApiBase: "https://x", horizonDomain: "d" }))).toBe(false);
    expect(hasHorizonConfig(fullHorizon)).toBe(true);
  });
});

describe("Horizon summarizers", () => {
  it("summarizes a pool", () => {
    const s = summarizePool({ id: "p1", name: "pool1", display_name: "Pool One", type: "AUTOMATED", enabled: true });
    expect(s).toMatchObject({ id: "p1", name: "pool1", displayName: "Pool One", enabled: true });
  });

  it("summarizes a machine", () => {
    const s = summarizeMachine({ id: "m1", name: "vm-01", desktop_pool_id: "p1", state: "AVAILABLE", agent_version: "8.x" });
    expect(s).toMatchObject({ id: "m1", pool: "p1", state: "AVAILABLE" });
  });

  it("summarizes a session, tolerating user_name or username", () => {
    expect(summarizeSession({ id: "s1", user_name: "CORP\\alice", session_state: "CONNECTED" }).user).toBe("CORP\\alice");
    expect(summarizeSession({ id: "s2", username: "bob", session_state: "DISCONNECTED" }).user).toBe("bob");
  });
});

describe("HorizonProvider", () => {
  it("advertises vdi substrate with session-control + maintenance", () => {
    const provider = new HorizonProvider(fullHorizon, silentLogger);
    const caps = provider.capabilities();
    expect(caps.substrate).toBe("vdi");
    expect(caps.operations).toEqual(expect.arrayContaining(["SESSION_CONTROL", "MAINTENANCE"]));
    expect(caps.operations).toContain("IMAGE_ROLLOUT");
  });

  it("derives sessionCount and loadIndex telemetry", async () => {
    const provider = new HorizonProvider(fullHorizon, silentLogger);
    const sessions: HorizonSession[] = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
    const machines: HorizonMachine[] = [
      { id: "m1", state: "AVAILABLE" },
      { id: "m2", state: "CONNECTED" },
      { id: "m3", state: "ERROR" },
      { id: "m4", state: "MAINTENANCE" }
    ];
    (provider as unknown as { gw: { listSessions: () => Promise<HorizonSession[]>; listMachines: () => Promise<HorizonMachine[]> } }).gw = {
      listSessions: async () => sessions,
      listMachines: async () => machines
    };
    const samples = await provider.getMetrics();
    const byMetric = Object.fromEntries(samples.map((s) => [s.metric, s.value]));
    expect(byMetric.sessionCount).toBe(3);
    expect(byMetric.loadIndex).toBe(2); // ERROR + MAINTENANCE not in available set
  });

  it("adds an infrastructure load sample when the Monitor API is reachable", async () => {
    const provider = new HorizonProvider(fullHorizon, silentLogger);
    (
      provider as unknown as {
        gw: {
          listSessions: () => Promise<HorizonSession[]>;
          listMachines: () => Promise<HorizonMachine[]>;
          monitorHealth: () => Promise<{
            connectionServers: { status?: string }[];
            gateways: { status?: string }[];
          }>;
        };
      }
    ).gw = {
      listSessions: async () => [{ id: "s1" }],
      listMachines: async () => [{ id: "m1", state: "AVAILABLE" }],
      monitorHealth: async () => ({
        connectionServers: [{ status: "OK" }, { status: "ERROR" }],
        gateways: [{ status: "OK" }]
      })
    };
    const samples = await provider.getMetrics();
    const infra = samples.find((s) => s.entity === "infrastructure");
    expect(infra?.metric).toBe("loadIndex");
    expect(infra?.value).toBe(1); // one ERROR among 3 components
  });

  it("schedules an instant-clone image push via rolloutImage", async () => {
    const provider = new HorizonProvider(fullHorizon, silentLogger);
    let received: { poolId: string; spec: { snapshotId?: string } } | undefined;
    (
      provider as unknown as { gw: { pushImage: (poolId: string, spec: { snapshotId?: string }) => Promise<void> } }
    ).gw = {
      pushImage: async (poolId, spec) => {
        received = { poolId, spec };
      }
    };
    const job = await provider.rolloutImage({ id: "pool-1" }, { id: "snap-7" });
    expect(job).toEqual({ jobId: "horizon-pushimage-pool-1" });
    expect(received).toEqual({ poolId: "pool-1", spec: { snapshotId: "snap-7" } });
  });
});
