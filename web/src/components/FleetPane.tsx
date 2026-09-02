import type { Fleet, FleetRow, Health } from "../api";

const HEALTH_ORDER: Record<Health, number> = { critical: 0, warning: 1, unknown: 2, ok: 3 };

function metricChip(metric: string, value: number, unit?: string): JSX.Element {
  const pct = unit === "%" ? Math.min(100, Math.max(0, value)) : undefined;
  return (
    <div className="metric" key={metric} title={`${metric}: ${value}${unit ?? ""}`}>
      <div className="metric-head">
        <span className="metric-name">{metric}</span>
        <span className="metric-val">
          {value}
          <span className="metric-unit">{unit === "count" || unit === "index" ? "" : unit}</span>
        </span>
      </div>
      {pct !== undefined && (
        <div className="bar">
          <div className={`bar-fill ${pct >= 85 ? "bar-hot" : pct >= 60 ? "bar-warm" : ""}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function Card({ row }: { row: FleetRow }): JSX.Element {
  return (
    <div className={`fleet-card health-${row.health}`}>
      <div className="fleet-card-top">
        <span className={`dot dot-${row.health}`} />
        <span className="entity mono">{row.entity}</span>
        <span className={`substrate sub-${row.substrate}`}>{row.substrate}</span>
      </div>
      <div className="provider-label">{row.providerLabel}</div>
      <div className="metrics">{row.metrics.map((m) => metricChip(m.metric, m.value, m.unit))}</div>
    </div>
  );
}

export function FleetPane({ fleet }: { fleet: Fleet | null }): JSX.Element {
  const rows = [...(fleet?.rows ?? [])].sort(
    (a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.providerLabel.localeCompare(b.providerLabel)
  );

  return (
    <section className="fleet">
      <div className="pane-head">
        <h2>Fleet</h2>
        <span className="pane-sub">
          unified live telemetry across every substrate
          {fleet && <em className="ts"> · updated {new Date(fleet.ts).toLocaleTimeString()}</em>}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <p>No telemetry yet.</p>
          <p className="empty-sub">
            Configure providers and ensure reporting is enabled on the MCP server. Live metrics stream in here as
            they arrive.
          </p>
        </div>
      ) : (
        <div className="fleet-grid">
          {rows.map((row) => (
            <Card key={`${row.providerId}:${row.entity}`} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}
