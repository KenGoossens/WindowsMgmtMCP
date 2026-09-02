/**
 * Per-principal tenant resolution for credential selection.
 *
 * A multi-tenant Microsoft Entra app shares one `client_id` + secret across all
 * tenants and differs only in the **authority (tenant) per token**. So the
 * effective Graph tenant is taken from the authenticated principal when running
 * multi-tenant, and from the static config otherwise. Single-tenant behaviour is
 * unchanged when `MCP_MULTI_TENANT` is off.
 */
import type { AppConfig } from "../config/schema.js";
import type { Principal } from "./principal.js";

/**
 * The effective Graph tenant id for this caller, or `undefined` to fall back to
 * the provider's configured default. In multi-tenant mode the principal's
 * tenant wins; the system principal and single-tenant mode use config.
 */
export function resolveGraphTenant(config: AppConfig, principal?: Principal): string | undefined {
  if (config.multiTenant && principal && principal.kind === "integration" && principal.tenantId) {
    return principal.tenantId;
  }
  return config.graphTenantId;
}
