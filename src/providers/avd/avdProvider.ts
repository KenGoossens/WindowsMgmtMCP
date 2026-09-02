import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { ToolContext } from "../../core/tools.js";
import type { IPlatformProvider, MetricSample, ProviderCapabilities } from "../provider.js";
import { makeSample } from "../../reporting/metrics.js";
import type { OnboardingCapable, OnboardingPlan, OnboardingPlanInput, OnboardingStatus } from "../../onboarding/types.js";
import { buildAzureRbacPlan } from "../../onboarding/plans.js";
import { AvdGateway, hasAvdConfig, lastSegment } from "./avdClient.js";
import { registerAvdTools } from "./tools.js";

/** Session-host status values considered healthy/available. */
const AVAILABLE = "Available";

/**
 * Azure Virtual Desktop management (Azure-hosted VDI): host pools, session hosts
 * (with drain-mode maintenance), and live user-session control, via the official
 * `@azure/arm-desktopvirtualization` SDK. Reuses the Entra app credentials.
 */
export class AvdProvider implements IPlatformProvider, OnboardingCapable {
  readonly id = "avd";
  readonly displayName = "Azure Virtual Desktop";

  private readonly gw: AvdGateway;

  constructor(
    private readonly config: AppConfig,
    logger: Logger
  ) {
    this.gw = new AvdGateway(config, logger);
  }

  async isAvailable(): Promise<boolean> {
    return hasAvdConfig(this.config);
  }

  registerTools(server: McpServer, ctx: ToolContext): void {
    registerAvdTools(server, ctx, this.gw);
  }

  capabilities(): ProviderCapabilities {
    return {
      substrate: "vdi",
      operations: ["SESSION_CONTROL", "MAINTENANCE"],
      canBeMigrationSource: false,
      canBeMigrationTarget: false,
      canBeFailoverTarget: false,
      telemetry: {
        metrics: ["sessionCount", "loadIndex"],
        events: ["stateTransition"],
        live: true
      }
    };
  }

  /**
   * Per-host-pool telemetry: sessionCount (active sessions on the pool's hosts)
   * and loadIndex (count of session hosts not in the Available state).
   */
  async getMetrics(): Promise<MetricSample[]> {
    const pools = await this.gw.listHostPools();
    const samples: MetricSample[] = [];
    for (const pool of pools) {
      const poolName = lastSegment(pool.name);
      if (!poolName) continue;
      const hosts = await this.gw.listSessionHosts(poolName);
      const sessions = hosts.reduce((sum, h) => sum + (h.sessions ?? 0), 0);
      const unavailable = hosts.filter((h) => (h.status ?? "") !== AVAILABLE).length;
      const common = {
        providerId: this.id,
        substrate: "vdi" as const,
        entity: poolName,
        entityType: "grouping" as const
      };
      samples.push(
        makeSample({ ...common, metric: "sessionCount", value: sessions, unit: "count" }),
        makeSample({ ...common, metric: "loadIndex", value: unavailable, unit: "count" })
      );
    }
    return samples;
  }

  // ── Onboarding (Azure RBAC role assignment) ─────────────────────────────
  onboardingPlan(input: OnboardingPlanInput): OnboardingPlan {
    return buildAzureRbacPlan(this.config, input);
  }

  async onboardingStatus(): Promise<OnboardingStatus> {
    const base = { providerId: this.id, displayName: this.displayName };
    if (!hasAvdConfig(this.config)) {
      return { ...base, configured: false, onboarded: false, details: "AVD subscription/resource group or Entra credentials not configured yet." };
    }
    try {
      await this.gw.listHostPools();
      return { ...base, configured: true, onboarded: true, details: "Verified: listed AVD host pools." };
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
