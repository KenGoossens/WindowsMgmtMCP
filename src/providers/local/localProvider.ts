import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { ToolContext } from "../../core/tools.js";
import { PowerShellEngine, detectPowerShell } from "../../core/powershell.js";
import type { IPlatformProvider, MetricSample, ProviderCapabilities } from "../provider.js";
import { makeSample } from "../../reporting/metrics.js";
import { HOST_METRICS_SCRIPT, type HostMetrics } from "../windowsScripts.js";
import { buildCaptureScript, buildRestoreScript, type RawCapture } from "../../state/capture.js";
import type { StateScope } from "../../state/bundle.js";
import type { SettingsCapable } from "../../state/settingsCapable.js";
import { registerLocalTools } from "./tools.js";

/**
 * Local / host Windows management via the PowerShell engine.
 */
export class LocalProvider implements IPlatformProvider, SettingsCapable {
  readonly id = "local";
  readonly displayName = "Local Windows";

  private readonly ps: PowerShellEngine;

  constructor(config: AppConfig, logger: Logger) {
    const executable = detectPowerShell(config.psExecutable);
    logger.info({ executable }, "local provider using PowerShell executable");
    this.ps = new PowerShellEngine(executable, config.psDefaultTimeoutMs, logger);
  }

  async isAvailable(): Promise<boolean> {
    return process.platform === "win32";
  }

  registerTools(server: McpServer, ctx: ToolContext): void {
    registerLocalTools(server, ctx, this.ps);
  }

  capabilities(): ProviderCapabilities {
    return {
      substrate: "physical",
      operations: ["REPAIR_OS", "CAPTURE_STATE"],
      canBeMigrationSource: true,
      canBeMigrationTarget: false,
      canBeFailoverTarget: false,
      telemetry: { metrics: ["cpu", "memory", "disk"], events: ["error"], live: true }
    };
  }

  /** Live CPU / memory / disk utilisation of the host, as normalized samples. */
  async getMetrics(): Promise<MetricSample[]> {
    const data = await this.ps.runJson<HostMetrics>(HOST_METRICS_SCRIPT, { timeoutMs: 30_000 });
    const entity = process.env.COMPUTERNAME ?? "localhost";
    const common = { providerId: this.id, substrate: "physical" as const, entity, entityType: "machine" as const };
    return [
      makeSample({ ...common, metric: "cpu", value: Number(data?.cpu ?? 0) }),
      makeSample({ ...common, metric: "memory", value: Number(data?.memory ?? 0) }),
      makeSample({ ...common, metric: "disk", value: Number(data?.disk ?? 0) })
    ];
  }

  // ── State & settings portability (SettingsCapable) ────────────────────────
  async captureSettings(scope: StateScope, _entity?: string): Promise<{ entity: string; raw: RawCapture }> {
    const raw = await this.ps.runJson<RawCapture>(buildCaptureScript(scope), { timeoutMs: 90_000 });
    return { entity: process.env.COMPUTERNAME ?? "localhost", raw: raw ?? {} };
  }

  async restoreSettings(data: Record<string, unknown>, _entity?: string): Promise<Record<string, unknown>> {
    const outcome = await this.ps.runJson<Record<string, unknown>>(buildRestoreScript(data), { timeoutMs: 120_000 });
    return outcome ?? {};
  }
}
