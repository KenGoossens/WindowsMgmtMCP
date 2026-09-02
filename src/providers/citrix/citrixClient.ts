import { randomUUID } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import { RestClient, RestError } from "../restClient.js";
import type { AppConfig } from "../../config/schema.js";
import { ProviderUnavailableError } from "../../core/errors.js";

/** Whether enough configuration is present for the Citrix DaaS provider. */
export function hasCitrixConfig(config: AppConfig): boolean {
  return Boolean(config.citrixCustomerId && config.citrixClientId && config.citrixClientSecret);
}

interface CitrixTokenResponse {
  token: string;
  expires_in?: string | number;
}

export interface CitrixDeliveryGroup {
  Id?: string;
  Name?: string;
  DeliveryType?: string;
  Enabled?: boolean;
  InMaintenanceMode?: boolean;
  TotalMachines?: number;
  TotalApplications?: number;
}

export interface CitrixMachine {
  Id?: string;
  Name?: string;
  DnsName?: string;
  PowerState?: string;
  RegistrationState?: string;
  InMaintenanceMode?: boolean;
  SessionCount?: number;
  LoadIndex?: number;
  DeliveryGroup?: { Name?: string };
}

export interface CitrixSession {
  Id?: string;
  UserName?: string;
  UserUPN?: string;
  State?: string;
  MachineName?: string;
  DeliveryGroupName?: string;
}

/** A configured Citrix Cloud resource location (zone/connector topology). */
export interface CitrixResourceLocation {
  id?: string;
  name?: string;
  internalOnly?: boolean;
  timeZone?: string;
  readOnly?: boolean;
}

/** A Citrix Cloud service and the customer's entitlement state for it. */
export interface CitrixServiceState {
  serviceName?: string;
  state?: string;
}

/** Payload accepted by the Citrix Cloud Notifications API. */
export interface CitrixNotification {
  title: string;
  description: string;
  severity?: "Information" | "Warning" | "Error";
  priority?: "Low" | "Normal" | "High";
}

interface CitrixListResponse<T> {
  Items?: T[];
}

interface CitrixItemsResponse<T> {
  items?: T[];
}

/**
 * Typed client over the **Citrix DaaS REST APIs** (developer-docs.citrix.com).
 * Authentication follows the documented Citrix Cloud flow: exchange the API
 * client id/secret for a bearer token at the trust endpoint, then call the
 * `cvad/manage` resources with the `Citrix-CustomerId` header. The bearer token
 * is cached and refreshed on expiry.
 */
export class CitrixGateway {
  private readonly base: string;
  private api?: RestClient;
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(private readonly config: AppConfig) {
    this.base = (config.citrixApiBase ?? "https://api.cloud.com").replace(/\/+$/, "");
  }

