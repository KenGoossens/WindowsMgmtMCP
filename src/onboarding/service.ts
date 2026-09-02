import type { Logger } from "../core/logger.js";
import { AppError } from "../core/errors.js";
import type { ProviderRegistry } from "../providers/provider.js";
import {
  isOnboardingCapable,
  type OnboardingCapable,
  type OnboardingPlan,
  type OnboardingPlanInput,
  type OnboardingStatus
} from "./types.js";

export class OnboardingError extends AppError {}

interface OnboardingProvider extends OnboardingCapable {
  id: string;
  displayName: string;
}

/**
 * Discovers onboarding-capable providers and exposes plan/status/list. Plans are
 * produced regardless of whether the provider currently has credentials —
 * onboarding is precisely how those credentials are obtained.
 */
export class OnboardingService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly logger: Logger
  ) {}

  private capable(): OnboardingProvider[] {
    return this.registry
      .list()
      .filter((p): p is typeof p & OnboardingCapable => isOnboardingCapable(p))
      .map((p) => p as unknown as OnboardingProvider);
  }

  private resolve(providerId: string): OnboardingProvider {
    const provider = this.capable().find((p) => p.id === providerId);
    if (!provider) {
      throw new OnboardingError(
        `Provider '${providerId}' does not support onboarding. Onboardable: ${this.capable().map((p) => p.id).join(", ") || "(none)"}.`
      );
    }
    return provider;
  }

  /** Produce the onboarding plan for one provider (read-only, no side effects). */
  plan(providerId: string, input: OnboardingPlanInput = {}): OnboardingPlan {
    const plan = this.resolve(providerId).onboardingPlan(input);
    this.logger.info({ providerId, method: plan.method }, "onboarding plan produced");
    return plan;
  }

  /** Verify whether a provider's access actually works (a single live read). */
  async status(providerId: string): Promise<OnboardingStatus> {
    return this.resolve(providerId).onboardingStatus();
  }

  /** List which providers support onboarding and their headline method. */
  list(): { providerId: string; displayName: string; method: string }[] {
    return this.capable().map((p) => {
      const plan = p.onboardingPlan({});
      return { providerId: p.id, displayName: p.displayName, method: plan.method };
    });
  }
}
