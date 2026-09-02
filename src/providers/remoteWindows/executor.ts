/** Result of executing a script on a remote target. */
export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

/** A connection method (WinRM or SSH) that can run a PowerShell script remotely. */
export interface RemoteExecutor {
  readonly method: "winrm" | "ssh";
  exec(script: string, timeoutMs: number): Promise<RemoteExecResult>;
  /** Release any pooled connections. */
  dispose?(): Promise<void>;
}
