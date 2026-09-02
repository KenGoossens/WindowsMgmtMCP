import { describe, it, expect } from "vitest";
import {
  summarizeWorkspace,
  summarizeConnectionStatus,
  summarizeSnapshot,
  summarizePool,
  summarizePoolSession
} from "../src/providers/awsWorkspaces/tools.js";
import { hasAwsConfig } from "../src/providers/awsWorkspaces/workspacesClient.js";
import { AwsWorkspacesProvider } from "../src/providers/awsWorkspaces/awsWorkspacesProvider.js";
import type { AppConfig } from "../src/config/schema.js";
import type { Workspace } from "@aws-sdk/client-workspaces";

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

describe("hasAwsConfig", () => {
  it("is available only when a region is set", () => {
    expect(hasAwsConfig(baseConfig())).toBe(false);
    expect(hasAwsConfig(baseConfig({ awsRegion: "eu-west-1" }))).toBe(true);
  });
});

describe("summarizeWorkspace", () => {
  it("normalizes the verbose SDK shape to a stable summary", () => {
    const w: Workspace = {
      WorkspaceId: "ws-123",
      DirectoryId: "d-1",
      UserName: "alice",
      State: "AVAILABLE",
      IpAddress: "10.0.0.9",
      BundleId: "wsb-1",
      WorkspaceProperties: { RunningMode: "AUTO_STOP", ComputeTypeName: "STANDARD", RootVolumeSizeGib: 80, UserVolumeSizeGib: 50 }
    };
    expect(summarizeWorkspace(w)).toMatchObject({
      workspaceId: "ws-123",
      userName: "alice",
      state: "AVAILABLE",
      runningMode: "AUTO_STOP",
      compute: "STANDARD"
    });
  });

  it("omits empty error fields", () => {
    const s = summarizeWorkspace({ WorkspaceId: "ws-9", State: "AVAILABLE", ErrorCode: "", ErrorMessage: "" });
    expect(s.errorCode).toBeUndefined();
    expect(s.errorMessage).toBeUndefined();
  });
});

describe("new WorkSpaces summarizers", () => {
  it("normalizes connection status with ISO timestamps", () => {
    const ts = new Date("2026-01-02T03:04:05.000Z");
    expect(
      summarizeConnectionStatus({
        WorkspaceId: "ws-1",
        ConnectionState: "CONNECTED",
        ConnectionStateCheckTimestamp: ts,
        LastKnownUserConnectionTimestamp: ts
      })
    ).toEqual({
      workspaceId: "ws-1",
      connectionState: "CONNECTED",
      connectionStateCheckTimestamp: "2026-01-02T03:04:05.000Z",
      lastKnownUserConnectionTimestamp: "2026-01-02T03:04:05.000Z"
    });
  });

  it("normalizes snapshots, pools, and pool sessions", () => {
    expect(summarizeSnapshot({ SnapshotTime: new Date("2026-01-02T03:04:05.000Z") })).toEqual({
      snapshotTime: "2026-01-02T03:04:05.000Z"
    });
    expect(
      summarizePool({
        PoolId: "wsp-1",
        PoolName: "pool",
        State: "RUNNING",
        BundleId: "wsb-1",
        DirectoryId: "d-1",
        CapacityStatus: { DesiredUserSessions: 10, AvailableUserSessions: 6, ActualUserSessions: 4, ActiveUserSessions: 4 }
      } as never)
    ).toMatchObject({ poolId: "wsp-1", state: "RUNNING", desiredSessions: 10, activeSessions: 4 });
    expect(
      summarizePoolSession({ SessionId: "s-1", PoolId: "wsp-1", UserId: "u-1", ConnectionState: "CONNECTED" } as never)
    ).toMatchObject({ sessionId: "s-1", poolId: "wsp-1", userId: "u-1", connectionState: "CONNECTED" });
  });
});

