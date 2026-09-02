import {
  WorkSpacesClient,
  DescribeWorkspacesCommand,
  StartWorkspacesCommand,
  StopWorkspacesCommand,
  RebootWorkspacesCommand,
  RebuildWorkspacesCommand,
  CreateWorkspacesCommand,
  TerminateWorkspacesCommand,
  RestoreWorkspaceCommand,
  MigrateWorkspaceCommand,
  ModifyWorkspacePropertiesCommand,
  DescribeWorkspacesConnectionStatusCommand,
  DescribeWorkspaceSnapshotsCommand,
  CreateStandbyWorkspacesCommand,
  DescribeWorkspacesPoolsCommand,
  StartWorkspacesPoolCommand,
  StopWorkspacesPoolCommand,
  TerminateWorkspacesPoolCommand,
  DescribeWorkspacesPoolSessionsCommand,
  TerminateWorkspacesPoolSessionCommand,
  type Workspace,
  type WorkspaceRequest,
  type WorkspaceProperties,
  type WorkspaceConnectionStatus,
  type Snapshot,
  type StandbyWorkspace,
  type WorkspacesPool,
  type WorkspacesPoolSession,
  type FailedWorkspaceChangeRequest,
  type FailedCreateWorkspaceRequest,
  type FailedCreateStandbyWorkspacesRequest
} from "@aws-sdk/client-workspaces";
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { AppConfig } from "../../config/schema.js";

/** Whether enough AWS configuration is present for the WorkSpaces provider. */
export function hasAwsConfig(config: AppConfig): boolean {
  return Boolean(config.awsRegion);
}

/**
 * Thin, typed wrapper over the AWS WorkSpaces SDK. Resolves credentials through
 * the standard AWS chain: explicit keys, then a named profile, then the default
 * node provider chain (env / shared config / IAM role). The client is created
 * lazily so the provider can be registered without credentials being resolved
 * until the first call.
 */
export class WorkSpacesGateway {
  private client?: WorkSpacesClient;

  constructor(private readonly config: AppConfig) {}

  private getClient(): WorkSpacesClient {
    if (this.client) return this.client;

    let credentials;
    if (this.config.awsAccessKeyId && this.config.awsSecretAccessKey) {
      credentials = {
        accessKeyId: this.config.awsAccessKeyId,
        secretAccessKey: this.config.awsSecretAccessKey
      };
    } else if (this.config.awsProfile) {
      credentials = fromIni({ profile: this.config.awsProfile });
    } else {
      credentials = fromNodeProviderChain();
    }

    this.client = new WorkSpacesClient({ region: this.config.awsRegion, credentials });
    return this.client;
  }

  /** List WorkSpaces, optionally filtered by directory or a specific id. */
  async describe(opts: { workspaceId?: string; directoryId?: string; limit?: number } = {}): Promise<Workspace[]> {
    const all: Workspace[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.getClient().send(
        new DescribeWorkspacesCommand({
          WorkspaceIds: opts.workspaceId ? [opts.workspaceId] : undefined,
          DirectoryId: opts.directoryId ?? this.config.awsWorkspacesDirectoryId,
          Limit: opts.limit,
          NextToken: nextToken
        })
      );
      for (const w of res.Workspaces ?? []) all.push(w);
      nextToken = res.NextToken;
      if (opts.workspaceId || opts.limit) break;
    } while (nextToken);
    return all;
  }

  async start(workspaceId: string): Promise<FailedWorkspaceChangeRequest[]> {
    const res = await this.getClient().send(
      new StartWorkspacesCommand({ StartWorkspaceRequests: [{ WorkspaceId: workspaceId }] })
    );
    return res.FailedRequests ?? [];
  }

  async stop(workspaceId: string): Promise<FailedWorkspaceChangeRequest[]> {
    const res = await this.getClient().send(
      new StopWorkspacesCommand({ StopWorkspaceRequests: [{ WorkspaceId: workspaceId }] })
    );
    return res.FailedRequests ?? [];
  }

  async reboot(workspaceId: string): Promise<FailedWorkspaceChangeRequest[]> {
    const res = await this.getClient().send(
      new RebootWorkspacesCommand({ RebootWorkspaceRequests: [{ WorkspaceId: workspaceId }] })
    );
    return res.FailedRequests ?? [];
  }

  async rebuild(workspaceId: string): Promise<FailedWorkspaceChangeRequest[]> {
    const res = await this.getClient().send(
      new RebuildWorkspacesCommand({ RebuildWorkspaceRequests: [{ WorkspaceId: workspaceId }] })
    );
    return res.FailedRequests ?? [];
  }

  async create(request: WorkspaceRequest): Promise<{
    pending: Workspace[];
    failed: FailedCreateWorkspaceRequest[];
  }> {
    const res = await this.getClient().send(new CreateWorkspacesCommand({ Workspaces: [request] }));
    return { pending: res.PendingRequests ?? [], failed: res.FailedRequests ?? [] };
  }

  /** Permanently terminate a WorkSpace (irreversible — destroys both volumes). */
  async terminate(workspaceId: string): Promise<FailedWorkspaceChangeRequest[]> {
    const res = await this.getClient().send(
      new TerminateWorkspacesCommand({ TerminateWorkspaceRequests: [{ WorkspaceId: workspaceId }] })
    );
    return res.FailedRequests ?? [];
  }

