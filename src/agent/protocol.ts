/**
 * Shared wire protocol + autonomy model for the client troubleshooter agent
 * (technical spec, Ch. 10). The agent is outbound-only: it dials the broker,
 * enrolls, then long-polls for commands and posts back results. These types are
 * shared by the server-side registry/broker and the agent runtime.
 */

/** The autonomy ladder (spec Ch. 10.1). Higher = more independent action. */
export type AutonomyLevel = "L0" | "L1" | "L2" | "L3";

export const AUTONOMY_RANK: Record<AutonomyLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

export const AUTONOMY_LABEL: Record<AutonomyLevel, string> = {
  L0: "Observe (read-only diagnostics/state)",
  L1: "Suggest (propose a fix for a human)",
  L2: "Confirm (execute after explicit confirmation)",
  L3: "Autonomous (self-verifying remediate + auto-rollback)"
};

/** Clamp a requested autonomy level to the policy ceiling. */
export function capAutonomy(requested: AutonomyLevel, ceiling: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_RANK[requested] <= AUTONOMY_RANK[ceiling] ? requested : ceiling;
}

export type AgentStatus = "online" | "stale" | "offline";

/** Server-side record of an enrolled agent. */
export interface AgentRecord {
  id: string;
  hostname: string;
  platform: string;
  agentVersion?: string;
  enrolledAt: string;
  lastSeenAt: string;
  status: AgentStatus;
  /** The autonomy ceiling this agent may act at (min of its request and server policy). */
  autonomyCeiling: AutonomyLevel;
  /** Command kinds the agent is allowed to run. */
  allowList: AgentCommandKind[];
  /** Opaque attestation claim presented at enrollment (MVP trust model). */
  attestation?: string;
}

export type AgentCommandKind = "diagnostics" | "remediate" | "collect_state";

/** A command queued for an agent to execute. */
export interface AgentCommand {
  id: string;
  agentId: string;
  kind: AgentCommandKind;
  params: Record<string, unknown>;
  autonomy: AutonomyLevel;
  createdAt: string;
}

/** A result posted back by an agent for a command. */
export interface AgentCommandResult {
  commandId: string;
  agentId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  completedAt: string;
}

// ── Enrollment / heartbeat payloads ─────────────────────────────────────────

export interface EnrollRequest {
  agentId: string;
  hostname: string;
  platform: string;
  agentVersion?: string;
  /** Requested autonomy ceiling (capped by server policy). */
  autonomy?: AutonomyLevel;
  /** Command kinds the agent offers. */
  capabilities?: AgentCommandKind[];
  /** Attestation claim (MVP: an opaque string; production: signed/hardware). */
  attestation?: string;
}

export interface EnrollResponse {
  agentId: string;
  /** The effective autonomy ceiling after applying server policy. */
  autonomyCeiling: AutonomyLevel;
  allowList: AgentCommandKind[];
  /** Heartbeat cadence the agent should honor (ms). */
  heartbeatIntervalMs: number;
}
