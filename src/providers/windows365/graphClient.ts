import { Client } from "@microsoft/microsoft-graph-client";
import { ClientSecretCredential, DeviceCodeCredential, type TokenCredential } from "@azure/identity";
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import { ProviderUnavailableError } from "../../core/errors.js";

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

/**
 * Whether enough Graph configuration is present for the Windows 365 provider.
 */
export function hasGraphConfig(config: AppConfig): boolean {
  if (!config.graphTenantId || !config.graphClientId) return false;
  if (config.graphAuthMode === "app") return Boolean(config.graphClientSecret);
  return true;
}

/**
 * Build a Microsoft Graph client backed by either app-only (`ClientSecretCredential`)
 * or delegated (`DeviceCodeCredential`) authentication. A custom authentication
 * provider wraps the credential so no extra Graph auth subpath import is required.
 *
 * `tenantOverride` selects the authority for a multi-tenant Entra app (same
 * `client_id` + secret, different tenant per caller); it falls back to the
 * statically configured tenant for single-tenant deployments.
 */
export function createGraphClient(config: AppConfig, logger: Logger, tenantOverride?: string): Client {
  if (!hasGraphConfig(config)) {
    throw new ProviderUnavailableError(
      "Windows 365 provider requires GRAPH_TENANT_ID, GRAPH_CLIENT_ID (and GRAPH_CLIENT_SECRET in app mode)."
    );
  }

  const tenantId = tenantOverride ?? config.graphTenantId!;
  let credential: TokenCredential;
  if (config.graphAuthMode === "app") {
    credential = new ClientSecretCredential(
      tenantId,
      config.graphClientId!,
      config.graphClientSecret!
    );
  } else {
    credential = new DeviceCodeCredential({
      tenantId,
      clientId: config.graphClientId!,
      userPromptCallback: (info) => {
        logger.warn({ verificationUri: info.verificationUri, userCode: info.userCode }, info.message);
      }
    });
  }

  return Client.initWithMiddleware({
    authProvider: {
      getAccessToken: async () => {
        const token = await credential.getToken(GRAPH_SCOPE);
        if (!token) throw new ProviderUnavailableError("Failed to acquire a Microsoft Graph access token.");
        return token.token;
      }
    }
  });
}
