#!/usr/bin/env node
import { loadConfig } from "./config/config.js";
import { createLogger } from "./core/logger.js";
import { AuditLogger } from "./core/audit.js";
import { RiskGate } from "./core/riskGate.js";
import type { ToolContext } from "./core/tools.js";
import { ReportingService, type MetricSource, type AlertSink } from "./reporting/collector.js";
import { StateStore } from "./state/store.js";
import { StatePortabilityService } from "./state/statePortability.js";
import { JobManager } from "./orchestration/jobs.js";
import { MigrationOrchestrator } from "./orchestration/migrationOrchestrator.js";
import { ContinuityController } from "./orchestration/continuityController.js";
import { AgentRegistry } from "./agent/registry.js";
import { OnboardingService } from "./onboarding/service.js";
import { IntegrationRegistry } from "./saas/integrations.js";
import { QuotaManager } from "./saas/quota.js";
import { createAuthenticator } from "./saas/auth.js";
import { SYSTEM_PRINCIPAL } from "./saas/principal.js";
import { createProviderRegistry } from "./server.js";
import { startStdio, type TransportHandle } from "./transports/stdio.js";
import { startHttp } from "./transports/http.js";

type TransportName = "stdio" | "http";

function parseArgs(argv: string[]): { transport?: TransportName } {
  const result: { transport?: TransportName } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--transport") {
      const value = argv[i + 1];
      if (value === "stdio" || value === "http") result.transport = value;
      i++;
    }
  }
  return result;
}

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const transport: TransportName = args.transport ?? baseConfig.transport;
  const config = { ...baseConfig, transport };

  const logger = createLogger(config.logLevel);
  const audit = new AuditLogger(config.auditLogPath, logger);
  const riskGate = new RiskGate();
  const ctx: ToolContext = { config, logger, audit, riskGate, principal: SYSTEM_PRINCIPAL };

  const registry = createProviderRegistry(ctx);

  // SaaS multi-tenancy: per-integration principals, per-principal quota, and the
  // authenticator (static/per-integration bearer, or OAuth 2.1 JWT). The HTTP
  // transport resolves a principal per session; stdio runs as the system
  // principal (full local trust).
  const integrations = IntegrationRegistry.fromConfig(config, logger);
  ctx.quota = new QuotaManager();
  ctx.authenticator = createAuthenticator(config, integrations, logger);
  if (integrations) {
    logger.info(
      { mode: config.authMode, multiTenant: config.multiTenant, integrations: integrations.size },
      "SaaS multi-tenant auth enabled"
    );
  }

  // Tenant onboarding is always available — it is the bootstrap that grants the
  // server access to each substrate, so it must work before any creds exist.
  ctx.onboarding = new OnboardingService(registry, logger);

  // Real-time reporting: collect normalized telemetry from providers that
  // advertise getMetrics() and are available in this environment.
  let reporting: ReportingService | undefined;
  if (config.reportingEnabled) {
    reporting = new ReportingService(
      {
        pollIntervalMs: config.reportingPollIntervalMs,
        retentionMinutes: config.reportingRetentionMinutes,
        maxSamples: config.reportingMaxSamples
      },
      logger
    );
    const sources: MetricSource[] = [];
    for (const provider of registry.list()) {
      if (typeof provider.getMetrics !== "function") continue;
      if (!(await provider.isAvailable())) continue;
      const getMetrics = provider.getMetrics.bind(provider);
      sources.push({ id: provider.id, displayName: provider.displayName, getMetrics });
    }
    reporting.setSources(sources);

    // Outbound alert sinks: forward newly-fired alerts to external admin consoles.
    if (config.citrixNotificationsEnabled) {
      const citrix = registry.list().find((p) => p.id === "citrix");
      const sinkable = citrix as unknown as { createAlertSink?: () => AlertSink } | undefined;
      if (citrix && (await citrix.isAvailable()) && typeof sinkable?.createAlertSink === "function") {
        reporting.addAlertSink(sinkable.createAlertSink());
        logger.info("citrix notifications alert sink enabled");
      } else {
        logger.warn("CITRIX_NOTIFICATIONS_ENABLED is set but the Citrix provider is unavailable; alert sink not wired");
      }
    }

    reporting.start();
    ctx.reporting = reporting;
  }

  // State & settings portability: enabled when an encryption key is configured
  // (StateBundles may carry PII, so at-rest encryption is mandatory).
  if (config.stateEncryptionKey) {
    const store = new StateStore(config.stateStoreUri, config.stateEncryptionKey, config.stateRetentionDays);
    void store.purgeExpired().catch((err) => logger.warn({ err }, "state retention purge failed"));
    const stateSvc = new StatePortabilityService(store, registry, logger);
    ctx.state = stateSvc;
    logger.info({ store: config.stateStoreUri, retentionDays: config.stateRetentionDays }, "state portability enabled");

    // Migration orchestration composes the state layer; it shares the JobManager.
    const jobs = new JobManager(logger);
    ctx.migration = new MigrationOrchestrator(registry, stateSvc, jobs, logger, config.migrationRetainSource);
    logger.info({ retainSource: config.migrationRetainSource }, "migration orchestration enabled");

    // Continuity / failover reuses the same JobManager + state layer, and the
    // reporting telemetry (when enabled) for its health signal.
    ctx.continuity = new ContinuityController(
      registry,
      stateSvc,
      jobs,
      logger,
      { primary: config.continuityPrimary, secondary: config.continuitySecondary, mode: config.failoverMode },
      ctx.reporting
    );
    logger.info(
      { primary: config.continuityPrimary, secondary: config.continuitySecondary, mode: config.failoverMode },
      "continuity / failover enabled"
    );
  } else {
    logger.info("state portability disabled (set STATE_ENCRYPTION_KEY to enable)");
  }

  // Outbound client-troubleshooter-agent broker (requires the http transport to
  // actually receive agent connections; the tools register regardless).
  if (config.agentBrokerEnabled) {
    if (!config.agentEnrollmentToken) {
      logger.warn("AGENT_BROKER_ENABLED but AGENT_ENROLLMENT_TOKEN is unset; enrollment will reject all agents");
    }
    ctx.agents = new AgentRegistry(
      {
        enrollmentToken: config.agentEnrollmentToken,
        maxAutonomy: config.agentMaxAutonomy,
        staleSeconds: config.agentStaleSeconds
      },
      logger
    );
    if (transport !== "http") {
      logger.warn("agent broker enabled but transport is not http; agents cannot connect until http is used");
    }
    logger.info({ maxAutonomy: config.agentMaxAutonomy }, "agent broker enabled");
  }

  let handle: TransportHandle;
  if (transport === "http") {
    handle = await startHttp(ctx, registry);
  } else {
    handle = await startStdio(ctx, registry);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    try {
      await handle.close();
      reporting?.stop();
      ctx.agents?.dispose();
      await registry.disposeAll();
      await audit.close();
    } catch (err) {
      logger.error({ err }, "error during shutdown");
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // For stdio, exit cleanly when the client disconnects (stdin closes).
  if (transport === "stdio") {
    process.stdin.on("end", () => void shutdown("stdin-end"));
    process.stdin.on("close", () => void shutdown("stdin-close"));
  }
}

main().catch((err) => {
  // Logger may not exist yet on a config failure; stderr is always safe.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
