import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, type ToolContext, type ToolSpec } from "../../core/tools.js";
import type { CitrixGateway, CitrixDeliveryGroup, CitrixMachine, CitrixSession } from "./citrixClient.js";

export function summarizeDeliveryGroup(g: CitrixDeliveryGroup): Record<string, unknown> {
  return {
    id: g.Id,
    name: g.Name,
    deliveryType: g.DeliveryType,
    enabled: g.Enabled,
    inMaintenance: g.InMaintenanceMode,
    totalMachines: g.TotalMachines,
    totalApplications: g.TotalApplications
  };
}

export function summarizeMachine(m: CitrixMachine): Record<string, unknown> {
  return {
    id: m.Id,
    name: m.Name,
    dnsName: m.DnsName,
    powerState: m.PowerState,
    registrationState: m.RegistrationState,
    inMaintenance: m.InMaintenanceMode,
    sessionCount: m.SessionCount,
    loadIndex: m.LoadIndex,
    deliveryGroup: m.DeliveryGroup?.Name
  };
}

export function summarizeSession(s: CitrixSession): Record<string, unknown> {
  return {
    id: s.Id,
    user: s.UserName ?? s.UserUPN,
    state: s.State,
    machine: s.MachineName,
    deliveryGroup: s.DeliveryGroupName
  };
}

/**
 * Register the Citrix DaaS tools (spec §14.3): delivery groups, machine catalogs,
 * machines (power + maintenance), and live session control. Backed by the Citrix
 * DaaS REST APIs. `shadow` and `image_rollout` from the spec are intentionally
 * omitted from this slice (shadow is consent-gated and not a single REST call;
 * image rollout is a long-running provisioning job) — they belong with the
 * orchestration phase.
 */
