import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config/schema.js";
import type { Logger } from "./logger.js";
import type { AuditLogger } from "./audit.js";
import { RiskGate, type RiskDecision } from "./riskGate.js";
import { AppError, PowerShellError, PowerShellTimeoutError } from "./errors.js";
import type { ReportingService } from "../reporting/collector.js";
import type { StatePortabilityService } from "../state/statePortability.js";
import type { MigrationOrchestrator } from "../orchestration/migrationOrchestrator.js";
import type { ContinuityController } from "../orchestration/continuityController.js";
import type { AgentRegistry } from "../agent/registry.js";
import type { OnboardingService } from "../onboarding/service.js";
import type { Principal } from "../saas/principal.js";
import { authorizeTool } from "../saas/principal.js";
import type { QuotaManager } from "../saas/quota.js";
import type { Authenticator } from "../saas/auth.js";

/** Shared services every tool handler can use. */
export interface ToolContext {
  config: AppConfig;
  logger: Logger;
  audit: AuditLogger;
  riskGate: RiskGate;
  /** Present when the real-time reporting subsystem is enabled. */
  reporting?: ReportingService;
  /** Present when the state-portability subsystem is enabled (encryption key set). */
  state?: StatePortabilityService;
  /** Present when the migration orchestrator is enabled (requires state). */
  migration?: MigrationOrchestrator;
  /** Present when the continuity/failover controller is enabled (requires state). */
  continuity?: ContinuityController;
  /** Present when the agent broker is enabled. */
  agents?: AgentRegistry;
  /** Tenant onboarding / access provisioning (always available). */
  onboarding?: OnboardingService;
  /** The authenticated caller for this session. Absent = full local trust. */
  principal?: Principal;
  /** Per-principal quota enforcer (present when SaaS multi-tenancy is active). */
  quota?: QuotaManager;
  /** Resolves a presented credential to a principal (HTTP transport auth). */
  authenticator?: Authenticator;
}

/** The MCP content shape every tool returns. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(data: unknown): ToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** A self-describing, validated, risk-gated tool. */
export interface ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  /** State-changing tools gain an automatic `confirm` flag and risk-gate handling. */
  mutating?: boolean;
  /** Extra-dangerous (reprovision, kill, restore, …) — surfaced via annotations. */
  destructive?: boolean;
  idempotent?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

const confirmField = z
  .boolean()
  .optional()
  .describe(
    "Set to true to execute this state-changing operation. Omit or set false to receive a safety preview without making any changes."
  );

/** Map any thrown value to a user-facing, non-leaking tool error result. */
export function mapErrorToToolResult(err: unknown): ToolResult {
  if (err instanceof PowerShellTimeoutError) {
    return errorResult(`PowerShell timed out: ${err.message}`);
  }
  if (err instanceof PowerShellError) {
    return errorResult(`PowerShell error: ${err.message}${err.stderr ? `\n${err.stderr}` : ""}`);
  }
  if (err instanceof AppError) {
    return errorResult(`${err.name}: ${err.message}`);
  }
  const apiErr = err as { statusCode?: number; code?: string; message?: string };
  if (apiErr && typeof apiErr.statusCode === "number") {
    return errorResult(
      `API error ${apiErr.statusCode}${apiErr.code ? ` (${apiErr.code})` : ""}: ${apiErr.message ?? "request failed"}`
    );
  }
  return errorResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
}

function previewResult(spec: ToolSpec, decision: RiskDecision): ToolResult {
  return jsonResult({
    status: "confirmation_required",
    tool: spec.name,
    riskLevel: decision.level,
    riskScore: decision.score,
    reasons: decision.reasons,
    message: `This is a ${decision.level} operation and was NOT executed. Re-invoke with "confirm": true to proceed.`
  });
}

/**
 * Register a tool on the MCP server, wiring the cross-cutting concerns once:
 * allow-listing, risk gating, destructive-op `confirm` handling, audit logging,
 * and typed error mapping. Providers describe *what* a tool does; this function
 * enforces *how* it is allowed to run.
 */
export function registerTool<S extends z.ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  spec: ToolSpec<S>
): void {
  const { config, audit, riskGate, logger } = ctx;

  if (config.toolAllowlist && config.toolAllowlist.length > 0 && !config.toolAllowlist.includes(spec.name)) {
    logger.warn({ tool: spec.name }, "tool excluded by allow-list; not registered");
    return;
  }

  // Per-principal least-disclosure: do not even expose a tool the authenticated
  // caller could never invoke (e.g. arbitrary-execution tools for a third-party
  // integration). Call-time authorization below remains as defence-in-depth.
  if (ctx.principal && !authorizeTool(ctx.principal, spec.name).allowed) {
    logger.debug({ tool: spec.name, principal: ctx.principal.id }, "tool not exposed to principal");
    return;
  }

  const inputSchema: z.ZodRawShape = spec.mutating
    ? { ...spec.inputSchema, confirm: confirmField }
    : { ...spec.inputSchema };

  const handler = async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
    const principal = ctx.principal;
    const handle = audit.begin({
      tool: spec.name,
      args: rawArgs,
      transport: config.transport,
      caller: principal?.id,
      tenantId: principal?.tenantId
    });
    try {
      // Per-principal authorization: allow/deny-list and the third-party
      // arbitrary-execution posture (enforced at call time, per caller).
      if (principal) {
        const authz = authorizeTool(principal, spec.name);
        if (!authz.allowed) {
          handle.end("blocked", { reason: authz.reason });
          return errorResult(`Not authorized: ${authz.reason}`);
        }
        // Per-principal quota / rate limit (isolated per tenant).
        if (ctx.quota) {
          const q = ctx.quota.check(principal.id, principal.quota);
          if (!q.allowed) {
            handle.end("blocked", { reason: `quota:${q.limit}` });
            return errorResult(
              `Quota exceeded (${q.limit} limit). Retry after ${q.retryAfterSec ?? 0}s.`
            );
          }
        }
      }

      const decision = riskGate.evaluate({
        tool: spec.name,
        mutating: spec.mutating,
        destructive: spec.destructive,
        args: rawArgs
      });

      if (decision.disposition === "block") {
        handle.end("blocked", { score: decision.score, reasons: decision.reasons });
        return errorResult(
          `Blocked by risk gate (score ${decision.score}). Reasons: ${decision.reasons.join("; ")}`
        );
      }

      const confirmed = rawArgs.confirm === true;
      if (decision.disposition === "confirm" && !confirmed) {
        handle.end("dry-run", { score: decision.score, reasons: decision.reasons });
        return previewResult(spec as ToolSpec, decision);
      }

      const result = await spec.handler(rawArgs as z.infer<z.ZodObject<S>>, ctx);
      handle.end(result.isError ? "error" : "ok", { score: decision.score });
      return result;
    } catch (err) {
      handle.end("error", { error: err instanceof Error ? err.message : String(err) });
      logger.error({ err, tool: spec.name }, "tool handler threw");
      return mapErrorToToolResult(err);
    }
  };

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema,
      annotations: {
        title: spec.title,
        readOnlyHint: !spec.mutating,
        destructiveHint: Boolean(spec.destructive),
        idempotentHint: spec.idempotent ?? false,
        openWorldHint: true
      }
    },
    handler as unknown as ToolCallback<z.ZodRawShape>
  );
}
