import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, errorResult, type ToolContext, type ToolSpec } from "../../core/tools.js";
import type {
  WorkSpacesGateway,
  Workspace,
  WorkspaceProperties,
  WorkspaceConnectionStatus,
  Snapshot,
  WorkspacesPool,
  WorkspacesPoolSession
} from "./workspacesClient.js";
import type { FailedWorkspaceChangeRequest } from "@aws-sdk/client-workspaces";

/** Reduce a verbose SDK Workspace to a normalized, stable summary. */
export function summarizeWorkspace(w: Workspace): Record<string, unknown> {
  return {
    workspaceId: w.WorkspaceId,
    directoryId: w.DirectoryId,
    userName: w.UserName,
    state: w.State,
    computerName: w.ComputerName,
    ipAddress: w.IpAddress,
    bundleId: w.BundleId,
    runningMode: w.WorkspaceProperties?.RunningMode,
    compute: w.WorkspaceProperties?.ComputeTypeName,
    rootVolumeGiB: w.WorkspaceProperties?.RootVolumeSizeGib,
    userVolumeGiB: w.WorkspaceProperties?.UserVolumeSizeGib,
    errorCode: w.ErrorCode || undefined,
    errorMessage: w.ErrorMessage || undefined
  };
}

/** Normalize a per-WorkSpace connection-status record. */
export function summarizeConnectionStatus(s: WorkspaceConnectionStatus): Record<string, unknown> {
  return {
    workspaceId: s.WorkspaceId,
    connectionState: s.ConnectionState,
    connectionStateCheckTimestamp: s.ConnectionStateCheckTimestamp?.toISOString(),
    lastKnownUserConnectionTimestamp: s.LastKnownUserConnectionTimestamp?.toISOString()
  };
}

/** Normalize a WorkSpace snapshot record. */
export function summarizeSnapshot(s: Snapshot): Record<string, unknown> {
  return { snapshotTime: s.SnapshotTime?.toISOString() };
}

/** Normalize a WorkSpaces Pool record. */
export function summarizePool(p: WorkspacesPool): Record<string, unknown> {
  return {
    poolId: p.PoolId,
    poolName: p.PoolName,
    state: p.State,
    bundleId: p.BundleId,
    directoryId: p.DirectoryId,
    desiredSessions: p.CapacityStatus?.DesiredUserSessions,
    availableSessions: p.CapacityStatus?.AvailableUserSessions,
    activeSessions: p.CapacityStatus?.ActiveUserSessions
  };
}

/** Normalize a WorkSpaces Pool streaming session record. */
export function summarizePoolSession(s: WorkspacesPoolSession): Record<string, unknown> {
  return {
    sessionId: s.SessionId,
    poolId: s.PoolId,
    userId: s.UserId,
    connectionState: s.ConnectionState,
    authenticationType: s.AuthenticationType,
    instanceId: s.InstanceId,
    expirationTime: s.ExpirationTime?.toISOString()
  };
}

function changeResult(action: string, workspaceId: string, failed: FailedWorkspaceChangeRequest[]): Record<string, unknown> {
  const failure = failed.find((f) => f.WorkspaceId === workspaceId) ?? failed[0];
  if (failure) {
    return {
      status: "failed",
      action,
      workspaceId,
      errorCode: failure.ErrorCode,
      errorMessage: failure.ErrorMessage
    };
  }
  return { status: "accepted", action, workspaceId };
}

/**
 * Register the AWS WorkSpaces tools (spec §14.6). Read tools return normalized
 * summaries; power actions are mutating (confirm-gated) and `rebuild` is
 * destructive. The primary strategic role is as a cross-cloud failover target.
 */
