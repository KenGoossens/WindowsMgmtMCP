import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, type ToolContext, type ToolSpec } from "../core/tools.js";
import type { ReportingService } from "./collector.js";
import { aggregate, METRIC_LABELS } from "./metrics.js";
import { TELEMETRY_ALERTS_URI, TELEMETRY_SNAPSHOT_URI } from "./resources.js";

const metricKind = z.enum([
  "cpu",
  "memory",
  "disk",
  "gpu",
  "logonDuration",
  "protocolLatency",
  "sessionCount",
  "loadIndex"
]);

const comparison = z.enum([">", ">=", "<", "<=", "=="]);

/**
 * Register the real-time reporting & telemetry tools (Chapter 11). Snapshot and
 * query answer "what is it now / over time"; subscribe / session_monitor point a
 * client at the live MCP telemetry resources; alert_* manage threshold rules.
 */
export function registerReportingTools(
  server: McpServer,
  ctx: ToolContext,
  reporting: ReportingService
): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── report_snapshot ──────────────────────────────────────────────────────────
  reg({
    name: "report_snapshot",
    title: "Fleet snapshot",
    description:
      "Unified point-in-time telemetry across every available substrate: a live pull of per-provider metrics plus current active alerts.",
    inputSchema: {
      providerId: z.string().optional().describe("Limit the snapshot to one provider id.")
    },
    handler: async (args) => {
      const snap = await reporting.snapshot(args.providerId ? { providerId: args.providerId } : undefined);
      const samples = args.providerId
        ? snap.samples.filter((s) => s.providerId === args.providerId)
        : snap.samples;
      return jsonResult({
        ts: snap.ts,
        providers: snap.providers,
        metrics: aggregate(samples).map((a) => ({
          provider: a.providerId,
          entity: a.entity,
          metric: a.metric,
          label: METRIC_LABELS[a.metric],
          value: a.last,
          unit: a.unit
        })),
        activeAlerts: snap.activeAlerts
      });
    }
  });

  // ── report_query ─────────────────────────────────────────────────────────────
  reg({
    name: "report_query",
    title: "Query telemetry history",
    description:
      "Query the normalized telemetry history with per-series aggregates (count/min/max/avg/last) over a time range.",
    inputSchema: {
      metric: metricKind.optional().describe("Restrict to a single metric kind."),
      providerId: z.string().optional().describe("Restrict to one provider id."),
      entity: z.string().optional().describe("Restrict to one entity (machine/session/substrate id)."),
      rangeMinutes: z
        .number()
        .int()
        .min(1)
        .max(10_080)
        .optional()
        .describe("Look-back window in minutes (default 60).")
    },
    handler: (args) => {
      const rangeMinutes = args.rangeMinutes ?? 60;
      const sinceMs = Date.now() - rangeMinutes * 60_000;
      const rows = reporting.store.query({
        metric: args.metric,
        providerId: args.providerId,
        entity: args.entity,
        sinceMs
      });
      return jsonResult({
        rangeMinutes,
        totalSamples: rows.length,
        series: aggregate(rows)
      });
    }
  });

  // ── report_subscribe ─────────────────────────────────────────────────────────
  reg({
    name: "report_subscribe",
    title: "Subscribe to live telemetry",
    description:
      "Return the MCP resource URIs that stream live telemetry. Subscribe to them via resources/subscribe to receive notifications/resources/updated as state and metrics change.",
    inputSchema: {},
    handler: () =>
      jsonResult({
        resources: [
          { uri: TELEMETRY_SNAPSHOT_URI, description: "Live fleet snapshot (metrics + provider availability)." },
          { uri: TELEMETRY_ALERTS_URI, description: "Live active-alerts feed." }
        ],
        howTo: "Call resources/subscribe with one of these URIs; updates arrive as notifications/resources/updated."
      })
  });

  // ── report_unsubscribe ───────────────────────────────────────────────────────
  reg({
    name: "report_unsubscribe",
    title: "Unsubscribe from live telemetry",
    description: "Guidance to cancel a live telemetry subscription (use resources/unsubscribe with the resource URI).",
    inputSchema: {
      uri: z.string().optional().describe("The telemetry resource URI to unsubscribe from.")
    },
    handler: (args) =>
      jsonResult({
        message: "Use the MCP resources/unsubscribe request with the resource URI to stop updates.",
        uri: args.uri ?? null
      })
  });

  // ── session_monitor ──────────────────────────────────────────────────────────
  reg({
    name: "session_monitor",
    title: "Monitor an entity",
    description: "Latest live metrics for a specific entity (machine / session / substrate id) across providers.",
    inputSchema: {
      entity: z.string().min(1).describe("The entity id to monitor (e.g. a machine or substrate id)."),
      providerId: z.string().optional().describe("Optionally scope to one provider id.")
    },
    handler: async (args) => {
      await reporting.collectOnce();
      const latest = reporting.store.latest({ entity: args.entity, providerId: args.providerId });
      return jsonResult({
        entity: args.entity,
        metrics: latest.map((s) => ({
          provider: s.providerId,
          metric: s.metric,
          label: METRIC_LABELS[s.metric],
          value: s.value,
          unit: s.unit,
          ts: s.ts
        })),
        subscribeForLiveUpdates: TELEMETRY_SNAPSHOT_URI
      });
    }
  });

  // ── alert_define ─────────────────────────────────────────────────────────────
  reg({
    name: "alert_define",
    title: "Define an alert rule",
    description:
      "Register a threshold alert. When a matching metric breaches the condition, an active alert opens and the telemetry alerts resource updates.",
    inputSchema: {
      metric: metricKind.describe("The metric kind to watch."),
      condition: comparison.describe("Comparison operator."),
      threshold: z.number().describe("Threshold value the metric is compared against."),
      providerId: z.string().optional().describe("Scope the rule to one provider id."),
      entity: z.string().optional().describe("Scope the rule to one entity id."),
      description: z.string().optional().describe("Human-readable description of the rule.")
    },
    handler: (args) => {
      const rule = reporting.alerts.define({
        metric: args.metric,
        condition: args.condition,
        threshold: args.threshold,
        scope: { providerId: args.providerId, entity: args.entity },
        description: args.description
      });
      return jsonResult({ status: "created", rule });
    }
  });

  // ── alert_list ───────────────────────────────────────────────────────────────
  reg({
    name: "alert_list",
    title: "List alerts",
    description: "List configured alert rules and currently active alerts.",
    inputSchema: {},
    handler: () =>
      jsonResult({
        rules: reporting.alerts.listRules(),
        active: reporting.alerts.listActive()
      })
  });

  // ── alert_ack ────────────────────────────────────────────────────────────────
  reg({
    name: "alert_ack",
    title: "Acknowledge an alert",
    description: "Acknowledge an active alert by id (it remains active until the condition clears).",
    inputSchema: {
      alertId: z.string().min(1).describe("The active alert id to acknowledge.")
    },
    handler: (args) => {
      const ok = reporting.alerts.acknowledge(args.alertId);
      return jsonResult({ acknowledged: ok, alertId: args.alertId });
    }
  });
}
