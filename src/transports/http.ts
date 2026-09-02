import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../core/tools.js";
import type { Principal } from "../saas/principal.js";
import type { ProviderRegistry } from "../providers/provider.js";
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from "../server.js";
import { mountAgentBroker } from "./agentBroker.js";
import type { TransportHandle } from "./stdio.js";

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Minimal HTML-escape for values reflected into the onboarding callback page. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Start the server over the Streamable HTTP transport with session management.
 *
 * Security: bearer-token auth on `/mcp`, loopback binding by default, and
 * DNS-rebinding protection via Host-header validation (technical spec, Ch. 13).
 */
export async function startHttp(ctx: ToolContext, registry: ProviderRegistry): Promise<TransportHandle> {
  const { config, logger } = ctx;
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  const allowedHosts = [
    `${config.httpHost}:${config.httpPort}`,
    `127.0.0.1:${config.httpPort}`,
    `localhost:${config.httpPort}`
  ];

  // Unauthenticated liveness probe.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
  });

  // Outbound-agent broker (additive channel; enabled when the registry exists).
  if (ctx.agents) {
    mountAgentBroker(app, ctx.agents, logger);
  }

  // Onboarding consent redirect landing. Entra redirects the admin here after
  // tenant-wide consent with ?admin_consent=True&tenant={id} (or an error). We
  // only render a result page; verification is done via the onboarding_status
  // tool (a live read), never trusting the redirect alone.
  app.get("/onboarding/callback", (req: Request, res: Response) => {
    const granted = String(req.query.admin_consent ?? "").toLowerCase() === "true";
    const tenant = typeof req.query.tenant === "string" ? req.query.tenant : undefined;
    const error = typeof req.query.error === "string" ? req.query.error : undefined;
    const errorDesc = typeof req.query.error_description === "string" ? req.query.error_description : undefined;
    logger.info({ granted, tenant, error }, "onboarding consent callback");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const title = error ? "Consent not completed" : granted ? "Consent granted" : "Consent callback";
    const body = error
      ? `<p>The provider reported an error: <code>${escapeHtml(error)}</code></p><p>${escapeHtml(errorDesc ?? "")}</p>`
      : granted
        ? `<p>Admin consent was granted${tenant ? ` for tenant <code>${escapeHtml(tenant)}</code>` : ""}.</p>
           <p>Return to your admin tool and run <code>onboarding_status</code> to verify the server now has access.</p>`
        : `<p>Received the consent callback. Run <code>onboarding_status</code> to verify access.</p>`;
    res.send(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
        `<style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:640px;margin:64px auto;padding:0 20px;color:#1c2333}` +
        `code{background:#eef1f6;border:1px solid #e4e8f0;border-radius:6px;padding:.1em .4em}h1{font-size:22px}</style></head>` +
        `<body><h1>${title}</h1>${body}</body></html>`
    );
  });

  const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
    try {
      const principal = ctx.authenticator ? await ctx.authenticator.authenticate(token) : undefined;
      if (!principal) {
        jsonRpcError(res, 401, -32001, "Unauthorized: a valid bearer token is required.");
        return;
      }
      res.locals.principal = principal;
      next();
    } catch (err) {
      logger.warn({ err }, "authentication error");
      jsonRpcError(res, 401, -32001, "Unauthorized: a valid bearer token is required.");
    }
  };

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", requireAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId || !isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32000, "No valid session; send an initialize request first.");
        return;
      }
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableDnsRebindingProtection: true,
        allowedHosts,
        onsessioninitialized: (sid) => {
          transports.set(sid, newTransport);
          logger.info({ sessionId: sid }, "MCP HTTP session initialised");
        }
      });
      newTransport.onclose = () => {
        if (newTransport.sessionId) transports.delete(newTransport.sessionId);
      };
      // Bind this session to its authenticated caller so the tool registrar can
      // enforce per-principal authorization, quotas, and per-tenant credentials.
      const principal = res.locals.principal as Principal;
      const sessionCtx: ToolContext = { ...ctx, principal };
      const server = await buildMcpServer(sessionCtx, registry);
      await server.connect(newTransport);
      transport = newTransport;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session id");
      return;
    }
    await transport.handleRequest(req, res);
  };

  // Server-to-client notifications (SSE) and session teardown.
  app.get("/mcp", requireAuth, handleSessionRequest);
  app.delete("/mcp", requireAuth, handleSessionRequest);

  const httpServer: HttpServer = await new Promise((resolve) => {
    const server = app.listen(config.httpPort, config.httpHost, () => resolve(server));
  });
  logger.info(
    { host: config.httpHost, port: config.httpPort },
    "MCP server listening (Streamable HTTP)"
  );

  return {
    close: async () => {
      for (const transport of transports.values()) {
        try {
          await transport.close();
        } catch (err) {
          logger.warn({ err }, "error closing HTTP transport");
        }
      }
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve()))
      );
    }
  };
}
