import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, type ToolContext, type ToolSpec } from "../../core/tools.js";
import type { Ws1Gateway, Ws1Device } from "./ws1Client.js";

/** Normalize a WS1 UEM device to a stable summary. */
export function summarizeDevice(d: Ws1Device): Record<string, unknown> {
  return {
    id: d.Id?.Value,
    friendlyName: d.DeviceFriendlyName,
    userName: d.UserName,
    platform: d.Platform,
    model: d.Model,
    operatingSystem: d.OperatingSystem,
    serialNumber: d.SerialNumber,
    enrollmentStatus: d.EnrollmentStatus,
    complianceStatus: d.ComplianceStatus,
    lastSeen: d.LastSeen
  };
}

/**
 * Register the Workspace ONE UEM tools — multi-OS endpoint management
 * (iOS / Android / Windows / macOS). Read tools enumerate devices and
 * compliance; device commands are mutating, with enterprise wipe flagged
 * destructive.
 */
export function registerWs1Tools(server: McpServer, ctx: ToolContext, gw: Ws1Gateway): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── device_list ───────────────────────────────────────────────────────────────
  reg({
    name: "device_list",
    title: "List managed devices",
    description:
      "Search Workspace ONE UEM managed devices (iOS/Android/Windows/macOS), optionally filtered by user or platform.",
    inputSchema: {
      user: z.string().optional().describe("Filter by enrolled user name."),
      platform: z.string().optional().describe("Filter by platform, e.g. Apple, Android, WinRT."),
      pageSize: z.number().int().min(1).max(500).optional().describe("Maximum devices to return (first page).")
    },
    handler: async (args) => {
      const devices = await gw.searchDevices({ user: args.user, platform: args.platform, pageSize: args.pageSize });
      return jsonResult({ count: devices.length, devices: devices.map(summarizeDevice) });
    }
  });

  // ── device_get ──────────────────────────────────────────────────────────────
  reg({
    name: "device_get",
    title: "Get a managed device",
    description: "Read a single Workspace ONE UEM device by its numeric device id.",
    inputSchema: { deviceId: z.number().int().positive().describe("The UEM device id.") },
    handler: async (args) => jsonResult(summarizeDevice(await gw.getDevice(args.deviceId)))
  });

  // ── device_compliance_list ────────────────────────────────────────────────────
  reg({
    name: "device_compliance_list",
    title: "List non-compliant devices",
    description: "List Workspace ONE UEM devices currently in a NonCompliant state.",
    inputSchema: {
      pageSize: z.number().int().min(1).max(500).optional().describe("Maximum devices to return (first page).")
    },
    handler: async (args) => {
      const devices = await gw.searchDevices({ complianceStatus: "NonCompliant", pageSize: args.pageSize });
      return jsonResult({ count: devices.length, devices: devices.map(summarizeDevice) });
    }
  });

  // ── device_lock ───────────────────────────────────────────────────────────────
  reg({
    name: "device_lock",
    title: "Lock a managed device",
    description: "Lock a Workspace ONE UEM device (DeviceLock command).",
    mutating: true,
    inputSchema: { deviceId: z.number().int().positive().describe("The UEM device id.") },
    handler: async (args) => {
      await gw.deviceCommand(args.deviceId, "DeviceLock");
      return jsonResult({ status: "accepted", action: "lock", deviceId: args.deviceId });
    }
  });

  // ── device_clear_passcode ─────────────────────────────────────────────────────
  reg({
    name: "device_clear_passcode",
    title: "Clear a device passcode",
    description: "Clear the passcode on a Workspace ONE UEM device (ClearPasscode command).",
    mutating: true,
    inputSchema: { deviceId: z.number().int().positive().describe("The UEM device id.") },
    handler: async (args) => {
      await gw.deviceCommand(args.deviceId, "ClearPasscode");
      return jsonResult({ status: "accepted", action: "clear_passcode", deviceId: args.deviceId });
    }
  });

  // ── device_query ──────────────────────────────────────────────────────────────
  reg({
    name: "device_query",
    title: "Query a managed device",
    description: "Request a Workspace ONE UEM device to check in and report current sample data (DeviceQuery command).",
    mutating: true,
    inputSchema: { deviceId: z.number().int().positive().describe("The UEM device id.") },
    handler: async (args) => {
      await gw.deviceCommand(args.deviceId, "DeviceQuery");
      return jsonResult({ status: "accepted", action: "query", deviceId: args.deviceId });
    }
  });

  // ── device_wipe ───────────────────────────────────────────────────────────────
  reg({
    name: "device_wipe",
    title: "Enterprise-wipe a managed device",
    description:
      "Enterprise-wipe a Workspace ONE UEM device (EnterpriseWipe command): removes corporate accounts, profiles, and managed apps. DESTRUCTIVE and not reversible.",
    mutating: true,
    destructive: true,
    inputSchema: { deviceId: z.number().int().positive().describe("The UEM device id.") },
    handler: async (args) => {
      await gw.deviceCommand(args.deviceId, "EnterpriseWipe");
      return jsonResult({ status: "accepted", action: "enterprise_wipe", deviceId: args.deviceId });
    }
  });
}
