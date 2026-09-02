import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, errorResult, type ToolContext, type ToolSpec } from "../../core/tools.js";
import { SYSTEM_INFO_SCRIPT, buildServiceControlScript, buildEventLogScript } from "../windowsScripts.js";
import { resolveSecret } from "./targets.js";
import type { RemoteWindowsProvider } from "./remoteProvider.js";

/**
 * Register the Remote Windows tools. Each tool takes a `target` id (resolved
 * against the configured catalog) and runs the same operations as the Local
 * provider, over WinRM or SSH. Arbitrary remote scripts pass through the same
 * static risk gate as `powershell_run`.
 */
export function registerRemoteTools(
  server: McpServer,
  ctx: ToolContext,
  provider: RemoteWindowsProvider
): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── remote_target_list ───────────────────────────────────────────────────────
  reg({
    name: "remote_target_list",
    title: "List remote targets",
    description:
      "List configured remote Windows targets (no secrets). Set test=true to attempt a quick connectivity check on each.",
    inputSchema: {
      test: z.boolean().optional().describe("Attempt a lightweight connectivity check per target.")
    },
    handler: async (args) => {
      const targets = provider.listTargets().map((t) => ({
        id: t.id,
        host: t.host,
        method: t.method,
        port: t.port,
        username: t.username,
        hasCredential: Boolean(resolveSecret(t.passwordEnv)) || Boolean(t.privateKeyPath),
        useSsl: t.useSsl ?? false,
        label: t.label
      }));

      if (!args.test) return jsonResult({ count: targets.length, targets });

      const tested = await Promise.all(
        provider.listTargets().map(async (t) => {
          const start = Date.now();
          try {
            const data = await provider.runJson<{ ok: boolean; host: string }>(
              t,
              "[pscustomobject]@{ ok = $true; host = $env:COMPUTERNAME } | ConvertTo-Json",
              Math.min(provider.timeoutMs, 25_000)
            );
            return { id: t.id, reachable: Boolean(data?.ok), remoteHost: data?.host, ms: Date.now() - start };
          } catch (err) {
            return { id: t.id, reachable: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - start };
          }
        })
      );
      return jsonResult({ count: targets.length, targets, connectivity: tested });
    }
  });

  // ── remote_run ────────────────────────────────────────────────────────────────
  reg({
    name: "remote_run",
    title: "Run PowerShell on a remote target",
    description:
      "Execute an arbitrary PowerShell script on a configured remote target (WinRM/SSH). The same static risk gate as powershell_run applies: read-only runs directly, state-changing/irreversible scripts require \"confirm\": true.",
    mutating: true,
    inputSchema: {
      target: z.string().min(1).describe("The configured remote target id."),
      script: z.string().min(1).describe("The PowerShell script to execute on the target."),
      timeoutMs: z.number().int().positive().max(600_000).optional().describe("Per-call timeout override (ms).")
    },
    handler: async (args) => {
      const target = provider.getTarget(args.target);
      if (!target) return errorResult(`Unknown remote target: '${args.target}'`);
      const res = await provider.runRaw(target, args.script, args.timeoutMs);
      return jsonResult({
        target: target.id,
        method: target.method,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        durationMs: res.durationMs,
        stdout: res.stdout,
        stderr: res.stderr
      });
    }
  });

  // ── remote_system_info ─────────────────────────────────────────────────────────
  reg({
    name: "remote_system_info",
    title: "Remote system information",
    description: "Return an OS/hardware/uptime summary from a configured remote target.",
    inputSchema: {
      target: z.string().min(1).describe("The configured remote target id.")
    },
    handler: async (args) => {
      const target = provider.getTarget(args.target);
      if (!target) return errorResult(`Unknown remote target: '${args.target}'`);
      return jsonResult(await provider.runJson(target, SYSTEM_INFO_SCRIPT));
    }
  });

  // ── remote_service_control ──────────────────────────────────────────────────────
  reg({
    name: "remote_service_control",
    title: "Control a remote service",
    description: "Start, stop, or restart a Windows service on a configured remote target.",
    mutating: true,
    inputSchema: {
      target: z.string().min(1).describe("The configured remote target id."),
      name: z.string().min(1).describe("Service name (not display name)."),
      action: z.enum(["start", "stop", "restart"]).describe("The control action to perform.")
    },
    handler: async (args) => {
      const target = provider.getTarget(args.target);
      if (!target) return errorResult(`Unknown remote target: '${args.target}'`);
      const script = buildServiceControlScript(args.name, args.action);
      return jsonResult(await provider.runJson(target, script, Math.min(provider.timeoutMs, 120_000)));
    }
  });

  // ── remote_eventlog_query ────────────────────────────────────────────────────────
  reg({
    name: "remote_eventlog_query",
    title: "Query a remote event log",
    description: "Query a Windows event log on a configured remote target.",
    inputSchema: {
      target: z.string().min(1).describe("The configured remote target id."),
      logName: z.string().min(1).describe("Log name, e.g. System, Application, Security."),
      level: z.enum(["Critical", "Error", "Warning", "Information", "Verbose"]).optional(),
      since: z.string().optional().describe("ISO start time, e.g. 2026-01-01T00:00:00."),
      max: z.number().int().min(1).max(1000).optional().describe("Maximum events (default 50).")
    },
    handler: async (args) => {
      const target = provider.getTarget(args.target);
      if (!target) return errorResult(`Unknown remote target: '${args.target}'`);
      const script = buildEventLogScript({
        logName: args.logName,
        level: args.level,
        since: args.since,
        max: args.max
      });
      return jsonResult(await provider.runJson(target, script));
    }
  });
}
