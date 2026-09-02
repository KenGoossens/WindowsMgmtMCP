/**
 * Integration registry — the static (config-driven) side of SaaS multi-tenancy.
 *
 * Each integration is an authenticated caller of the server: a downstream SaaS
 * product, an internal platform, or a per-tenant connector. Definitions are
 * supplied as JSON (inline via `SAAS_INTEGRATIONS` or a file via
 * `SAAS_INTEGRATIONS_PATH`), mirroring the remote-targets pattern. Secrets are
 * referenced by **environment-variable name** (`tokenEnv`) and never inlined.
 */
import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Logger } from "../core/logger.js";
import { ConfigError } from "../core/errors.js";
import type { AppConfig } from "../config/schema.js";
import type { Principal, QuotaPolicy } from "./principal.js";

/** Raw integration definition as authored in configuration. */
const integrationSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
    /** Name of the env var holding this integration's bearer secret (preferred). */
    tokenEnv: z.string().min(1).optional(),
    /** Inline secret — discouraged; `tokenEnv` is preferred. */
    token: z.string().min(1).optional(),
    /** Effective tenant for per-tenant credential resolution (e.g. Graph authority). */
    tenantId: z.string().min(1).optional(),
    trust: z.enum(["first-party", "third-party"]).default("third-party"),
    allowlist: z.array(z.string().min(1)).optional(),
    denylist: z.array(z.string().min(1)).optional(),
    quotaPerMinute: z.coerce.number().int().min(0).optional(),
    quotaPerDay: z.coerce.number().int().min(0).optional()
  })
  .strict();

const integrationsSchema = z.array(integrationSchema);

export type IntegrationDef = z.infer<typeof integrationSchema>;

/** A resolved integration: its principal plus the secret to match against. */
interface ResolvedIntegration {
  secret: string;
  principal: Principal;
}

/** Constant-time string comparison that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still compare to avoid early-exit timing, but the result is false.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Loads integration definitions and resolves a presented bearer secret to a
 * {@link Principal}. Construction fails fast on malformed config, duplicate ids,
 * or a `tokenEnv` whose environment variable is missing.
 */
export class IntegrationRegistry {
  private readonly byId = new Map<string, ResolvedIntegration>();

  private constructor(integrations: ResolvedIntegration[]) {
    for (const it of integrations) this.byId.set(it.principal.id, it);
  }

  /** Number of configured integrations. */
  get size(): number {
    return this.byId.size;
  }

  /** Integration ids (for diagnostics; never logs secrets). */
  ids(): string[] {
    return [...this.byId.keys()];
  }

  /**
   * Build a registry from configuration. Returns `undefined` when no
   * integrations are configured (the server then uses legacy single-token auth).
   */
  static fromConfig(
    config: AppConfig,
    logger: Logger,
    env: NodeJS.ProcessEnv = process.env
  ): IntegrationRegistry | undefined {
    const raw = IntegrationRegistry.readRaw(config);
    if (!raw) return undefined;

    let defs: IntegrationDef[];
    try {
      defs = integrationsSchema.parse(JSON.parse(raw));
    } catch (err) {
      throw new ConfigError(
        `Invalid SAAS_INTEGRATIONS: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const resolved: ResolvedIntegration[] = [];
    const seen = new Set<string>();
    for (const def of defs) {
      if (seen.has(def.id)) {
        throw new ConfigError(`Duplicate integration id "${def.id}" in SAAS_INTEGRATIONS.`);
      }
      seen.add(def.id);

      const secret = def.tokenEnv ? env[def.tokenEnv] : def.token;
      if (!secret) {
        throw new ConfigError(
          def.tokenEnv
            ? `Integration "${def.id}" references env var "${def.tokenEnv}" which is not set.`
            : `Integration "${def.id}" must define "tokenEnv" (preferred) or "token".`
        );
      }

      const quota: QuotaPolicy = {
        perMinute: def.quotaPerMinute ?? config.quotaPerMinute,
        perDay: def.quotaPerDay ?? config.quotaPerDay
      };

      resolved.push({
        secret,
        principal: {
          id: def.id,
          displayName: def.displayName ?? def.id,
          kind: "integration",
          tenantId: def.tenantId,
          allowlist: def.allowlist,
          denylist: def.denylist,
          scopes: [],
          quota,
          trust: def.trust
        }
      });
    }

    logger.info({ integrations: resolved.map((r) => r.principal.id) }, "SaaS integrations loaded");
    return new IntegrationRegistry(resolved);
  }

  private static readRaw(config: AppConfig): string | undefined {
    if (config.saasIntegrations) return config.saasIntegrations;
    if (config.saasIntegrationsPath) {
      try {
        return fs.readFileSync(config.saasIntegrationsPath, "utf8");
      } catch (err) {
        throw new ConfigError(
          `Could not read SAAS_INTEGRATIONS_PATH "${config.saasIntegrationsPath}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    return undefined;
  }

  /** Resolve a presented bearer secret to its principal, or `undefined`. */
  resolveByToken(token: string): Principal | undefined {
    for (const it of this.byId.values()) {
      if (safeEqual(token, it.secret)) return it.principal;
    }
    return undefined;
  }

  /** Look up a principal by id (used by the OAuth path to merge static policy). */
  principalById(id: string): Principal | undefined {
    return this.byId.get(id)?.principal;
  }
}
