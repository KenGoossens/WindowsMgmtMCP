import { fetch as undiciFetch } from "undici";
import type { Logger } from "../core/logger.js";
import type { PowerShellEngine } from "../core/powershell.js";
import {
  runSelfVerifying,
  type RemediationOutcome
} from "../agent/remediation.js";
import type {
  AgentCommand,
  AgentCommandResult,
  AutonomyLevel,
  EnrollRequest,
  EnrollResponse
} from "../agent/protocol.js";
import { runDiagnostics, collectStateBundle } from "./diagnostics.js";
import { buildAction } from "./actions.js";

export interface AgentRuntimeOptions {
  brokerUrl: string;
  agentId: string;
  enrollmentToken: string;
  autonomy: AutonomyLevel;
  pollIntervalMs?: number;
}

/**
 * The outbound client troubleshooter agent (technical spec, Ch. 10). It dials the
 * broker (never listens), enrolls with an attestation claim, then long-polls for
 * commands and executes them locally via the PowerShell engine — diagnostics and
 * state collection (read-only), and the self-verifying remediation loop. Results
 * are posted back. Outbound-only means no inbound attack surface on the endpoint.
 */
export class AgentRuntime {
  private enrollment?: EnrollResponse;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly options: AgentRuntimeOptions,
    private readonly ps: PowerShellEngine,
    private readonly logger: Logger
  ) {}

  private get base(): string {
    return this.options.brokerUrl.replace(/\/+$/, "");
  }

  private get pollMs(): number {
    return this.options.pollIntervalMs ?? 2000;
  }

  /** Enroll, then begin the poll loop. */
  async start(): Promise<void> {
    await this.enroll();
    this.scheduleNextPoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Build the attestation claim presented at enrollment (MVP: descriptive). */
  private attestation(): string {
    return `node:${process.version};platform:${process.platform};pid:${process.pid}`;
  }

  async enroll(): Promise<EnrollResponse> {
    const body: EnrollRequest = {
      agentId: this.options.agentId,
      hostname: process.env.COMPUTERNAME ?? "localhost",
      platform: process.platform,
      agentVersion: "0.1.0",
      autonomy: this.options.autonomy,
      capabilities: ["diagnostics", "remediate", "collect_state"],
      attestation: this.attestation()
    };
    const res = await undiciFetch(`${this.base}/agent/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.enrollmentToken}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error(`Enrollment failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    this.enrollment = (await res.json()) as EnrollResponse;
    this.logger.info(
      { agentId: this.options.agentId, ceiling: this.enrollment.autonomyCeiling },
      "agent enrolled with broker"
    );
    return this.enrollment;
  }

  private scheduleNextPoll(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => this.scheduleNextPoll());
    }, this.pollMs);
  }

  /** Fetch queued commands and execute each, posting results back. */
  async pollOnce(): Promise<void> {
    let commands: AgentCommand[] = [];
    try {
      const res = await undiciFetch(`${this.base}/agent/commands?agentId=${encodeURIComponent(this.options.agentId)}`);
      if (!res.ok) return;
      commands = ((await res.json()) as { commands: AgentCommand[] }).commands ?? [];
    } catch (err) {
      this.logger.debug({ err }, "poll failed (broker unreachable?)");
      return;
    }
    for (const command of commands) {
      const result = await this.execute(command);
      await this.postResult(result);
    }
  }

  private async execute(command: AgentCommand): Promise<AgentCommandResult> {
    const base = { commandId: command.id, agentId: this.options.agentId, completedAt: new Date().toISOString() };
    try {
      switch (command.kind) {
        case "diagnostics": {
          const checks = Array.isArray(command.params.checks) ? (command.params.checks as string[]) : [];
          return { ...base, ok: true, data: await runDiagnostics(this.ps, checks) };
        }
        case "collect_state": {
          return { ...base, ok: true, data: await collectStateBundle(this.ps) };
        }
        case "remediate": {
          const data = await this.remediate(command);
          return { ...base, ok: true, data };
        }
        default:
          return { ...base, ok: false, error: `unknown command kind: ${command.kind}` };
      }
    } catch (err) {
      return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async remediate(command: AgentCommand): Promise<RemediationOutcome & { autonomy: AutonomyLevel }> {
    const action = String(command.params.action ?? "");
    const target = command.params.target as string | undefined;
    const built = buildAction(action, target, this.ps);
    // restart-service: healthy when running (score 1).
    const outcome = await runSelfVerifying(built, { healthyThreshold: 1 });
    return { ...outcome, autonomy: command.autonomy };
  }

  private async postResult(result: AgentCommandResult): Promise<void> {
    try {
      await undiciFetch(`${this.base}/agent/results`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result)
      });
    } catch (err) {
      this.logger.warn({ err, commandId: result.commandId }, "failed to post agent result");
    }
  }
}