  /** Restore a WorkSpace from its last known-good snapshot (root + user volume). */
  async restore(workspaceId: string): Promise<void> {
    await this.getClient().send(new RestoreWorkspaceCommand({ WorkspaceId: workspaceId }));
  }

  /** Migrate a WorkSpace to a new bundle (recreates from a new image, keeps the user profile). */
  async migrate(
    sourceWorkspaceId: string,
    bundleId: string
  ): Promise<{ sourceWorkspaceId?: string; targetWorkspaceId?: string }> {
    const res = await this.getClient().send(
      new MigrateWorkspaceCommand({ SourceWorkspaceId: sourceWorkspaceId, BundleId: bundleId })
    );
    return { sourceWorkspaceId: res.SourceWorkspaceId, targetWorkspaceId: res.TargetWorkspaceId };
  }

  /** Modify mutable WorkSpace properties: compute type, running mode, and volume sizes. */
  async modifyProperties(workspaceId: string, properties: WorkspaceProperties): Promise<void> {
    await this.getClient().send(
      new ModifyWorkspacePropertiesCommand({ WorkspaceId: workspaceId, WorkspaceProperties: properties })
    );
  }

  /** Real per-WorkSpace session connectivity (CONNECTED / DISCONNECTED / UNKNOWN). */
  async connectionStatus(workspaceIds?: string[]): Promise<WorkspaceConnectionStatus[]> {
    const all: WorkspaceConnectionStatus[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.getClient().send(
        new DescribeWorkspacesConnectionStatusCommand({ WorkspaceIds: workspaceIds, NextToken: nextToken })
      );
      for (const s of res.WorkspacesConnectionStatus ?? []) all.push(s);
      nextToken = res.NextToken;
      if (workspaceIds && workspaceIds.length > 0) break;
    } while (nextToken);
    return all;
  }

  /** List the rebuild (user-volume) and restore (root + user) snapshots for a WorkSpace. */
  async snapshots(workspaceId: string): Promise<{ rebuild: Snapshot[]; restore: Snapshot[] }> {
    const res = await this.getClient().send(new DescribeWorkspaceSnapshotsCommand({ WorkspaceId: workspaceId }));
    return { rebuild: res.RebuildSnapshots ?? [], restore: res.RestoreSnapshots ?? [] };
  }

  /** Create a cross-region standby (DR replica) of a primary WorkSpace. */
  async createStandby(
    primaryRegion: string,
    standby: StandbyWorkspace
  ): Promise<{ pending: unknown[]; failed: FailedCreateStandbyWorkspacesRequest[] }> {
    const res = await this.getClient().send(
      new CreateStandbyWorkspacesCommand({ PrimaryRegion: primaryRegion, StandbyWorkspaces: [standby] })
    );
    return { pending: res.PendingStandbyRequests ?? [], failed: res.FailedStandbyRequests ?? [] };
  }

  // ── WorkSpaces Pools (non-persistent / streaming substrate) ────────────────

  /** List WorkSpaces Pools (ephemeral, AppStream-style desktops). */
  async describePools(poolIds?: string[]): Promise<WorkspacesPool[]> {
    const all: WorkspacesPool[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.getClient().send(
        new DescribeWorkspacesPoolsCommand({ PoolIds: poolIds, NextToken: nextToken })
      );
      for (const p of res.WorkspacesPools ?? []) all.push(p);
      nextToken = res.NextToken;
      if (poolIds && poolIds.length > 0) break;
    } while (nextToken);
    return all;
  }

  async startPool(poolId: string): Promise<void> {
    await this.getClient().send(new StartWorkspacesPoolCommand({ PoolId: poolId }));
  }

  async stopPool(poolId: string): Promise<void> {
    await this.getClient().send(new StopWorkspacesPoolCommand({ PoolId: poolId }));
  }

  async terminatePool(poolId: string): Promise<void> {
    await this.getClient().send(new TerminateWorkspacesPoolCommand({ PoolId: poolId }));
  }

  /** List active streaming sessions for a pool, optionally scoped to a user. */
  async describePoolSessions(poolId: string, userId?: string): Promise<WorkspacesPoolSession[]> {
    const all: WorkspacesPoolSession[] = [];
    let nextToken: string | undefined;
    do {
      const res = await this.getClient().send(
        new DescribeWorkspacesPoolSessionsCommand({ PoolId: poolId, UserId: userId, NextToken: nextToken })
      );
      for (const s of res.Sessions ?? []) all.push(s);
      nextToken = res.NextToken;
    } while (nextToken);
    return all;
  }

  async terminatePoolSession(sessionId: string): Promise<void> {
    await this.getClient().send(new TerminateWorkspacesPoolSessionCommand({ SessionId: sessionId }));
  }

  /** For tests / disposal. */
  destroy(): void {
    this.client?.destroy();
    this.client = undefined;
  }
}

export type {
  Workspace,
  WorkspaceRequest,
  WorkspaceProperties,
  WorkspaceConnectionStatus,
  Snapshot,
  StandbyWorkspace,
  WorkspacesPool,
  WorkspacesPoolSession
};
