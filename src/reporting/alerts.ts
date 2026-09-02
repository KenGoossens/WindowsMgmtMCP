import { randomUUID } from "node:crypto";
import type { MetricKind, MetricSample } from "../providers/provider.js";

export type Comparison = ">" | ">=" | "<" | "<=" | "==";

export interface AlertRuleInput {
  metric: MetricKind;
  condition: Comparison;
  threshold: number;
  scope?: { providerId?: string; entity?: string };
  description?: string;
}

export interface AlertRule extends AlertRuleInput {
  id: string;
  createdAt: string;
}

export interface ActiveAlert {
  id: string;
  ruleId: string;
  metric: MetricKind;
  condition: Comparison;
  threshold: number;
  providerId: string;
  entity: string;
  value: number;
  firedAt: string;
  lastSeen: string;
  acknowledged: boolean;
}

function compare(value: number, condition: Comparison, threshold: number): boolean {
  switch (condition) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case "==":
      return value === threshold;
  }
}

/**
 * Threshold/policy alert engine. Rules are evaluated against the latest sample
 * of each matching series on every collection tick; a breach opens (or sustains)
 * an active alert keyed by rule+entity, and recovery clears it.
 */
export class AlertEngine {
  private readonly rules = new Map<string, AlertRule>();
  private readonly active = new Map<string, ActiveAlert>();

  define(input: AlertRuleInput): AlertRule {
    const rule: AlertRule = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.rules.set(rule.id, rule);
    return rule;
  }

  removeRule(ruleId: string): boolean {
    for (const [key, alert] of this.active) {
      if (alert.ruleId === ruleId) this.active.delete(key);
    }
    return this.rules.delete(ruleId);
  }

  listRules(): AlertRule[] {
    return [...this.rules.values()];
  }

  listActive(includeAcknowledged = true): ActiveAlert[] {
    return [...this.active.values()].filter((a) => includeAcknowledged || !a.acknowledged);
  }

  acknowledge(alertId: string): boolean {
    for (const alert of this.active.values()) {
      if (alert.id === alertId) {
        alert.acknowledged = true;
        return true;
      }
    }
    return false;
  }

  private static key(ruleId: string, providerId: string, entity: string): string {
    return `${ruleId}::${providerId}::${entity}`;
  }

  /**
   * Evaluate all rules against the latest samples. Returns the alerts that
   * newly fired on this evaluation (for push notification).
   */
  evaluate(latest: MetricSample[], now: string = new Date().toISOString()): ActiveAlert[] {
    const newlyFired: ActiveAlert[] = [];
    const seen = new Set<string>();

    for (const rule of this.rules.values()) {
      for (const sample of latest) {
        if (sample.metric !== rule.metric) continue;
        if (rule.scope?.providerId && sample.providerId !== rule.scope.providerId) continue;
        if (rule.scope?.entity && sample.entity !== rule.scope.entity) continue;
        if (!compare(sample.value, rule.condition, rule.threshold)) continue;

        const key = AlertEngine.key(rule.id, sample.providerId, sample.entity);
        seen.add(key);
        const existing = this.active.get(key);
        if (existing) {
          existing.value = sample.value;
          existing.lastSeen = now;
        } else {
          const alert: ActiveAlert = {
            id: randomUUID(),
            ruleId: rule.id,
            metric: rule.metric,
            condition: rule.condition,
            threshold: rule.threshold,
            providerId: sample.providerId,
            entity: sample.entity,
            value: sample.value,
            firedAt: now,
            lastSeen: now,
            acknowledged: false
          };
          this.active.set(key, alert);
          newlyFired.push(alert);
        }
      }
    }

    // Clear alerts whose condition no longer holds.
    for (const [key, alert] of this.active) {
      const stillBreaching = seen.has(key);
      const ruleGone = !this.rules.has(alert.ruleId);
      if (!stillBreaching || ruleGone) this.active.delete(key);
    }

    return newlyFired;
  }
}
