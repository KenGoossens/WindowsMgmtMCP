import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, type ToolContext, type ToolSpec } from "../core/tools.js";
import type { StatePortabilityService, EndpointRef } from "./statePortability.js";

const endpointShape = {
  providerId: z.string().min(1).describe("Provider id of the endpoint (e.g. 'local', 'remoteWindows')."),
  entity: z.string().optional().describe("Substrate entity id (remote target id; omit for the local host).")
};

const scopeShape = {
  userData: z.boolean().optional().describe("Include the user-data tier (default true)."),
  appSettings: z.boolean().optional().describe("Include the application-settings tier (default true)."),
  osSettings: z.boolean().optional().describe("Include the OS/user-settings tier (default true).")
};

/**
 * Register the state & settings portability tools (spec §14.7). All capture is
 * additive (snapshots state to an encrypted bundle); restore/import are mutating
 * and confirm-gated because they re-apply settings onto a live endpoint.
 */
export function registerStateTools(server: McpServer, ctx: ToolContext, svc: StatePortabilityService): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── state_capture ────────────────────────────────────────────────────────────
  reg({
    name: "state_capture",
    title: "Capture a StateBundle",
    description:
      "Capture a normalized, encrypted StateBundle (user/app/OS settings) from an endpoint. Returns the fidelity manifest describing exactly what transferred.",
    mutating: true,
    inputSchema: {
      ...endpointShape,
      ...scopeShape,
      subject: z.string().optional().describe("Logical subject (user/endpoint) the bundle belongs to.")
    },
    handler: async (args) => {
      const ref: EndpointRef = { providerId: args.providerId, entity: args.entity };
      const manifest = await svc.capture(ref, args, args.subject);
      return jsonResult({ status: "captured", manifest });
    }
  });

  // ── state_restore ────────────────────────────────────────────────────────────
  reg({
    name: "state_restore",
    title: "Restore a StateBundle",
    description:
      "Restore a stored StateBundle onto a target endpoint. Only restorable items are applied (time zone, mapped drives, network printers); referenced items are reported, not faked.",
    mutating: true,
    inputSchema: {
      ...endpointShape,
      bundleId: z.string().min(1).describe("The StateBundle id to restore (from state_list).")
    },
    handler: async (args) => {
      const ref: EndpointRef = { providerId: args.providerId, entity: args.entity };
      const { manifest, outcome } = await svc.restore(ref, args.bundleId);
      return jsonResult({ status: "restored", bundleId: args.bundleId, fidelity: manifest.fidelity, outcome });
    }
  });

  // ── state_list ───────────────────────────────────────────────────────────────
  reg({
    name: "state_list",
    title: "List StateBundles",
    description: "List available StateBundles (manifests only — no secret values), optionally filtered by subject.",
    inputSchema: {
      subject: z.string().optional().describe("Filter by subject (user/endpoint).")
    },
    handler: async (args) => {
      const manifests = await svc.list(args.subject);
      return jsonResult({
        count: manifests.length,
        bundles: manifests.map((m) => ({
          id: m.id,
          subject: m.subject,
          source: `${m.sourceProviderId}:${m.sourceEntity}`,
          createdAt: m.createdAt,
          fidelity: m.fidelity.overall,
          items: m.items.length
        }))
      });
    }
  });

  // ── settings_export ──────────────────────────────────────────────────────────
  reg({
    name: "settings_export",
    title: "Export a settings subset",
    description:
      "Export a user/app/OS settings subset from an endpoint inline (read-only; not persisted). Use the scope flags to select tiers.",
    inputSchema: {
      ...endpointShape,
      ...scopeShape
    },
    handler: async (args) => {
      const ref: EndpointRef = { providerId: args.providerId, entity: args.entity };
      const bundle = await svc.exportSettings(ref, args);
      return jsonResult({ manifest: bundle.manifest, data: bundle.data });
    }
  });

  // ── settings_import ──────────────────────────────────────────────────────────
  reg({
    name: "settings_import",
    title: "Import settings onto a target",
    description: "Import a previously stored StateBundle's settings onto a target endpoint (alias of state_restore by bundle id).",
    mutating: true,
    inputSchema: {
      ...endpointShape,
      bundleId: z.string().min(1).describe("The StateBundle id to import.")
    },
    handler: async (args) => {
      const ref: EndpointRef = { providerId: args.providerId, entity: args.entity };
      const { manifest, outcome } = await svc.restore(ref, args.bundleId);
      return jsonResult({ status: "imported", bundleId: args.bundleId, fidelity: manifest.fidelity, outcome });
    }
  });
}
