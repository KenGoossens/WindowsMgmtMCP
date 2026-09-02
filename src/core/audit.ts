import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

/** Keys whose values must never be written to the audit trail verbatim. */
const SENSITIVE_KEY_PATTERNS = [/secret/i, /token/i, /password/i, /credential/i, /\bkey\b/i, /apikey/i];

const REDACTED = "[REDACTED]";

/** Recursively redact values for keys that look sensitive. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERNS.some((re) => re.test(k)) ? REDACTED : redact(v);
    }
    return out;
  }
  return value;
}

export type AuditStatus = "ok" | "error" | "dry-run" | "blocked";

export interface AuditContext {
  tool: string;
  args: unknown;
  caller?: string;
  tenantId?: string;
  transport?: string;
  sessionId?: string;
}

export interface AuditHandle {
  /** Record the end of a tool call with its final disposition. */
  end(status: AuditStatus, extra?: Record<string, unknown>): void;
}

/**
 * Per-call audit trail. Every tool invocation is recorded with begin/end events
 * (tool, redacted arguments, caller/session, status, and duration) to both a
 * dedicated append-only log file and the structured logger.
 */
export class AuditLogger {
  private readonly stream: fs.WriteStream;

  constructor(
    filePath: string,
    private readonly logger: Logger
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: "a" });
  }

  begin(ctx: AuditContext): AuditHandle {
    const id = randomUUID();
    const start = Date.now();
    this.write({
      id,
      event: "tool_call_begin",
      tool: ctx.tool,
      args: redact(ctx.args),
      caller: ctx.caller,
      tenantId: ctx.tenantId,
      transport: ctx.transport,
      sessionId: ctx.sessionId
    });
    return {
      end: (status, extra) => {
        this.write({
          id,
          event: "tool_call_end",
          tool: ctx.tool,
          status,
          durationMs: Date.now() - start,
          ...extra
        });
      }
    };
  }

  private write(entry: Record<string, unknown>): void {
    const record = { ts: new Date().toISOString(), ...entry };
    this.stream.write(`${JSON.stringify(record)}\n`);
    this.logger.info(record, "audit");
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}
