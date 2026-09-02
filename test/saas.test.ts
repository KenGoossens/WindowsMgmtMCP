import { describe, it, expect } from "vitest";
import { SignJWT, generateKeyPair, jwtVerify } from "jose";
import {
  authorizeTool,
  SYSTEM_PRINCIPAL,
  ARBITRARY_EXECUTION_TOOLS,
  type Principal
} from "../src/saas/principal.js";
import { IntegrationRegistry } from "../src/saas/integrations.js";
import { QuotaManager } from "../src/saas/quota.js";
import {
  BearerAuthenticator,
  OAuthAuthenticator,
  createAuthenticator,
  type JwtVerifier
} from "../src/saas/auth.js";
import { resolveGraphTenant } from "../src/saas/tenant.js";
import { ConfigError } from "../src/core/errors.js";
import type { AppConfig } from "../src/config/schema.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 3000,
    authMode: "bearer",
    multiTenant: false,
    quotaPerMinute: 120,
    quotaPerDay: 0,
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

function thirdParty(over: Partial<Principal> = {}): Principal {
  return { id: "acme", displayName: "Acme", kind: "integration", scopes: [], trust: "third-party", ...over };
}

describe("authorizeTool", () => {
  it("the system principal may call anything, including arbitrary execution", () => {
    for (const tool of ARBITRARY_EXECUTION_TOOLS) {
      expect(authorizeTool(SYSTEM_PRINCIPAL, tool).allowed).toBe(true);
    }
  });

  it("denies third-party callers arbitrary-execution tools by default", () => {
    const d = authorizeTool(thirdParty(), "powershell_run");
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toMatch(/arbitrary-execution/);
  });

  it("permits arbitrary-execution when explicitly allow-listed", () => {
    expect(authorizeTool(thirdParty({ allowlist: ["powershell_run"] }), "powershell_run").allowed).toBe(true);
  });

  it("deny-list always wins, even over the allow-list", () => {
    const p = thirdParty({ allowlist: ["cloudpc_list"], denylist: ["cloudpc_list"] });
    expect(authorizeTool(p, "cloudpc_list").allowed).toBe(false);
  });

  it("an explicit allow-list is exhaustive", () => {
    const p = thirdParty({ allowlist: ["cloudpc_list"] });
    expect(authorizeTool(p, "cloudpc_list").allowed).toBe(true);
    expect(authorizeTool(p, "report_snapshot").allowed).toBe(false);
  });

  it("a first-party caller with no allow-list may call non-arbitrary tools", () => {
    const p = thirdParty({ trust: "first-party" });
    expect(authorizeTool(p, "report_snapshot").allowed).toBe(true);
    // first-party still implicitly allowed arbitrary exec (no third-party posture)
    expect(authorizeTool(p, "powershell_run").allowed).toBe(true);
  });
});

