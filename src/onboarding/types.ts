/**
 * Tenant onboarding / access-provisioning model (P-SaaS front door).
 *
 * The goal: an admin grants this server least-privilege access to manage a
 * substrate, ideally by signing in and consenting (the platform then auto-creates
 * the enterprise app / service principal / role) rather than by us holding
 * keys-to-the-kingdom scopes. This is the same intent-normalized pattern as the
 * management layer (spec Appendix D.3), applied to *identity*: one normalized
 * intent — "grant me least-privilege access to substrate X" — resolves to the
 * correct per-substrate mechanism.
 *
 * Design stance (honest, least-privilege):
 *  - Prefer *consent* (admin-reviewed, one-click revocable) over programmatic
 *    creation. Only Entra offers a true "log in → consent → done" URL today.
 *  - Every plan lists the EXACT permissions requested, so the admin sees what
 *    they are granting before they click.
 *  - Every plan is auto-verifiable: after onboarding, a single live read proves
 *    it worked. We never claim success we can't verify.
 */

export type OnboardingMethod =
  /** A single admin-consent URL the platform fulfills automatically (Entra). */
  | "admin-consent"
  /** Apply a supplied artifact (IAM policy / role command) then provide creds. */
  | "guided"
  /** Assign an Azure RBAC role to the app's service principal. */
  | "azure-rbac"
  /** Create a service account by hand (on-prem, no cloud flow). */
  | "manual";

export interface OnboardingPermission {
  /** The scope / role / policy-action name being requested. */
  name: string;
  /** Why this server needs it (shown to the admin). */
  reason: string;
}

/** A document the admin applies when there is no one-click URL. */
export interface OnboardingArtifact {
  kind: "iam-policy" | "cli-command" | "cloudformation" | "instructions";
  /** A human-friendly label for the artifact. */
  label: string;
  content: string;
}

export interface OnboardingPlan {
  providerId: string;
  displayName: string;
  method: OnboardingMethod;
  summary: string;
  /** A URL the admin opens to grant access (present for admin-consent flows). */
  actionUrl?: string;
  /** The exact permissions/scopes/roles requested — review before granting. */
  permissions: OnboardingPermission[];
  /** Artifact to apply when there is no one-click URL (policy JSON, CLI command). */
  artifact?: OnboardingArtifact;
  /** Ordered steps the admin follows. */
  steps: string[];
  /** Caveats / prerequisites the admin must weigh. */
  warnings: string[];
  /** Whether {@link OnboardingCapable.onboardingStatus} can auto-verify completion. */
  verifiable: boolean;
}

export interface OnboardingStatus {
  providerId: string;
  displayName: string;
  /** Are the provider's credentials configured on this server yet? */
  configured: boolean;
  /** Did a live read confirm working access? */
  onboarded: boolean;
  details: string;
}

export interface OnboardingPlanInput {
  /** The admin's tenant/account identifier when known (Entra tenant id or domain). */
  tenant?: string;
  /** Override the public base URL used to build redirect URIs. */
  publicUrl?: string;
}

/**
 * Optional capability a provider implements to describe how an admin grants it
 * access, and to verify that access works. Plans must be producible BEFORE the
 * provider has credentials — onboarding is how those credentials are obtained.
 */
export interface OnboardingCapable {
  onboardingPlan(input: OnboardingPlanInput): OnboardingPlan;
  onboardingStatus(): Promise<OnboardingStatus>;
}

/** Runtime guard: does this provider expose the onboarding capability? */
export function isOnboardingCapable(provider: unknown): provider is OnboardingCapable {
  const c = provider as Partial<OnboardingCapable>;
  return typeof c.onboardingPlan === "function" && typeof c.onboardingStatus === "function";
}
