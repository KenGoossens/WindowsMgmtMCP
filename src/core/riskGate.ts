/**
 * Risk-aware execution gate.
 *
 * A pre-execution analyzer that scores a tool call's blast radius and selects an
 * execution disposition. For `powershell_run` it performs lightweight static
 * analysis of the script; for declarative tools it uses the tool's mutating /
 * destructive metadata. This is the MVP embodiment of the risk-gate concept in
 * the technical spec (Chapter 13 / Appendix D.4): the single decision point that
 * governs human-, model-, and (later) agent-initiated actions alike.
 */

export type RiskLevel = "read" | "mutate" | "destructive" | "irreversible";

/** What the gate decides should happen with a call. */
export type Disposition = "allow" | "confirm" | "block";

export interface RiskDecision {
  disposition: Disposition;
  level: RiskLevel;
  /** 0 (harmless read) … 100 (catastrophic / irreversible). */
  score: number;
  reasons: string[];
}

export interface RiskInput {
  tool: string;
  mutating?: boolean;
  destructive?: boolean;
  args: Record<string, unknown>;
}

interface Pattern {
  re: RegExp;
  reason: string;
}

/** Patterns indicating irreversible, data-destroying actions. */
const IRREVERSIBLE_PATTERNS: Pattern[] = [
  { re: /Format-Volume\b/i, reason: "Formats a volume (irreversible data loss)" },
  { re: /Clear-Disk\b/i, reason: "Clears a disk" },
  { re: /Initialize-Disk\b/i, reason: "Re-initializes a disk" },
  { re: /\bdiskpart\b/i, reason: "diskpart low-level disk manipulation" },
  { re: /\bcipher\s+\/w/i, reason: "cipher /w wipes free space" },
  {
    re: /Remove-Item\b[^\n]*-Recurse[^\n]*(C:\\?(\s|"|'|$)|\$env:SystemRoot|\$env:windir|\\Windows\b)/i,
    reason: "Recursive delete targeting a system path"
  },
  { re: /Remove-Item\b[^\n]*-Recurse[^\n]*-Force/i, reason: "Recursive forced delete" },
  { re: /\bRemove-Computer\b/i, reason: "Removes the computer from its domain" },
  { re: /\b(Stop|Restart)-Computer\b[^\n]*-Force/i, reason: "Forced shutdown/restart of the machine" }
];

/** Patterns indicating state-changing (but generally reversible) actions. */
const MUTATING_PATTERNS: Pattern[] = [
  { re: /\b(Set|New|Remove|Stop|Start|Restart|Suspend|Resume|Disable|Enable|Rename|Move|Clear|Reset|Update|Install|Uninstall)-[A-Z][A-Za-z]+/, reason: "State-changing cmdlet" },
  { re: /\bSet-ItemProperty\b/i, reason: "Modifies registry/item properties" },
  { re: /\bNew-Item\b/i, reason: "Creates a filesystem/registry item" },
  { re: /\breg(\.exe)?\s+(add|delete|import)\b/i, reason: "Registry modification via reg.exe" },
  { re: /\b(Out-File|Set-Content|Add-Content)\b/i, reason: "Writes to a file" },
  { re: /\s>>?\s*['"]?[A-Za-z]:\\/, reason: "Redirects output to a file path" },
  { re: /\bInvoke-Expression\b|\biex\b/i, reason: "Dynamically evaluates a string as code" },
  { re: /\b(net|sc)\.exe?\s+(stop|start|config)/i, reason: "Service control via net/sc" }
];

export class RiskGate {
  evaluate(input: RiskInput): RiskDecision {
    // Any tool carrying an arbitrary `script` string (powershell_run, remote_run)
    // is statically analysed so the interlock is uniform across callers.
    if (typeof input.args.script === "string") {
      return this.scoreScript(input.args.script);
    }

    if (input.destructive) {
      return {
        disposition: "confirm",
        level: "destructive",
        score: 80,
        reasons: ["Destructive operation; requires explicit confirmation"]
      };
    }
    if (input.mutating) {
      return {
        disposition: "confirm",
        level: "mutate",
        score: 50,
        reasons: ["State-changing operation; requires explicit confirmation"]
      };
    }
    return { disposition: "allow", level: "read", score: 0, reasons: [] };
  }

  /** Lightweight static analysis of an arbitrary PowerShell script. */
  private scoreScript(script: string): RiskDecision {
    const reasons: string[] = [];

    for (const { re, reason } of IRREVERSIBLE_PATTERNS) {
      if (re.test(script)) reasons.push(reason);
    }
    if (reasons.length > 0) {
      return { disposition: "confirm", level: "irreversible", score: 95, reasons };
    }

    for (const { re, reason } of MUTATING_PATTERNS) {
      if (re.test(script) && !reasons.includes(reason)) reasons.push(reason);
    }
    if (reasons.length > 0) {
      return { disposition: "confirm", level: "mutate", score: 55, reasons };
    }

    return {
      disposition: "allow",
      level: "read",
      score: 5,
      reasons: ["No state-changing patterns detected (read-only)"]
    };
  }
}
