import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { ToolContext } from "../../core/tools.js";
import type { IPlatformProvider, MetricSample, ProviderCapabilities } from "../provider.js";
import { makeSample } from "../../reporting/metrics.js";
import type { OnboardingCapable, OnboardingPlan, OnboardingPlanInput, OnboardingStatus } from "../../onboarding/types.js";
import { buildHorizonCloudPlan } from "../../onboarding/plans.js";
import { HorizonCloudGateway, hasHorizonCloudConfig } from "./cloudClient.js";
import { registerHorizonCloudTools } from "./tools.js";

/** VM lifecycle states considered healthy/ready. */
const READY_STATES = new Set(["PROVISIONED", "AVAILABLE"]);

/**
 * Omnissa Horizon Cloud Service (next-gen) — a modern, multi-cloud DaaS managed
 * through the Cloud Services Portal. Templates are the next-gen term for pools.
 * Available when a regional API base and CSP credentials (API token or OAuth app)
 * are configured.
 */
export class HorizonCloudProvider implements IPlatformProvider, OnboardingCapable {
  readonly id = "horizoncloud";
  readonly displayName = "Omnissa Horizon Cloud";

  private readonly gw: HorizonCloudGateway;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.gw = new HorizonCloudGateway(config);
  }

  async isAvailable(): Promise<boolean> {
    return hasHorizonCloudConfig(this.config);
  }

  registerTools(server: McpServer, ctx: ToolContext): void {
    registerHorizonCloudTools(server, ctx, this.gw);
  }

  capabilities(): ProviderCapabilities {
    return {
      substrate: "daas",
      operations: ["SESSION_CONTROL", "POWER"],
      canBeMigrationSource: true,
      canBeMigrationTarget: false,
      canBeFailoverTarget: true,
      telemetry: { metrics: ["sessionCount", "loadIndex"], events: ["stateTransition"], live: true }
    };
  }

  /**
   * Per-template (pool) telemetry: sessionCount approximates capacity as the sum
   * of ready VMs, and loadIndex counts VMs not in a ready lifecycle state.
   */
  async getMetrics(): Promise<MetricSample[]> {
    const templates = await this.gw.listTemplates();
    const samples: MetricSample[] = [];
    for (const t of templates) {
      if (!t.id) continue;
      let vms: Awaited<ReturnType<HorizonCloudGateway["listVms"]>> = [];
      try {
        vms = await this.gw.listVms(t.id);
      } catch (err) {
        this.logger.debug({ err, templateId: t.id }, "horizon cloud: listVms failed; skipping template in metrics");
        continue;
      }
      const ready = vms.filter((v) => READY_STATES.has((v.lifecycleStatus ?? "").toUpperCase())).length;
      const notReady = vms.length - ready;
      const common = {
        providerId: this.id,
        substrate: "daas" as const,
        entity: t.name ?? t.id,
        entityType: "grouping" as const
      };
      samples.push(
        makeSample({ ...common, metric: "sessionCount", value: ready, unit: "count" }),
        makeSample({ ...common, metric: "loadIndex", value: notReady, unit: "count" })
      );
    }
    return samples;
  }

  // ── Onboarding (guided CSP token / OAuth app) ────────────────────────
  onboardingPlan(input: OnboardingPlanInput): OnboardingPlan {
    return buildHorizonCloudPlan(this.config, input);
  }

  async onboardingStatus(): Promise<OnboardingStatus> {
    const base = { providerId: this.id, displayName: this.displayName };
    if (!hasHorizonCloudConfig(this.config)) {
      return { ...base, configured: false, onboarded: false, details: "Horizon Cloud CSP credentials not configured yet." };
    }
    try {
      await this.gw.listTemplates();
      return { ...base, configured: true, onboarded: true, details: "Verified: listed Horizon Cloud templates." };
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
