import { randomUUID } from "node:crypto";
import type { Logger } from "../core/logger.js";
import { AppError } from "../core/errors.js";
import {
  AUTONOMY_RANK,
  capAutonomy,
  type AgentCommand,
  type AgentCommandKind,
  type AgentCommandResult,
  type AgentRecord,
  type AutonomyLevel,
  type EnrollRequest,
  type EnrollResponse
} from "./protocol.js";

export class AgentError extends AppError {}

interface PendingResult {
  resolve: (result: AgentCommandResult) => void;
  timer: NodeJS.Timeout;
}

export interface AgentRegistryOptions {
  /** Shared enrollment secret an agent must present. */
  enrollmentToken?: string;
  /** Server-wide autonomy ceiling; per-agent ceilings are capped to this. */
  maxAutonomy: AutonomyLevel;
  /** Seconds without a heartbeat before an agent is considered stale. */
  staleSeconds: number;
  heartbeatIntervalMs?: number;
}

/**
 * Server-side registry + command broker for outbound agents (technical spec,
 * Ch. 10). Because agents are outbound-only, the registry uses a command-queue:
 * `dispatch()` enqueues a command and returns a promise that resolves when the
 * agent posts its result (or rejects on timeout). The agent long-polls
 * `take()` for queued commands and reports back via `submitResult()`.
 *
 * It is a single shared instance (created in index.ts), used by both the broker
 * HTTP routes and the agent_* tools.
 */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly queues = new Map<string, AgentCommand[]>();
  private readonly pending = new Map<string, PendingResult>();

  constructor(
    private readonly options: AgentRegistryOptions,
    private readonly logger: Logger
  ) {}

  get heartbeatIntervalMs(): number {
    return this.options.heartbeatIntervalMs ?? 30_000;
  }

  /** Validate the enrollment token (constant-ish check; empty token = open enrollment off). */
  verifyEnrollmentToken(token: string | undefined): boolean {
    if (!this.options.enrollmentToken) return false;
    return token === this.options.enrollmentToken;
  }

  /** Enroll (or re-enroll) an agent, applying the server autonomy ceiling. */
  enroll(req: EnrollRequest): EnrollResponse {
    const ceiling = capAutonomy(req.autonomy ?? "L0", this.options.maxAutonomy);
    const allowList: AgentCommandKind[] = req.capabilities ?? ["diagnostics", "collect_state"];
    const now = new Date().toISOString();
    const existing = this.agents.get(req.agentId);
    const record: AgentRecord = {
      id: req.agentId,
      hostname: req.hostname,
      platform: req.platform,
      agentVersion: req.agentVersion,
      enrolledAt: existing?.enrolledAt ?? now,
      lastSeenAt: now,
      status: "online",
      autonomyCeiling: ceiling,
      allowList,
      attestation: req.attestation
    };
    this.agents.set(req.agentId, record);
    if (!this.queues.has(req.agentId)) this.queues.set(req.agentId, []);
    this.logger.info({ agentId: req.agentId, hostname: req.hostname, ceiling }, "agent enrolled");
    return {
      agentId: req.agentId,
      autonomyCeiling: ceiling,
      allowList,
      heartbeatIntervalMs: this.heartbeatIntervalMs
    };
  }

  /** Record a heartbeat; returns false if the agent is not enrolled. */
  heartbeat(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.lastSeenAt = new Date().toISOString();
    agent.status = "online";
    return true;
  }

  private freshen(agent: AgentRecord): AgentRecord {
    const ageMs = Date.now() - Date.parse(agent.lastSeenAt);
    agent.status = ageMs > this.options.staleSeconds * 1000 ? "stale" : "online";
    return agent;
  }

  get(agentId: string): AgentRecord | undefined {
    const agent = this.agents.get(agentId);
    return agent ? this.freshen(agent) : undefined;
  }

  list(): AgentRecord[] {
    return [...this.agents.values()].map((a) => this.freshen(a)).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Agent long-poll: take all queued commands for an agent. */
  take(agentId: string): AgentCommand[] {
    this.heartbeat(agentId);
    const queue = this.queues.get(agentId);
    if (!queue || queue.length === 0) return [];
    return queue.splice(0, queue.length);
  }

  /** Agent posts a command result; resolves the matching pending dispatch. */
  submitResult(result: AgentCommandResult): void {
    this.heartbeat(result.agentId);
    const pending = this.pending.get(result.commandId);
    if (!pending) {
      this.logger.warn({ commandId: result.commandId }, "result for unknown/expired command");
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(result.commandId);
    pending.resolve(result);
  }

  /**
   * Enqueue a command for an agent and await its result. Enforces enrollment,
   * online status, the allow-list, and the autonomy ceiling before dispatch.
   */
  dispatch(
    agentId: string,
    kind: AgentCommandKind,
    params: Record<string, unknown>,
    requestedAutonomy: AutonomyLevel = "L0",
    timeoutMs = 60_000
  ): Promise<AgentCommandResult> {
    const agent = this.get(agentId);
    if (!agent) throw new AgentError(`Unknown agent: '${agentId}'`);
    if (agent.status !== "online") throw new AgentError(`Agent '${agentId}' is ${agent.status}; cannot dispatch.`);
    if (!agent.allowList.includes(kind)) {
      throw new AgentError(`Agent '${agentId}' is not allow-listed for '${kind}'.`);
    }
    const autonomy = capAutonomy(requestedAutonomy, agent.autonomyCeiling);
    if (kind === "remediate" && AUTONOMY_RANK[autonomy] < AUTONOMY_RANK.L2) {
      throw new AgentError(
        `Remediation needs at least L2 autonomy; agent ceiling is '${agent.autonomyCeiling}'.`
      );
    }

    const command: AgentCommand = {
      id: randomUUID(),
      agentId,
      kind,
      params,
      autonomy,
      createdAt: new Date().toISOString()
    };
    const queue = this.queues.get(agentId) ?? [];
    queue.push(command);
    this.queues.set(agentId, queue);

    return new Promise<AgentCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new AgentError(`Agent '${agentId}' did not return a result within ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(command.id, { resolve, timer });
    });
  }

  /** Clear all pending waits (on shutdown). */
  dispose(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
