import type { PendingApproval } from "../App";

function riskBand(level?: string, score?: number): { cls: string; label: string } {
  const s = score ?? 0;
  if (level === "irreversible" || s >= 90) return { cls: "risk-crit", label: level ?? "irreversible" };
  if (level === "destructive" || s >= 70) return { cls: "risk-high", label: level ?? "destructive" };
  if (s >= 40) return { cls: "risk-med", label: level ?? "elevated" };
  return { cls: "risk-low", label: level ?? "low" };
}

export function ApprovalCard({
  pending,
  busy,
  onApprove,
  onDeny
}: {
  pending: PendingApproval;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}): JSX.Element {
  const { tool, args, result } = pending;
  const band = riskBand(result.risk?.level, result.risk?.score);
  const shownArgs = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "confirm"));

  return (
    <div className={`approval ${band.cls}`}>
      <div className="approval-head">
        <span className="approval-title">Approval required</span>
        <span className={`risk-badge ${band.cls}`}>
          {band.label}
          {result.risk?.score !== undefined && <em> · {result.risk.score}</em>}
        </span>
      </div>

      <div className="approval-tool mono">{tool.name}</div>

      <div className="approval-section">
        <div className="approval-label">Arguments</div>
        <pre className="approval-args">{JSON.stringify(shownArgs, null, 2)}</pre>
      </div>

      {result.risk?.reasons && result.risk.reasons.length > 0 && (
        <div className="approval-section">
          <div className="approval-label">Why this is gated</div>
          <ul className="reasons">
            {result.risk.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="approval-actions">
        <button className="btn-deny" onClick={onDeny} disabled={busy}>
          Deny
        </button>
        <button className="btn-approve" onClick={onApprove} disabled={busy}>
          {busy ? "Executing…" : "Approve & execute"}
        </button>
      </div>
      <p className="approval-note">Nothing has executed yet — this was a safe preview from the server's risk gate.</p>
    </div>
  );
}
