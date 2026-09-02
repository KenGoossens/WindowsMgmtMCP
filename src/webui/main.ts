import "dotenv/config";
import { join } from "node:path";
import { createLogger } from "../core/logger.js";
import { WebUiMcpClient } from "./mcpClient.js";
import { createWebUiServer } from "./server.js";

/**
 * Entry point for the mission-control BFF. It connects to a running windows-mcp
 * server (Streamable HTTP) as an MCP client, then serves a small REST + SSE API
 * (and optionally the built web app) for the browser console.
 *
 * Env:
 *   WEBUI_HOST          bind host (default 127.0.0.1)
 *   WEBUI_PORT          bind port (default 4100)
 *   WEBUI_MCP_URL       MCP server endpoint (default http://127.0.0.1:3000/mcp)
 *   WEBUI_MCP_TOKEN     bearer token presented to the MCP server
 *   WEBUI_STATIC_DIR    built web app to serve (default ./web/dist)
 *   LOG_LEVEL           pino level (default info)
 */
async function main(): Promise<void> {
  const logger = createLogger(process.env.LOG_LEVEL ?? "info");
  const host = process.env.WEBUI_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.WEBUI_PORT ?? "4100", 10);
  const url = process.env.WEBUI_MCP_URL ?? "http://127.0.0.1:3000/mcp";
  const token = process.env.WEBUI_MCP_TOKEN;
  const staticDir = process.env.WEBUI_STATIC_DIR ?? join(process.cwd(), "web", "dist");

  const client = new WebUiMcpClient({ url, token, logger });
  const server = createWebUiServer({ client, logger, staticDir });

  // Debounce telemetry-change notifications into a single broadcast per burst.
  let timer: NodeJS.Timeout | undefined;
  const onTelemetryChanged = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void server.broadcastTelemetry();
    }, 250);
  };

  try {
    await client.connect(onTelemetryChanged);
  } catch (err) {
    logger.error({ err, url }, "webui: failed to connect to MCP server — is it running with --transport http?");
    // Serve anyway so the operator sees a clear 'disconnected' state rather than nothing.
  }

  const httpServer = await server.listen(host, port);
  logger.info({ host, port, mcp: url }, "mission-control web UI listening");

  const shutdown = async (): Promise<void> => {
    logger.info("webui: shutting down");
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("webui fatal:", err);
  process.exit(1);
});
