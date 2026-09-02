import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, errorResult, type ToolContext, type ToolSpec } from "../core/tools.js";
import type { Job } from "./jobs.js";
import type { MigrationOrchestrator, MigrationSubject } from "./migrationOrchestrator.js";

const endpointShape = {
  sourceProvider: z.string().min(1).describe("Source provider id (e.g. 'local', 'remoteWindows')."),
  sourceEntity: z.string().optional().describe("Source entity id (remote target id; omit for the local host)."),
  targetProvider: z.string().min(1).describe("Target provider id (e.g. 'windows365', 'awsworkspaces')."),
  targetEntity: z.string().optional().describe("Target entity id; omit to request provisioning.")
};

const scopeShape = {
  userData: z.boolean().optional(),
  appSettings: z.boolean().optional(),
  osSettings: z.boolean().optional()
};

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
 * Register the migration orchestration tools (spec §14.7). `migration_plan` is a
 * read-only dry-run that previews the state-fidelity manifest; `migration_execute`
 * is high-impact and confirm-gated, returning a `jobId` to poll via
 * `migration_status` (return-then-poll, Ch. 16).
 */
export function registerMigrationTools(server: McpServer, ctx: ToolContext, orch: MigrationOrchestrator): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── migration_plan ───────────────────────────────────────────────────────────
  reg({
    name: "migration_plan",
    title: "Plan a migration (dry-run)",
    description:
      "Dry-run a traditional/VDI → cloud migration: validate source/target eligibility and preview exactly what state will transfer (with a fidelity manifest). No side effects.",
    inputSchema: {
      ...endpointShape,
      ...scopeShape,
      user: z.string().optional().describe("Logical subject (user) being migrated.")
    },
    handler: async (args) => {
      const subject: MigrationSubject = {
        source: { providerId: args.sourceProvider, entity: args.sourceEntity },
        target: { providerId: args.targetProvider, entity: args.targetEntity },
        scope: { userData: args.userData, appSettings: args.appSettings, osSettings: args.osSettings },
        user: args.user
      };
      const plan = await orch.plan(subject);
      return jsonResult({
        executable: plan.executable,
        source: plan.source,
        target: plan.target,
        provisioningRequired: plan.provisioningRequired,
        fidelityPreview: plan.fidelityPreview,
        stateItems: plan.stateItems.map((i) => ({ key: i.key, label: i.label, fidelity: i.fidelity, restorable: i.restorable })),
        warnings: plan.warnings
      });
    }
  });

  // ── migration_execute ────────────────────────────────────────────────────────
  reg({
    name: "migration_execute",
    title: "Execute a migration",
    description:
      "Run the migration end-to-end (provision → capture → restore → verify), keeping the source intact until verified. Returns a jobId to poll with migration_status.",
    mutating: true,
    inputSchema: {
      ...endpointShape,
      ...scopeShape,
      user: z.string().optional().describe("Logical subject (user) being migrated.")
    },
    handler: async (args) => {
      const subject: MigrationSubject = {
        source: { providerId: args.sourceProvider, entity: args.sourceEntity },
        target: { providerId: args.targetProvider, entity: args.targetEntity },
        scope: { userData: args.userData, appSettings: args.appSettings, osSettings: args.osSettings },
        user: args.user
      };
      // Validate eligibility before launching the job, so obvious mistakes fail fast.
      const plan = await orch.plan(subject);
      if (!plan.executable) {
        return errorResult(`Migration is not executable as planned. Warnings: ${plan.warnings.join("; ")}`);
      }
      const job = orch.execute(subject);
      return jsonResult({ status: "started", ...jobView(job) });
    }
  });

  // ── migration_status ─────────────────────────────────────────────────────────
  reg({
    name: "migration_status",
    title: "Poll a migration job",
    description: "Poll the status and step progress of a migration job by its jobId.",
    inputSchema: {
      jobId: z.string().min(1).describe("The migration job id from migration_execute.")
    },
    handler: (args) => {
      const job = orch.status(args.jobId);
      if (!job) return errorResult(`Unknown migration job: ${args.jobId}`);
      return jsonResult(jobView(job));
    }
  });
}
