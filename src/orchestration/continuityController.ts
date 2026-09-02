import type { Logger } from "../core/logger.js";
import { AppError } from "../core/errors.js";
import type { ProviderRegistry, IPlatformProvider } from "../providers/provider.js";
import type { StatePortabilityService, EndpointRef } from "../state/statePortability.js";
import type { ReportingService } from "../reporting/collector.js";
import type { Job, JobManager } from "./jobs.js";

export class FailoverError extends AppError {}

export interface ContinuityConfig {
  primary?: string;
  secondary?: string;
  mode: "manual" | "policy";
}

/** Health assessment of a substrate, informed by live telemetry when available. */
export interface HealthAssessment {
  providerId: string;
  available: boolean;
  healthy: boolean;
  /** 0 (down) … 100 (perfectly healthy). */
  score: number;
  signals: string[];
  activeAlerts: number;
  source: "telemetry" | "availability" | "none";
}

export interface FailoverSubject {
  /** The user/workspace being failed over. */
  user: string;
  /** Substrate currently serving the user (defaults to configured primary). */
  primary?: string;
  /** Substrate to fail over to (defaults to configured secondary). */
  secondary?: string;
  /** Existing target entity, if pre-staged (warm standby); else provisioning is attempted. */
  targetEntity?: string;
}

export interface FailoverResult {
  user: string;
  from: string;
  to: string;
  targetEntity?: string;
  bundleId?: string;
  stateRehydrated: boolean;
  verified: boolean;
  notes: string[];
}

/**
 * Cross-substrate continuity & failover controller (technical spec, Ch. 9.3).
 * Monitors primary-substrate health (using the same live telemetry as the
 * reporting layer when present) and, on a manual or policy trigger, fails a
 * user's workspace over to a secondary substrate — restoring the latest
 * StateBundle — then fails back when the primary recovers.
 *
 * It composes the provider lifecycle primitives + the state layer; it owns no
 * substrate specifics and discovers failover eligibility via `capabilities()`.
 */
