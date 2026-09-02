import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, type ToolContext, type ToolSpec } from "../../core/tools.js";
import { lastSegment, parseUserSessionName, type AvdGateway, type HostPool, type SessionHost, type UserSession } from "./avdClient.js";

/** Normalize an AVD host pool to a stable summary. */
export function summarizeHostPool(hp: HostPool): Record<string, unknown> {
  return {
    name: lastSegment(hp.name),
    friendlyName: hp.friendlyName,
    type: hp.hostPoolType,
    loadBalancer: hp.loadBalancerType,
    maxSessionLimit: hp.maxSessionLimit,
    location: hp.location
  };
}

/** Normalize an AVD session host to a stable summary. */
export function summarizeSessionHost(sh: SessionHost): Record<string, unknown> {
  return {
    name: lastSegment(sh.name),
    status: sh.status,
    sessions: sh.sessions,
    allowNewSession: sh.allowNewSession,
    inMaintenance: sh.allowNewSession === false,
    agentVersion: sh.agentVersion,
    osVersion: sh.osVersion,
    assignedUser: sh.assignedUser,
    lastHeartBeat: sh.lastHeartBeat?.toISOString?.() ?? sh.lastHeartBeat
  };
}

/** Normalize an AVD user session, exposing the parts needed for session control. */
export function summarizeUserSession(us: UserSession): Record<string, unknown> {
  const { sessionHost, userSessionId } = parseUserSessionName(us.name);
  return {
    userSessionId,
    sessionHost,
    userPrincipalName: us.userPrincipalName,
    sessionState: us.sessionState,
    applicationType: us.applicationType,
    createTime: us.createTime?.toISOString?.() ?? us.createTime
  };
}

/**
 * Register the Azure Virtual Desktop tools (spec §14.5): host pools, session
 * hosts (with drain-mode maintenance), and live user-session control. Backed by
 * the official `@azure/arm-desktopvirtualization` SDK.
 *
 * Note: VM-level session-host restart lives in the compute resource provider,
 * not the desktop-virtualization API; drain mode is the maintenance primitive
 * exposed here.
 */
export function registerAvdTools(server: McpServer, ctx: ToolContext, gw: AvdGateway): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── avd_hostpool_list ────────────────────────────────────────────────────────
  reg({
    name: "avd_hostpool_list",
    title: "List AVD host pools",
    description: "List Azure Virtual Desktop host pools in the configured resource group.",
    inputSchema: {},
    handler: async () => {
      const pools = await gw.listHostPools();
      return jsonResult({ count: pools.length, hostPools: pools.map(summarizeHostPool) });
    }
  });

  // ── avd_sessionhost_list ─────────────────────────────────────────────────────
  reg({
    name: "avd_sessionhost_list",
    title: "List AVD session hosts",
    description: "List session hosts in an AVD host pool, with registration status and session counts.",
    inputSchema: {
      hostPool: z.string().min(1).describe("The host pool name.")
    },
    handler: async (args) => {
      const hosts = await gw.listSessionHosts(args.hostPool);
      return jsonResult({ hostPool: args.hostPool, count: hosts.length, sessionHosts: hosts.map(summarizeSessionHost) });
    }
  });

  // ── avd_sessionhost_get ──────────────────────────────────────────────────────
  reg({
    name: "avd_sessionhost_get",
    title: "Get an AVD session host",
    description: "Get detail and status for a single AVD session host.",
    inputSchema: {
      hostPool: z.string().min(1).describe("The host pool name."),
      name: z.string().min(1).describe("The session host name (e.g. host.domain.com).")
    },
    handler: async (args) => {
      const sh = await gw.getSessionHost(args.hostPool, args.name);
      return jsonResult(summarizeSessionHost(sh));
    }
  });

  // ── avd_sessionhost_drain ────────────────────────────────────────────────────
  reg({
    name: "avd_sessionhost_drain",
    title: "Drain an AVD session host",
    description:
      "Toggle drain (maintenance) mode on a session host. on=true stops new sessions landing on the host; on=false re-enables it.",
    mutating: true,
    inputSchema: {
      hostPool: z.string().min(1).describe("The host pool name."),
      name: z.string().min(1).describe("The session host name."),
      on: z.boolean().describe("true = drain (no new sessions); false = allow new sessions.")
    },
    handler: async (args) => {
      const sh = await gw.setDrain(args.hostPool, args.name, !args.on);
      return jsonResult({
        status: "ok",
        action: args.on ? "drain-on" : "drain-off",
        sessionHost: summarizeSessionHost(sh)
      });
    }
  });

  // ── avd_session_list ─────────────────────────────────────────────────────────
  reg({
    name: "avd_session_list",
    title: "List AVD user sessions",
    description: "List user sessions across an AVD host pool, optionally filtered by user principal name.",
    inputSchema: {
      hostPool: z.string().min(1).describe("The host pool name."),
      user: z.string().optional().describe("Filter by user principal name (substring, case-insensitive).")
    },
    handler: async (args) => {
      let sessions = await gw.listSessions(args.hostPool);
      if (args.user) {
        const needle = args.user.toLowerCase();
        sessions = sessions.filter((s) => (s.userPrincipalName ?? "").toLowerCase().includes(needle));
      }
      return jsonResult({ hostPool: args.hostPool, count: sessions.length, sessions: sessions.map(summarizeUserSession) });
    }
  });

  // ── avd_session_disconnect ───────────────────────────────────────────────────
  reg({
    name: "avd_session_disconnect",
    title: "Disconnect an AVD session",
    description: "Disconnect a user session (leaves it running, disconnected).",
    mutating: true,
    inputSchema: {
      hostPool: z.string().min(1).describe("The host pool name."),
      sessionHost: z.string().min(1).describe("The session host name the session is on."),
      userSessionId: z.string().min(1).describe("The user session id (from avd_session_list).")
    },
    handler: async (args) => {
      await gw.disconnectSession(args.hostPool, args.sessionHost, args.userSessionId);
      return jsonResult({ status: "accepted", action: "disconnect", userSessionId: args.userSessionId });
    }
  });

  // ── avd_session_logoff ───────────────────────────────────────────────────────
  reg({
    name: "avd_session_logoff",
    title: "Log off an AVD session",
    description: "Log off (sign out) a user session. The user's unsaved work may be lost.",
    mutating: true,
    destructive: true,
    inputSchema: {
      hostPool: z.string().min(1).describe("The host pool name."),
      sessionHost: z.string().min(1).describe("The session host name the session is on."),
      userSessionId: z.string().min(1).describe("The user session id (from avd_session_list).")
    },
    handler: async (args) => {
      await gw.logoffSession(args.hostPool, args.sessionHost, args.userSessionId);
      return jsonResult({ status: "accepted", action: "logoff", userSessionId: args.userSessionId });
    }
  });

  // ── avd_session_message ──────────────────────────────────────────────────────
  reg({
    name: "avd_session_message",
    title: "Message an AVD session",
    description: "Send a pop-up message to a user session (e.g. a maintenance heads-up).",
    mutating: true,
    inputSchema: {
      hostPool: z.string().min(1).describe("The host pool name."),
      sessionHost: z.string().min(1).describe("The session host name the session is on."),
      userSessionId: z.string().min(1).describe("The user session id (from avd_session_list)."),
      title: z.string().min(1).describe("Message title."),
      body: z.string().min(1).describe("Message body.")
    },
    handler: async (args) => {
      await gw.sendMessage(args.hostPool, args.sessionHost, args.userSessionId, args.title, args.body);
      return jsonResult({ status: "sent", action: "message", userSessionId: args.userSessionId });
    }
  });
}
