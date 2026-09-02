import { Client, type ConnectConfig } from "ssh2";
import { readFileSync } from "node:fs";
import type { Logger } from "../../core/logger.js";
import { ProviderUnavailableError } from "../../core/errors.js";
import type { RemoteExecResult, RemoteExecutor } from "./executor.js";
import { resolveSecret, type RemoteTarget } from "./targets.js";

/**
 * Executes scripts on a remote host over SSH (via the pure-JS `ssh2` client).
 * The script is sent as a base64 `-EncodedCommand` so quoting/escaping across
 * the SSH channel is a non-issue. Supports password or private-key auth.
 */
export class SshExecutor implements RemoteExecutor {
  readonly method = "ssh" as const;

  constructor(
    private readonly target: RemoteTarget,
    private readonly logger: Logger,
    /** PowerShell command to invoke on the target (Windows: powershell; Linux: pwsh). */
    private readonly shell: string = "powershell"
  ) {}

  /** Build the ssh2 connection config, resolving secrets from the environment. */
  buildConnectConfig(): ConnectConfig {
    const cfg: ConnectConfig = {
      host: this.target.host,
      port: this.target.port ?? 22,
      username: this.target.username
    };
    if (this.target.privateKeyPath) {
      cfg.privateKey = readFileSync(this.target.privateKeyPath);
      const passphrase = resolveSecret(this.target.passphraseEnv);
      if (passphrase) cfg.passphrase = passphrase;
    } else {
      const pwd = resolveSecret(this.target.passwordEnv);
      if (!pwd) {
        throw new ProviderUnavailableError(
          `SSH target '${this.target.id}' has no usable credential (env '${this.target.passwordEnv}' empty and no privateKeyPath).`
        );
      }
      cfg.password = pwd;
    }
    return cfg;
  }

  buildCommand(script: string): string {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return `${this.shell} -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  }

  exec(script: string, timeoutMs: number): Promise<RemoteExecResult> {
    const start = Date.now();
    const command = this.buildCommand(script);
    const cfg = this.buildConnectConfig();

    return new Promise<RemoteExecResult>((resolve) => {
      const conn = new Client();
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const finish = (exitCode: number | null, extraStderr = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          conn.end();
        } catch {
          // ignore
        }
        resolve({
          stdout,
          stderr: stderr + extraStderr,
          exitCode,
          timedOut,
          durationMs: Date.now() - start
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          conn.end();
        } catch {
          // ignore
        }
        finish(null, "\nSSH execution timed out");
      }, timeoutMs);

      conn.on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            finish(null, `\n${String(err)}`);
            return;
          }
          stream
            .on("close", (code: number | null) => finish(code ?? null))
            .on("data", (d: Buffer) => {
              stdout += d.toString();
            });
          stream.stderr.on("data", (d: Buffer) => {
            stderr += d.toString();
          });
        });
      });

      conn.on("error", (err) => {
        this.logger.debug({ err, target: this.target.id }, "ssh connection error");
        finish(null, `\n${String(err)}`);
      });

      conn.connect({ ...cfg, readyTimeout: Math.min(timeoutMs, 20_000) });
    });
  }
}