describe("IntegrationRegistry", () => {
  it("returns undefined when no integrations are configured", () => {
    expect(IntegrationRegistry.fromConfig(baseConfig(), silentLogger)).toBeUndefined();
  });

  it("loads integrations and resolves a presented token to a principal", () => {
    const cfg = baseConfig({
      saasIntegrations: JSON.stringify([
        { id: "portal", tokenEnv: "PORTAL_TOKEN", tenantId: "tenant-a", trust: "first-party" }
      ])
    });
    const reg = IntegrationRegistry.fromConfig(cfg, silentLogger, { PORTAL_TOKEN: "s3cret" } as never)!;
    expect(reg.size).toBe(1);
    const p = reg.resolveByToken("s3cret");
    expect(p?.id).toBe("portal");
    expect(p?.tenantId).toBe("tenant-a");
    expect(p?.trust).toBe("first-party");
    expect(p?.quota).toEqual({ perMinute: 120, perDay: 0 });
    expect(reg.resolveByToken("wrong")).toBeUndefined();
  });

  it("applies per-integration quota overrides", () => {
    const cfg = baseConfig({
      saasIntegrations: JSON.stringify([
        { id: "metered", token: "t", quotaPerMinute: 5, quotaPerDay: 100 }
      ])
    });
    const reg = IntegrationRegistry.fromConfig(cfg, silentLogger, {} as never)!;
    expect(reg.resolveByToken("t")?.quota).toEqual({ perMinute: 5, perDay: 100 });
  });

  it("rejects a missing token env var", () => {
    const cfg = baseConfig({
      saasIntegrations: JSON.stringify([{ id: "x", tokenEnv: "MISSING_VAR" }])
    });
    expect(() => IntegrationRegistry.fromConfig(cfg, silentLogger, {} as never)).toThrow(ConfigError);
  });

  it("rejects duplicate integration ids", () => {
    const cfg = baseConfig({
      saasIntegrations: JSON.stringify([
        { id: "dup", token: "a" },
        { id: "dup", token: "b" }
      ])
    });
    expect(() => IntegrationRegistry.fromConfig(cfg, silentLogger, {} as never)).toThrow(/Duplicate/);
  });

  it("third-party is the default trust posture", () => {
    const cfg = baseConfig({ saasIntegrations: JSON.stringify([{ id: "ext", token: "t" }]) });
    const p = IntegrationRegistry.fromConfig(cfg, silentLogger, {} as never)!.resolveByToken("t")!;
    expect(p.trust).toBe("third-party");
    expect(authorizeTool(p, "powershell_run").allowed).toBe(false);
  });
});

describe("QuotaManager", () => {
  it("is unlimited when no policy or all-zero policy", () => {
    const qm = new QuotaManager();
    expect(qm.check("a").allowed).toBe(true);
    expect(qm.check("a", { perMinute: 0, perDay: 0 }).allowed).toBe(true);
  });

  it("enforces the per-minute window and does not consume budget on denial", () => {
    let now = 1_000;
    const qm = new QuotaManager(() => now);
    const policy = { perMinute: 2, perDay: 0 };
    expect(qm.check("a", policy)).toMatchObject({ allowed: true, remaining: 1 });
    expect(qm.check("a", policy)).toMatchObject({ allowed: true, remaining: 0 });
    const denied = qm.check("a", policy);
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe("perMinute");
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    // After the window rolls over, the budget is restored.
    now += 60_001;
    expect(qm.check("a", policy).allowed).toBe(true);
  });

  it("enforces the per-day cap independently", () => {
    const now = 1_000;
    const qm = new QuotaManager(() => now);
    const policy = { perMinute: 0, perDay: 2 };
    expect(qm.check("a", policy).allowed).toBe(true);
    expect(qm.check("a", policy).allowed).toBe(true);
    expect(qm.check("a", policy)).toMatchObject({ allowed: false, limit: "perDay" });
  });

  it("partitions budgets per principal", () => {
    const qm = new QuotaManager();
    const policy = { perMinute: 1, perDay: 0 };
    expect(qm.check("a", policy).allowed).toBe(true);
    expect(qm.check("b", policy).allowed).toBe(true);
    expect(qm.check("a", policy).allowed).toBe(false);
  });
});

describe("BearerAuthenticator", () => {
  it("maps the static token to the system principal", async () => {
    const auth = new BearerAuthenticator({ staticToken: "tok" });
    expect((await auth.authenticate("tok"))?.kind).toBe("system");
    expect(await auth.authenticate("nope")).toBeUndefined();
    expect(await auth.authenticate(undefined)).toBeUndefined();
  });

  it("uses per-integration secrets and ignores the static token when integrations exist", async () => {
    const cfg = baseConfig({ saasIntegrations: JSON.stringify([{ id: "portal", token: "itok" }]) });
    const reg = IntegrationRegistry.fromConfig(cfg, silentLogger, {} as never)!;
    const auth = new BearerAuthenticator({ staticToken: "godtoken", integrations: reg });
    expect((await auth.authenticate("itok"))?.id).toBe("portal");
    // The static token is NOT a backdoor when integrations are configured.
    expect(await auth.authenticate("godtoken")).toBeUndefined();
  });
});

