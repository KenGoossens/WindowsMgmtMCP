/**
 * Self-verifying autonomous remediation loop (technical spec, Ch. 10.2 and
 * Appendix D.5 / Candidate 3). The novelty is the **self-verifying, self-reverting**
 * property: the loop measures the symptom, checkpoints, applies a fix, re-measures,
 * and **automatically rolls back if the symptom did not improve** — so it never
 * leaves a half-applied change. This module is pure and substrate-agnostic; the
 * agent runtime supplies concrete {@link RemediationAction}s.
 */

/**
 * A remediation action expressed as four primitives. `probe` returns a numeric
 * health score where **higher is better**; the loop keeps the change only if the
 * post-fix score strictly improves on the baseline.
 */
export interface RemediationAction<C = unknown> {
  name: string;
  description?: string;
  /** Measure the symptom; higher = healthier. */
  probe(): Promise<number>;
  /** Capture the state needed to undo the fix. */
  checkpoint(): Promise<C>;
  /** Apply the fix. */
  apply(): Promise<void>;
  /** Undo the fix using the checkpoint. */
  rollback(checkpoint: C): Promise<void>;
}

export interface RemediationOutcome {
  action: string;
  baselineScore: number;
  postScore?: number;
  /** Did the symptom improve after applying the fix? */
  improved: boolean;
  /** Was the fix applied at all (skipped if already healthy)? */
  appliedChange: boolean;
  /** Was the change reverted because it didn't help (or threw)? */
  rolledBack: boolean;
  /** Whether the endpoint is healthy now (post-loop). */
  resolved: boolean;
  steps: string[];
}

export interface RemediationOptions {
  /** If baseline >= this, the endpoint is already healthy; skip the fix. */
  healthyThreshold?: number;
  /** Treat the symptom resolved when score >= this (default = healthyThreshold). */
  resolvedThreshold?: number;
}

/**
 * Run the self-verifying loop for one action:
 *   measure → (already healthy? stop) → checkpoint → apply → re-measure →
 *   keep if improved, else auto-rollback.
 *
 * Any throw during apply triggers a rollback attempt, so a partial change is
 * never left behind.
 */
export async function runSelfVerifying<C>(
  action: RemediationAction<C>,
  options: RemediationOptions = {}
): Promise<RemediationOutcome> {
  const healthyThreshold = options.healthyThreshold ?? 1;
  const resolvedThreshold = options.resolvedThreshold ?? healthyThreshold;
  const steps: string[] = [];

  const baselineScore = await action.probe();
  steps.push(`measured baseline score=${baselineScore}`);

  if (baselineScore >= healthyThreshold) {
    steps.push("already healthy; no change applied");
    return {
      action: action.name,
      baselineScore,
      postScore: baselineScore,
      improved: false,
      appliedChange: false,
      rolledBack: false,
      resolved: baselineScore >= resolvedThreshold,
      steps
    };
  }

  const checkpoint = await action.checkpoint();
  steps.push("captured checkpoint");

  try {
    await action.apply();
    steps.push("applied fix");
  } catch (err) {
    steps.push(`apply failed: ${err instanceof Error ? err.message : String(err)}`);
    await safeRollback(action, checkpoint, steps);
    const postScore = await action.probe().catch(() => baselineScore);
    return {
      action: action.name,
      baselineScore,
      postScore,
      improved: false,
      appliedChange: true,
      rolledBack: true,
      resolved: postScore >= resolvedThreshold,
      steps
    };
  }

  const postScore = await action.probe();
  steps.push(`re-measured score=${postScore}`);
  const improved = postScore > baselineScore;

  if (improved) {
    steps.push("symptom improved; change kept");
    return {
      action: action.name,
      baselineScore,
      postScore,
      improved: true,
      appliedChange: true,
      rolledBack: false,
      resolved: postScore >= resolvedThreshold,
      steps
    };
  }

  steps.push("no improvement; rolling back");
  await safeRollback(action, checkpoint, steps);
  const finalScore = await action.probe().catch(() => postScore);
  return {
    action: action.name,
    baselineScore,
    postScore: finalScore,
    improved: false,
    appliedChange: true,
    rolledBack: true,
    resolved: finalScore >= resolvedThreshold,
    steps
  };
}

async function safeRollback<C>(action: RemediationAction<C>, checkpoint: C, steps: string[]): Promise<void> {
  try {
    await action.rollback(checkpoint);
    steps.push("rollback succeeded");
  } catch (err) {
    steps.push(`rollback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
