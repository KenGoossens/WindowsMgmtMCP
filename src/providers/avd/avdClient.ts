import { DesktopVirtualizationAPIClient } from "@azure/arm-desktopvirtualization";
import type { HostPool, SessionHost, UserSession } from "@azure/arm-desktopvirtualization";
import { ClientSecretCredential, DeviceCodeCredential, type TokenCredential } from "@azure/identity";
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../core/logger.js";
import { ProviderUnavailableError } from "../../core/errors.js";

/**
 * Whether enough configuration is present for the AVD provider. AVD reuses the
 * Entra app credentials (`GRAPH_*`) scoped to Azure Resource Manager, plus an
 * AVD subscription id and resource group.
 */
export function hasAvdConfig(config: AppConfig): boolean {
  if (!config.avdSubscriptionId || !config.avdResourceGroup) return false;
  if (!config.graphTenantId || !config.graphClientId) return false;
  if (config.graphAuthMode === "app") return Boolean(config.graphClientSecret);
  return true;
}

/** Build the same credential the Graph client uses (app-only or delegated). */
function buildCredential(config: AppConfig, logger: Logger): TokenCredential {
  if (config.graphAuthMode === "app") {
    return new ClientSecretCredential(config.graphTenantId!, config.graphClientId!, config.graphClientSecret!);
  }
  return new DeviceCodeCredential({
    tenantId: config.graphTenantId!,
    clientId: config.graphClientId!,
    userPromptCallback: (info) => {
      logger.warn({ verificationUri: info.verificationUri, userCode: info.userCode }, info.message);
    }
  });
}

/**
 * Strip an AVD "parent/child" resource-name prefix. AVD returns nested resource
 * names like `hostPool/sessionHost` and `hostPool/sessionHost/userSessionId`;
 * sub-resource operations expect just the trailing segment(s).
 */
export function lastSegment(name: string | undefined): string {
  if (!name) return "";
  const parts = name.split("/");
  return parts[parts.length - 1];
}

/** Parse a userSession resource name into the parts its operations need. */
export function parseUserSessionName(name: string | undefined): { sessionHost: string; userSessionId: string } {
  const parts = (name ?? "").split("/");
  return {
    sessionHost: parts.length >= 2 ? parts[parts.length - 2] : "",
    userSessionId: parts[parts.length - 1] ?? ""
  };
}

/**
 * Typed wrapper over the Azure Desktop Virtualization ARM SDK, scoped to one
 * subscription + resource group. Pages are eagerly collected into arrays for the
 * tool layer. The client is created lazily so registration needs no live auth.
 */
export class AvdGateway {
  private client?: DesktopVirtualizationAPIClient;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  private get rg(): string {
    return this.config.avdResourceGroup!;
  }

  private getClient(): DesktopVirtualizationAPIClient {
    if (this.client) return this.client;
    if (!hasAvdConfig(this.config)) {
      throw new ProviderUnavailableError(
        "AVD provider requires AVD_SUBSCRIPTION_ID, AVD_RESOURCE_GROUP and the GRAPH_* Entra credentials."
      );
    }
    const credential = buildCredential(this.config, this.logger);
    this.client = new DesktopVirtualizationAPIClient(credential, this.config.avdSubscriptionId!);
    return this.client;
  }

  async listHostPools(): Promise<HostPool[]> {
    const out: HostPool[] = [];
    for await (const hp of this.getClient().hostPools.listByResourceGroup(this.rg)) out.push(hp);
    return out;
  }

  async listSessionHosts(hostPoolName: string): Promise<SessionHost[]> {
    const out: SessionHost[] = [];
    for await (const sh of this.getClient().sessionHosts.list(this.rg, hostPoolName)) out.push(sh);
    return out;
  }

  async getSessionHost(hostPoolName: string, sessionHostName: string): Promise<SessionHost> {
    return this.getClient().sessionHosts.get(this.rg, hostPoolName, sessionHostName);
  }

  /** Toggle drain mode (maintenance): allowNewSession=false drains the host. */
  async setDrain(hostPoolName: string, sessionHostName: string, allowNewSession: boolean): Promise<SessionHost> {
    return this.getClient().sessionHosts.update(this.rg, hostPoolName, sessionHostName, {
      sessionHost: { allowNewSession }
    });
  }

  async listSessions(hostPoolName: string): Promise<UserSession[]> {
    const out: UserSession[] = [];
    for await (const us of this.getClient().userSessions.listByHostPool(this.rg, hostPoolName)) out.push(us);
    return out;
  }

  async disconnectSession(hostPoolName: string, sessionHostName: string, userSessionId: string): Promise<void> {
    await this.getClient().userSessions.disconnect(this.rg, hostPoolName, sessionHostName, userSessionId);
  }

  /** Log off a user session (force flag completes the sign-out). */
  async logoffSession(hostPoolName: string, sessionHostName: string, userSessionId: string): Promise<void> {
    await this.getClient().userSessions.delete(this.rg, hostPoolName, sessionHostName, userSessionId, { force: true });
  }

  async sendMessage(
    hostPoolName: string,
    sessionHostName: string,
    userSessionId: string,
    title: string,
    body: string
  ): Promise<void> {
    await this.getClient().userSessions.sendMessage(this.rg, hostPoolName, sessionHostName, userSessionId, {
      sendMessage: { messageTitle: title, messageBody: body }
    });
  }
}

export type { HostPool, SessionHost, UserSession };