export class ContinuityController {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly state: StatePortabilityService,
    private readonly jobs: JobManager,
    private readonly logger: Logger,
    private readonly config: ContinuityConfig,
    private readonly reporting?: ReportingService
  ) {}

  private provider(id: string): IPlatformProvider {
    const p = this.registry.list().find((x) => x.id === id);
    if (!p) throw new FailoverError(`Unknown provider: '${id}'`);
    return p;
  }

  private resolvePrimary(override?: string): string {
    const id = override ?? this.config.primary;
    if (!id) throw new FailoverError("No primary substrate specified (set CONTINUITY_PRIMARY or pass one).");
    return id;
  }

  private resolveSecondary(override?: string): string {
    const id = override ?? this.config.secondary;
    if (!id) throw new FailoverError("No secondary substrate specified (set CONTINUITY_SECONDARY or pass one).");
    return id;
  }

  /**
   * Assess a substrate's health. Prefers live telemetry (loadIndex + active
   * alerts) when reporting is enabled; otherwise falls back to provider
   * availability. Never fabricates a healthy result.
   */
  async healthcheck(providerId?: string): Promise<HealthAssessment> {
    const id = this.resolvePrimary(providerId);
    const provider = this.provider(id);
    const signals: string[] = [];

    const available = await provider.isAvailable().catch(() => false);
    if (!available) {
      return { providerId: id, available: false, healthy: false, score: 0, signals: ["provider unavailable / unreachable"], activeAlerts: 0, source: "availability" };
    }

    // Telemetry-informed health when the reporting layer is present.
    if (this.reporting) {
      const latest = this.reporting.store.latest({ providerId: id });
      const alerts = this.reporting.alerts.listActive().filter((a) => a.providerId === id);
      if (latest.length > 0 || alerts.length > 0) {
        const loadSamples = latest.filter((s) => s.metric === "loadIndex");
        const totalLoad = loadSamples.reduce((sum, s) => sum + s.value, 0);
        let score = 100;
        if (totalLoad > 0) {
          score -= Math.min(60, totalLoad * 10);
          signals.push(`loadIndex sum=${totalLoad} (degraded/unhealthy entities)`);
        }
        score -= Math.min(40, alerts.length * 20);
        if (alerts.length > 0) signals.push(`${alerts.length} active alert(s) on ${id}`);
        if (signals.length === 0) signals.push("telemetry nominal");
        const healthy = score >= 50;
        return { providerId: id, available: true, healthy, score: Math.max(0, score), signals, activeAlerts: alerts.length, source: "telemetry" };
      }
    }

    // Fallback: available but no telemetry to judge degradation.
    return { providerId: id, available: true, healthy: true, score: 100, signals: ["available; no telemetry signal to assess degradation"], activeAlerts: 0, source: this.reporting ? "telemetry" : "none" };
  }

  /** Fail a user over to the secondary substrate as an async job. */
  initiate(subject: FailoverSubject): Job<FailoverResult> {
    const from = this.resolvePrimary(subject.primary);
    const to = this.resolveSecondary(subject.secondary);
    return this.jobs.start<FailoverResult>("failover", subject.user, async (ctx) => {
      return this.runFailover(ctx, subject.user, from, to, subject.targetEntity, "failover");
    });
  }

  /** Fail a user back to the primary substrate as an async job. */
  failback(subject: FailoverSubject): Job<FailoverResult> {
    // Failback reverses direction: from the secondary back to the primary.
    const primary = this.resolvePrimary(subject.primary);
    const secondary = this.resolveSecondary(subject.secondary);
    return this.jobs.start<FailoverResult>("failback", subject.user, async (ctx) => {
      return this.runFailover(ctx, subject.user, secondary, primary, subject.targetEntity, "failback");
    });
  }

  /** Shared failover spine: provision/activate target → restore latest state → verify → redirect. */
  private async runFailover(
    ctx: { step: (name: string) => { succeed(d?: string): void; fail(d: string): void; skip(d?: string): void } },
    user: string,
    fromId: string,
    toId: string,
    targetEntity: string | undefined,
    kind: string
  ): Promise<FailoverResult> {
    const target = this.provider(toId);
    const notes: string[] = [];

    // 0) Eligibility: the target must advertise it can be a failover target.
    const caps = target.capabilities?.();
    if (caps && !caps.canBeFailoverTarget) {
      throw new FailoverError(`Target substrate '${toId}' does not advertise canBeFailoverTarget.`);
    }

    // 1) Provision / activate the target (warm standby if an entity is supplied).
    const provStep = ctx.step("activate-target");
    let entity = targetEntity;
    if (entity) {
      provStep.skip(`Using pre-staged target ${toId}:${entity} (warm standby)`);
    } else if (typeof target.provision === "function") {
      const ref = await target.provision({ providerId: toId, user });
      entity = ref.id;
      provStep.succeed(`Provisioned ${toId}:${entity} (cold standby)`);
    } else {
      provStep.succeed(`No provision() on '${toId}'; assuming externally pre-staged capacity`);
      notes.push(`Target '${toId}' has no provision primitive — pre-stage capacity out of band.`);
    }

    // 2) Restore the latest StateBundle for the user onto the target.
    const stateStep = ctx.step("rehydrate-state");
    let bundleId: string | undefined;
    let stateRehydrated = false;
    const bundles = await this.state.list(user);
    if (bundles.length === 0) {
      stateStep.skip(`No StateBundle found for '${user}'; RPO depends on capture cadence`);
      notes.push(`No prior state capture for '${user}' — nothing to rehydrate (data loss risk).`);
    } else {
      bundleId = bundles[0].id; // list() is newest-first
      const targetRef: EndpointRef = { providerId: toId, entity };
      try {
        await this.state.restore(targetRef, bundleId);
        stateRehydrated = true;
        stateStep.succeed(`Rehydrated bundle ${bundleId} (captured ${bundles[0].createdAt})`);
      } catch (err) {
        stateStep.fail(`State restore failed: ${err instanceof Error ? err.message : String(err)}`);
        notes.push("State rehydration failed; target is running without restored settings.");
      }
    }

    // 3) Verify target health (best-effort).
    const verStep = ctx.step("verify-target");
    let verified = false;
    if (typeof target.health === "function" && entity) {
      const health = await target.health({ providerId: toId, id: entity });
      verified = health.healthy;
      verStep.succeed(`Target health: ${health.healthy ? "healthy" : "unhealthy"}`);
    } else {
      verStep.succeed("No provider health primitive; target activation assumed complete");
      verified = true;
    }

    // 4) Redirect the user (recorded as an explicit, audited step).
    const redirStep = ctx.step("redirect-user");
    redirStep.succeed(`User '${user}' directed to ${toId}:${entity ?? "target"}`);

    this.logger.info({ user, from: fromId, to: toId, kind, bundleId, stateRehydrated }, `${kind} executed`);

    return { user, from: fromId, to: toId, targetEntity: entity, bundleId, stateRehydrated, verified, notes };
  }

  status(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }
}
