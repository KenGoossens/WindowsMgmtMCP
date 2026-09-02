import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, errorResult, type ToolContext, type ToolSpec } from "../core/tools.js";
import { AUTONOMY_LABEL } from "./protocol.js";
import type { AgentRegistry } from "./registry.js";

/**
 * Register the client-troubleshooter-agent tools (spec §14.8). These dispatch
 * commands to outbound, enrolled endpoint agents through the {@link AgentRegistry}
 * and await the agent's result. `agent_remediate` is the only mutating one and
 * runs the self-verifying loop on-device under the agent's autonomy ceiling.
 */
export function registerAgentTools(server: McpServer, ctx: ToolContext, registry: AgentRegistry): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── agent_list ───────────────────────────────────────────────────────────────
  reg({
    name: "agent_list",
    title: "List enrolled agents",
    description: "List enrolled endpoint agents with their status, autonomy ceiling, and allow-list.",
    inputSchema: {
      status: z.enum(["online", "stale", "offline"]).optional().describe("Filter by agent status.")
    },
    handler: (args) => {
      let agents = registry.list();
      if (args.status) agents = agents.filter((a) => a.status === args.status);
      return jsonResult({
        count: agents.length,
        agents: agents.map((a) => ({
          id: a.id,
          hostname: a.hostname,
          platform: a.platform,
          status: a.status,
          autonomyCeiling: a.autonomyCeiling,
          autonomy: AUTONOMY_LABEL[a.autonomyCeiling],
          allowList: a.allowList,
          lastSeenAt: a.lastSeenAt,
          attested: Boolean(a.attestation)
        }))
      });
    }
  });

  // ── agent_diagnostics ────────────────────────────────────────────────────────
  reg({
    name: "agent_diagnostics",
    title: "Run agent diagnostics",
    description: "Run read-only local diagnostics on an enrolled endpoint agent (CPU/memory/disk + optional service checks).",
    inputSchema: {
      agentId: z.string().min(1).describe("The enrolled agent id."),
      checks: z.array(z.string()).optional().describe("Optional service names to additionally check."),
      timeoutMs: z.number().int().positive().max(300_000).optional().describe("How long to await the agent (default 60s).")
    },
    handler: async (args) => {
      const result = await registry.dispatch(
        args.agentId,
        "diagnostics",
        { checks: args.checks ?? [] },
        "L0",
        args.timeoutMs
      );
      if (!result.ok) return errorResult(`Agent diagnostics failed: ${result.error ?? "unknown error"}`);
      return jsonResult({ agentId: args.agentId, diagnostics: result.data });
    }
  });

  // ── agent_remediate ──────────────────────────────────────────────────────────
  reg({
    name: "agent_remediate",
    title: "Run a self-verifying remediation",
    description:
      "Run a risk-gated, self-verifying remediation on an endpoint agent: diagnose → checkpoint → remediate → re-measure → auto-rollback if not improved. Requires the agent to permit at least L2 autonomy.",
    mutating: true,
    destructive: true,
    inputSchema: {
      agentId: z.string().min(1).describe("The enrolled agent id."),
      action: z.string().min(1).describe("The remediation action name (e.g. 'restart-service')."),
      target: z.string().optional().describe("Action target (e.g. the service name)."),
      autonomy: z.enum(["L2", "L3"]).optional().describe("Requested autonomy (capped by the agent ceiling); default L2."),
      timeoutMs: z.number().int().positive().max(600_000).optional().describe("How long to await the agent (default 120s).")
    },
    handler: async (args) => {
      const result = await registry.dispatch(
        args.agentId,
        "remediate",
        { action: args.action, target: args.target },
        args.autonomy ?? "L2",
        args.timeoutMs ?? 120_000
      );
      if (!result.ok) return errorResult(`Remediation failed: ${result.error ?? "unknown error"}`);
      return jsonResult({ agentId: args.agentId, remediation: result.data });
    }
  });

  // ── agent_collect_state ──────────────────────────────────────────────────────
  reg({
    name: "agent_collect_state",
    title: "Collect a state/diagnostic bundle",
    description: "Capture a diagnostic/state bundle from an endpoint agent (e.g. to attach to an escalation).",
    inputSchema: {
      agentId: z.string().min(1).describe("The enrolled agent id."),
      timeoutMs: z.number().int().positive().max(300_000).optional()
    },
    handler: async (args) => {
      const result = await registry.dispatch(args.agentId, "collect_state", {}, "L0", args.timeoutMs);
      if (!result.ok) return errorResult(`State collection failed: ${result.error ?? "unknown error"}`);
      return jsonResult({ agentId: args.agentId, state: result.data });
    }
  });
}
