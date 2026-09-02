import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../core/logger.js";
import type { ToolContext } from "../core/tools.js";

/**
 * The single contract every managed substrate implements. The MVP requires only
 * the base members; the optional members form the forward-looking contract that
 * the orchestration (migration / failover / state) and reporting layers discover
 * at runtime via {@link IPlatformProvider.capabilities} (technical spec, Ch. 8).
 */
export interface IPlatformProvider {
  readonly id: string;
  readonly displayName: string;

  /** Are the credentials / environment for this provider present? */
  isAvailable(): Promise<boolean>;

  /** Contribute this provider's tools to the server. */
  registerTools(server: McpServer, ctx: ToolContext): void;

  /** Release any resources held by the provider. */
  dispose?(): Promise<void>;

  /** Declare which normalized operations and telemetry this substrate supports. */
  capabilities?(): ProviderCapabilities;

  // ── Lifecycle primitives (migration / failover) ──────────────────────────
  provision?(spec: ProvisionSpec): Promise<EndpointRef>;
  health?(ref: EndpointRef): Promise<HealthStatus>;

  // ── Substrate-agnostic user/app/settings state ───────────────────────────
  captureState?(ref: EndpointRef, scope: StateScope): Promise<StateBundleRef>;
  restoreState?(ref: EndpointRef, bundle: StateBundleRef): Promise<RestoreResult>;

  // ── Full VDI / DaaS management ────────────────────────────────────────────
  listGroupings?(): Promise<Grouping[]>;
  listMachines?(filter?: MachineFilter): Promise<Machine[]>;
  listSessions?(filter?: SessionFilter): Promise<Session[]>;
  controlSession?(ref: SessionRef, action: SessionAction): Promise<OpResult>;
  powerMachine?(ref: MachineRef, action: PowerAction): Promise<OpResult>;
  setMaintenance?(ref: MachineRef, on: boolean): Promise<OpResult>;
  rolloutImage?(ref: GroupingRef, image: ImageSpec): Promise<JobRef>;
  assignUser?(ref: GroupingRef, user: UserRef, on: boolean): Promise<OpResult>;

  // ── Real-time telemetry (reporting layer) ─────────────────────────────────
  getMetrics?(scope?: MetricScope): Promise<MetricSample[]>;
  streamTelemetry?(sink: TelemetrySink, scope?: MetricScope): Promise<Subscription>;
}

export type Substrate = "physical" | "vdi" | "daas" | "cloud" | "device";

export type NormalizedOp =
  | "PROVISION"
  | "RESTORE_KNOWN_GOOD"
  | "REPAIR_OS"
  | "RESIZE"
  | "CAPTURE_STATE"
  | "RESTORE_STATE"
  | "SESSION_CONTROL"
  | "POWER"
  | "MAINTENANCE"
  | "IMAGE_ROLLOUT"
  | "MIGRATE_TO"
  | "FAILOVER_TO";

export type MetricKind =
  | "cpu"
  | "memory"
  | "disk"
  | "gpu"
  | "logonDuration"
  | "protocolLatency"
  | "sessionCount"
  | "loadIndex";

export type EventKind = "stateTransition" | "error" | "thresholdBreach" | "lifecycle";

export interface ProviderCapabilities {
  substrate: Substrate;
  operations: NormalizedOp[];
  canBeMigrationSource: boolean;
  canBeMigrationTarget: boolean;
  canBeFailoverTarget: boolean;
  telemetry?: { metrics: MetricKind[]; events: EventKind[]; live: boolean };
}

// ── Lightweight supporting types (fleshed out in later phases) ──────────────
export interface EndpointRef {
  providerId: string;
  id: string;
}
export interface ProvisionSpec {
  providerId: string;
  sku?: string;
  region?: string;
  user?: string;
  [key: string]: unknown;
}
export interface HealthStatus {
  healthy: boolean;
  details?: string;
}
export interface StateScope {
  userData?: boolean;
  appSettings?: boolean;
  osSettings?: boolean;
}
export interface StateBundleRef {
  id: string;
  fidelity: "full" | "partial" | "referenced";
}
export interface RestoreResult {
  success: boolean;
  details?: string;
}
export interface Grouping {
  id: string;
  name: string;
  kind: string;
}
export type MachineFilter = Record<string, unknown>;
export interface Machine {
  id: string;
  name: string;
  state?: string;
}
export type SessionFilter = Record<string, unknown>;
export interface Session {
  id: string;
  user?: string;
  state?: string;
}
export interface SessionRef {
  id: string;
}
export interface MachineRef {
  id: string;
}
export interface GroupingRef {
  id: string;
}
export type SessionAction = "disconnect" | "logoff" | "message" | "shadow" | "reset";
export type PowerAction = "start" | "stop" | "restart" | "suspend" | "resume";
export interface ImageSpec {
  id: string;
}
export interface JobRef {
  jobId: string;
}
export interface UserRef {
  id: string;
}
export interface OpResult {
  success: boolean;
  details?: string;
}
export type MetricScope = Record<string, unknown>;
export type EntityType = "substrate" | "grouping" | "machine" | "session" | "user";
/** A single normalized telemetry reading from a provider's estate. */
export interface MetricSample {
  providerId: string;
  substrate: Substrate;
  entityType: EntityType;
  /** Stable identifier of the entity the reading is about. */
  entity: string;
  metric: MetricKind;
  value: number;
  unit?: string;
  /** ISO-8601 timestamp. */
  ts: string;
}
/** A normalized telemetry event (state transition, error, lifecycle, breach). */
export interface TelemetryEvent {
  providerId: string;
  substrate: Substrate;
  kind: EventKind;
  entity: string;
  message: string;
  ts: string;
  data?: Record<string, unknown>;
}
export interface TelemetrySink {
  push(samples: MetricSample[]): void;
}
export interface Subscription {
  close(): void;
}

/**
 * Aggregates providers and registers the tools of those that are available.
 * Adding a platform is: implement {@link IPlatformProvider}, register it here.
 */
export class ProviderRegistry {
  private readonly providers: IPlatformProvider[] = [];

  constructor(private readonly logger: Logger) {}

  register(provider: IPlatformProvider): this {
    this.providers.push(provider);
    return this;
  }

  list(): readonly IPlatformProvider[] {
    return this.providers;
  }

  /** Register tools for every available provider. Returns which were on/off. */
  async registerAvailable(
    server: McpServer,
    ctx: ToolContext
  ): Promise<{ registered: string[]; skipped: string[] }> {
    const registered: string[] = [];
    const skipped: string[] = [];
    for (const provider of this.providers) {
      try {
        if (await provider.isAvailable()) {
          provider.registerTools(server, ctx);
          registered.push(provider.id);
          this.logger.info({ provider: provider.id }, "provider registered");
        } else {
          skipped.push(provider.id);
          this.logger.warn({ provider: provider.id }, "provider unavailable; skipped");
        }
      } catch (err) {
        skipped.push(provider.id);
        this.logger.error({ err, provider: provider.id }, "provider failed to register");
      }
    }
    return { registered, skipped };
  }

  async disposeAll(): Promise<void> {
    for (const provider of this.providers) {
      try {
        await provider.dispose?.();
      } catch (err) {
        this.logger.warn({ err, provider: provider.id }, "provider dispose failed");
      }
    }
  }
}