describe("OAuthAuthenticator", () => {
  async function makeToken(claims: Record<string, unknown>) {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setIssuer("https://issuer.example/v2.0")
      .setAudience("api://windows-mcp")
      .setExpirationTime("5m")
      .sign(privateKey);
    const verify: JwtVerifier = async (t) =>
      (await jwtVerify(t, publicKey, { issuer: "https://issuer.example/v2.0", audience: "api://windows-mcp" })).payload;
    return { token, verify };
  }

  it("maps verified JWT claims to a principal (offline jose sign/verify)", async () => {
    const { token, verify } = await makeToken({ azp: "client-123", tid: "tenant-xyz", scp: "CloudPC.Read Fleet.View" });
    const auth = new OAuthAuthenticator(verify, silentLogger);
    const p = await auth.authenticate(token);
    expect(p?.id).toBe("client-123");
    expect(p?.tenantId).toBe("tenant-xyz");
    expect(p?.scopes).toEqual(["CloudPC.Read", "Fleet.View"]);
    expect(p?.kind).toBe("integration");
    expect(p?.trust).toBe("third-party");
  });

  it("merges static integration policy by client id", async () => {
    const cfg = baseConfig({
      saasIntegrations: JSON.stringify([
        { id: "client-123", token: "unused", trust: "first-party", allowlist: ["cloudpc_list"], quotaPerMinute: 7 }
      ])
    });
    const reg = IntegrationRegistry.fromConfig(cfg, silentLogger, {} as never)!;
    const { token, verify } = await makeToken({ azp: "client-123", tid: "t", roles: ["Admin"] });
    const auth = new OAuthAuthenticator(verify, silentLogger, reg);
    const p = await auth.authenticate(token);
    expect(p?.trust).toBe("first-party");
    expect(p?.allowlist).toEqual(["cloudpc_list"]);
    expect(p?.quota?.perMinute).toBe(7);
    expect(p?.scopes).toEqual(["Admin"]); // app-role claim
  });

  it("rejects an invalid token", async () => {
    const auth = new OAuthAuthenticator(async () => {
      throw new Error("bad signature");
    }, silentLogger);
    expect(await auth.authenticate("garbage")).toBeUndefined();
  });

  it("the factory builds an OAuth authenticator with an injected verifier", async () => {
    const cfg = baseConfig({ authMode: "oauth", oauthIssuer: "https://issuer.example/v2.0", oauthAudience: "api://windows-mcp" });
    const { token, verify } = await makeToken({ azp: "c", tid: "t" });
    const auth = createAuthenticator(cfg, undefined, silentLogger, verify);
    expect(auth.mode).toBe("oauth");
    expect((await auth.authenticate(token))?.id).toBe("c");
  });
});

describe("resolveGraphTenant", () => {
  const cfg = baseConfig({ graphTenantId: "home-tenant" });

  it("uses the principal's tenant in multi-tenant mode", () => {
    const mt = baseConfig({ graphTenantId: "home-tenant", multiTenant: true });
    expect(resolveGraphTenant(mt, thirdParty({ tenantId: "caller-tenant" }))).toBe("caller-tenant");
  });

  it("falls back to the configured tenant when the principal has none", () => {
    const mt = baseConfig({ graphTenantId: "home-tenant", multiTenant: true });
    expect(resolveGraphTenant(mt, thirdParty())).toBe("home-tenant");
  });

  it("ignores the principal tenant in single-tenant mode", () => {
    expect(resolveGraphTenant(cfg, thirdParty({ tenantId: "caller-tenant" }))).toBe("home-tenant");
  });

  it("uses config for the system principal", () => {
    expect(resolveGraphTenant(cfg, SYSTEM_PRINCIPAL)).toBe("home-tenant");
  });
});
