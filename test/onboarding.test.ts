import { describe, it, expect } from "vitest";
import {
  buildEntraConsentPlan,
  buildAwsGuidedPlan,
  buildAzureRbacPlan,
  buildCitrixGuidedPlan,
  buildHorizonManualPlan
} from "../src/onboarding/plans.js";
import { isOnboardingCapable } from "../src/onboarding/types.js";
import { OnboardingService } from "../src/onboarding/service.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import type { AppConfig } from "../src/config/schema.js";

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
    stateStoreUri: "./state",
    stateRetentionDays: 30,
    migrationRetainSource: true,
    failoverMode: "manual",
    agentBrokerEnabled: false,
    agentMaxAutonomy: "L1",
    agentStaleSeconds: 90,
    auditLogPath: "./logs/audit.log",
    logLevel: "info",
    ...over
  } as AppConfig;
}

describe("buildEntraConsentPlan", () => {
  it("builds an admin-consent URL when a client id + public url are set", () => {
    const plan = buildEntraConsentPlan(
      baseConfig({ graphClientId: "app-123", graphTenantId: "tenant-abc", onboardingPublicUrl: "https://mcp.example.com" }),
      {}
    );
    expect(plan.method).toBe("admin-consent");
    expect(plan.actionUrl).toContain("https://login.microsoftonline.com/tenant-abc/adminconsent");
    expect(plan.actionUrl).toContain("client_id=app-123");
    expect(plan.actionUrl).toContain("redirect_uri=https%3A%2F%2Fmcp.example.com%2Fonboarding%2Fcallback");
    expect(plan.permissions.some((p) => p.name === "CloudPC.ReadWrite.All")).toBe(true);
    expect(plan.verifiable).toBe(true);
    expect(plan.warnings).toHaveLength(0);
  });

  it("uses 'organizations' and warns when no client id is configured", () => {
    const plan = buildEntraConsentPlan(baseConfig(), {});
    expect(plan.actionUrl).toBeUndefined();
    expect(plan.warnings.join(" ")).toMatch(/GRAPH_CLIENT_ID/);
  });

  it("honours an input tenant override", () => {
    const plan = buildEntraConsentPlan(baseConfig({ graphClientId: "app-1", onboardingPublicUrl: "https://x" }), { tenant: "contoso.onmicrosoft.com" });
    expect(plan.actionUrl).toContain("/contoso.onmicrosoft.com/adminconsent");
  });
});

describe("buildAwsGuidedPlan", () => {
  it("emits a least-privilege IAM policy artifact (no wildcards in actions)", () => {
    const plan = buildAwsGuidedPlan(baseConfig({ awsRegion: "eu-west-1" }), {});
    expect(plan.method).toBe("guided");
    expect(plan.artifact?.kind).toBe("iam-policy");
    const policy = JSON.parse(plan.artifact!.content);
    expect(policy.Statement[0].Action).toContain("workspaces:DescribeWorkspaces");
    expect(policy.Statement[0].Action).not.toContain("*");
    expect(plan.warnings.join(" ")).toMatch(/ExternalId/);
  });
});

describe("buildAzureRbacPlan", () => {
  it("emits an az role assignment command scoped to the resource group", () => {
    const plan = buildAzureRbacPlan(baseConfig({ avdSubscriptionId: "sub-1", avdResourceGroup: "rg-avd", graphClientId: "app-1" }), {});
    expect(plan.method).toBe("azure-rbac");
    expect(plan.artifact?.content).toContain("az role assignment create");
    expect(plan.artifact?.content).toContain("Desktop Virtualization Contributor");
    expect(plan.artifact?.content).toContain("/subscriptions/sub-1/resourceGroups/rg-avd");
  });
});

describe("buildCitrixGuidedPlan / buildHorizonManualPlan", () => {
  it("citrix is guided and verifiable", () => {
    const plan = buildCitrixGuidedPlan(baseConfig(), {});
    expect(plan.method).toBe("guided");
    expect(plan.verifiable).toBe(true);
  });
  it("horizon is manual and verifiable", () => {
    const plan = buildHorizonManualPlan(baseConfig(), {});
    expect(plan.method).toBe("manual");
    expect(plan.verifiable).toBe(true);
  });
});

describe("isOnboardingCapable", () => {
  it("detects the capability shape", () => {
    expect(isOnboardingCapable({ onboardingPlan() {}, onboardingStatus() {} })).toBe(true);
    expect(isOnboardingCapable({ onboardingPlan() {} })).toBe(false);
    expect(isOnboardingCapable({})).toBe(false);
  });
});

describe("OnboardingService", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function fakeOnboardable(id: string): any {
    return {
      id,
      displayName: id,
      isAvailable: async () => false,
      registerTools() {},
      onboardingPlan: () => ({ providerId: id, displayName: id, method: "guided", summary: "", permissions: [], steps: [], warnings: [], verifiable: true }),
      onboardingStatus: async () => ({ providerId: id, displayName: id, configured: false, onboarded: false, details: "n/a" })
    };
  }

  function svc() {
    const registry = new ProviderRegistry(silentLogger);
    registry.register(fakeOnboardable("windows365"));
    // a non-onboardable provider should be excluded
    registry.register({ id: "local", displayName: "Local", isAvailable: async () => true, registerTools() {} } as never);
    return new OnboardingService(registry, silentLogger);
  }

  it("lists only onboarding-capable providers", () => {
    const list = svc().list();
    expect(list.map((p) => p.providerId)).toEqual(["windows365"]);
  });

  it("plans for a capable provider", () => {
    expect(svc().plan("windows365").providerId).toBe("windows365");
  });

  it("throws for a non-onboardable provider", () => {
    expect(() => svc().plan("local")).toThrow(/does not support onboarding/);
  });
});
