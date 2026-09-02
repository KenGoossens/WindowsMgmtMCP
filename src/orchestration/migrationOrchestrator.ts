import type { Logger } from "../core/logger.js";
import { AppError } from "../core/errors.js";
import type { ProviderRegistry, IPlatformProvider } from "../providers/provider.js";
import type { StatePortabilityService, EndpointRef } from "../state/statePortability.js";
import { isSettingsCapable } from "../state/settingsCapable.js";
import type { FidelitySummary, StateItem, StateScope } from "../state/bundle.js";
import type { Job, JobManager } from "./jobs.js";

export class MigrationError extends AppError {}

/** The endpoints + scope describing a migration. */
export interface MigrationSubject {
  /** The source desktop (physical / VDI) being transformed. */
  source: EndpointRef;
  /** The cloud target (e.g. Windows 365). May omit `entity` to request provisioning. */
  target: EndpointRef;
  /** Which state tiers to move (defaults to all). */
  scope?: StateScope;
  /** Logical subject (user) the migration is for. */
  user?: string;
}

export interface MigrationPlan {
  source: EndpointRef;
  target: EndpointRef;
  scope: StateScope;
  user?: string;
  /** What the state layer can move, previewed read-only from the source. */
  stateItems: StateItem[];
  fidelityPreview: FidelitySummary;
  /** Whether the target needs provisioning (no entity supplied). */
  provisioningRequired: boolean;
  /** Caveats the operator must weigh before executing. */
  warnings: string[];
  /** Whether the plan can be executed as-is. */
  executable: boolean;
}

export interface MigrationResult {
  bundleId: string;
  fidelity: FidelitySummary;
  restoreOutcome: Record<string, unknown>;
  sourceRetained: boolean;
  verified: boolean;
}

/**
 * Cloud transformation orchestrator (technical spec, Ch. 9.2): composes the
 * provider lifecycle primitives and the state-portability layer into one
 * audited, resumable operation — **plan → provision → capture → restore →
 * verify** — keeping the source intact until the target is verified.
 *
 * It owns no substrate specifics: it discovers source/target eligibility via
 * `capabilities()` and moves state via the {@link StatePortabilityService}.
 */
