/** Canonical MCP resource URIs the reporting layer exposes for live telemetry. */
export const TELEMETRY_SNAPSHOT_URI = "telemetry://fleet/snapshot";
export const TELEMETRY_ALERTS_URI = "telemetry://fleet/alerts";

export const TELEMETRY_RESOURCES = [TELEMETRY_SNAPSHOT_URI, TELEMETRY_ALERTS_URI] as const;
