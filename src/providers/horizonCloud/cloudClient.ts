import { fetch as undiciFetch } from "undici";
import { RestClient, RestError } from "../restClient.js";
import type { AppConfig } from "../../config/schema.js";
import { ProviderUnavailableError } from "../../core/errors.js";

/** Whether enough configuration is present for the Horizon Cloud (next-gen) provider. */
export function hasHorizonCloudConfig(config: AppConfig): boolean {
  return Boolean(
    config.horizonCloudApiBase &&
      (config.horizonCloudApiToken || (config.horizonCloudClientId && config.horizonCloudClientSecret))
  );
}

interface CspTokenResponse {
  access_token: string;
  expires_in?: number;
}

/** Spring-style page wrapper used across the next-gen admin/image APIs. */
interface Page<T> {
  content?: T[];
  totalElements?: number;
}

/** A next-gen "template" (the modern name for a desktop/app pool). */
export interface HorizonCloudTemplate {
  id?: string;
  name?: string;
  description?: string;
  imageId?: string;
  templateType?: string;
  sessionsPerVm?: number;
  orgId?: string;
}

/** A pool VM with its lifecycle/agent status. */
export interface HorizonCloudVm {
  id?: string;
  templateId?: string;
  lifecycleStatus?: string;
  powerState?: string;
  agentStatus?: string;
  privateIp?: string;
}

/** An image-management catalog image. */
export interface HorizonCloudImage {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Typed client over the **Omnissa Horizon Cloud Service – next-gen** REST API
 * (developer.omnissa.com, OAS 3.0). Authentication is via the Cloud Services
 * Portal (CSP): exchange a CSP API token (or an OAuth-app client id/secret) for
 * a short-lived access token, then call the regional Horizon Cloud host with a
 * Bearer token. Resource paths and shapes are grounded in the published
 * `horizon-cloud-nextgen-api-doc-public` spec (templates = pools; sessions are
 * user/org-scoped; VM restart and bulk session actions live under helpdesk/portal).
 */
export class HorizonCloudGateway {
  private readonly base: string;
  private readonly cspUrl: string;
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(private readonly config: AppConfig) {
    this.base = (config.horizonCloudApiBase ?? "").replace(/\/+$/, "");
    this.cspUrl = (config.horizonCloudCspUrl ?? "https://connect.omnissa.com").replace(/\/+$/, "");
  }

  /** Obtain (and cache) a CSP access token via API-token or OAuth-app credentials. */
  async getToken(now: number = Date.now()): Promise<string> {
    if (this.token && now < this.tokenExpiresAt) return this.token;
    if (!hasHorizonCloudConfig(this.config)) {
      throw new ProviderUnavailableError(
        "Horizon Cloud provider requires HORIZON_CLOUD_API_BASE and either HORIZON_CLOUD_API_TOKEN or HORIZON_CLOUD_CLIENT_ID/SECRET."
      );
    }

    let url: string;
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    };
    let body: string;
    if (this.config.horizonCloudApiToken) {
      url = `${this.cspUrl}/csp/gateway/am/api/auth/api-tokens/authorize`;
      body = new URLSearchParams({ refresh_token: this.config.horizonCloudApiToken }).toString();
    } else {
      url = `${this.cspUrl}/csp/gateway/am/api/auth/authorize`;
      const basic = Buffer.from(
        `${this.config.horizonCloudClientId}:${this.config.horizonCloudClientSecret}`
      ).toString("base64");
      headers.Authorization = `Basic ${basic}`;
      body = new URLSearchParams({ grant_type: "client_credentials" }).toString();
    }

    const res = await undiciFetch(url, { method: "POST", headers, body });
    const text = await res.text();
    if (!res.ok) {
      throw new RestError(`Horizon Cloud CSP token request failed (HTTP ${res.status})`, res.status, text.slice(0, 1000));
    }
    const parsed = JSON.parse(text) as CspTokenResponse;
    this.token = parsed.access_token;
    // CSP access tokens last ~30 min (expires_in seconds); refresh a minute early.
    const ttlSec = parsed.expires_in ?? 1799;
    this.tokenExpiresAt = now + Math.max(60, ttlSec - 60) * 1000;
    return this.token;
  }

  private async api(): Promise<RestClient> {
    const token = await this.getToken();
    return new RestClient({
      baseUrl: this.base,
      defaultHeaders: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
  }

  /** List templates (pools). */
  async listTemplates(): Promise<HorizonCloudTemplate[]> {
    const api = await this.api();
    const res = await api.get<Page<HorizonCloudTemplate>>("/admin/v2/templates", {
      org_id: this.config.horizonCloudOrgId,
      size: 200
    });
    return res.content ?? [];
  }

  /** List the VMs in a template, with lifecycle/agent status. */
  async listVms(templateId: string): Promise<HorizonCloudVm[]> {
    const api = await this.api();
    const res = await api.get<Page<HorizonCloudVm>>(`/admin/v2/templates/${encodeURIComponent(templateId)}/vms`, {
      org_id: this.config.horizonCloudOrgId,
      size: 200
    });
    return res.content ?? [];
  }

  /** List image-management catalog images. */
  async listImages(): Promise<HorizonCloudImage[]> {
    const api = await this.api();
    const res = await api.get<Page<HorizonCloudImage> | HorizonCloudImage[]>("/imagemgmt/v1/images", {
      org_id: this.config.horizonCloudOrgId
    });
    return Array.isArray(res) ? res : (res.content ?? []);
  }

  /** List a user's sessions (the next-gen session API is user/org-scoped). */
  async listUserSessions(userId: string): Promise<Record<string, unknown>[]> {
    const api = await this.api();
    const res = await api.get<Page<Record<string, unknown>> | Record<string, unknown>[]>("/portal/v2/sessions", {
      userId,
      org_id: this.config.horizonCloudOrgId
    });
    return Array.isArray(res) ? res : (res.content ?? []);
  }

  /** Perform a bulk session action (logoff/disconnect) on the given session ids. */
  async bulkSessionAction(sessionIds: string[], actionType: "BULK_LOGOFF" | "BULK_DISCONNECT"): Promise<void> {
    const api = await this.api();
    await api.post(
      "/portal/v2/sessions/bulk-session-action",
      { actionType, sessionIds },
      { org_id: this.config.horizonCloudOrgId }
    );
  }

  /** Restart the given pool VMs. */
  async restartVms(requests: { vmId: string; templateId?: string }[]): Promise<void> {
    const api = await this.api();
    await api.post("/helpdesk/v2/vms/restart", { requests }, { org_id: this.config.horizonCloudOrgId });
  }
}
