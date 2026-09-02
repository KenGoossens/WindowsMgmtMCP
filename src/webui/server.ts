import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server as HttpServer } from "node:http";
import type { Logger } from "../core/logger.js";
import type { WebUiMcpClient } from "./mcpClient.js";

export interface WebUiServerOptions {
  client: WebUiMcpClient;
  logger: Logger;
  /** Directory of the built web app to serve (optional; API works without it). */
  staticDir?: string;
}

export interface WebUiServer {
  app: express.Express;
  /** Re-read telemetry and push it to all connected SSE clients. */
  broadcastTelemetry(): Promise<void>;
  listen(host: string, port: number): Promise<HttpServer>;
}

/** Write one named SSE event to a response. */
function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * The backend-for-frontend: a small REST + SSE surface over the MCP client that
 * the mission-control web app consumes. It exposes the tool catalogue, a
 * tool-call endpoint (which transparently carries the risk-gate confirm flow),
 * the unified fleet snapshot, alerts, and a live Server-Sent-Events stream.
 */
export function createWebUiServer(opts: WebUiServerOptions): WebUiServer {
  const { client, logger } = opts;
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Permissive CORS for loopback dev (the BFF binds 127.0.0.1). Harmless for a
  // local single-operator console; tighten if ever exposed beyond localhost.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  const sseClients = new Set<Response>();

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", connected: client.isConnected() });
  });

  app.get("/api/tools", async (_req: Request, res: Response) => {
    try {
      res.json({ tools: await client.listTools() });
    } catch (err) {
      logger.warn({ err }, "webui: listTools failed");
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tools/:name", async (req: Request, res: Response) => {
    const name = req.params.name;
    const args = (req.body ?? {}) as Record<string, unknown>;
    try {
      const started = Date.now();
      const result = await client.callTool(name, args);
      const durationMs = Date.now() - started;
      res.json({ ...result, durationMs });
      // A mutating call may change fleet state; refresh subscribers shortly after.
      if (!result.confirmationRequired && !result.isError) {
        setTimeout(() => void broadcastTelemetry(), 300);
      }
    } catch (err) {
      logger.warn({ err, tool: name }, "webui: callTool failed");
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/fleet", async (_req: Request, res: Response) => {
    try {
      res.json(await client.fleet());
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/alerts", async (_req: Request, res: Response) => {
    try {
      res.json(await client.alerts());
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Live telemetry stream (Server-Sent Events).
  app.get("/stream", async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    sseClients.add(res);
    logger.debug({ clients: sseClients.size }, "webui: SSE client connected");

    // Prime the new client with the current state.
    try {
      sse(res, "fleet", await client.fleet());
    } catch (err) {
      sse(res, "error", { message: err instanceof Error ? err.message : String(err) });
    }

    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
      logger.debug({ clients: sseClients.size }, "webui: SSE client disconnected");
    });
  });

  // Optionally serve the built web app (SPA) for same-origin production use.
  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir));
    app.get(/^(?!\/api\/|\/stream).*/, (_req: Request, res: Response) => {
      res.sendFile(join(opts.staticDir as string, "index.html"));
    });
    logger.info({ staticDir: opts.staticDir }, "webui: serving built web app");
  }

  async function broadcastTelemetry(): Promise<void> {
    if (sseClients.size === 0) return;
    try {
      const fleet = await client.fleet();
      for (const res of sseClients) sse(res, "fleet", fleet);
    } catch (err) {
      logger.debug({ err }, "webui: telemetry broadcast failed");
    }
  }

  return {
    app,
    broadcastTelemetry,
    listen: (host, port) =>
      new Promise((resolve) => {
        const server = app.listen(port, host, () => resolve(server));
      })
  };
}
