import type { PowerShellEngine } from "../../core/powershell.js";
import { ProviderUnavailableError } from "../../core/errors.js";
import type { RemoteExecResult, RemoteExecutor } from "./executor.js";
import { resolveSecret, type RemoteTarget } from "./targets.js";

/**
 * Constant local wrapper that runs a remote script via PowerShell Remoting
 * (`Invoke-Command`). It reads the script and all connection parameters from
 * environment variables — never from interpolated command text — so neither the
 * remote script nor the credential is ever concatenated into a shell line.
 */
const WINRM_WRAPPER = `
$ErrorActionPreference = 'Stop'
$script = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:WMCP_RS))
$sb = [scriptblock]::Create($script)
$p = @{ ComputerName = $env:WMCP_HOST; ScriptBlock = $sb }
if ($env:WMCP_PORT) { $p.Port = [int]$env:WMCP_PORT }
if ($env:WMCP_SSL -eq '1') { $p.UseSSL = $true }
if ($env:WMCP_USER) {
  $sec = ConvertTo-SecureString $env:WMCP_PWD -AsPlainText -Force
  $p.Credential = New-Object System.Management.Automation.PSCredential($env:WMCP_USER, $sec)
}
Invoke-Command @p`;

/**
 * Executes scripts on a remote Windows host over WinRM by driving the local
 * PowerShell engine's `Invoke-Command`. Requires no native dependencies — it
 * reuses the same hardened engine (encoded command, timeout, process-tree kill)
 * as the Local provider.
 */
export class WinRmExecutor implements RemoteExecutor {
  readonly method = "winrm" as const;

  constructor(
    private readonly ps: PowerShellEngine,
    private readonly target: RemoteTarget
  ) {}

  /** Build the child-process environment carrying the script + connection info. */
  buildEnv(script: string): Record<string, string> {
    const env: Record<string, string> = {
      WMCP_RS: Buffer.from(script, "utf16le").toString("base64"),
      WMCP_HOST: this.target.host
    };
    if (this.target.port) env.WMCP_PORT = String(this.target.port);
    if (this.target.useSsl) env.WMCP_SSL = "1";
    if (this.target.username) {
      const pwd = resolveSecret(this.target.passwordEnv);
      if (!pwd) {
        throw new ProviderUnavailableError(
          `WinRM target '${this.target.id}' sets a username but env var '${this.target.passwordEnv}' is empty.`
        );
      }
      env.WMCP_USER = this.target.username;
      env.WMCP_PWD = pwd;
    }
    return env;
  }

  async exec(script: string, timeoutMs: number): Promise<RemoteExecResult> {
    const env = this.buildEnv(script);
    const res = await this.ps.run(WINRM_WRAPPER, { timeoutMs, env });
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs: res.durationMs
    };
  }
}