export function registerCitrixTools(server: McpServer, ctx: ToolContext, gw: CitrixGateway): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  reg({
    name: "citrix_deliverygroup_list",
    title: "List Citrix delivery groups",
    description: "List Citrix DaaS delivery groups with machine and application counts.",
    inputSchema: {},
    handler: async () => {
      const groups = await gw.listDeliveryGroups();
      return jsonResult({ count: groups.length, deliveryGroups: groups.map(summarizeDeliveryGroup) });
    }
  });

  reg({
    name: "citrix_catalog_list",
    title: "List Citrix machine catalogs",
    description: "List Citrix DaaS machine catalogs.",
    inputSchema: {},
    handler: async () => {
      const catalogs = await gw.listMachineCatalogs();
      return jsonResult({ count: catalogs.length, catalogs: catalogs.map((c) => ({ id: c.Id, name: c.Name })) });
    }
  });

  reg({
    name: "citrix_machine_list",
    title: "List Citrix machines",
    description: "List Citrix machines (VDAs) with power, registration and load, optionally scoped to a delivery group.",
    inputSchema: {
      deliveryGroup: z.string().optional().describe("Delivery group name or id to scope the list.")
    },
    handler: async (args) => {
      const machines = await gw.listMachines(args.deliveryGroup);
      return jsonResult({ count: machines.length, machines: machines.map(summarizeMachine) });
    }
  });

  reg({
    name: "citrix_machine_power",
    title: "Citrix machine power action",
    description: "Perform a power action on a Citrix machine.",
    mutating: true,
    inputSchema: {
      machineId: z.string().min(1).describe("The machine id or name."),
      action: z.enum(["turnon", "turnoff", "shutdown", "restart", "suspend", "resume"]).describe("Power action.")
    },
    handler: async (args) => {
      await gw.powerMachine(args.machineId, args.action);
      return jsonResult({ status: "accepted", action: args.action, machineId: args.machineId });
    }
  });

  reg({
    name: "citrix_machine_maintenance",
    title: "Citrix machine maintenance mode",
    description: "Toggle maintenance mode on a Citrix machine (on=true blocks new sessions).",
    mutating: true,
    inputSchema: {
      machineId: z.string().min(1).describe("The machine id or name."),
      on: z.boolean().describe("true = enter maintenance; false = exit maintenance.")
    },
    handler: async (args) => {
      await gw.setMaintenanceMode(args.machineId, args.on);
      return jsonResult({ status: "ok", action: args.on ? "maintenance-on" : "maintenance-off", machineId: args.machineId });
    }
  });

  reg({
    name: "citrix_session_list",
    title: "List Citrix sessions",
    description: "List Citrix sessions, optionally filtered by user (substring, case-insensitive).",
    inputSchema: {
      user: z.string().optional().describe("Filter by user name / UPN substring.")
    },
    handler: async (args) => {
      let sessions = await gw.listSessions();
      if (args.user) {
        const needle = args.user.toLowerCase();
        sessions = sessions.filter(
          (s) => (s.UserName ?? "").toLowerCase().includes(needle) || (s.UserUPN ?? "").toLowerCase().includes(needle)
        );
      }
      return jsonResult({ count: sessions.length, sessions: sessions.map(summarizeSession) });
    }
  });

  reg({
    name: "citrix_session_disconnect",
    title: "Disconnect a Citrix session",
    description: "Disconnect a Citrix session (leaves it running, disconnected).",
    mutating: true,
    inputSchema: { sessionId: z.string().min(1).describe("The session id.") },
    handler: async (args) => {
      await gw.sessionAction(args.sessionId, "disconnect");
      return jsonResult({ status: "accepted", action: "disconnect", sessionId: args.sessionId });
    }
  });

  reg({
    name: "citrix_session_logoff",
    title: "Log off a Citrix session",
    description: "Log off (sign out) a Citrix session. The user's unsaved work may be lost.",
    mutating: true,
    destructive: true,
    inputSchema: { sessionId: z.string().min(1).describe("The session id.") },
    handler: async (args) => {
      await gw.sessionAction(args.sessionId, "logoff");
      return jsonResult({ status: "accepted", action: "logoff", sessionId: args.sessionId });
    }
  });

  reg({
    name: "citrix_session_message",
    title: "Message a Citrix session",
    description: "Send a message to a Citrix session (e.g. a maintenance heads-up).",
    mutating: true,
    inputSchema: {
      sessionId: z.string().min(1).describe("The session id."),
      title: z.string().min(1).describe("Message title."),
      text: z.string().min(1).describe("Message body.")
    },
    handler: async (args) => {
      await gw.sendSessionMessage(args.sessionId, args.title, args.text);
      return jsonResult({ status: "sent", action: "message", sessionId: args.sessionId });
    }
  });

  // ── citrix_service_entitlement ───────────────────────────────────────────────
  reg({
    name: "citrix_service_entitlement",
    title: "List Citrix Cloud service entitlements",
    description:
      "List the Citrix Cloud services available to this customer and their entitlement state (Service Entitlement API) — useful for capability discovery (e.g. whether XenDesktop/DaaS is enabled).",
    inputSchema: {},
    handler: async () => {
      const services = await gw.serviceStates();
      return jsonResult({
        count: services.length,
        services: services.map((s) => ({ serviceName: s.serviceName, state: s.state }))
      });
    }
  });

  // ── citrix_resource_locations ────────────────────────────────────────────────
  reg({
    name: "citrix_resource_locations",
    title: "List Citrix Cloud resource locations",
    description:
      "List the customer's configured resource locations (Resource Locations API) — the zones / Cloud Connector topology backing the DaaS estate.",
    inputSchema: {},
    handler: async () => {
      const locations = await gw.resourceLocations();
      return jsonResult({
        count: locations.length,
        resourceLocations: locations.map((l) => ({
          id: l.id,
          name: l.name,
          timeZone: l.timeZone,
          internalOnly: l.internalOnly
        }))
      });
    }
  });

  // ── citrix_notify ────────────────────────────────────────────────────────────
  reg({
    name: "citrix_notify",
    title: "Send a Citrix Cloud notification",
    description:
      "Push a notification to Citrix Cloud administrators (Notifications API). Useful for surfacing operational events in the Citrix Cloud console.",
    mutating: true,
    inputSchema: {
      title: z.string().min(1).describe("Notification title."),
      description: z.string().min(1).describe("Notification body."),
      severity: z.enum(["Information", "Warning", "Error"]).optional().describe("Severity (default Information).")
    },
    handler: async (args) => {
      await gw.sendNotification({ title: args.title, description: args.description, severity: args.severity });
      return jsonResult({ status: "sent", action: "notify", title: args.title });
    }
  });
}
