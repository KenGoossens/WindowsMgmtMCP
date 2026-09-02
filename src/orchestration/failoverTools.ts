import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, errorResult, type ToolContext, type ToolSpec } from "../core/tools.js";
import type { Job } from "./jobs.js";
import type { ContinuityController, FailoverSubject } from "./continuityController.js";

/** Render a job into a compact, pollable status object. */
function jobView(job: Job): Record<string, unknown> {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    subject: job.subject,
    steps: job.steps.map((s) => ({ name: s.name, status: s.status, detail: s.detail })),
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    endedAt: job.endedAt
  };
}

/**
 * Register the cross-substrate continuity & failover tools (spec §14.7).
 * Failover is among the highest-impact operations, so `failover_initiate` and
 * `failover_failback` are mutating + confirm-gated and return a `jobId` to poll.
 * `continuity_healthcheck` is read-only and consumes live telemetry when present.
 */
export function registerFailoverTools(server: McpServer, ctx: ToolContext, ctrl: ContinuityController): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── continuity_healthcheck ───────────────────────────────────────────────────
  reg({
    name: "continuity_healthcheck",
    title: "Continuity health check",
    description:
      "Assess a primary substrate's health (telemetry-informed when reporting is enabled: loadIndex + active alerts), returning a 0–100 score and the signals behind it. Read-only.",
    inputSchema: {
      providerId: z.string().optional().describe("Substrate to assess (defaults to the configured primary).")
    },
    handler: async (args) => {
      const assessment = await ctrl.healthcheck(args.providerId);
      return jsonResult(assessment);
    }
  });

  // ── failover_initiate ────────────────────────────────────────────────────────
  reg({
    name: "failover_initiate",
    title: "Initiate failover",
    description:
      "Fail a user's workspace over to a secondary substrate: activate/provision target → rehydrate the latest StateBundle → verify → redirect. High-impact; returns a jobId to poll with failover_status.",
    mutating: true,
    destructive: true,
    inputSchema: {
      user: z.string().min(1).describe("The user / workspace being failed over."),
      primary: z.string().optional().describe("Current substrate (defaults to configured primary)."),
      secondary: z.string().optional().describe("Failover target substrate (defaults to configured secondary)."),
      targetEntity: z.string().optional().describe("Pre-staged target entity id (warm standby); omit for cold provisioning.")
    },
    handler: (args) => {
      const subject: FailoverSubject = {
        user: args.user,
        primary: args.primary,
        secondary: args.secondary,
        targetEntity: args.targetEntity
      };
      const job = ctrl.initiate(subject);
      return jsonResult({ status: "started", ...jobView(job) });
    }
  });

  // ── failover_status ──────────────────────────────────────────────────────────
  reg({
    name: "failover_status",
    title: "Poll a failover job",
    description: "Poll the status and step progress of a failover (or failback) job by its jobId.",
    inputSchema: {
      jobId: z.string().min(1).describe("The job id from failover_initiate or failover_failback.")
    },
    handler: (args) => {
      const job = ctrl.status(args.jobId);
      if (!job) return errorResult(`Unknown failover job: ${args.jobId}`);
      return jsonResult(jobView(job));
    }
  });

  // ── failover_failback ────────────────────────────────────────────────────────
  reg({
    name: "failover_failback",
    title: "Fail back to primary",
    description:
      "Return a user's workspace to the primary substrate once it has recovered: re-activate primary → rehydrate the latest StateBundle → verify → redirect. High-impact; returns a jobId.",
    mutating: true,
    destructive: true,
    inputSchema: {
      user: z.string().min(1).describe("The user / workspace being failed back."),
      primary: z.string().optional().describe("Primary substrate to return to (defaults to configured primary)."),
      secondary: z.string().optional().describe("Substrate currently serving the user (defaults to configured secondary)."),
      targetEntity: z.string().optional().describe("Pre-staged primary entity id; omit for cold provisioning.")
    },
    handler: (args) => {
      const subject: FailoverSubject = {
        user: args.user,
        primary: args.primary,
        secondary: args.secondary,
        targetEntity: args.targetEntity
      };
      const job = ctrl.failback(subject);
      return jsonResult({ status: "started", ...jobView(job) });
    }
  });
}
