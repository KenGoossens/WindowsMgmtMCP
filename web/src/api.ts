// Thin typed client over the BFF REST + SSE surface.

export type ToolClass = "read" | "mutating" | "destructive";
export type Health = "ok" | "warning" | "critical" | "unknown";

export interface UiTool {
  name: string;
  title: string;
  description: string;
  toolClass: ToolClass;
  group: string;
  inputSchema?: JsonSchema;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
}

export interface JsonSchemaProp {
  type?: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  items?: { type?: string; enum?: string[] };
}

export interface FleetMetric {
  metric: string;
  value: number;
  unit?: string;
}

export interface FleetRow {
  providerId: string;
  providerLabel: string;
  substrate: string;
  entity: string;
  health: Health;
  metrics: FleetMetric[];
  lastTs?: string;
}

export interface Fleet {
  ts: string;
  rows: FleetRow[];
}

export interface ToolResult {
  confirmationRequired: boolean;
  isError: boolean;
  risk?: { level?: string; score?: number; reasons?: string[] };
  data?: unknown;
  text: string;
  durationMs?: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchTools(): Promise<UiTool[]> {
  const { tools } = await getJson<{ tools: UiTool[] }>("/api/tools");
  return tools;
}

export async function fetchFleet(): Promise<Fleet> {
  return getJson<Fleet>("/api/fleet");
}

export async function fetchHealth(): Promise<{ status: string; connected: boolean }> {
  return getJson<{ status: string; connected: boolean }>("/api/health");
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await fetch(`/api/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as ToolResult;
}

/** Subscribe to the live fleet SSE stream. Returns an unsubscribe function. */
export function subscribeFleet(onFleet: (f: Fleet) => void, onError?: (e: Event) => void): () => void {
  const es = new EventSource("/stream");
  es.addEventListener("fleet", (ev) => {
    try {
      onFleet(JSON.parse((ev as MessageEvent).data) as Fleet);
    } catch {
      /* ignore malformed frame */
    }
  });
  if (onError) es.onerror = onError;
  return () => es.close();
}
