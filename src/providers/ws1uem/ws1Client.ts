import { fetch as undiciFetch } from "undici";
import { RestClient, RestError } from "../restClient.js";
import type { AppConfig } from "../../config/schema.js";
import { ProviderUnavailableError } from "../../core/errors.js";

/** Whether enough configuration is present for the Workspace ONE UEM provider. */
export function hasWs1Config(config: AppConfig): boolean {
  return Boolean(
    config.ws1ApiHost &&
      config.ws1TenantCode &&
      config.ws1TokenUrl &&
      config.ws1ClientId &&
      config.ws1ClientSecret
  );
}

interface Ws1TokenResponse {
  access_token: string;
  expires_in?: number;
}

/** A normalized managed device from a WS1 UEM device search. */
export interface Ws1Device {
  Id?: { Value?: number };
  Udid?: string;
  SerialNumber?: string;
  DeviceFriendlyName?: string;
  UserName?: string;
  Platform?: string;
  Model?: string;
  OperatingSystem?: string;
  ComplianceStatus?: string;
  EnrollmentStatus?: string;
  LastSeen?: string;
}

interface Ws1DeviceSearchResponse {
  Devices?: Ws1Device[];
  Total?: number;
}

/** Options for a device search. */
export interface Ws1DeviceSearchOptions {
  user?: string;
  platform?: string;
  complianceStatus?: string;
  pageSize?: number;
}

/**
 * Typed client over the **Workspace ONE UEM (AirWatch) REST API**
 * (developer.omnissa.com). Authentication is OAuth 2.0 client-credentials against
 * a region-specific token URL, after which every call carries a Bearer token, the
 * tenant API key (`aw-tenant-code`), and a versioned `Accept` header. This is the
 * multi-OS endpoint-management substrate (iOS / Android / Windows / macOS).
 */
export class Ws1Gateway {
  private readonly base: string;
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(private readonly config: AppConfig) {
    this.base = (config.ws1ApiHost ?? "").replace(/\/+$/, "");
  }

  /** Obtain (and cache) an OAuth client-credentials access token. */
  async getToken(now: number = Date.now()): Promise<string> {
    if (this.token && now < this.tokenExpiresAt) return this.token;
    if (!hasWs1Config(this.config)) {
      throw new ProviderUnavailableError(
        "Workspace ONE UEM provider requires WS1_API_HOST, WS1_TENANT_CODE, WS1_TOKEN_URL, WS1_CLIENT_ID and WS1_CLIENT_SECRET."
      );
    }
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.ws1ClientId!,
      client_secret: this.config.ws1ClientSecret!
    }).toString();

    const res = await undiciFetch(this.config.ws1TokenUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body
    });
    const text = await res.text();
    if (!res.ok) {
      throw new RestError(`Workspace ONE token request failed (HTTP ${res.status})`, res.status, text.slice(0, 1000));
    }
    const parsed = JSON.parse(text) as Ws1TokenResponse;
    this.token = parsed.access_token;
    const ttlSec = parsed.expires_in ?? 3600;
    this.tokenExpiresAt = now + Math.max(60, ttlSec - 60) * 1000;
    return this.token;
  }

  private async api(): Promise<RestClient> {
    const token = await this.getToken();
    const version = this.config.ws1ApiVersion ?? "1";
    return new RestClient({
      baseUrl: this.base,
      defaultHeaders: {
        Authorization: `Bearer ${token}`,
        "aw-tenant-code": this.config.ws1TenantCode!,
        Accept: `application/json;version=${version}`
      }
    });
  }

  /** Search managed devices, optionally filtered by user, platform, or compliance. */
  async searchDevices(opts: Ws1DeviceSearchOptions = {}): Promise<Ws1Device[]> {
    const api = await this.api();
    const res = await api.get<Ws1DeviceSearchResponse>("/api/mdm/devices/search", {
      user: opts.user,
      platform: opts.platform,
      compliancestatus: opts.complianceStatus,
      pagesize: opts.pageSize
    });
    return res.Devices ?? [];
  }

  /** Get a single device by its numeric UEM device id. */
  async getDevice(deviceId: number): Promise<Ws1Device> {
    const api = await this.api();
    return api.get<Ws1Device>(`/api/mdm/devices/${encodeURIComponent(String(deviceId))}`);
  }

  /** Issue a device command (DeviceLock, EnterpriseWipe, ClearPasscode, DeviceQuery, …). */
  async deviceCommand(deviceId: number, command: string): Promise<void> {
    const api = await this.api();
    await api.post(`/api/mdm/devices/${encodeURIComponent(String(deviceId))}/commands`, undefined, { command });
  }
}
