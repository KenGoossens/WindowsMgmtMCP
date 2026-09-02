import type { Express, Request, Response } from "express";
import type { Logger } from "../core/logger.js";
import type { AgentRegistry } from "../agent/registry.js";
import type { AgentCommandResult, EnrollRequest } from "../agent/protocol.js";

/**
 * Mount the outbound-agent broker channel onto the existing Express host
 * (technical spec, Ch. 12 — an additive channel on the HTTP host, not a
 * replacement). Endpoints are outbound-dialed by agents:
 *
 *   POST /agent/enroll     — present enrollment token + attestation, get a ceiling
 *   POST /agent/heartbeat  — liveness
 *   GET  /agent/commands   — long-poll for queued commands
 *   POST /agent/results    — return a command result
 *
 * MVP trust model: a shared enrollment token (production hardening: mTLS +
 * hardware attestation), consistent with the bearer-token → OAuth path for /mcp.
 */
export function mountAgentBroker(app: Express, registry: AgentRegistry, logger: Logger): void {
  // Enrollment: gate on the shared token; capture the attestation claim.
  app.post("/agent/enroll", (req: Request, res: Response) => {
    const token = bearer(req);
    if (!registry.verifyEnrollmentToken(token)) {
      res.status(401).json({ error: "invalid or missing enrollment token" });
      return;
    }
    const body = req.body as EnrollRequest;
    if (!body?.agentId || !body?.hostname) {
      res.status(400).json({ error: "agentId and hostname are required" });
      return;
    }
    res.json(registry.enroll(body));
  });

  // From here on, the agent must be enrolled (its id identifies it).
  app.post("/agent/heartbeat", (req: Request, res: Response) => {
    const agentId = String(req.body?.agentId ?? "");
    res.json({ ok: registry.heartbeat(agentId) });
  });

  app.get("/agent/commands", (req: Request, res: Response) => {
    const agentId = String(req.query.agentId ?? "");
    if (!registry.get(agentId)) {
      res.status(404).json({ error: "agent not enrolled" });
      return;
    }
    res.json({ commands: registry.take(agentId) });
  });

  app.post("/agent/results", (req: Request, res: Response) => {
    const result = req.body as AgentCommandResult;
    if (!result?.commandId || !result?.agentId) {
      res.status(400).json({ error: "commandId and agentId are required" });
      return;
    }
    registry.submitResult(result);
    res.json({ ok: true });
  });

  logger.info("agent broker mounted (/agent/*)");
}

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
}