describe("AwsWorkspacesProvider", () => {
  it("advertises daas + failover-target capabilities", () => {
    const provider = new AwsWorkspacesProvider(baseConfig({ awsRegion: "eu-west-1" }), silentLogger);
    const caps = provider.capabilities();
    expect(caps.substrate).toBe("daas");
    expect(caps.canBeFailoverTarget).toBe(true);
    expect(caps.operations).toContain("RESIZE");
  });

  it("derives sessionCount and loadIndex telemetry from the fleet", async () => {
    const provider = new AwsWorkspacesProvider(baseConfig({ awsRegion: "eu-west-1" }), silentLogger);
    // Inject a fake gateway so no live AWS call is made.
    (provider as unknown as { gw: { describe: () => Promise<Workspace[]> } }).gw = {
      describe: async () => [
        { WorkspaceId: "a", State: "AVAILABLE" },
        { WorkspaceId: "b", State: "STOPPED" },
        { WorkspaceId: "c", State: "ERROR" },
        { WorkspaceId: "d", State: "IMPAIRED" }
      ]
    };
    const samples = await provider.getMetrics();
    const byMetric = Object.fromEntries(samples.map((s) => [s.metric, s.value]));
    expect(byMetric.sessionCount).toBe(4);
    expect(byMetric.loadIndex).toBe(2); // ERROR + IMPAIRED
    expect(samples[0].providerId).toBe("awsworkspaces");
    expect(samples[0].substrate).toBe("daas");
  });

  it("reports real connected sessions when connection status is available", async () => {
    const provider = new AwsWorkspacesProvider(baseConfig({ awsRegion: "eu-west-1" }), silentLogger);
    (
      provider as unknown as {
        gw: { describe: () => Promise<Workspace[]>; connectionStatus: () => Promise<{ ConnectionState: string }[]> };
      }
    ).gw = {
      describe: async () => [
        { WorkspaceId: "a", State: "AVAILABLE" },
        { WorkspaceId: "b", State: "AVAILABLE" },
        { WorkspaceId: "c", State: "STOPPED" }
      ],
      connectionStatus: async () => [
        { ConnectionState: "CONNECTED" },
        { ConnectionState: "DISCONNECTED" },
        { ConnectionState: "CONNECTED" }
      ]
    };
    const byMetric = Object.fromEntries((await provider.getMetrics()).map((s) => [s.metric, s.value]));
    expect(byMetric.sessionCount).toBe(2); // real CONNECTED count, not fleet size (3)
  });

  it("reports health from the WorkSpace state", async () => {
    const provider = new AwsWorkspacesProvider(baseConfig({ awsRegion: "eu-west-1" }), silentLogger);
    (provider as unknown as { gw: { describe: (o: { workspaceId?: string }) => Promise<Workspace[]> } }).gw = {
      describe: async (o) => (o.workspaceId === "ws-ok" ? [{ WorkspaceId: "ws-ok", State: "AVAILABLE" }] : [])
    };
    expect(await provider.health({ providerId: "awsworkspaces", id: "ws-ok" })).toEqual({
      healthy: true,
      details: "state=AVAILABLE"
    });
    expect((await provider.health({ providerId: "awsworkspaces", id: "ws-missing" })).healthy).toBe(false);
  });

  it("provisions a WorkSpace from a generic spec and returns its endpoint ref", async () => {
    const provider = new AwsWorkspacesProvider(baseConfig({ awsRegion: "eu-west-1" }), silentLogger);
    let received: unknown;
    (
      provider as unknown as {
        gw: { create: (r: unknown) => Promise<{ pending: Workspace[]; failed: unknown[] }> };
      }
    ).gw = {
      create: async (r) => {
        received = r;
        return { pending: [{ WorkspaceId: "ws-new" }], failed: [] };
      }
    };
    const ref = await provider.provision({
      providerId: "awsworkspaces",
      user: "bob",
      sku: "wsb-7",
      directoryId: "d-9"
    });
    expect(ref).toEqual({ providerId: "awsworkspaces", id: "ws-new" });
    expect(received).toMatchObject({ DirectoryId: "d-9", UserName: "bob", BundleId: "wsb-7" });
  });

  it("rejects provision when required inputs are missing", async () => {
    const provider = new AwsWorkspacesProvider(baseConfig({ awsRegion: "eu-west-1" }), silentLogger);
    await expect(provider.provision({ providerId: "awsworkspaces" })).rejects.toThrow(/requires a directory id/);
  });
});