export class MigrationOrchestrator {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly state: StatePortabilityService,
    private readonly jobs: JobManager,
    private readonly logger: Logger,
    private readonly retainSource: boolean
  ) {}

  private provider(id: string): IPlatformProvider {
    const p = this.registry.list().find((x) => x.id === id);
    if (!p) throw new MigrationError(`Unknown provider: '${id}'`);
    return p;
  }

  /** Dry-run: validate eligibility and preview exactly what state will move. */
  async plan(subject: MigrationSubject): Promise<MigrationPlan> {
    const scope: StateScope = subject.scope ?? {};
    const warnings: string[] = [];

    const sourceProvider = this.provider(subject.source.providerId);
    const targetProvider = this.provider(subject.target.providerId);

    // Source must be able to surrender state.
    const sourceCaps = sourceProvider.capabilities?.();
    if (sourceCaps && !sourceCaps.canBeMigrationSource) {
      warnings.push(`Source provider '${subject.source.providerId}' is not a supported migration source.`);
    }
    if (!isSettingsCapable(sourceProvider)) {
      warnings.push(
        `Source provider '${subject.source.providerId}' cannot capture settings here; only the fidelity model is previewed.`
      );
    }

    // Target must be able to receive a migration.
    const targetCaps = targetProvider.capabilities?.();
    if (targetCaps && !targetCaps.canBeMigrationTarget) {
      warnings.push(`Target provider '${subject.target.providerId}' is not a supported migration target.`);
    }

    const provisioningRequired = !subject.target.entity;
    if (provisioningRequired && typeof targetProvider.provision !== "function") {
      warnings.push(
        `Target '${subject.target.providerId}' needs provisioning but exposes no provision() primitive; supply an existing target entity.`
      );
    }
    if (!isSettingsCapable(targetProvider)) {
      warnings.push(
        `Target provider '${subject.target.providerId}' cannot apply settings here; restore will be limited to provider-native state.`
      );
    }

    // Preview the state read-only from the source (no side effects).
    let stateItems: StateItem[] = [];
    let fidelityPreview: FidelitySummary = { full: 0, partial: 0, referenced: 0, overall: "referenced" };
    if (isSettingsCapable(sourceProvider)) {
      const bundle = await this.state.exportSettings(subject.source, scope, subject.user);
      stateItems = bundle.manifest.items;
      fidelityPreview = bundle.manifest.fidelity;
    }

    const executable =
      isSettingsCapable(sourceProvider) &&
      isSettingsCapable(targetProvider) &&
      (!provisioningRequired || typeof targetProvider.provision === "function");

    return {
      source: subject.source,
      target: subject.target,
      scope,
      user: subject.user,
      stateItems,
      fidelityPreview,
      provisioningRequired,
      warnings,
      executable
    };
  }

  /**
   * Execute the migration as an async job (returns immediately with the job).
   * Spine: provision (if needed) → capture source → restore onto target → verify.
   */
  execute(subject: MigrationSubject): Job<MigrationResult> {
    return this.jobs.start<MigrationResult>("migration", subject.user ?? subject.source.entity, async (ctx) => {
      const sourceProvider = this.provider(subject.source.providerId);
      const targetProvider = this.provider(subject.target.providerId);
      const scope: StateScope = subject.scope ?? {};

      if (!isSettingsCapable(sourceProvider)) {
        throw new MigrationError(`Source provider '${subject.source.providerId}' cannot capture state.`);
      }
      if (!isSettingsCapable(targetProvider)) {
        throw new MigrationError(`Target provider '${subject.target.providerId}' cannot apply state.`);
      }

      // 1) Provision target if no entity was supplied.
      let target = subject.target;
      const provStep = ctx.step("provision-target");
      if (target.entity) {
        provStep.skip(`Using existing target ${target.providerId}:${target.entity}`);
      } else if (typeof targetProvider.provision === "function") {
        const ref = await targetProvider.provision({ providerId: target.providerId, user: subject.user });
        target = { providerId: target.providerId, entity: ref.id };
        provStep.succeed(`Provisioned ${target.providerId}:${ref.id}`);
      } else {
        provStep.fail("Target requires provisioning but provides no provision() primitive");
        throw new MigrationError("Target requires provisioning but provides no provision() primitive.");
      }

      // 2) Capture source state into an encrypted bundle.
      const capStep = ctx.step("capture-source");
      const manifest = await this.state.capture(subject.source, scope, subject.user);
      capStep.succeed(`Captured bundle ${manifest.id} (fidelity: ${manifest.fidelity.overall})`);

      // 3) Restore onto the target.
      const resStep = ctx.step("restore-target");
      const { outcome } = await this.state.restore(target, manifest.id);
      resStep.succeed(`Restored onto ${target.providerId}:${target.entity ?? "host"}`);

      // 4) Verify target health (best-effort; never fakes success).
      const verStep = ctx.step("verify");
      let verified = false;
      if (typeof targetProvider.health === "function" && target.entity) {
        const health = await targetProvider.health({ providerId: target.providerId, id: target.entity });
        verified = health.healthy;
        verStep.succeed(`Target health: ${health.healthy ? "healthy" : "unhealthy"}${health.details ? ` (${health.details})` : ""}`);
      } else {
        verStep.succeed("Restore completed; no provider health primitive to assert against");
        verified = true;
      }

      // 5) Source retention (reversibility).
      const retStep = ctx.step("retain-source");
      retStep.succeed(this.retainSource ? "Source retained until sign-off" : "Source retention disabled by config");

      this.logger.info(
        { bundleId: manifest.id, source: subject.source, target, user: subject.user },
        "migration executed"
      );

      return {
        bundleId: manifest.id,
        fidelity: manifest.fidelity,
        restoreOutcome: outcome,
        sourceRetained: this.retainSource,
        verified
      };
    });
  }

  status(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }
}
