import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, type ToolContext, type ToolSpec } from "../../core/tools.js";
import type { HorizonCloudGateway, HorizonCloudTemplate, HorizonCloudVm, HorizonCloudImage } from "./cloudClient.js";

/** Normalize a next-gen template (pool) to a stable summary. */
export function summarizeTemplate(t: HorizonCloudTemplate): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    templateType: t.templateType,
    imageId: t.imageId,
    sessionsPerVm: t.sessionsPerVm
  };
}

/** Normalize a pool VM to a stable summary. */
export function summarizeVm(v: HorizonCloudVm): Record<string, unknown> {
  return {
    id: v.id,
    templateId: v.templateId,
    lifecycleStatus: v.lifecycleStatus,
    powerState: v.powerState,
    agentStatus: v.agentStatus,
    privateIp: v.privateIp
  };
}

/** Normalize a catalog image to a stable summary. */
export function summarizeImage(i: HorizonCloudImage): Record<string, unknown> {
  return { id: i.id, name: i.name };
}

/**
 * Register the Omnissa Horizon Cloud (next-gen) tools. Read tools enumerate
 * templates (pools), VMs, images and per-user sessions; session/VM actions are
 * mutating, with logoff/restart flagged destructive.
 */
export function registerHorizonCloudTools(server: McpServer, ctx: ToolContext, gw: HorizonCloudGateway): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── horizoncloud_pool_list ────────────────────────────────────────────────────
  reg({
    name: "horizoncloud_pool_list",
    title: "List Horizon Cloud pools",
    description: "List Horizon Cloud (next-gen) templates — the modern term for desktop/app pools.",
    inputSchema: {},
    handler: async () => {
      const templates = await gw.listTemplates();
      return jsonResult({ count: templates.length, pools: templates.map(summarizeTemplate) });
    }
  });

  // ── horizoncloud_vm_list ──────────────────────────────────────────────────────
  reg({
    name: "horizoncloud_vm_list",
    title: "List Horizon Cloud pool VMs",
    description: "List the virtual machines in a Horizon Cloud template (pool), with lifecycle and agent status.",
    inputSchema: { templateId: z.string().min(1).describe("The template (pool) id.") },
    handler: async (args) => {
      const vms = await gw.listVms(args.templateId);
      return jsonResult({ count: vms.length, vms: vms.map(summarizeVm) });
    }
  });

  // ── horizoncloud_image_list ───────────────────────────────────────────────────
  reg({
    name: "horizoncloud_image_list",
    title: "List Horizon Cloud images",
    description: "List the images in the Horizon Cloud image-management catalog.",
    inputSchema: {},
    handler: async () => {
      const images = await gw.listImages();
      return jsonResult({ count: images.length, images: images.map(summarizeImage) });
    }
  });

  // ── horizoncloud_session_list ─────────────────────────────────────────────────
  reg({
    name: "horizoncloud_session_list",
    title: "List Horizon Cloud user sessions",
    description:
      "List a user's Horizon Cloud sessions (the next-gen session API is scoped per user). Provide the user id to query.",
    inputSchema: { userId: z.string().min(1).describe("The user id whose sessions to list.") },
    handler: async (args) => {
      const sessions = await gw.listUserSessions(args.userId);
      return jsonResult({ count: sessions.length, sessions });
    }
  });

  // ── horizoncloud_session_disconnect ───────────────────────────────────────────
  reg({
    name: "horizoncloud_session_disconnect",
    title: "Disconnect Horizon Cloud sessions",
    description: "Disconnect one or more Horizon Cloud sessions (leaves them running, disconnected).",
    mutating: true,
    inputSchema: {
      sessionIds: z.array(z.string().min(1)).min(1).describe("The session ids to disconnect.")
    },
    handler: async (args) => {
      await gw.bulkSessionAction(args.sessionIds, "BULK_DISCONNECT");
      return jsonResult({ status: "accepted", action: "disconnect", count: args.sessionIds.length });
    }
  });

  // ── horizoncloud_session_logoff ───────────────────────────────────────────────
  reg({
    name: "horizoncloud_session_logoff",
    title: "Log off Horizon Cloud sessions",
    description: "Log off (sign out) one or more Horizon Cloud sessions. The users' unsaved work may be lost.",
    mutating: true,
    destructive: true,
    inputSchema: {
      sessionIds: z.array(z.string().min(1)).min(1).describe("The session ids to log off.")
    },
    handler: async (args) => {
      await gw.bulkSessionAction(args.sessionIds, "BULK_LOGOFF");
      return jsonResult({ status: "accepted", action: "logoff", count: args.sessionIds.length });
    }
  });

  // ── horizoncloud_vm_restart ───────────────────────────────────────────────────
  reg({
    name: "horizoncloud_vm_restart",
    title: "Restart a Horizon Cloud VM",
    description: "Restart a Horizon Cloud pool VM. DESTRUCTIVE: any in-progress work on the VM is lost.",
    mutating: true,
    destructive: true,
    inputSchema: {
      vmId: z.string().min(1).describe("The VM id to restart."),
      templateId: z.string().optional().describe("The template (pool) id the VM belongs to.")
    },
    handler: async (args) => {
      await gw.restartVms([{ vmId: args.vmId, templateId: args.templateId }]);
      return jsonResult({ status: "accepted", action: "restart", vmId: args.vmId });
    }
  });
}
