import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { ToolContext } from "../../core/tools.js";
import type { IPlatformProvider, MetricSample, ProviderCapabilities } from "../provider.js";
import { makeSample } from "../../reporting/metrics.js";
import type { OnboardingCapable, OnboardingPlan, OnboardingPlanInput, OnboardingStatus } from "../../onboarding/types.js";
import { buildWs1GuidedPlan } from "../../onboarding/plans.js";
import { Ws1Gateway, hasWs1Config } from "./ws1Client.js";
import { registerWs1Tools } from "./tools.js";

/**
 * Workspace ONE UEM (AirWatch) — multi-OS endpoint management for iOS, Android,
 * Windows, and macOS devices. Unlike the desktop providers this manages enrolled
 * physical/mobile devices (substrate "device"); it is not a failover/migration
 * target. Available when UEM API credentials and a tenant code are configured.
 */
export class Ws1Provider implements IPlatformProvider, OnboardingCapable {
  readonly id = "ws1uem";
  readonly displayName = "Workspace ONE UEM";

  private readonly gw: Ws1Gateway;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.gw = new Ws1Gateway(config);
  }

  async isAvailable(): Promise<boolean> {
    return hasWs1Config(this.config);
  }

  registerTools(server: McpServer, ctx: ToolContext): void {
    registerWs1Tools(server, ctx, this.gw);
  }

  capabilities(): ProviderCapabilities {
    return {
      substrate: "device",
      operations: [],
      canBeMigrationSource: false,
      canBeMigrationTarget: false,
      canBeFailoverTarget: false,
      telemetry: { metrics: ["sessionCount", "loadIndex"], events: ["lifecycle"], live: true }
    };
  }

  /**
   * Fleet telemetry: `sessionCount` is the number of enrolled devices and
   * `loadIndex` is the number that are non-compliant.
   */
  async getMetrics(): Promise<MetricSample[]> {
    const [all, nonCompliant] = await Promise.all([
      this.gw.searchDevices({ pageSize: 500 }),
      this.gw.searchDevices({ complianceStatus: "NonCompliant", pageSize: 500 })
    ]);
    const common = {
      providerId: this.id,
      substrate: "device" as const,
      entity: this.id,
      entityType: "substrate" as const
    };
    return [
      makeSample({ ...common, metric: "sessionCount", value: all.length, unit: "count" }),
      makeSample({ ...common, metric: "loadIndex", value: nonCompliant.length, unit: "count" })
    ];
  }

  // ── Onboarding (guided OAuth client + API key) ───────────────────────
  onboardingPlan(input: OnboardingPlanInput): OnboardingPlan {
    return buildWs1GuidedPlan(this.config, input);
  }

  async onboardingStatus(): Promise<OnboardingStatus> {
    const base = { providerId: this.id, displayName: this.displayName };
    if (!hasWs1Config(this.config)) {
      return { ...base, configured: false, onboarded: false, details: "Workspace ONE UEM API credentials not configured yet." };
    }
    try {
      await this.gw.searchDevices({ pageSize: 1 });
      return { ...base, configured: true, onboarded: true, details: "Verified: searched Workspace ONE UEM devices." };
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
