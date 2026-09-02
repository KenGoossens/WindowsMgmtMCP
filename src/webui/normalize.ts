import type { SeriesAggregate } from "../reporting/metrics.js";

/**
 * Pure normalizers that translate the MCP server's tool/telemetry shapes into
 * the compact, UI-friendly view models the web console consumes. Kept free of
 * I/O so they can be unit-tested in isolation.
 */

/** How a tool is classified for the UI (drives colour + confirm flow). */
export type ToolClass = "read" | "mutating" | "destructive";

/** The minimal tool shape we rely on from `listTools()`. */
export interface RawTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** A tool as presented to the UI. */
export interface UiTool {
  name: string;
  title: string;
  description: string;
  toolClass: ToolClass;
  /** The provider/subsystem group inferred from the tool name prefix. */
  group: string;
  inputSchema?: unknown;
}

/** Classify a tool from its MCP annotations. */
export function classifyTool(tool: RawTool): ToolClass {
  if (tool.annotations?.destructiveHint) return "destructive";
  if (tool.annotations?.readOnlyHint === false) return "mutating";
  return "read";
}

/** Infer a coarse provider/subsystem group from a tool name prefix. */
export function toolGroup(name: string): string {
  const prefixes: Record<string, string> = {
    workspace: "AWS WorkSpaces",
    avd: "Azure Virtual Desktop",
    citrix: "Citrix DaaS",
    horizoncloud: "Horizon Cloud",
    horizon: "Omnissa Horizon",
    cloudpc: "Windows 365",
    device: "Workspace ONE UEM",
    remote: "Remote Windows",
    report: "Reporting",
    alert: "Reporting",
    session: "Reporting",
    state: "State",
    settings: "State",
    migration: "Migration",
    failover: "Continuity",
    continuity: "Continuity",
    agent: "Agent",
    onboarding: "Onboarding"
  };
  for (const [prefix, group] of Object.entries(prefixes)) {
    if (name.startsWith(prefix)) return group;
  }
  // Local Windows tools have varied names (powershell_run, wmi_query, …).
  return "Local Windows";
}

/** Convert a raw MCP tool into the UI view model. */
export function toUiTool(tool: RawTool): UiTool {
  return {
    name: tool.name,
    title: tool.title ?? tool.annotations?.title ?? tool.name,
    description: tool.description ?? "",
    toolClass: classifyTool(tool),
    group: toolGroup(tool.name),
    inputSchema: tool.inputSchema
  };
}

/** Static provider→substrate map for display grouping in the fleet view. */
export const PROVIDER_SUBSTRATE: Record<string, string> = {
  local: "physical",
  remotewindows: "physical",
  windows365: "cloud",
  awsworkspaces: "daas",
  citrix: "daas",
  horizoncloud: "daas",
  avd: "vdi",
  horizon: "vdi",
  ws1uem: "device"
};

/** Friendly provider display names for the fleet view. */
export const PROVIDER_LABELS: Record<string, string> = {
  local: "Local Windows",
  remotewindows: "Remote Windows",
  windows365: "Windows 365",
  awsworkspaces: "AWS WorkSpaces",
  citrix: "Citrix DaaS",
  horizoncloud: "Horizon Cloud",
  avd: "Azure Virtual Desktop",
  horizon: "Omnissa Horizon",
  ws1uem: "Workspace ONE UEM"
};

/** Health classification for a fleet entity. */
export type Health = "ok" | "warning" | "critical" | "unknown";

/** A single metric reading on a fleet row. */
export interface FleetMetric {
  metric: string;
  value: number;
  unit?: string;
}

/** One entity (substrate / grouping / machine) in the unified fleet grid. */
export interface FleetRow {
  providerId: string;
  providerLabel: string;
  substrate: string;
  entity: string;
  health: Health;
  metrics: FleetMetric[];
  lastTs?: string;
}

/** A minimal active-alert shape (from the alerts resource). */
export interface RawAlert {
  providerId: string;
  entity: string;
  metric: string;
  value: number;
  threshold: number;
  condition: string;
  acknowledged?: boolean;
}

/**
 * Derive a health signal for an entity from its metrics and any active alerts.
 * `loadIndex > 0` means a provider reported unhealthy/unavailable members; an
 * active (unacknowledged) alert escalates to critical.
 */
export function deriveHealth(metrics: FleetMetric[], alerts: RawAlert[]): Health {
  if (alerts.some((a) => !a.acknowledged)) return "critical";
  const load = metrics.find((m) => m.metric === "loadIndex");
  if (load) return load.value > 0 ? "warning" : "ok";
  if (metrics.length === 0) return "unknown";
  return "ok";
}

/**
 * Fold a flat list of per-series aggregates (the snapshot resource) into one
 * row per `provider::entity`, attaching health from the alerts feed.
 */
export function toFleetRows(series: SeriesAggregate[], alerts: RawAlert[] = []): FleetRow[] {
  const rows = new Map<string, FleetRow>();
  for (const s of series) {
    const key = `${s.providerId}::${s.entity}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        providerId: s.providerId,
        providerLabel: PROVIDER_LABELS[s.providerId] ?? s.providerId,
        substrate: PROVIDER_SUBSTRATE[s.providerId] ?? "unknown",
        entity: s.entity,
        health: "unknown",
        metrics: [],
        lastTs: s.lastTs
      };
      rows.set(key, row);
    }
    row.metrics.push({ metric: s.metric, value: s.last, unit: s.unit });
    if (s.lastTs && (!row.lastTs || s.lastTs > row.lastTs)) row.lastTs = s.lastTs;
  }
  for (const row of rows.values()) {
    const entityAlerts = alerts.filter((a) => a.providerId === row.providerId && a.entity === row.entity);
    row.health = deriveHealth(row.metrics, entityAlerts);
  }
  return [...rows.values()].sort(
    (a, b) => a.providerLabel.localeCompare(b.providerLabel) || a.entity.localeCompare(b.entity)
  );
}

/** The parsed outcome of a tool call, distinguishing the confirm-preview path. */
export interface ParsedToolResult {
  /** True when the server returned a risk-gate confirmation preview (not executed). */
  confirmationRequired: boolean;
  /** True when the tool reported an error (isError or an error payload). */
  isError: boolean;
  /** Risk metadata when a confirmation is required. */
  risk?: { level?: string; score?: number; reasons?: string[] };
  /** Parsed JSON payload when the text content was JSON; else undefined. */
  data?: unknown;
  /** Raw text content (concatenated). */
  text: string;
}

/** The MCP tool-result shape we consume from `callTool()`. */
export interface RawToolResult {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
}

/**
 * Parse an MCP tool result: concatenate text content, JSON-decode when possible,
 * and detect the `confirmation_required` risk-gate preview so the UI can raise
 * an approval card instead of treating it as a completed action.
 */
export function parseToolResult(result: RawToolResult): ParsedToolResult {
  const text = (result.content ?? [])
    .filter((c) => (c.type ?? "text") === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }

  const obj = (data ?? {}) as Record<string, unknown>;
  const confirmationRequired = obj.status === "confirmation_required";

  return {
    confirmationRequired,
    isError: Boolean(result.isError),
    risk: confirmationRequired
      ? {
          level: typeof obj.riskLevel === "string" ? obj.riskLevel : undefined,
          score: typeof obj.riskScore === "number" ? obj.riskScore : undefined,
          reasons: Array.isArray(obj.reasons) ? (obj.reasons as string[]) : undefined
        }
      : undefined,
    data,
    text
  };
}
