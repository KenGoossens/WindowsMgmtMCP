import { describe, it, expect } from "vitest";
import { AgentRegistry, AgentError } from "../src/agent/registry.js";
import type { AgentCommandResult, EnrollRequest } from "../src/agent/protocol.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

function registry(over: { maxAutonomy?: "L0" | "L1" | "L2" | "L3"; token?: string; staleSeconds?: number } = {}) {
  return new AgentRegistry(
    { enrollmentToken: over.token ?? "enroll-secret", maxAutonomy: over.maxAutonomy ?? "L3", staleSeconds: over.staleSeconds ?? 90 },
    silentLogger
  );
}

const enrollReq = (over: Partial<EnrollRequest> = {}): EnrollRequest => ({
  agentId: "agent-1",
  hostname: "PC-1",
  platform: "win32",
  autonomy: "L3",
  capabilities: ["diagnostics", "remediate", "collect_state"],
  attestation: "node:v22;platform:win32",
  ...over
});

describe("AgentRegistry enrollment", () => {
  it("verifies the enrollment token", () => {
    const r = registry({ token: "secret" });
    expect(r.verifyEnrollmentToken("secret")).toBe(true);
    expect(r.verifyEnrollmentToken("wrong")).toBe(false);
    expect(r.verifyEnrollmentToken(undefined)).toBe(false);
  });

  it("enrolls an agent and caps autonomy to server policy", () => {
    const r = registry({ maxAutonomy: "L1" });
    const resp = r.enroll(enrollReq({ autonomy: "L3" }));
    expect(resp.autonomyCeiling).toBe("L1"); // capped down
    expect(r.list()).toHaveLength(1);
    expect(r.get("agent-1")?.status).toBe("online");
  });

  it("marks an agent stale after the heartbeat window", async () => {
    const r = registry({ staleSeconds: 0 });
    r.enroll(enrollReq());
    // staleSeconds=0 → any elapsed time past enrollment is stale
    await new Promise((resolve) => setTimeout(resolve, 15));
    const agent = r.get("agent-1");
    expect(agent?.status).toBe("stale");
  });
});

describe("AgentRegistry dispatch", () => {
  it("rejects dispatch to an unknown agent", () => {
    const r = registry();
    expect(() => r.dispatch("nope", "diagnostics", {})).toThrow(AgentError);
  });

  it("enforces the allow-list", () => {
    const r = registry();
    r.enroll(enrollReq({ capabilities: ["diagnostics"] }));
    expect(() => r.dispatch("agent-1", "remediate", {}, "L2")).toThrow(/allow-listed/);
  });

  it("requires at least L2 autonomy for remediation", () => {
    const r = registry({ maxAutonomy: "L1" });
    r.enroll(enrollReq({ autonomy: "L1" }));
    expect(() => r.dispatch("agent-1", "remediate", {}, "L3")).toThrow(/at least L2/);
  });

  it("queues a command for the agent to take", () => {
    const r = registry();
    r.enroll(enrollReq());
    void r.dispatch("agent-1", "diagnostics", { checks: [] }, "L0", 5000);
    const taken = r.take("agent-1");
    expect(taken).toHaveLength(1);
    expect(taken[0].kind).toBe("diagnostics");
    // a second take is empty (commands were dequeued)
    expect(r.take("agent-1")).toHaveLength(0);
  });

  it("resolves the dispatch promise when a result is submitted", async () => {
    const r = registry();
    r.enroll(enrollReq());
    const p = r.dispatch("agent-1", "diagnostics", {}, "L0", 5000);
    const [cmd] = r.take("agent-1");
    const result: AgentCommandResult = {
      commandId: cmd.id,
      agentId: "agent-1",
      ok: true,
      data: { cpu: 5 },
      completedAt: new Date().toISOString()
    };
    r.submitResult(result);
    await expect(p).resolves.toMatchObject({ ok: true, data: { cpu: 5 } });
  });

  it("rejects the dispatch on timeout", async () => {
    const r = registry();
    r.enroll(enrollReq());
    await expect(r.dispatch("agent-1", "diagnostics", {}, "L0", 20)).rejects.toThrow(/did not return a result/);
  });
});
