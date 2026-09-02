import type { PowerShellEngine } from "../core/powershell.js";
import { psQuote } from "../core/powershell.js";
import type { RemediationAction } from "../agent/remediation.js";

/** Checkpoint captured before a service remediation, used for rollback. */
interface ServiceCheckpoint {
  startType?: string;
  status?: string;
}

/**
 * Vetted, on-device remediation actions for the agent. Each action is expressed
 * as the four self-verifying primitives (probe/checkpoint/apply/rollback) so the
 * engine in {@link ../agent/remediation.js} can keep or auto-revert the change.
 *
 * The catalog is deliberately small and safe — real native operations with a
 * measurable symptom — rather than arbitrary commands.
 */
export function buildAction(name: string, target: string | undefined, ps: PowerShellEngine): RemediationAction {
  switch (name) {
    case "restart-service":
      return restartServiceAction(requireTarget(name, target), ps);
    default:
      throw new Error(`Unknown remediation action: '${name}'. Known: restart-service.`);
  }
}

export const KNOWN_ACTIONS = ["restart-service"] as const;

function requireTarget(action: string, target: string | undefined): string {
  if (!target) throw new Error(`Action '${action}' requires a target (e.g. the service name).`);
  return target;
}

/**
 * Recover a stopped/unhealthy Windows service. Symptom score: 1 if Running, else 0.
 * The fix starts the service; if it still won't run, the change is reverted to the
 * captured start type (nothing is left half-applied).
 */
function restartServiceAction(serviceName: string, ps: PowerShellEngine): RemediationAction<ServiceCheckpoint> {
  const q = psQuote(serviceName);
  return {
    name: "restart-service",
    description: `Recover the '${serviceName}' service`,
    async probe(): Promise<number> {
      const script = `try { if ((Get-Service -Name ${q} -ErrorAction Stop).Status -eq 'Running') { 1 } else { 0 } } catch { 0 }`;
      const out = await ps.run(script, { timeoutMs: 20_000 });
      return out.stdout.trim() === "1" ? 1 : 0;
    },
    async checkpoint(): Promise<ServiceCheckpoint> {
      const script = `Get-Service -Name ${q} -ErrorAction SilentlyContinue | Select-Object @{n='startType';e={[string]$_.StartType}}, @{n='status';e={[string]$_.Status}} | ConvertTo-Json -Compress`;
      return (await ps.runJson<ServiceCheckpoint>(script, { timeoutMs: 20_000 })) ?? {};
    },
    async apply(): Promise<void> {
      const script = `$ErrorActionPreference='Stop'; Restart-Service -Name ${q} -Force`;
      const out = await ps.run(script, { timeoutMs: 120_000 });
      if (out.exitCode !== 0 && out.stderr.trim()) {
        // Restart can fail on a stopped service; fall back to Start-Service.
        const start = await ps.run(`$ErrorActionPreference='Stop'; Start-Service -Name ${q}`, { timeoutMs: 120_000 });
        if (start.exitCode !== 0 && start.stderr.trim()) {
          throw new Error(start.stderr.trim().slice(0, 500));
        }
      }
    },
    async rollback(checkpoint: ServiceCheckpoint): Promise<void> {
      // Best-effort: restore the captured start type. We never stop a service that
      // is now running (that would re-break a recovered endpoint).
      if (checkpoint.startType) {
        await ps.run(`Set-Service -Name ${q} -StartupType ${psQuote(checkpoint.startType)} -ErrorAction SilentlyContinue`, {
          timeoutMs: 20_000
        });
      }
    }
  };
}
