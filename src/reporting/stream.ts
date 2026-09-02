import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../core/logger.js";
import type { ReportingService } from "./collector.js";
import { aggregate } from "./metrics.js";
import { TELEMETRY_ALERTS_URI, TELEMETRY_SNAPSHOT_URI } from "./resources.js";

/**
 * Wire the live-telemetry MCP resources onto a server instance:
 *  - register readable `telemetry://fleet/{snapshot,alerts}` resources;
 *  - handle resources/subscribe + resources/unsubscribe to track interest;
 *  - on each collector tick, push notifications/resources/updated to subscribers.
 *
 * Returns a cleanup function that detaches the collector listener (call on close).
 */
export function registerReportingResources(
  server: McpServer,
  reporting: ReportingService,
  logger: Logger
): () => void {
  const subscribed = new Set<string>();

  server.registerResource(
    "fleet-snapshot",
    TELEMETRY_SNAPSHOT_URI,
    {
      title: "Live fleet snapshot",
      description: "Latest normalized metrics per series across all available substrates.",
      mimeType: "application/json"
    },
    () => {
      const latest = reporting.store.latest();
      return {
        contents: [
          {
            uri: TELEMETRY_SNAPSHOT_URI,
            mimeType: "application/json",
            text: JSON.stringify(
              { ts: new Date().toISOString(), series: aggregate(latest) },
              null,
              2
            )
          }
        ]
      };
    }
  );

  server.registerResource(
    "fleet-alerts",
    TELEMETRY_ALERTS_URI,
    {
      title: "Live active alerts",
      description: "Currently active threshold alerts across the fleet.",
      mimeType: "application/json"
    },
    () => ({
      contents: [
        {
          uri: TELEMETRY_ALERTS_URI,
          mimeType: "application/json",
          text: JSON.stringify(
            { ts: new Date().toISOString(), active: reporting.alerts.listActive() },
            null,
            2
          )
        }
      ]
    })
  );

  // Track subscriptions so we only notify interested clients.
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscribed.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscribed.delete(request.params.uri);
    return {};
  });

  const off = reporting.onUpdate((result) => {
    // The snapshot always changes; alerts only when something fired/cleared.
    const toNotify = new Set<string>();
    if (subscribed.has(TELEMETRY_SNAPSHOT_URI)) toNotify.add(TELEMETRY_SNAPSHOT_URI);
    if (subscribed.has(TELEMETRY_ALERTS_URI) && result.firedAlerts.length > 0) {
      toNotify.add(TELEMETRY_ALERTS_URI);
    }
    for (const uri of toNotify) {
      server.server.sendResourceUpdated({ uri }).catch((err) => {
        logger.debug({ err, uri }, "failed to send resource update");
      });
    }
  });

  return off;
}
