import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import type { ToolContext } from "../../core/tools.js";
import { PowerShellEngine, detectPowerShell } from "../../core/powershell.js";
import { PowerShellError, PowerShellTimeoutError } from "../../core/errors.js";
import type { IPlatformProvider, MetricSample, ProviderCapabilities } from "../provider.js";
import { makeSample } from "../../reporting/metrics.js";
import { HOST_METRICS_SCRIPT, type HostMetrics } from "../windowsScripts.js";
import { buildCaptureScript, buildRestoreScript, type RawCapture } from "../../state/capture.js";
import type { StateScope } from "../../state/bundle.js";
import type { SettingsCapable } from "../../state/settingsCapable.js";
import { loadRemoteTargets, type RemoteTarget } from "./targets.js";
import type { RemoteExecResult, RemoteExecutor } from "./executor.js";
import { WinRmExecutor } from "./winrm.js";
import { SshExecutor } from "./ssh.js";
import { registerRemoteTools } from "./tools.js";

/**
 * Remote Windows management over WinRM (via local PowerShell Remoting) and SSH
 * (via ssh2), selectable per target. Targets are declared in configuration; the
 * provider is unavailable when none are configured.
 */
export class RemoteWindowsProvider implements IPlatformProvider, SettingsCapable {
  readonly id = "remoteWindows";
  readonly displayName = "Remote Windows";

  private readonly ps: PowerShellEngine;
  private readonly targets: RemoteTarget[];
  private readonly byId = new Map<string, RemoteTarget>();
  private readonly defaultTimeoutMs: number;

  constructor(config: AppConfig, private readonly logger: Logger) {
    this.defaultTimeoutMs = config.remoteDefaultTimeoutMs;
    this.ps = new PowerShellEngine(detectPowerShell(config.psExecutable), config.remoteDefaultTimeoutMs, logger);
    try {
      this.targets = loadRemoteTargets({
        inlineJson: config.remoteTargets,
        filePath: config.remoteTargetsPath
      });
    } catch (err) {
      logger.error({ err }, "failed to load remote targets; remote provider disabled");
      this.targets = [];
    }
    for (const t of this.targets) this.byId.set(t.id, t);
  }

  async isAvailable(): Promise<boolean> {
    return this.targets.length > 0;
  }

  listTargets(): RemoteTarget[] {
    return this.targets;
  }

  getTarget(id: string): RemoteTarget | undefined {
    return this.byId.get(id);
  }

  get timeoutMs(): number {
    return this.defaultTimeoutMs;
  }

  /** Build the right executor for a target's connection method. */
  executorFor(target: RemoteTarget): RemoteExecutor {
    return target.method === "winrm"
      ? new WinRmExecutor(this.ps, target)
      : new SshExecutor(target, this.logger);
  }

  /** Run a script on a target and parse its JSON output. */
  async runJson<T = unknown>(target: RemoteTarget, script: string, timeoutMs?: number): Promise<T> {
    const res = await this.executorFor(target).exec(script, timeoutMs ?? this.defaultTimeoutMs);
    return this.parseJson<T>(res, target.id);
  }

  /** Run a script on a target and return the raw execution result. */
  async runRaw(target: RemoteTarget, script: string, timeoutMs?: number): Promise<RemoteExecResult> {
    return this.executorFor(target).exec(script, timeoutMs ?? this.defaultTimeoutMs);
  }

  private parseJson<T>(res: RemoteExecResult, targetId: string): T {
    if (res.timedOut) {
      throw new PowerShellTimeoutError(`Remote execution on '${targetId}' timed out`, res.stderr, res.exitCode);
    }
    const text = res.stdout.trim();
    if (res.exitCode !== 0 && !text) {
      throw new PowerShellError(
        `Remote execution on '${targetId}' failed (exit ${res.exitCode})`,
        res.stderr.trim(),
        res.exitCode
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PowerShellError(
        `Remote output from '${targetId}' was not valid JSON`,
        (res.stderr || text).slice(0, 4000),
        res.exitCode
      );
    }
  }

  registerTools(server: McpServer, ctx: ToolContext): void {
    registerRemoteTools(server, ctx, this);
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

  /** Live CPU / memory / disk per reachable target, as normalized samples. */
  async getMetrics(): Promise<MetricSample[]> {
    const perTargetTimeout = Math.min(this.defaultTimeoutMs, 30_000);
    const results = await Promise.allSettled(
      this.targets.map(async (t) => {
        const data = await this.runJson<HostMetrics>(t, HOST_METRICS_SCRIPT, perTargetTimeout);
        const common = {
          providerId: this.id,
          substrate: "physical" as const,
          entity: t.id,
          entityType: "machine" as const
        };
        return [
          makeSample({ ...common, metric: "cpu", value: Number(data?.cpu ?? 0) }),
          makeSample({ ...common, metric: "memory", value: Number(data?.memory ?? 0) }),
          makeSample({ ...common, metric: "disk", value: Number(data?.disk ?? 0) })
        ];
      })
    );
    const samples: MetricSample[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") samples.push(...r.value);
    }
    return samples;
  }

  // ── State & settings portability (SettingsCapable) ────────────────────────
  async captureSettings(scope: StateScope, entity?: string): Promise<{ entity: string; raw: RawCapture }> {
    const target = this.requireTarget(entity);
    const raw = await this.runJson<RawCapture>(target, buildCaptureScript(scope), Math.min(this.defaultTimeoutMs, 90_000));
    return { entity: target.id, raw: raw ?? {} };
  }

  async restoreSettings(data: Record<string, unknown>, entity?: string): Promise<Record<string, unknown>> {
    const target = this.requireTarget(entity);
    const outcome = await this.runJson<Record<string, unknown>>(target, buildRestoreScript(data), this.defaultTimeoutMs);
    return outcome ?? {};
  }

  private requireTarget(entity?: string): RemoteTarget {
    if (!entity) throw new Error("Remote settings capture/restore requires a target id (the endpoint entity).");
    const target = this.getTarget(entity);
    if (!target) throw new Error(`Unknown remote target: '${entity}'`);
    return target;
  }
}
