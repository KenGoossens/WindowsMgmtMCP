import { useState } from "react";
import type { UiTool } from "../api";

export interface ActivityEntry {
  id: number;
  ts: string;
  kind: "ok" | "error" | "denied";
  title: string;
  detail?: string;
  toolClass?: UiTool["toolClass"];
}

function Row({ entry }: { entry: ActivityEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <li className={`act act-${entry.kind}`}>
      <button className="act-head" onClick={() => setOpen((o) => !o)}>
        <span className={`act-dot act-dot-${entry.kind}`} />
        <span className="act-title mono">{entry.title}</span>
        <time className="act-time">{new Date(entry.ts).toLocaleTimeString()}</time>
      </button>
      {open && entry.detail && <pre className="act-detail">{entry.detail}</pre>}
    </li>
  );
}

export function ActivityRail({ entries }: { entries: ActivityEntry[] }): JSX.Element {
  return (
    <section className="activity">
      <div className="pane-head">
        <h2>Activity</h2>
        <span className="pane-sub">audited tool calls, newest first</span>
      </div>
      {entries.length === 0 ? (
        <p className="empty-sub">No actions yet. Run a tool from the operator pane.</p>
      ) : (
        <ul className="act-list">
          {entries.map((e) => (
            <Row key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </section>
  );
}
