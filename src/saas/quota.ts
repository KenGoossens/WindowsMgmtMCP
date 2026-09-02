/**
 * Per-principal request quotas and rate limiting.
 *
 * A lightweight in-memory enforcer with two independent fixed windows: a
 * short per-minute rate limit (burst control) and a per-day cap (fair-use
 * budget). Both are partitioned per principal so one tenant cannot exhaust
 * another's budget (technical spec §7.7 isolation). `0` disables a dimension.
 *
 * In-memory state is consistent with the rest of the MVP; a distributed store
 * would slot in behind this same interface for horizontal scaling (P-SaaS
 * scaling track, deferred).
 */
import type { QuotaPolicy } from "./principal.js";

export interface QuotaResult {
  allowed: boolean;
  /** Which dimension was exceeded, when `allowed` is false. */
  limit?: "perMinute" | "perDay";
  /** Seconds until the offending window resets. */
  retryAfterSec?: number;
  /** Remaining calls in the tighter (per-minute) window after this check. */
  remaining: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

export class QuotaManager {
  private readonly minute = new Map<string, Window>();
  private readonly day = new Map<string, Window>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Account for one request by {@link principalId} under {@link policy} and
   * decide whether it is permitted. When denied, no window is incremented
   * (a rejected call does not consume budget).
   */
  check(principalId: string, policy?: QuotaPolicy): QuotaResult {
    if (!policy || (policy.perMinute <= 0 && policy.perDay <= 0)) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY };
    }
    const t = this.now();

    const dayWin = this.peek(this.day, principalId, t, DAY_MS);
    if (policy.perDay > 0 && dayWin.count >= policy.perDay) {
      return {
        allowed: false,
        limit: "perDay",
        retryAfterSec: Math.ceil((dayWin.resetAt - t) / 1000),
        remaining: 0
      };
    }

    const minWin = this.peek(this.minute, principalId, t, MINUTE_MS);
    if (policy.perMinute > 0 && minWin.count >= policy.perMinute) {
      return {
        allowed: false,
        limit: "perMinute",
        retryAfterSec: Math.ceil((minWin.resetAt - t) / 1000),
        remaining: 0
      };
    }

    // Permitted: consume budget in both windows.
    if (policy.perMinute > 0) minWin.count += 1;
    if (policy.perDay > 0) dayWin.count += 1;

    const remaining = policy.perMinute > 0 ? policy.perMinute - minWin.count : Number.POSITIVE_INFINITY;
    return { allowed: true, remaining };
  }

  /** Fetch the live window for a principal, rolling it over when expired. */
  private peek(map: Map<string, Window>, id: string, t: number, span: number): Window {
    let win = map.get(id);
    if (!win || t >= win.resetAt) {
      win = { count: 0, resetAt: t + span };
      map.set(id, win);
    }
    return win;
  }
}
