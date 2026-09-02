import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { ToolContext } from "../../core/tools.js";
import type { IPlatformProvider, MetricSample, ProviderCapabilities } from "../provider.js";
import { makeSample } from "../../reporting/metrics.js";
import type { AlertSink } from "../../reporting/collector.js";
import type { OnboardingCapable, OnboardingPlan, OnboardingPlanInput, OnboardingStatus } from "../../onboarding/types.js";
import { buildCitrixGuidedPlan } from "../../onboarding/plans.js";
import { CitrixGateway, hasCitrixConfig } from "./citrixClient.js";
import { registerCitrixTools } from "./tools.js";

/**
 * Citrix DaaS (Virtual Apps & Desktops) management via the Citrix DaaS REST APIs:
 * delivery groups, machine catalogs, machine power/maintenance, and live session
 * control. Available when Citrix Cloud API credentials are configured.
 */
export class CitrixProvider implements IPlatformProvider, OnboardingCapable {
  readonly id = "citrix";
  readonly displayName = "Citrix DaaS";

  private readonly gw: CitrixGateway;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.gw = new CitrixGateway(config);
  }

  async isAvailable(): Promise<boolean> {
    return hasCitrixConfig(this.config);
  }

  registerTools(server: McpServer, ctx: ToolContext): void {
    registerCitrixTools(server, ctx, this.gw);
  }

  capabilities(): ProviderCapabilities {
    return {
      substrate: "daas",
      operations: ["SESSION_CONTROL", "POWER", "MAINTENANCE"],
      canBeMigrationSource: true,
      canBeMigrationTarget: false,
      canBeFailoverTarget: true,
      telemetry: { metrics: ["sessionCount", "loadIndex"], events: ["stateTransition"], live: true }
    };
  }

  /**
   * Per-delivery-group telemetry: sessionCount (sum of machine session counts)
   * and loadIndex (count of unregistered machines) across the estate.
   */
  async getMetrics(): Promise<MetricSample[]> {
    const machines = await this.gw.listMachines();
    const byGroup = new Map<string, { sessions: number; unregistered: number }>();
    for (const m of machines) {
      const group = m.DeliveryGroup?.Name ?? "ungrouped";
      const agg = byGroup.get(group) ?? { sessions: 0, unregistered: 0 };
      agg.sessions += m.SessionCount ?? 0;
      if ((m.RegistrationState ?? "").toLowerCase() !== "registered") agg.unregistered += 1;
      byGroup.set(group, agg);
    }
    const samples: MetricSample[] = [];
    for (const [group, agg] of byGroup) {
      const common = {
        providerId: this.id,
        substrate: "daas" as const,
        entity: group,
        entityType: "grouping" as const
      };
      samples.push(
        makeSample({ ...common, metric: "sessionCount", value: agg.sessions, unit: "count" }),
        makeSample({ ...common, metric: "loadIndex", value: agg.unregistered, unit: "count" })
      );
    }
    return samples;
  }

  /**
   * An outbound alert sink that forwards newly-fired telemetry alerts to the
   * Citrix Cloud Notifications API so they surface in the admin console.
   * Wired by the bootstrap only when CITRIX_NOTIFICATIONS_ENABLED is set.
   */
  createAlertSink(): AlertSink {
    return {
      id: "citrix-notifications",
      onAlerts: async (alerts) => {
        for (const a of alerts) {
          await this.gw.sendNotification({
            title: `WindowsMCP alert: ${a.metric} ${a.condition} ${a.threshold}`,
            description:
              `Provider ${a.providerId} / ${a.entity}: ${a.metric} is ${a.value} ` +
              `(threshold ${a.condition} ${a.threshold}). Fired ${a.firedAt}.`,
            severity: "Warning"
          });
        }
      }
    };
  }

  // ── Onboarding (guided Secure Client) ────────────────────────────────
  onboardingPlan(input: OnboardingPlanInput): OnboardingPlan {
    return buildCitrixGuidedPlan(this.config, input);
  }

  async onboardingStatus(): Promise<OnboardingStatus> {
    const base = { providerId: this.id, displayName: this.displayName };
    if (!hasCitrixConfig(this.config)) {
      return { ...base, configured: false, onboarded: false, details: "Citrix Cloud API credentials not configured yet." };
    }
    try {
      await this.gw.listDeliveryGroups();
      return { ...base, configured: true, onboarded: true, details: "Verified: listed Citrix delivery groups." };
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
