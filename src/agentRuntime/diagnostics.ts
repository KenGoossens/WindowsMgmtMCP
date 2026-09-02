import type { PowerShellEngine } from "../core/powershell.js";
import { psQuote } from "../core/powershell.js";
import { HOST_METRICS_SCRIPT, type HostMetrics } from "../providers/windowsScripts.js";

export interface AgentDiagnostics {
  hostname: string;
  ts: string;
  metrics: HostMetrics;
  services: { name: string; status: string }[];
  notes: string[];
}

/**
 * Run read-only local diagnostics on the endpoint: live host metrics
 * (CPU/memory/disk) plus the run state of any requested services. Non-Windows
 * hosts (or a missing PowerShell) degrade gracefully with a note rather than
 * failing the whole command.
 */
export async function runDiagnostics(ps: PowerShellEngine, checks: string[]): Promise<AgentDiagnostics> {
  const notes: string[] = [];
  let metrics: HostMetrics = { cpu: 0, memory: 0, disk: 0 };
  try {
    metrics = await ps.runJson<HostMetrics>(HOST_METRICS_SCRIPT, { timeoutMs: 30_000 });
  } catch (err) {
    notes.push(`metrics unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const services: { name: string; status: string }[] = [];
  for (const name of checks) {
    try {
      const script = `Get-Service -Name ${psQuote(name)} -ErrorAction Stop | Select-Object Name, @{n='status';e={[string]$_.Status}} | ConvertTo-Json -Compress`;
      const svc = await ps.runJson<{ Name: string; status: string }>(script, { timeoutMs: 20_000 });
      services.push({ name: svc?.Name ?? name, status: svc?.status ?? "unknown" });
    } catch {
      services.push({ name, status: "not-found" });
    }
  }

  return {
    hostname: process.env.COMPUTERNAME ?? "localhost",
    ts: new Date().toISOString(),
    metrics,
    services,
    notes
  };
}

/** Capture a richer diagnostic/state bundle for escalation (system info + diagnostics). */
export async function collectStateBundle(ps: PowerShellEngine): Promise<Record<string, unknown>> {
  const diagnostics = await runDiagnostics(ps, []);
  let osInfo: unknown = null;
  try {
    osInfo = await ps.runJson(
      "Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, LastBootUpTime | ConvertTo-Json -Compress",
      { timeoutMs: 20_000 }
    );
  } catch {
    // best-effort
  }
  return { capturedAt: new Date().toISOString(), os: osInfo, diagnostics };
}
