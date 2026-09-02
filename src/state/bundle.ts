/**
 * Normalized StateBundle model (technical spec, Ch. 9.1).
 *
 * A StateBundle is a substrate-agnostic capture of what makes a desktop "theirs",
 * organized into three tiers, with an explicit per-item **fidelity** so the layer
 * records exactly what did and didn't transfer — it never claims a perfect clone.
 */

/** The three tiers of portable desktop state. */
export type StateTier = "userData" | "appSettings" | "osSettings";

/**
 * How completely an item was captured:
 * - `full`       — the value itself is captured and can be restored.
 * - `partial`    — some of the value is captured (e.g. names without secrets).
 * - `referenced` — only a pointer/metadata is captured; the bulk lives elsewhere
 *                  (e.g. OneDrive Known Folder data is referenced, not copied).
 */
export type Fidelity = "full" | "partial" | "referenced";

/** A single captured settings item, with honest fidelity and an optional note. */
export interface StateItem {
  tier: StateTier;
  /** Stable key, e.g. "os.timeZone", "app.printers", "user.knownFolders". */
  key: string;
  label: string;
  fidelity: Fidelity;
  /** Whether this item can be re-applied by the restore layer. */
  restorable: boolean;
  /** Number of underlying entries captured (e.g. 3 printers), when meaningful. */
  count?: number;
  note?: string;
}

export interface StateScope {
  userData?: boolean;
  appSettings?: boolean;
  osSettings?: boolean;
}

/** Default scope: capture every tier. */
export const FULL_SCOPE: Required<StateScope> = { userData: true, appSettings: true, osSettings: true };

export interface FidelitySummary {
  full: number;
  partial: number;
  referenced: number;
  /** Overall fidelity: the lowest tier present (referenced < partial < full). */
  overall: Fidelity;
}

/** The manifest describes *what* was captured — never the secret values themselves. */
export interface StateBundleManifest {
  id: string;
  /** The subject this state belongs to (user/endpoint identifier). */
  subject: string;
  sourceProviderId: string;
  sourceEntity: string;
  scope: StateScope;
  createdAt: string;
  items: StateItem[];
  fidelity: FidelitySummary;
  /** Schema version for forward compatibility. */
  version: 1;
}

/** A full bundle: the manifest plus the (to-be-encrypted) captured payload. */
export interface StateBundle {
  manifest: StateBundleManifest;
  /** Captured values keyed by StateItem.key. Encrypted at rest by the store. */
  data: Record<string, unknown>;
}

const RANK: Record<Fidelity, number> = { referenced: 0, partial: 1, full: 2 };

/** Compute a fidelity summary from a list of items (overall = the weakest item). */
export function summarizeFidelity(items: StateItem[]): FidelitySummary {
  const summary: FidelitySummary = { full: 0, partial: 0, referenced: 0, overall: "full" };
  if (items.length === 0) return { full: 0, partial: 0, referenced: 0, overall: "referenced" };
  let weakest: Fidelity = "full";
  for (const item of items) {
    summary[item.fidelity] += 1;
    if (RANK[item.fidelity] < RANK[weakest]) weakest = item.fidelity;
  }
  summary.overall = weakest;
  return summary;
}
