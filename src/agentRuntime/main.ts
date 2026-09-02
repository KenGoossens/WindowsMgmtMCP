#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { createLogger } from "../core/logger.js";
import { PowerShellEngine, detectPowerShell } from "../core/powershell.js";
import type { AutonomyLevel } from "../agent/protocol.js";
import { AgentRuntime } from "./runtime.js";

/**
 * Entry point for the outbound client troubleshooter agent. Runs on the ENDPOINT
 * (not the server): it dials AGENT_BROKER_URL, enrolls with AGENT_ENROLLMENT_TOKEN,
 * and then executes brokered diagnostics / remediation / state-collection locally.
 */
async function main(): Promise<void> {
  loadDotenv();
  const brokerUrl = process.env.AGENT_BROKER_URL;
  const agentId = process.env.AGENT_ID;
  const enrollmentToken = process.env.AGENT_ENROLLMENT_TOKEN;
  const autonomy = (process.env.AGENT_MAX_AUTONOMY as AutonomyLevel | undefined) ?? "L1";

  if (!brokerUrl) throw new Error("AGENT_BROKER_URL is required.");
  if (!agentId) throw new Error("AGENT_ID is required.");
  if (!enrollmentToken) throw new Error("AGENT_ENROLLMENT_TOKEN is required.");

  const logger = createLogger(process.env.LOG_LEVEL ?? "info");
  const ps = new PowerShellEngine(detectPowerShell(process.env.PS_EXECUTABLE), 120_000, logger);
  const runtime = new AgentRuntime({ brokerUrl, agentId, enrollmentToken, autonomy }, ps, logger);

  await runtime.start();
  logger.info({ brokerUrl, agentId, autonomy }, "client troubleshooter agent running");

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "agent shutting down");
    runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
