import { spawn, spawnSync } from "node:child_process";
import type { Logger } from "pino";
import { PowerShellError, PowerShellTimeoutError } from "./errors.js";

export interface PowerShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface PowerShellOptions {
  timeoutMs?: number;
  workingDir?: string;
  /**
   * Extra environment variables for the child process. Use this to pass secrets
   * (e.g. a remote credential) so they never appear in the script text or args.
   */
  env?: Record<string, string>;
}

/**
 * Escape a string for safe single-quoted interpolation into a PowerShell script.
 * Use this for every value derived from tool input to prevent script injection
 * in the structured tools (the `powershell_run` tool is intentionally arbitrary).
 */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Detect an available PowerShell executable, preferring PowerShell 7 (`pwsh`)
 * and falling back to Windows PowerShell 5.1 (`powershell.exe`).
 */
export function detectPowerShell(preferred?: string): string {
  const candidates = preferred ? [preferred] : ["pwsh", "powershell.exe", "powershell"];
  for (const exe of candidates) {
    try {
      const probe = spawnSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
        windowsHide: true,
        timeout: 8000
      });
      if (probe.status === 0) return exe;
    } catch {
      // try next candidate
    }
  }
  // Fall back to a sensible default; invocations will surface a clear error if absent.
  return preferred ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");
}

/**
 * Arbitrary PowerShell execution engine.
 *
 * Security properties (per the technical spec, Chapter 13):
 * - scripts are passed via `-EncodedCommand` (base64 UTF-16LE), never string-concatenated;
 * - every invocation has a hard timeout with a **process-tree kill** on expiry;
 * - stdout/stderr/exit-code are captured and surfaced.
 */
export class PowerShellEngine {
  constructor(
    private readonly executable: string,
    private readonly defaultTimeoutMs: number,
    private readonly logger: Logger
  ) {}

  get executablePath(): string {
    return this.executable;
  }

  run(script: string, options: PowerShellOptions = {}): Promise<PowerShellResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-NoLogo",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded
    ];
    const start = Date.now();

    return new Promise<PowerShellResult>((resolve) => {
      const child = spawn(this.executable, args, {
        cwd: options.workingDir,
        windowsHide: true,
        env: options.env ? { ...process.env, ...options.env } : process.env
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        this.killTree(child.pid);
      }, timeoutMs);

      const finish = (exitCode: number | null, extraStderr = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: stderr + extraStderr,
          exitCode,
          timedOut,
          durationMs: Date.now() - start
        });
      };

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        finish(null, `\n${String(err)}`);
      });
      child.on("close", (code) => {
        finish(code);
      });
    });
  }

  /**
   * Run a script that emits JSON on stdout and parse the result. Throws
   * {@link PowerShellTimeoutError} / {@link PowerShellError} on failure.
   */
  async runJson<T = unknown>(script: string, options?: PowerShellOptions): Promise<T> {
    const wrapped = `$ProgressPreference='SilentlyContinue'; ${script}`;
    const res = await this.run(wrapped, options);

    if (res.timedOut) {
      throw new PowerShellTimeoutError(
        `PowerShell timed out after ${options?.timeoutMs ?? this.defaultTimeoutMs}ms`,
        res.stderr,
        res.exitCode
      );
    }
    const text = res.stdout.trim();
    if (res.exitCode !== 0 && !text) {
      throw new PowerShellError(
        `PowerShell exited with code ${res.exitCode}`,
        res.stderr.trim(),
        res.exitCode
      );
    }
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PowerShellError(
        "PowerShell output was not valid JSON",
        (res.stderr || text).slice(0, 4000),
        res.exitCode
      );
    }
  }

  private killTree(pid?: number): void {
    if (!pid) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch (err) {
      this.logger.warn({ err, pid }, "failed to kill PowerShell process tree");
    }
  }
}