  /** Obtain (and cache) a Citrix Cloud bearer token. */
  async getToken(now: number = Date.now()): Promise<string> {
    if (this.token && now < this.tokenExpiresAt) return this.token;
    if (!hasCitrixConfig(this.config)) {
      throw new ProviderUnavailableError(
        "Citrix provider requires CITRIX_CUSTOMER_ID, CITRIX_CLIENT_ID and CITRIX_CLIENT_SECRET."
      );
    }
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.citrixClientId!,
      client_secret: this.config.citrixClientSecret!
    }).toString();

    const url = `${this.base}/cctrustoauth2/${this.config.citrixCustomerId}/tokens/clients`;
    const res = await undiciFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body
    });
    const text = await res.text();
    if (!res.ok) {
      throw new RestError(`Citrix token request failed (HTTP ${res.status})`, res.status, text.slice(0, 1000));
    }
    const parsed = JSON.parse(text) as CitrixTokenResponse;
    const ttlSec =
      typeof parsed.expires_in === "string" ? Number.parseInt(parsed.expires_in, 10) : parsed.expires_in ?? 3600;
    this.token = parsed.token;
    this.tokenExpiresAt = now + Math.max(60, ttlSec - 60) * 1000;
    return this.token;
  }

  private async apiClient(): Promise<RestClient> {
    const token = await this.getToken();
    this.api = new RestClient({
      baseUrl: this.base,
      defaultHeaders: {
        Authorization: `CWSAuth bearer=${token}`,
        "Citrix-CustomerId": this.config.citrixCustomerId!,
        Accept: "application/json"
      }
    });
    return this.api;
  }

  async listDeliveryGroups(): Promise<CitrixDeliveryGroup[]> {
    const api = await this.apiClient();
    const res = await api.get<CitrixListResponse<CitrixDeliveryGroup>>("/cvad/manage/DeliveryGroups");
    return res.Items ?? [];
  }

  async listMachineCatalogs(): Promise<Array<{ Id?: string; Name?: string }>> {
    const api = await this.apiClient();
    const res = await api.get<CitrixListResponse<{ Id?: string; Name?: string }>>("/cvad/manage/MachineCatalogs");
    return res.Items ?? [];
  }

  async listMachines(deliveryGroup?: string): Promise<CitrixMachine[]> {
    const api = await this.apiClient();
    const path = deliveryGroup
      ? `/cvad/manage/DeliveryGroups/${encodeURIComponent(deliveryGroup)}/Machines`
      : "/cvad/manage/Machines";
    const res = await api.get<CitrixListResponse<CitrixMachine>>(path);
    return res.Items ?? [];
  }

  async listSessions(): Promise<CitrixSession[]> {
    const api = await this.apiClient();
    const res = await api.get<CitrixListResponse<CitrixSession>>("/cvad/manage/Sessions");
    return res.Items ?? [];
  }

  /** Power action on a machine: turnon | turnoff | shutdown | restart | suspend | resume. */
  async powerMachine(machineId: string, action: string): Promise<void> {
    const api = await this.apiClient();
    await api.post(`/cvad/manage/Machines/${encodeURIComponent(machineId)}/%24power`, undefined, { action });
  }

  async setMaintenanceMode(machineId: string, on: boolean): Promise<void> {
    const api = await this.apiClient();
    await api.request(`/cvad/manage/Machines/${encodeURIComponent(machineId)}`, {
      method: "PATCH",
      body: { InMaintenanceMode: on }
    });
  }

  async sessionAction(sessionId: string, action: "logoff" | "disconnect"): Promise<void> {
    const api = await this.apiClient();
    await api.post(`/cvad/manage/Sessions/${encodeURIComponent(sessionId)}/%24${action}`);
  }

  async sendSessionMessage(sessionId: string, title: string, text: string): Promise<void> {
    const api = await this.apiClient();
    await api.post(`/cvad/manage/Sessions/${encodeURIComponent(sessionId)}/%24sendMessage`, {
      Title: title,
      Text: text,
      MessageStyle: "Information"
    });
  }

  // ── Citrix Cloud platform (control-plane) APIs ─────────────────────────────
  // These live on dedicated *.citrixworkspacesapi.net hosts but accept the same
  // Citrix Cloud bearer token. They are customer-scoped via the URL path.

  /** Build a client for a Citrix Cloud platform host using the shared bearer token. */
  private async platformClient(baseUrl: string): Promise<RestClient> {
    const token = await this.getToken();
    return new RestClient({
      baseUrl,
      defaultHeaders: { Authorization: `CwsAuth Bearer=${token}`, Accept: "application/json" }
    });
  }

  /** List the customer's configured resource locations (zones / connector topology). */
  async resourceLocations(): Promise<CitrixResourceLocation[]> {
    const api = await this.platformClient("https://registry.citrixworkspacesapi.net");
    const res = await api.get<CitrixItemsResponse<CitrixResourceLocation>>(
      `/${encodeURIComponent(this.config.citrixCustomerId!)}/resourcelocations`
    );
    return res.items ?? [];
  }

  /** List Citrix Cloud services and the customer's entitlement state for each. */
  async serviceStates(): Promise<CitrixServiceState[]> {
    const api = await this.platformClient("https://core.citrixworkspacesapi.net");
    const res = await api.get<CitrixItemsResponse<CitrixServiceState>>(
      `/${encodeURIComponent(this.config.citrixCustomerId!)}/serviceStates`
    );
    return res.items ?? [];
  }

  /** Push a notification to Citrix Cloud administrators (outbound alert sink). */
  async sendNotification(n: CitrixNotification): Promise<void> {
    const api = await this.platformClient("https://notifications.citrixworkspacesapi.net");
    await api.post(`/${encodeURIComponent(this.config.citrixCustomerId!)}/notifications/items`, {
      destinationAdmin: "*",
      component: "WindowsMCP",
      createdDate: new Date().toISOString(),
      eventId: randomUUID(),
      severity: n.severity ?? "Information",
      priority: n.priority ?? "Normal",
      content: [{ languageTag: "en-US", title: n.title, description: n.description }]
    });
  }
}
