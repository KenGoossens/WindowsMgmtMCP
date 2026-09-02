import { RestClient } from "../restClient.js";
import type { AppConfig } from "../../config/schema.js";
import { ProviderUnavailableError } from "../../core/errors.js";

/** Whether enough configuration is present for the Horizon provider. */
export function hasHorizonConfig(config: AppConfig): boolean {
  return Boolean(
    config.horizonApiBase && config.horizonDomain && config.horizonUsername && config.horizonPassword
  );
}

interface HorizonLoginResponse {
  access_token: string;
  refresh_token?: string;
}

export interface HorizonPool {
  id?: string;
  name?: string;
  display_name?: string;
  type?: string;
  enabled?: boolean;
}

export interface HorizonMachine {
  id?: string;
  name?: string;
  desktop_pool_id?: string;
  state?: string;
  agent_version?: string;
  operating_system?: string;
}

export interface HorizonSession {
  id?: string;
  user_name?: string;
  username?: string;
  session_state?: string;
  machine_id?: string;
  desktop_pool_id?: string;
  session_type?: string;
}

/** A monitored Horizon infrastructure component (connection server, gateway, …). */
export interface HorizonMonitorComponent {
  id?: string;
  name?: string;
  status?: string;
  details?: unknown;
}

/** Scheduling options for an instant-clone pool image push (recompose). */
export interface HorizonPushImageSpec {
  parentVmId?: string;
  snapshotId?: string;
  startTime?: string;
  logoffPolicy?: "WAIT_FOR_LOGOFF" | "FORCE_LOGOFF";
  stopOnFirstError?: boolean;
  addVirtualTpm?: boolean;
}

/**
 * Typed client over the **Omnissa Horizon Server REST API** (developer.omnissa.com).
 * Authentication is the documented flow: `POST /rest/login` with domain/username/
 * password returns an access token (and refresh token); subsequent calls send it
 * as a Bearer token. Inventory and session-control endpoints live under
 * `/rest/inventory/...`. Self-signed Connection Server certs are supported via
 * the opt-in `HORIZON_INSECURE_TLS` flag.
 */
export class HorizonGateway {
  private readonly base: string;
  private client?: RestClient;
  private accessToken?: string;
  private tokenExpiresAt = 0;

  constructor(private readonly config: AppConfig) {
    this.base = (config.horizonApiBase ?? "").replace(/\/+$/, "");
  }

  /** Log in and cache the access token (Horizon access tokens last ~30 min). */
  async login(now: number = Date.now()): Promise<string> {
    if (this.accessToken && now < this.tokenExpiresAt) return this.accessToken;
    if (!hasHorizonConfig(this.config)) {
      throw new ProviderUnavailableError(
        "Horizon provider requires HORIZON_API_BASE, HORIZON_DOMAIN, HORIZON_USERNAME and HORIZON_PASSWORD."
      );
    }
    const auth = new RestClient({ baseUrl: this.base, insecureTls: this.config.horizonInsecureTls });
    const res = await auth.post<HorizonLoginResponse>("/rest/login", {
      domain: this.config.horizonDomain,
      username: this.config.horizonUsername,
      password: this.config.horizonPassword
    });
    this.accessToken = res.access_token;
    // Access tokens are valid ~30 min; refresh a minute early.
    this.tokenExpiresAt = now + 29 * 60_000;
    return this.accessToken;
  }

  private async api(): Promise<RestClient> {
    const token = await this.login();
    this.client = new RestClient({
      baseUrl: this.base,
      insecureTls: this.config.horizonInsecureTls,
      defaultHeaders: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    return this.client;
  }

  async listPools(): Promise<HorizonPool[]> {
    const api = await this.api();
    return api.get<HorizonPool[]>("/rest/inventory/v1/desktop-pools");
  }

  async listFarms(): Promise<Array<{ id?: string; name?: string }>> {
    const api = await this.api();
    return api.get<Array<{ id?: string; name?: string }>>("/rest/inventory/v1/farms");
  }

  async listMachines(poolId?: string): Promise<HorizonMachine[]> {
    const api = await this.api();
    return api.get<HorizonMachine[]>("/rest/inventory/v1/machines", {
      filter: poolId ? JSON.stringify({ type: "Equals", name: "desktop_pool_id", value: poolId }) : undefined
    });
  }

  async listSessions(): Promise<HorizonSession[]> {
    const api = await this.api();
    return api.get<HorizonSession[]>("/rest/inventory/v1/sessions");
  }

  /** Session control: action is "logoff", "disconnect", or "restart". */
  async sessionAction(sessionIds: string[], action: "logoff" | "disconnect" | "restart"): Promise<void> {
    const api = await this.api();
    await api.post(`/rest/inventory/v1/sessions/action/${action}`, sessionIds);
  }

  async sendMessage(sessionIds: string[], messageType: string, message: string): Promise<void> {
    const api = await this.api();
    await api.post("/rest/inventory/v1/sessions/action/send-message", {
      ids: sessionIds,
      message_type: messageType,
      message
    });
  }

  /** Toggle maintenance mode on a machine. */
  async setMaintenance(machineIds: string[], on: boolean): Promise<void> {
    const api = await this.api();
    const action = on ? "enter-maintenance" : "exit-maintenance";
    await api.post(`/rest/inventory/v1/machines/action/${action}`, machineIds);
  }

  // ── Monitor (infrastructure health) ───────────────────────────────────────

  /**
   * Health of the core Horizon infrastructure components (Monitor API). Each
   * component endpoint is queried independently and tolerated if absent, so a
   * partial deployment still yields a usable health picture.
   */
  async monitorHealth(): Promise<{
    connectionServers: HorizonMonitorComponent[];
    gateways: HorizonMonitorComponent[];
  }> {
    const api = await this.api();
    const [connectionServers, gateways] = await Promise.all([
      api.get<HorizonMonitorComponent[]>("/rest/monitor/v2/connection-servers").catch(() => []),
      api.get<HorizonMonitorComponent[]>("/rest/monitor/v2/gateways").catch(() => [])
    ]);
    return { connectionServers, gateways };
  }

  // ── Help Desk (per-user troubleshooting) ──────────────────────────────────

  /** Help Desk session detail, optionally scoped to a user (richer than inventory). */
  async helpdeskSessions(userName?: string): Promise<Record<string, unknown>[]> {
    const api = await this.api();
    return api.get<Record<string, unknown>[]>("/rest/helpdesk/v1/sessions", {
      filter: userName ? JSON.stringify({ type: "Equals", name: "user_name", value: userName }) : undefined
    });
  }

  // ── Config (instant-clone image push / recompose) ─────────────────────────

  /** Schedule an instant-clone image push (recompose) for a desktop pool. */
  async pushImage(poolId: string, spec: HorizonPushImageSpec): Promise<void> {
    const api = await this.api();
    await api.post(`/rest/inventory/v1/desktop-pools/${encodeURIComponent(poolId)}/action/schedule-push-image`, {
      parent_vm_id: spec.parentVmId,
      snapshot_id: spec.snapshotId,
      start_time: spec.startTime,
      logoff_policy: spec.logoffPolicy ?? "WAIT_FOR_LOGOFF",
      stop_on_first_error: spec.stopOnFirstError ?? true,
      add_virtual_tpm: spec.addVirtualTpm
    });
  }
}
