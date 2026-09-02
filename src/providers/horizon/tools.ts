import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, type ToolContext, type ToolSpec } from "../../core/tools.js";
import type { HorizonGateway, HorizonPool, HorizonMachine, HorizonSession } from "./horizonClient.js";

export function summarizePool(p: HorizonPool): Record<string, unknown> {
  return { id: p.id, name: p.name, displayName: p.display_name, type: p.type, enabled: p.enabled };
}

export function summarizeMachine(m: HorizonMachine): Record<string, unknown> {
  return {
    id: m.id,
    name: m.name,
    pool: m.desktop_pool_id,
    state: m.state,
    agentVersion: m.agent_version,
    os: m.operating_system
  };
}

export function summarizeSession(s: HorizonSession): Record<string, unknown> {
  return {
    id: s.id,
    user: s.user_name ?? s.username,
    state: s.session_state,
    machine: s.machine_id,
    pool: s.desktop_pool_id,
    type: s.session_type
  };
}

/**
 * Register the Omnissa Horizon tools (spec §14.4): desktop pools, farms,
 * machines (with maintenance), and live session control. Backed by the Horizon
 * Server REST API. Image push/recompose is a long-running provisioning job and
 * is deferred to the orchestration phase.
 */
export function registerHorizonTools(server: McpServer, ctx: ToolContext, gw: HorizonGateway): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  reg({
    name: "horizon_pool_list",
    title: "List Horizon desktop pools",
    description: "List Omnissa Horizon desktop pools.",
    inputSchema: {},
    handler: async () => {
      const pools = await gw.listPools();
      return jsonResult({ count: pools.length, pools: pools.map(summarizePool) });
    }
  });

  reg({
    name: "horizon_farm_list",
    title: "List Horizon RDS farms",
    description: "List Omnissa Horizon RDS farms.",
    inputSchema: {},
    handler: async () => {
      const farms = await gw.listFarms();
      return jsonResult({ count: farms.length, farms: farms.map((f) => ({ id: f.id, name: f.name })) });
    }
  });

  reg({
    name: "horizon_machine_list",
    title: "List Horizon machines",
    description: "List Horizon machines, optionally scoped to a desktop pool.",
    inputSchema: {
      pool: z.string().optional().describe("Desktop pool id to scope the list.")
    },
    handler: async (args) => {
      const machines = await gw.listMachines(args.pool);
      return jsonResult({ count: machines.length, machines: machines.map(summarizeMachine) });
    }
  });

  reg({
    name: "horizon_machine_maintenance",
    title: "Horizon machine maintenance mode",
    description: "Toggle maintenance mode on a Horizon machine (on=true blocks new sessions).",
    mutating: true,
    inputSchema: {
      machineId: z.string().min(1).describe("The machine id."),
      on: z.boolean().describe("true = enter maintenance; false = exit maintenance.")
    },
    handler: async (args) => {
      await gw.setMaintenance([args.machineId], args.on);
      return jsonResult({ status: "ok", action: args.on ? "maintenance-on" : "maintenance-off", machineId: args.machineId });
    }
  });

  reg({
    name: "horizon_session_list",
    title: "List Horizon sessions",
    description: "List Horizon sessions, optionally filtered by user (substring, case-insensitive).",
    inputSchema: {
      user: z.string().optional().describe("Filter by user name substring.")
    },
    handler: async (args) => {
      let sessions = await gw.listSessions();
      if (args.user) {
        const needle = args.user.toLowerCase();
        sessions = sessions.filter(
          (s) => (s.user_name ?? "").toLowerCase().includes(needle) || (s.username ?? "").toLowerCase().includes(needle)
        );
      }
      return jsonResult({ count: sessions.length, sessions: sessions.map(summarizeSession) });
    }
  });

  reg({
    name: "horizon_session_disconnect",
    title: "Disconnect a Horizon session",
    description: "Disconnect a Horizon session (leaves it running, disconnected).",
    mutating: true,
    inputSchema: { sessionId: z.string().min(1).describe("The session id.") },
    handler: async (args) => {
      await gw.sessionAction([args.sessionId], "disconnect");
      return jsonResult({ status: "accepted", action: "disconnect", sessionId: args.sessionId });
    }
  });

  reg({
    name: "horizon_session_logoff",
    title: "Log off a Horizon session",
    description: "Log off (sign out) a Horizon session. The user's unsaved work may be lost.",
    mutating: true,
    destructive: true,
    inputSchema: { sessionId: z.string().min(1).describe("The session id.") },
    handler: async (args) => {
      await gw.sessionAction([args.sessionId], "logoff");
      return jsonResult({ status: "accepted", action: "logoff", sessionId: args.sessionId });
    }
  });

  reg({
    name: "horizon_session_reset",
    title: "Reset a Horizon session",
    description: "Reset (force-restart) the machine backing a Horizon session. DESTRUCTIVE: in-progress work is lost.",
    mutating: true,
    destructive: true,
    inputSchema: { sessionId: z.string().min(1).describe("The session id.") },
    handler: async (args) => {
      await gw.sessionAction([args.sessionId], "restart");
      return jsonResult({ status: "accepted", action: "reset", sessionId: args.sessionId });
    }
  });

  reg({
    name: "horizon_session_message",
    title: "Message a Horizon session",
    description: "Send a message to a Horizon session (e.g. a maintenance heads-up).",
    mutating: true,
    inputSchema: {
      sessionId: z.string().min(1).describe("The session id."),
      message: z.string().min(1).describe("Message text."),
      messageType: z.enum(["INFO", "WARNING", "ERROR"]).optional().describe("Message severity (default INFO).")
    },
    handler: async (args) => {
      await gw.sendMessage([args.sessionId], args.messageType ?? "INFO", args.message);
      return jsonResult({ status: "sent", action: "message", sessionId: args.sessionId });
    }
  });

  // ── horizon_monitor_health ────────────────────────────────────────────────────
  reg({
    name: "horizon_monitor_health",
    title: "Horizon infrastructure health",
    description:
      "Report the health of core Horizon infrastructure (Monitor API): connection servers and gateways, with a count of components not reporting OK.",
    inputSchema: {},
    handler: async () => {
      const { connectionServers, gateways } = await gw.monitorHealth();
      const components = [...connectionServers, ...gateways];
      const unhealthy = components.filter((c) => (c.status ?? "").toUpperCase() !== "OK").length;
      return jsonResult({
        connectionServers: connectionServers.map((c) => ({ name: c.name, status: c.status })),
        gateways: gateways.map((c) => ({ name: c.name, status: c.status })),
        unhealthyCount: unhealthy
      });
    }
  });

  // ── horizon_helpdesk_session_get ──────────────────────────────────────────────
  reg({
    name: "horizon_helpdesk_session_get",
    title: "Horizon Help Desk session detail",
    description:
      "Retrieve detailed Help Desk session information (logon segments, latency, etc.), optionally scoped to a user, for per-user troubleshooting.",
    inputSchema: {
      user: z.string().optional().describe("Scope to a user (domain\\\\user or UPN). Omit for all sessions.")
    },
    handler: async (args) => {
      const sessions = await gw.helpdeskSessions(args.user);
      return jsonResult({ count: sessions.length, sessions });
    }
  });

  // ── horizon_pool_push_image ───────────────────────────────────────────────────
  reg({
    name: "horizon_pool_push_image",
    title: "Push image to a Horizon pool",
    description:
      "Schedule an instant-clone image push (recompose) for a desktop pool. DESTRUCTIVE: machines are recreated from the new image; affected sessions are logged off per the chosen policy.",
    mutating: true,
    destructive: true,
    inputSchema: {
      poolId: z.string().min(1).describe("The desktop pool id."),
      parentVmId: z.string().optional().describe("The parent (golden) VM id."),
      snapshotId: z.string().min(1).describe("The snapshot id of the new image."),
      startTime: z.string().optional().describe("ISO-8601 start time; omit to start immediately."),
      logoffPolicy: z
        .enum(["WAIT_FOR_LOGOFF", "FORCE_LOGOFF"])
        .optional()
        .describe("How to handle active sessions (default WAIT_FOR_LOGOFF)."),
      stopOnFirstError: z.boolean().optional().describe("Halt the rollout on the first error (default true).")
    },
    handler: async (args) => {
      await gw.pushImage(args.poolId, {
        parentVmId: args.parentVmId,
        snapshotId: args.snapshotId,
        startTime: args.startTime,
        logoffPolicy: args.logoffPolicy,
        stopOnFirstError: args.stopOnFirstError
      });
      return jsonResult({ status: "scheduled", action: "push_image", poolId: args.poolId });
    }
  });
}
