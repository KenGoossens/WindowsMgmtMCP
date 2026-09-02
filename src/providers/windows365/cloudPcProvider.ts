import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@microsoft/microsoft-graph-client";
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { ToolContext } from "../../core/tools.js";
import type { IPlatformProvider, MetricSample, ProviderCapabilities } from "../provider.js";
import { makeSample } from "../../reporting/metrics.js";
import type { OnboardingCapable, OnboardingPlan, OnboardingPlanInput, OnboardingStatus } from "../../onboarding/types.js";
import { buildEntraConsentPlan } from "../../onboarding/plans.js";
import { resolveGraphTenant } from "../../saas/tenant.js";
import { createGraphClient, hasGraphConfig } from "./graphClient.js";
import { registerWindows365Tools } from "./tools.js";

/**
 * Windows 365 Cloud PC fleet management via Microsoft Graph.
 */
export class Windows365Provider implements IPlatformProvider, OnboardingCapable {
  readonly id = "windows365";
  readonly displayName = "Windows 365 Cloud PC";

  /** Graph clients keyed by effective tenant (multi-tenant Entra app). */
  private readonly clients = new Map<string, Client>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  async isAvailable(): Promise<boolean> {
    return hasGraphConfig(this.config);
  }

  /** Lazily create (and memoize, per tenant) the Graph client on first tool use. */
  private getClient(tenant?: string): Client {
    const key = tenant ?? this.config.graphTenantId ?? "default";
    let client = this.clients.get(key);
    if (!client) {
      client = createGraphClient(this.config, this.logger, tenant);
      this.clients.set(key, client);
    }
    return client;
  }

  registerTools(server: McpServer, ctx: ToolContext): void {
    // Resolve this session's tenant once (multi-tenant: from the caller's
    // principal; single-tenant: the configured default).
    const tenant = resolveGraphTenant(this.config, ctx.principal);
    registerWindows365Tools(server, ctx, () => this.getClient(tenant));
  }

  capabilities(): ProviderCapabilities {
    return {
      substrate: "cloud",
      operations: ["PROVISION", "RESTORE_KNOWN_GOOD", "RESIZE", "REPAIR_OS"],
      canBeMigrationSource: false,
      canBeMigrationTarget: true,
      canBeFailoverTarget: true,
      telemetry: { metrics: ["sessionCount", "loadIndex"], events: ["stateTransition", "lifecycle"], live: true }
    };
  }

  /**
   * Fleet-level Cloud PC telemetry: total count and the number not in a healthy
   * `provisioned` state (a normalized pressure/load signal).
   */
  async getMetrics(): Promise<MetricSample[]> {
    const res = await this.getClient()
      .api("/deviceManagement/virtualEndpoint/cloudPCs")
      .select("id,status")
      .get();
    const items: { status?: string }[] = res?.value ?? [];
    const total = items.length;
    const unhealthy = items.filter(
      (c) => (c.status ?? "").toLowerCase() !== "provisioned"
    ).length;
    const common = { providerId: this.id, substrate: "cloud" as const, entity: this.id, entityType: "substrate" as const };
    return [
      makeSample({ ...common, metric: "sessionCount", value: total, unit: "count" }),
      makeSample({ ...common, metric: "loadIndex", value: unhealthy, unit: "count" })
    ];
  }

  // ── Onboarding (Entra admin-consent) ──────────────────────────────────────
  onboardingPlan(input: OnboardingPlanInput): OnboardingPlan {
    return buildEntraConsentPlan(this.config, input);
  }

  async onboardingStatus(): Promise<OnboardingStatus> {
    const base = { providerId: this.id, displayName: "Windows 365 (Microsoft Entra)" };
    if (!hasGraphConfig(this.config)) {
      return { ...base, configured: false, onboarded: false, details: "Graph credentials not configured yet." };
    }
    try {
      await this.getClient().api("/deviceManagement/virtualEndpoint/cloudPCs").top(1).get();
      return { ...base, configured: true, onboarded: true, details: "Verified: read access to Cloud PCs succeeded." };
    } catch (err) {
      return {
        ...base,
        configured: true,
        onboarded: false,
        details: `Configured, but a live read failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }
}