export function registerWorkspacesTools(server: McpServer, ctx: ToolContext, gw: WorkSpacesGateway): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── workspace_list ───────────────────────────────────────────────────────────
  reg({
    name: "workspace_list",
    title: "List WorkSpaces",
    description: "List Amazon WorkSpaces (DescribeWorkspaces), optionally scoped to a directory, with a result cap.",
    inputSchema: {
      directoryId: z.string().optional().describe("Scope to a WorkSpaces directory id."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum WorkSpaces to return (first page).")
    },
    handler: async (args) => {
      const items = await gw.describe({ directoryId: args.directoryId, limit: args.limit });
      return jsonResult({ count: items.length, workspaces: items.map(summarizeWorkspace) });
    }
  });

  // ── workspace_get ────────────────────────────────────────────────────────────
  reg({
    name: "workspace_get",
    title: "Get a WorkSpace",
    description: "Read a single Amazon WorkSpace by its id.",
    inputSchema: {
      workspaceId: z.string().min(1).describe("The WorkSpace id, e.g. ws-abc123.")
    },
    handler: async (args) => {
      const items = await gw.describe({ workspaceId: args.workspaceId });
      if (items.length === 0) return errorResult(`WorkSpace not found: ${args.workspaceId}`);
      return jsonResult(summarizeWorkspace(items[0]));
    }
  });

  // ── workspace_start ──────────────────────────────────────────────────────────
  reg({
    name: "workspace_start",
    title: "Start a WorkSpace",
    description: "Start a stopped WorkSpace (only applies to AutoStop/Manual running modes).",
    mutating: true,
    inputSchema: { workspaceId: z.string().min(1).describe("The WorkSpace id.") },
    handler: async (args) => jsonResult(changeResult("start", args.workspaceId, await gw.start(args.workspaceId)))
  });

  // ── workspace_stop ───────────────────────────────────────────────────────────
  reg({
    name: "workspace_stop",
    title: "Stop a WorkSpace",
    description: "Stop a running WorkSpace (only applies to AutoStop/Manual running modes).",
    mutating: true,
    inputSchema: { workspaceId: z.string().min(1).describe("The WorkSpace id.") },
    handler: async (args) => jsonResult(changeResult("stop", args.workspaceId, await gw.stop(args.workspaceId)))
  });

  // ── workspace_reboot ─────────────────────────────────────────────────────────
  reg({
    name: "workspace_reboot",
    title: "Reboot a WorkSpace",
    description: "Reboot a WorkSpace.",
    mutating: true,
    inputSchema: { workspaceId: z.string().min(1).describe("The WorkSpace id.") },
    handler: async (args) => jsonResult(changeResult("reboot", args.workspaceId, await gw.reboot(args.workspaceId)))
  });

  // ── workspace_rebuild ────────────────────────────────────────────────────────
  reg({
    name: "workspace_rebuild",
    title: "Rebuild a WorkSpace",
    description:
      "Rebuild a WorkSpace from its bundle. DESTRUCTIVE: the system volume is recreated; only the user volume (D:) is preserved from the last backup.",
    mutating: true,
    destructive: true,
    inputSchema: { workspaceId: z.string().min(1).describe("The WorkSpace id.") },
    handler: async (args) => jsonResult(changeResult("rebuild", args.workspaceId, await gw.rebuild(args.workspaceId)))
  });

  // ── workspace_provision ──────────────────────────────────────────────────────
  reg({
    name: "workspace_provision",
    title: "Provision a WorkSpace",
    description:
      "Create a new WorkSpace (CreateWorkspaces) for a directory user from a bundle. Primary use: stand up a cross-cloud failover target.",
    mutating: true,
    inputSchema: {
      directoryId: z.string().min(1).describe("The registered WorkSpaces directory id."),
      userName: z.string().min(1).describe("The directory user to assign the WorkSpace to."),
      bundleId: z.string().min(1).describe("The bundle id defining the WorkSpace image/compute."),
      runningMode: z.enum(["AUTO_STOP", "ALWAYS_ON"]).optional().describe("Running mode (default AUTO_STOP)."),
      rootVolumeEncryption: z.boolean().optional().describe("Encrypt the root volume."),
      userVolumeEncryption: z.boolean().optional().describe("Encrypt the user volume.")
    },
    handler: async (args) => {
      const { pending, failed } = await gw.create({
        DirectoryId: args.directoryId,
        UserName: args.userName,
        BundleId: args.bundleId,
        RootVolumeEncryptionEnabled: args.rootVolumeEncryption,
        UserVolumeEncryptionEnabled: args.userVolumeEncryption,
        WorkspaceProperties: args.runningMode ? { RunningMode: args.runningMode } : undefined
      });
      if (failed.length > 0) {
        return jsonResult({
          status: "failed",
          action: "provision",
          errorCode: failed[0].ErrorCode,
          errorMessage: failed[0].ErrorMessage
        });
      }
      return jsonResult({
        status: "accepted",
        action: "provision",
        workspaces: pending.map(summarizeWorkspace)
      });
    }
  });

  // ── workspace_terminate ──────────────────────────────────────────────────────
  reg({
    name: "workspace_terminate",
    title: "Terminate a WorkSpace",
    description:
      "Permanently terminate a WorkSpace (TerminateWorkspaces). IRREVERSIBLE: both the root and user volumes are destroyed.",
    mutating: true,
    destructive: true,
    inputSchema: { workspaceId: z.string().min(1).describe("The WorkSpace id.") },
    handler: async (args) => jsonResult(changeResult("terminate", args.workspaceId, await gw.terminate(args.workspaceId)))
  });

  // ── workspace_restore ────────────────────────────────────────────────────────
  reg({
    name: "workspace_restore",
    title: "Restore a WorkSpace",
    description:
      "Restore a WorkSpace from its last known-good snapshot (RestoreWorkspace), recovering both the root and user volumes.",
    mutating: true,
    inputSchema: { workspaceId: z.string().min(1).describe("The WorkSpace id.") },
    handler: async (args) => {
      await gw.restore(args.workspaceId);
      return jsonResult({ status: "accepted", action: "restore", workspaceId: args.workspaceId });
    }
  });

  // ── workspace_migrate ────────────────────────────────────────────────────────
  reg({
    name: "workspace_migrate",
    title: "Migrate a WorkSpace",
    description:
      "Migrate a WorkSpace to a new bundle (MigrateWorkspace). DESTRUCTIVE: the WorkSpace is recreated from the target bundle's image; the user profile (D:) is recreated and reattached.",
    mutating: true,
    destructive: true,
    inputSchema: {
      workspaceId: z.string().min(1).describe("The source WorkSpace id to migrate."),
      bundleId: z.string().min(1).describe("The target bundle id to migrate the WorkSpace to.")
    },
    handler: async (args) => {
      const res = await gw.migrate(args.workspaceId, args.bundleId);
      return jsonResult({
        status: "accepted",
        action: "migrate",
        sourceWorkspaceId: res.sourceWorkspaceId,
        targetWorkspaceId: res.targetWorkspaceId
      });
    }
  });

  // ── workspace_modify ─────────────────────────────────────────────────────────
  reg({
    name: "workspace_modify",
    title: "Modify WorkSpace properties",
    description:
      "Modify a WorkSpace's compute type (resize), running mode, and/or volume sizes (ModifyWorkspaceProperties). Volume sizes can only be increased.",
    mutating: true,
    inputSchema: {
      workspaceId: z.string().min(1).describe("The WorkSpace id."),
      computeTypeName: z
        .string()
        .optional()
        .describe("Target compute type, e.g. STANDARD, PERFORMANCE, POWER, POWERPRO, GRAPHICS_G4DN."),
      runningMode: z.enum(["AUTO_STOP", "ALWAYS_ON", "MANUAL"]).optional().describe("Target running mode."),
      autoStopTimeoutMinutes: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("AutoStop idle timeout in minutes (AUTO_STOP mode)."),
      rootVolumeGiB: z.number().int().positive().optional().describe("New root volume size in GiB (increase only)."),
      userVolumeGiB: z.number().int().positive().optional().describe("New user volume size in GiB (increase only).")
    },
    handler: async (args) => {
      await gw.modifyProperties(args.workspaceId, {
        ComputeTypeName: args.computeTypeName as WorkspaceProperties["ComputeTypeName"],
        RunningMode: args.runningMode,
        RunningModeAutoStopTimeoutInMinutes: args.autoStopTimeoutMinutes,
        RootVolumeSizeGib: args.rootVolumeGiB,
        UserVolumeSizeGib: args.userVolumeGiB
      });
      return jsonResult({ status: "accepted", action: "modify", workspaceId: args.workspaceId });
    }
  });

  // ── workspace_connection_status ──────────────────────────────────────────────
  reg({
    name: "workspace_connection_status",
    title: "WorkSpace connection status",
    description:
      "Report real user-session connectivity (DescribeWorkspacesConnectionStatus): CONNECTED / DISCONNECTED / UNKNOWN plus the last known user-connection time.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Scope to a single WorkSpace id (omit for all).")
    },
    handler: async (args) => {
      const items = await gw.connectionStatus(args.workspaceId ? [args.workspaceId] : undefined);
      return jsonResult({ count: items.length, connections: items.map(summarizeConnectionStatus) });
    }
  });

  // ── workspace_snapshots ──────────────────────────────────────────────────────
  reg({
    name: "workspace_snapshots",
    title: "List WorkSpace snapshots",
    description:
      "List the rebuild (user-volume) and restore (root + user volume) snapshots available for a WorkSpace (DescribeWorkspaceSnapshots).",
    inputSchema: { workspaceId: z.string().min(1).describe("The WorkSpace id.") },
    handler: async (args) => {
      const { rebuild, restore } = await gw.snapshots(args.workspaceId);
      return jsonResult({
        workspaceId: args.workspaceId,
        rebuildSnapshots: rebuild.map(summarizeSnapshot),
        restoreSnapshots: restore.map(summarizeSnapshot)
      });
    }
  });

  // ── workspace_standby_create ─────────────────────────────────────────────────
  reg({
    name: "workspace_standby_create",
    title: "Create a standby WorkSpace",
    description:
      "Create a cross-region standby (DR replica) of a primary WorkSpace (CreateStandbyWorkspaces). The standby tracks the primary via data replication for failover.",
    mutating: true,
    inputSchema: {
      primaryRegion: z.string().min(1).describe("The AWS region of the primary WorkSpace, e.g. us-east-1."),
      primaryWorkspaceId: z.string().min(1).describe("The id of the primary WorkSpace to replicate."),
      directoryId: z.string().min(1).describe("The directory id in the standby region for the replica."),
      volumeEncryptionKey: z.string().optional().describe("KMS key for the standby volume (optional).")
    },
    handler: async (args) => {
      const { pending, failed } = await gw.createStandby(args.primaryRegion, {
        PrimaryWorkspaceId: args.primaryWorkspaceId,
        DirectoryId: args.directoryId,
        VolumeEncryptionKey: args.volumeEncryptionKey
      });
      if (failed.length > 0) {
        return jsonResult({
          status: "failed",
          action: "standby_create",
          errorCode: failed[0].ErrorCode,
          errorMessage: failed[0].ErrorMessage
        });
      }
      return jsonResult({ status: "accepted", action: "standby_create", pending });
    }
  });

  // ── workspace_pool_list ──────────────────────────────────────────────────────
  reg({
    name: "workspace_pool_list",
    title: "List WorkSpaces Pools",
    description:
      "List WorkSpaces Pools (DescribeWorkspacesPools) — the non-persistent, streaming desktop substrate — with capacity and state.",
    inputSchema: {
      poolId: z.string().optional().describe("Scope to a single pool id (omit for all).")
    },
    handler: async (args) => {
      const items = await gw.describePools(args.poolId ? [args.poolId] : undefined);
      return jsonResult({ count: items.length, pools: items.map(summarizePool) });
    }
  });

  // ── workspace_pool_start ─────────────────────────────────────────────────────
  reg({
    name: "workspace_pool_start",
    title: "Start a WorkSpaces Pool",
    description: "Start a stopped WorkSpaces Pool (StartWorkspacesPool).",
    mutating: true,
    inputSchema: { poolId: z.string().min(1).describe("The pool id.") },
    handler: async (args) => {
      await gw.startPool(args.poolId);
      return jsonResult({ status: "accepted", action: "pool_start", poolId: args.poolId });
    }
  });

  // ── workspace_pool_stop ──────────────────────────────────────────────────────
  reg({
    name: "workspace_pool_stop",
    title: "Stop a WorkSpaces Pool",
    description: "Stop a running WorkSpaces Pool (StopWorkspacesPool). Active streaming sessions are ended.",
    mutating: true,
    inputSchema: { poolId: z.string().min(1).describe("The pool id.") },
    handler: async (args) => {
      await gw.stopPool(args.poolId);
      return jsonResult({ status: "accepted", action: "pool_stop", poolId: args.poolId });
    }
  });

  // ── workspace_pool_session_list ──────────────────────────────────────────────
  reg({
    name: "workspace_pool_session_list",
    title: "List WorkSpaces Pool sessions",
    description:
      "List active streaming sessions for a WorkSpaces Pool (DescribeWorkspacesPoolSessions), optionally scoped to a user.",
    inputSchema: {
      poolId: z.string().min(1).describe("The pool id."),
      userId: z.string().optional().describe("Scope to a single user id.")
    },
    handler: async (args) => {
      const items = await gw.describePoolSessions(args.poolId, args.userId);
      return jsonResult({ count: items.length, sessions: items.map(summarizePoolSession) });
    }
  });

  // ── workspace_pool_session_terminate ─────────────────────────────────────────
  reg({
    name: "workspace_pool_session_terminate",
    title: "Terminate a WorkSpaces Pool session",
    description:
      "Terminate an active WorkSpaces Pool streaming session (TerminateWorkspacesPoolSession). DESTRUCTIVE: the user's unsaved work in the session is lost.",
    mutating: true,
    destructive: true,
    inputSchema: { sessionId: z.string().min(1).describe("The pool session id.") },
    handler: async (args) => {
      await gw.terminatePoolSession(args.sessionId);
      return jsonResult({ status: "accepted", action: "pool_session_terminate", sessionId: args.sessionId });
    }
  });
}
