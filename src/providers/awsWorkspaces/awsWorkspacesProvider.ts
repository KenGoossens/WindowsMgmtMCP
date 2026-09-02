import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { ToolContext } from "../../core/tools.js";
import type {
  IPlatformProvider,
  MetricSample,
  ProviderCapabilities,
  EndpointRef,
  HealthStatus,
  ProvisionSpec
} from "../provider.js";
import { makeSample } from "../../reporting/metrics.js";
import type { OnboardingCapable, OnboardingPlan, OnboardingPlanInput, OnboardingStatus } from "../../onboarding/types.js";
import { buildAwsGuidedPlan } from "../../onboarding/plans.js";
import { WorkSpacesGateway, hasAwsConfig } from "./workspacesClient.js";
import { registerWorkspacesTools } from "./tools.js";

/** WorkSpace states considered unhealthy for the normalized load signal. */
const UNHEALTHY_STATES = new Set(["ERROR", "IMPAIRED", "UNHEALTHY", "FAILED"]);

/**
 * AWS WorkSpaces management (cloud DaaS). Beyond day-to-day fleet operations,
 * its strategic role is as a cross-cloud failover target for the later
 * continuity phase. Available whenever an AWS region is configured.
 */
export class AwsWorkspacesProvider implements IPlatformProvider, OnboardingCapable {
  readonly id = "awsworkspaces";
  readonly displayName = "AWS WorkSpaces";

  private readonly gw: WorkSpacesGateway;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.gw = new WorkSpacesGateway(config);
  }

  async isAvailable(): Promise<boolean> {
    return hasAwsConfig(this.config);
  }

  registerTools(server: McpServer, ctx: ToolContext): void {
    registerWorkspacesTools(server, ctx, this.gw);
  }

  async dispose(): Promise<void> {
    this.gw.destroy();
  }

  capabilities(): ProviderCapabilities {
    return {
      substrate: "daas",
      operations: ["PROVISION", "RESTORE_KNOWN_GOOD", "RESIZE", "POWER", "REPAIR_OS"],
      canBeMigrationSource: false,
      canBeMigrationTarget: true,
      canBeFailoverTarget: true,
      telemetry: { metrics: ["sessionCount", "loadIndex"], events: ["stateTransition", "lifecycle"], live: true }
    };
  }

  /**
   * Fleet-level WorkSpaces telemetry. `sessionCount` reflects real connected user
   * sessions (DescribeWorkspacesConnectionStatus) for consistency with the VDI
   * providers; if connection status is unavailable it falls back to fleet size.
   * `loadIndex` is the count of WorkSpaces in an unhealthy state.
   */
  async getMetrics(): Promise<MetricSample[]> {
    const items = await this.gw.describe();
    const total = items.length;
    const unhealthy = items.filter((w) => UNHEALTHY_STATES.has((w.State ?? "").toUpperCase())).length;
    let connected = total;
    try {
      const conns = await this.gw.connectionStatus();
      connected = conns.filter((c) => (c.ConnectionState ?? "").toUpperCase() === "CONNECTED").length;
    } catch (err) {
      this.logger.debug({ err }, "workspaces connection status unavailable; using fleet size for sessionCount");
    }
    const common = {
      providerId: this.id,
      substrate: "daas" as const,
      entity: this.config.awsRegion ?? this.id,
      entityType: "substrate" as const
    };
    return [
      makeSample({ ...common, metric: "sessionCount", value: connected, unit: "count" }),
      makeSample({ ...common, metric: "loadIndex", value: unhealthy, unit: "count" })
    ];
  }

  /**
   * Provision a new WorkSpace as a migration/failover target. Maps the generic
   * spec to CreateWorkspaces: `user` -> directory user, `sku`/`bundleId` -> bundle,
   * directory id from the spec or the configured default.
   */
  async provision(spec: ProvisionSpec): Promise<EndpointRef> {
    const directoryId = (spec.directoryId as string | undefined) ?? this.config.awsWorkspacesDirectoryId;
    const bundleId = (spec.bundleId as string | undefined) ?? spec.sku;
    const userName = (spec.user as string | undefined) ?? (spec.userName as string | undefined);
    if (!directoryId || !bundleId || !userName) {
      throw new Error(
        "AWS WorkSpaces provision requires a directory id (spec.directoryId or AWS_WORKSPACES_DIRECTORY_ID), a bundle id (spec.bundleId or spec.sku), and a user (spec.user)."
      );
    }
    const { pending, failed } = await this.gw.create({ DirectoryId: directoryId, UserName: userName, BundleId: bundleId });
    if (failed.length > 0 || pending.length === 0) {
      throw new Error(`AWS WorkSpaces provision failed: ${failed[0]?.ErrorCode ?? "unknown"} ${failed[0]?.ErrorMessage ?? ""}`.trim());
    }
    return { providerId: this.id, id: pending[0].WorkspaceId ?? "" };
  }

  /** Report whether a specific WorkSpace is AVAILABLE (drives failover verify-target). */
  async health(ref: EndpointRef): Promise<HealthStatus> {
    const items = await this.gw.describe({ workspaceId: ref.id });
    if (items.length === 0) return { healthy: false, details: `WorkSpace not found: ${ref.id}` };
    const state = items[0].State ?? "unknown";
    return { healthy: state.toUpperCase() === "AVAILABLE", details: `state=${state}` };
  }

  // ── Onboarding (guided IAM) ───────────────────────────────────────────
  onboardingPlan(input: OnboardingPlanInput): OnboardingPlan {
    return buildAwsGuidedPlan(this.config, input);
  }

  async onboardingStatus(): Promise<OnboardingStatus> {
    const base = { providerId: this.id, displayName: this.displayName };
    if (!hasAwsConfig(this.config)) {
      return { ...base, configured: false, onboarded: false, details: "AWS region/credentials not configured yet." };
    }
    try {
      await this.gw.describe({ limit: 1 });
      return { ...base, configured: true, onboarded: true, details: "Verified: DescribeWorkspaces succeeded." };
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
