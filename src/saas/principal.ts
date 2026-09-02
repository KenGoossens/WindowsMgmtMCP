/**
 * Principal model for SaaS-grade multi-tenancy.
 *
 * Every authenticated caller is resolved to a {@link Principal} — a single,
 * uniform identity that carries the caller's tenant binding, tool allow/deny
 * policy, OAuth scopes, and quota policy. The tool registrar enforces against
 * the principal at call time, so one server instance can serve many tenants
 * and integrations with different governance without re-registering tools.
 */

/** Trust posture for an integration. */
export type IntegrationTrust = "first-party" | "third-party";

/** Per-principal request budget. `0` means unlimited for that dimension. */
export interface QuotaPolicy {
  perMinute: number;
  perDay: number;
}

/** A resolved, authenticated caller. */
export interface Principal {
  /** Stable identity (integration id, or OAuth `azp`/`appid`, or "system"). */
  id: string;
  displayName: string;
  /** `system` = full local trust (stdio / single-tenant). `integration` = a SaaS caller. */
  kind: "system" | "integration";
  /** Effective tenant for per-tenant credential resolution (e.g. Graph authority). */
  tenantId?: string;
  /** Explicit tool allow-list. When set, only these tools are callable. */
  allowlist?: string[];
  /** Explicit tool deny-list. Always wins over the allow-list. */
  denylist?: string[];
  /** OAuth scopes / app roles granted to this caller (informational + future gating). */
  scopes: string[];
  /** Request budget; absent = unlimited. */
  quota?: QuotaPolicy;
  /** Trust posture; `third-party` is denied arbitrary-execution tools by default. */
  trust: IntegrationTrust;
}

/**
 * Tools that grant arbitrary or high-blast-radius execution on a host. These are
 * excluded from third-party integrations unless explicitly allow-listed
 * (technical spec §7.5 default posture).
 */
export const ARBITRARY_EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  "powershell_run",
  "process_kill",
  "service_control",
  "remote_run",
  "remote_service_control"
]);

/**
 * The full-trust principal used for the stdio transport (a single local
 * operator) and as the fallback when no SaaS integrations are configured.
 */
export const SYSTEM_PRINCIPAL: Principal = {
  id: "system",
  displayName: "Local operator",
  kind: "system",
  scopes: ["*"],
  trust: "first-party"
};

/** Reasons a tool may be refused for a principal (for audit / error text). */
export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Decide whether {@link principal} may invoke a tool. Enforced at call time by
 * the tool registrar (in addition to the server-wide static allow-list).
 *
 * Order of checks (most-specific / most-restrictive first):
 *  1. deny-list always wins;
 *  2. third-party callers are refused arbitrary-execution tools unless the tool
 *     is explicitly present in their allow-list;
 *  3. an explicit allow-list, when present, is exhaustive.
 * The system principal bypasses all checks.
 */
export function authorizeTool(principal: Principal, toolName: string): AuthorizationDecision {
  if (principal.kind === "system") return { allowed: true };

  if (principal.denylist?.includes(toolName)) {
    return { allowed: false, reason: `tool "${toolName}" is deny-listed for integration "${principal.id}"` };
  }

  const explicitlyAllowed = principal.allowlist?.includes(toolName) ?? false;

  if (
    principal.trust === "third-party" &&
    ARBITRARY_EXECUTION_TOOLS.has(toolName) &&
    !explicitlyAllowed
  ) {
    return {
      allowed: false,
      reason: `tool "${toolName}" is an arbitrary-execution tool and is not enabled for third-party integration "${principal.id}"`
    };
  }

  if (principal.allowlist && principal.allowlist.length > 0 && !explicitlyAllowed) {
    return { allowed: false, reason: `tool "${toolName}" is not in the allow-list for integration "${principal.id}"` };
  }

  return { allowed: true };
}
