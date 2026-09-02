import { describe, it, expect } from "vitest";
import { runSelfVerifying, type RemediationAction } from "../src/agent/remediation.js";
import { capAutonomy, AUTONOMY_RANK } from "../src/agent/protocol.js";

/** Build a fake action whose probe returns a scripted sequence of scores. */
function scriptedAction(scores: number[], hooks: Partial<RemediationAction<string>> = {}): RemediationAction<string> & {
  applied: number;
  rolledBack: number;
} {
  let i = 0;
  const state = { applied: 0, rolledBack: 0 };
  return {
    name: "fake",
    applied: 0,
    rolledBack: 0,
    async probe() {
      const v = scores[Math.min(i, scores.length - 1)];
      i++;
      return v;
    },
    async checkpoint() {
      return "cp";
    },
    async apply() {
      state.applied++;
      (this as { applied: number }).applied = state.applied;
      await hooks.apply?.();
    },
    async rollback(cp: string) {
      state.rolledBack++;
      (this as { rolledBack: number }).rolledBack = state.rolledBack;
      expect(cp).toBe("cp");
      await hooks.rollback?.(cp);
    }
  };
}

describe("runSelfVerifying", () => {
  it("skips the fix when already healthy", async () => {
    const action = scriptedAction([1]);
    const outcome = await runSelfVerifying(action, { healthyThreshold: 1 });
    expect(outcome.appliedChange).toBe(false);
    expect(outcome.resolved).toBe(true);
    expect(action.applied).toBe(0);
  });

  it("keeps the change when the symptom improves", async () => {
    // baseline 0 (unhealthy) → after apply 1 (healthy)
    const action = scriptedAction([0, 1]);
    const outcome = await runSelfVerifying(action, { healthyThreshold: 1 });
    expect(outcome.appliedChange).toBe(true);
    expect(outcome.improved).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.resolved).toBe(true);
    expect(action.applied).toBe(1);
    expect(action.rolledBack).toBe(0);
  });

  it("auto-rolls-back when the symptom does not improve", async () => {
    // baseline 0 → after apply still 0 (no improvement) → rollback
    const action = scriptedAction([0, 0, 0]);
    const outcome = await runSelfVerifying(action, { healthyThreshold: 1 });
    expect(outcome.appliedChange).toBe(true);
    expect(outcome.improved).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.resolved).toBe(false);
    expect(action.rolledBack).toBe(1);
  });

  it("rolls back when apply throws (never leaves a half-applied change)", async () => {
    const action = scriptedAction([0, 0], { apply: () => Promise.reject(new Error("apply boom")) });
    const outcome = await runSelfVerifying(action, { healthyThreshold: 1 });
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.steps.join(" ")).toMatch(/apply failed/);
    expect(action.rolledBack).toBe(1);
  });

  it("tolerates a rollback failure without throwing", async () => {
    const action = scriptedAction([0, 0], { rollback: () => Promise.reject(new Error("rb boom")) });
    const outcome = await runSelfVerifying(action, { healthyThreshold: 1 });
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.steps.join(" ")).toMatch(/rollback failed/);
  });
});

describe("capAutonomy", () => {
  it("caps a requested level to the ceiling", () => {
    expect(capAutonomy("L3", "L1")).toBe("L1");
    expect(capAutonomy("L1", "L3")).toBe("L1");
    expect(capAutonomy("L2", "L2")).toBe("L2");
  });
  it("ranks levels in order", () => {
    expect(AUTONOMY_RANK.L0).toBeLessThan(AUTONOMY_RANK.L3);
  });
});
