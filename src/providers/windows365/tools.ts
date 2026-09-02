import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@microsoft/microsoft-graph-client";
import { registerTool, jsonResult, type ToolContext, type ToolSpec } from "../../core/tools.js";

const VE_BASE = "/deviceManagement/virtualEndpoint";
const CLOUD_PC_BASE = `${VE_BASE}/cloudPCs`;

/**
 * Register the Windows 365 Cloud PC tools, backed by Microsoft Graph
 * (`deviceManagement/virtualEndpoint`). The Graph client is obtained lazily so
 * delegated (device-code) auth is only triggered on first use.
 */
export function registerWindows365Tools(
  server: McpServer,
  ctx: ToolContext,
  getClient: () => Client
): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── cloudpc_list ─────────────────────────────────────────────────────────────
  reg({
    name: "cloudpc_list",
    title: "List Cloud PCs",
    description: "List the Windows 365 Cloud PCs in the tenant, with optional OData $filter and $top.",
    inputSchema: {
      filter: z.string().optional().describe("OData $filter expression, e.g. \"status eq 'provisioned'\"."),
      top: z.number().int().min(1).max(999).optional().describe("Maximum number of Cloud PCs to return.")
    },
    handler: async (args) => {
      let req = getClient().api(CLOUD_PC_BASE);
      if (args.filter) req = req.filter(args.filter);
      if (args.top) req = req.top(args.top);
      const data = await req.get();
      return jsonResult(data?.value ?? data);
    }
  });

  // ── cloudpc_get ──────────────────────────────────────────────────────────────
  reg({
    name: "cloudpc_get",
    title: "Get a Cloud PC",
    description: "Read the properties of a single Cloud PC by its id.",
    inputSchema: {
      cloudPcId: z.string().min(1).describe("The Cloud PC id (GUID).")
    },
    handler: async (args) => {
      const data = await getClient().api(`${CLOUD_PC_BASE}/${args.cloudPcId}`).get();
      return jsonResult(data);
    }
  });

  // ── cloudpc_provision ────────────────────────────────────────────────────────
  reg({
    name: "cloudpc_provision",
    title: "Provision Cloud PCs (assign policy)",
    description:
      "Trigger provisioning by assigning a provisioning policy to an Entra group; the service then provisions Cloud PCs for the group's members (migration target).",
    mutating: true,
    inputSchema: {
      provisioningPolicyId: z.string().min(1).describe("The cloudPcProvisioningPolicy id."),
      groupId: z.string().min(1).describe("The Entra ID group to assign the policy to.")
    },
    handler: async (args) => {
      await getClient()
        .api(`${VE_BASE}/provisioningPolicies/${args.provisioningPolicyId}/assign`)
        .post({
          assignments: [
            {
              target: {
                "@odata.type": "#microsoft.graph.cloudPcManagementGroupAssignmentTarget",
                groupId: args.groupId
              }
            }
          ]
        });
      return jsonResult({
        status: "accepted",
        action: "provision",
        provisioningPolicyId: args.provisioningPolicyId,
        groupId: args.groupId
      });
    }
  });

  // ── cloudpc_reboot ───────────────────────────────────────────────────────────
  reg({
    name: "cloudpc_reboot",
    title: "Reboot a Cloud PC",
    description: "Reboot a specific Cloud PC.",
    mutating: true,
    inputSchema: { cloudPcId: z.string().min(1).describe("The Cloud PC id (GUID).") },
    handler: async (args) => {
      await getClient().api(`${CLOUD_PC_BASE}/${args.cloudPcId}/reboot`).post(undefined);
      return jsonResult({ status: "accepted", action: "reboot", cloudPcId: args.cloudPcId });
    }
  });

  // ── cloudpc_reprovision ──────────────────────────────────────────────────────
  reg({
    name: "cloudpc_reprovision",
    title: "Reprovision a Cloud PC",
    description: "Reprovision a Cloud PC. DESTRUCTIVE: the existing OS and local data are replaced.",
    mutating: true,
    destructive: true,
    inputSchema: { cloudPcId: z.string().min(1).describe("The Cloud PC id (GUID).") },
    handler: async (args) => {
      await getClient().api(`${CLOUD_PC_BASE}/${args.cloudPcId}/reprovision`).post(undefined);
      return jsonResult({ status: "accepted", action: "reprovision", cloudPcId: args.cloudPcId });
    }
  });

  // ── cloudpc_restore ──────────────────────────────────────────────────────────
  reg({
    name: "cloudpc_restore",
    title: "Restore a Cloud PC",
    description: "Restore a Cloud PC to a previous state from a snapshot. DESTRUCTIVE: changes since the snapshot are lost.",
    mutating: true,
    destructive: true,
    inputSchema: {
      cloudPcId: z.string().min(1).describe("The Cloud PC id (GUID)."),
      snapshotId: z.string().min(1).describe("The cloudPcSnapshot id to restore from.")
    },
    handler: async (args) => {
      await getClient()
        .api(`${CLOUD_PC_BASE}/${args.cloudPcId}/restore`)
        .post({ cloudPcSnapshotId: args.snapshotId });
      return jsonResult({
        status: "accepted",
        action: "restore",
        cloudPcId: args.cloudPcId,
        snapshotId: args.snapshotId
      });
    }
  });

  // ── cloudpc_resize ───────────────────────────────────────────────────────────
  reg({
    name: "cloudpc_resize",
    title: "Resize a Cloud PC",
    description: "Upgrade or downgrade a Cloud PC to a different vCPU/storage configuration (service plan).",
    mutating: true,
    inputSchema: {
      cloudPcId: z.string().min(1).describe("The Cloud PC id (GUID)."),
      targetServicePlanId: z.string().min(1).describe("The target service plan id (the new SKU).")
    },
    handler: async (args) => {
      await getClient()
        .api(`${CLOUD_PC_BASE}/${args.cloudPcId}/resize`)
        .post({ targetServicePlanId: args.targetServicePlanId });
      return jsonResult({
        status: "accepted",
        action: "resize",
        cloudPcId: args.cloudPcId,
        targetServicePlanId: args.targetServicePlanId
      });
    }
  });

  // ── cloudpc_rename ───────────────────────────────────────────────────────────
  reg({
    name: "cloudpc_rename",
    title: "Rename a Cloud PC",
    description: "Change the display name of a Cloud PC (max 64 characters).",
    mutating: true,
    inputSchema: {
      cloudPcId: z.string().min(1).describe("The Cloud PC id (GUID)."),
      displayName: z.string().min(1).max(64).describe("The new display name.")
    },
    handler: async (args) => {
      await getClient()
        .api(`${CLOUD_PC_BASE}/${args.cloudPcId}/rename`)
        .post({ displayName: args.displayName });
      return jsonResult({
        status: "accepted",
        action: "rename",
        cloudPcId: args.cloudPcId,
        displayName: args.displayName
      });
    }
  });

  // ── cloudpc_troubleshoot ─────────────────────────────────────────────────────
  reg({
    name: "cloudpc_troubleshoot",
    title: "Troubleshoot a Cloud PC",
    description: "Run the Graph troubleshoot action to check and remediate a Cloud PC's health.",
    mutating: true,
    inputSchema: { cloudPcId: z.string().min(1).describe("The Cloud PC id (GUID).") },
    handler: async (args) => {
      await getClient().api(`${CLOUD_PC_BASE}/${args.cloudPcId}/troubleshoot`).post(undefined);
      return jsonResult({ status: "accepted", action: "troubleshoot", cloudPcId: args.cloudPcId });
    }
  });

  // ── cloudpc_end_grace_period ─────────────────────────────────────────────────
  reg({
    name: "cloudpc_end_grace_period",
    title: "End grace period",
    description: "End the grace period for a Cloud PC, immediately triggering reprovision/deprovision.",
    mutating: true,
    destructive: true,
    inputSchema: { cloudPcId: z.string().min(1).describe("The Cloud PC id (GUID).") },
    handler: async (args) => {
      await getClient().api(`${CLOUD_PC_BASE}/${args.cloudPcId}/endGracePeriod`).post(undefined);
      return jsonResult({ status: "accepted", action: "endGracePeriod", cloudPcId: args.cloudPcId });
    }
  });
}
