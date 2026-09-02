/**
 * Authentication — resolve a presented credential to a {@link Principal}.
 *
 * Two modes, behind one interface:
 *  - **bearer**: a static token (legacy single-tenant → full-trust system
 *    principal) or, when SaaS integrations are configured, a per-integration
 *    secret resolved by the {@link IntegrationRegistry}.
 *  - **oauth**: an OAuth 2.1 / OIDC access token (JWT) validated for signature,
 *    issuer, audience and expiry via JWKS, with its claims mapped to a
 *    principal. Static integration policy (allow-list, quota, trust) is merged
 *    in by id when a matching integration exists.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { AppConfig } from "../config/schema.js";
import type { Logger } from "../core/logger.js";
import type { IntegrationRegistry } from "./integrations.js";
import type { Principal, QuotaPolicy } from "./principal.js";
import { SYSTEM_PRINCIPAL } from "./principal.js";

export interface Authenticator {
  readonly mode: "bearer" | "oauth";
  /** Resolve a presented bearer credential to a principal, or `undefined` if invalid. */
  authenticate(token: string | undefined): Promise<Principal | undefined>;
}

/** Constant-time compare for the legacy single-token path. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Bearer-token authentication (static token and/or per-integration secrets). */
export class BearerAuthenticator implements Authenticator {
  readonly mode = "bearer" as const;

  constructor(
    private readonly opts: { staticToken?: string; integrations?: IntegrationRegistry }
  ) {}

  async authenticate(token: string | undefined): Promise<Principal | undefined> {
    if (!token) return undefined;
    // When integrations are configured, only per-integration secrets are valid —
    // the static token is not honoured as a god-mode backdoor.
    if (this.opts.integrations) {
      return this.opts.integrations.resolveByToken(token);
    }
    if (this.opts.staticToken && safeEqual(token, this.opts.staticToken)) {
      return SYSTEM_PRINCIPAL;
    }
    return undefined;
  }
}

/** A function that verifies a JWT and returns its payload (injectable for tests). */
export type JwtVerifier = (token: string) => Promise<JWTPayload>;

/** Extract OAuth scopes from either delegated (`scp`) or app-role (`roles`) claims. */
function extractScopes(payload: JWTPayload): string[] {
  const scp = payload.scp;
  if (typeof scp === "string") return scp.split(" ").filter(Boolean);
  const roles = payload.roles;
  if (Array.isArray(roles)) return roles.filter((r): r is string => typeof r === "string");
  return [];
}

/** OAuth 2.1 / OIDC bearer-JWT authentication. */
export class OAuthAuthenticator implements Authenticator {
  readonly mode = "oauth" as const;

  constructor(
    private readonly verify: JwtVerifier,
    private readonly logger: Logger,
    private readonly integrations?: IntegrationRegistry,
    private readonly defaultQuota?: QuotaPolicy
  ) {}

  async authenticate(token: string | undefined): Promise<Principal | undefined> {
    if (!token) return undefined;
    let payload: JWTPayload;
    try {
      payload = await this.verify(token);
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "OAuth token rejected");
      return undefined;
    }

    const id =
      (typeof payload.azp === "string" && payload.azp) ||
      (typeof payload.appid === "string" && payload.appid) ||
      (typeof payload.client_id === "string" && payload.client_id) ||
      (typeof payload.sub === "string" && payload.sub) ||
      "oauth-client";
    const tenantId = typeof payload.tid === "string" ? payload.tid : undefined;
    const scopes = extractScopes(payload);

    // Merge static integration policy (allow-list / deny-list / quota / trust)
    // when this client id is also a configured integration; otherwise treat it
    // as a third-party caller with the default quota.
    const known = this.integrations?.principalById(id);
    return {
      id,
      displayName: known?.displayName ?? (typeof payload.app_displayname === "string" ? payload.app_displayname : id),
      kind: "integration",
      tenantId: known?.tenantId ?? tenantId,
      allowlist: known?.allowlist,
      denylist: known?.denylist,
      scopes,
      quota: known?.quota ?? this.defaultQuota,
      trust: known?.trust ?? "third-party"
    };
  }
}

/** Derive an Entra-style JWKS URI from the issuer when none is configured. */
function deriveJwksUri(issuer: string): string {
  const trimmed = issuer.replace(/\/+$/, "");
  if (trimmed.endsWith("/v2.0")) return `${trimmed.slice(0, -"/v2.0".length)}/discovery/v2.0/keys`;
  return `${trimmed}/discovery/v2.0/keys`;
}

/**
 * Build the authenticator for the configured mode. The OAuth verifier validates
 * signature (JWKS), issuer, audience and expiry; a custom verifier may be
 * injected (used by tests to avoid network access).
 */
export function createAuthenticator(
  config: AppConfig,
  integrations: IntegrationRegistry | undefined,
  logger: Logger,
  verifier?: JwtVerifier
): Authenticator {
  if (config.authMode === "oauth") {
    const quota: QuotaPolicy = { perMinute: config.quotaPerMinute, perDay: config.quotaPerDay };
    if (verifier) return new OAuthAuthenticator(verifier, logger, integrations, quota);

    const jwksUri = config.oauthJwksUri ?? (config.oauthIssuer ? deriveJwksUri(config.oauthIssuer) : undefined);
    if (!jwksUri) {
      throw new Error("OAuth mode requires OAUTH_JWKS_URI or a derivable OAUTH_ISSUER.");
    }
    const jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(jwksUri));
    const verify: JwtVerifier = async (token) => {
      const { payload } = await jwtVerify(token, jwks, {
        audience: config.oauthAudience,
        issuer: config.oauthIssuer
      });
      return payload;
    };
    logger.info({ jwksUri, issuer: config.oauthIssuer, audience: config.oauthAudience }, "OAuth authenticator ready");
    return new OAuthAuthenticator(verify, logger, integrations, quota);
  }

  return new BearerAuthenticator({ staticToken: config.httpToken, integrations });
}
