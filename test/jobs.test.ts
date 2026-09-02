import { describe, it, expect } from "vitest";
import { JobManager, type JobContext } from "../src/orchestration/jobs.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

/** Wait until a job leaves the running/pending state (or time out). */
async function settle(jm: JobManager, jobId: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = jm.get(jobId);
    if (job && job.status !== "running" && job.status !== "pending") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job did not settle in time");
}

describe("JobManager", () => {
  it("runs a worker to success and records steps", async () => {
    const jm = new JobManager(silentLogger);
    const job = jm.start("test", "subj", async (ctx: JobContext) => {
      const s = ctx.step("only-step");
      s.succeed("done");
      return { ok: true };
    });
    expect(job.status).toMatch(/running|pending/);
    await settle(jm, job.id);
    const final = jm.get(job.id)!;
    expect(final.status).toBe("succeeded");
    expect(final.result).toEqual({ ok: true });
    expect(final.steps[0]).toMatchObject({ name: "only-step", status: "succeeded", detail: "done" });
    expect(final.endedAt).toBeTruthy();
  });

  it("captures an error and marks running steps failed", async () => {
    const jm = new JobManager(silentLogger);
    const job = jm.start("test", undefined, async (ctx: JobContext) => {
      ctx.step("will-hang"); // started but never finished
      throw new Error("boom");
    });
    await settle(jm, job.id);
    const final = jm.get(job.id)!;
    expect(final.status).toBe("failed");
    expect(final.error).toBe("boom");
    expect(final.steps[0].status).toBe("failed");
  });

  it("lists jobs filtered by kind, newest first", async () => {
    const jm = new JobManager(silentLogger);
    const a = jm.start("alpha", undefined, async () => 1);
    const b = jm.start("beta", undefined, async () => 2);
    await settle(jm, a.id);
    await settle(jm, b.id);
    expect(jm.list("alpha").map((j) => j.id)).toEqual([a.id]);
    expect(jm.list().length).toBe(2);
  });

  it("returns undefined for an unknown job", () => {
    const jm = new JobManager(silentLogger);
    expect(jm.get("nope")).toBeUndefined();
  });
});
