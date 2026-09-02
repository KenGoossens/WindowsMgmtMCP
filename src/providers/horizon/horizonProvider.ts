import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { ToolContext } from "../../core/tools.js";
import type {
  IPlatformProvider,
  MetricSample,
  ProviderCapabilities,
  GroupingRef,
  ImageSpec,
  JobRef
} from "../provider.js";
import { makeSample } from "../../reporting/metrics.js";
import type { OnboardingCapable, OnboardingPlan, OnboardingPlanInput, OnboardingStatus } from "../../onboarding/types.js";
import { buildHorizonManualPlan } from "../../onboarding/plans.js";
import { HorizonGateway, hasHorizonConfig } from "./horizonClient.js";
import { registerHorizonTools } from "./tools.js";

/** Horizon machine states considered available/healthy. */
const AVAILABLE_STATES = new Set(["AVAILABLE", "CONNECTED", "PROVISIONED"]);

/**
 * Omnissa Horizon (formerly VMware Horizon) management via the Horizon Server
 * REST API: desktop pools, RDS farms, machines (with maintenance), and live
 * session control. Available when a Connection Server + credentials are set.
 */
export class HorizonProvider implements IPlatformProvider, OnboardingCapable {
  readonly id = "horizon";
  readonly displayName = "Omnissa Horizon";

  private readonly gw: HorizonGateway;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.gw = new HorizonGateway(config);
  }

  async isAvailable(): Promise<boolean> {
    return hasHorizonConfig(this.config);
  }

  registerTools(server: McpServer, ctx: ToolContext): void {
    registerHorizonTools(server, ctx, this.gw);
  }

  capabilities(): ProviderCapabilities {
    return {
      substrate: "vdi",
      operations: ["SESSION_CONTROL", "MAINTENANCE", "IMAGE_ROLLOUT"],
      canBeMigrationSource: true,
      canBeMigrationTarget: false,
      canBeFailoverTarget: true,
      telemetry: { metrics: ["sessionCount", "loadIndex"], events: ["stateTransition"], live: true }
    };
  }

  /**
   * Estate-level telemetry: total sessions and count of unavailable machines,
   * plus a best-effort infrastructure load signal (unhealthy connection servers
   * / gateways) when the Monitor API is reachable.
   */
  async getMetrics(): Promise<MetricSample[]> {
    const [sessions, machines] = await Promise.all([this.gw.listSessions(), this.gw.listMachines()]);
    const unavailable = machines.filter((m) => !AVAILABLE_STATES.has((m.state ?? "").toUpperCase())).length;
    const common = {
      providerId: this.id,
      substrate: "vdi" as const,
      entity: this.id,
      entityType: "substrate" as const
    };
    const samples = [
      makeSample({ ...common, metric: "sessionCount", value: sessions.length, unit: "count" }),
      makeSample({ ...common, metric: "loadIndex", value: unavailable, unit: "count" })
    ];
    try {
      const health = await this.gw.monitorHealth();
      const components = [...health.connectionServers, ...health.gateways];
      if (components.length > 0) {
        const unhealthy = components.filter((c) => (c.status ?? "").toUpperCase() !== "OK").length;
        samples.push(
          makeSample({
            providerId: this.id,
            substrate: "vdi",
            entity: "infrastructure",
            entityType: "substrate",
            metric: "loadIndex",
            value: unhealthy,
            unit: "count"
          })
        );
      }
    } catch (err) {
      this.logger.debug({ err }, "horizon monitor health unavailable; skipping infrastructure load sample");
    }
    return samples;
  }

  /** Schedule an instant-clone image push (recompose) for a desktop pool. */
  async rolloutImage(ref: GroupingRef, image: ImageSpec): Promise<JobRef> {
    await this.gw.pushImage(ref.id, { snapshotId: image.id });
    return { jobId: `horizon-pushimage-${ref.id}` };
  }

  // ── Onboarding (manual service account) ──────────────────────────────
  onboardingPlan(input: OnboardingPlanInput): OnboardingPlan {
    return buildHorizonManualPlan(this.config, input);
  }

  async onboardingStatus(): Promise<OnboardingStatus> {
    const base = { providerId: this.id, displayName: this.displayName };
    if (!hasHorizonConfig(this.config)) {
      return { ...base, configured: false, onboarded: false, details: "Horizon Connection Server credentials not configured yet." };
    }
    try {
      await this.gw.listPools();
      return { ...base, configured: true, onboarded: true, details: "Verified: logged in and listed Horizon desktop pools." };
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
