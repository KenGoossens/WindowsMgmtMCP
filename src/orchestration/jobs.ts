import { randomUUID } from "node:crypto";
import type { Logger } from "../core/logger.js";

export type JobStatus = "pending" | "running" | "succeeded" | "failed";
export type JobStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface JobStep {
  name: string;
  status: JobStepStatus;
  detail?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface Job<R = unknown> {
  id: string;
  kind: string;
  subject?: string;
  status: JobStatus;
  steps: JobStep[];
  result?: R;
  error?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}

/** A step driver passed to the worker so it can report progress as it goes. */
export interface JobContext {
  /** Begin a step (marks running). Returns a handle to finish it. */
  step(name: string): {
    succeed(detail?: string): void;
    fail(detail: string): void;
    skip(detail?: string): void;
  };
}

/**
 * In-process async job manager implementing the spec's return-then-poll model
 * (Ch. 16): long-running orchestrations (migration, failover) return a `jobId`
 * immediately and the client polls status. Steps give the operator visibility
 * into the orchestration spine (provision → capture → restore → verify).
 *
 * This is the MVP store; a durable/queued store can replace it behind the same
 * shape for resumability across restarts.
 */
export class JobManager {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly logger: Logger,
    /** Cap on retained completed jobs (oldest evicted). */
    private readonly maxJobs = 500
  ) {}

  /**
   * Create a job and start the worker in the background. Returns the job record
   * (status `pending`/`running`) without awaiting completion.
   */
  start<R>(kind: string, subject: string | undefined, worker: (ctx: JobContext) => Promise<R>): Job<R> {
    const job: Job<R> = {
      id: randomUUID(),
      kind,
      subject,
      status: "pending",
      steps: [],
      createdAt: new Date().toISOString()
    };
    this.jobs.set(job.id, job as Job);
    this.evictIfNeeded();

    const ctx: JobContext = {
      step: (name: string) => {
        const step: JobStep = { name, status: "running", startedAt: new Date().toISOString() };
        job.steps.push(step);
        return {
          succeed: (detail?: string) => {
            step.status = "succeeded";
            step.detail = detail;
            step.endedAt = new Date().toISOString();
          },
          fail: (detail: string) => {
            step.status = "failed";
            step.detail = detail;
            step.endedAt = new Date().toISOString();
          },
          skip: (detail?: string) => {
            step.status = "skipped";
            step.detail = detail;
            step.endedAt = new Date().toISOString();
          }
        };
      }
    };

    job.status = "running";
    job.startedAt = new Date().toISOString();
    // Fire-and-forget; status is observed via get().
    void (async () => {
      try {
        job.result = await worker(ctx);
        job.status = "succeeded";
      } catch (err) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        // Mark any still-running step as failed for an honest trail.
        for (const s of job.steps) {
          if (s.status === "running") {
            s.status = "failed";
            s.endedAt = new Date().toISOString();
          }
        }
        this.logger.error({ err, jobId: job.id, kind }, "job failed");
      } finally {
        job.endedAt = new Date().toISOString();
      }
    })();

    return job as Job<R>;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  list(kind?: string): Job[] {
    const all = [...this.jobs.values()];
    const filtered = kind ? all.filter((j) => j.kind === kind) : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private evictIfNeeded(): void {
    if (this.jobs.size <= this.maxJobs) return;
    const sorted = [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.jobs.size > this.maxJobs) {
      const oldest = sorted.shift();
      if (!oldest) break;
      // Don't evict a job that's still running.
      if (oldest.status === "running" || oldest.status === "pending") continue;
      this.jobs.delete(oldest.id);
    }
  }
}
