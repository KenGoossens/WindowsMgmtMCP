import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  callTool,
  fetchFleet,
  fetchHealth,
  fetchTools,
  subscribeFleet,
  type Fleet,
  type ToolResult,
  type UiTool
} from "./api";
import { FleetPane } from "./components/FleetPane";
import { Operator } from "./components/Operator";
import { ApprovalCard } from "./components/ApprovalCard";
import { ActivityRail, type ActivityEntry } from "./components/ActivityRail";
import { ToolTester } from "./components/ToolTester";

type View = "mission" | "tester";

export interface PendingApproval {
  tool: UiTool;
  args: Record<string, unknown>;
  result: ToolResult;
}

let activitySeq = 0;

export function App(): JSX.Element {
  const [tools, setTools] = useState<UiTool[]>([]);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [connected, setConnected] = useState(false);
  const [streamLive, setStreamLive] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>("mission");
  const seenError = useRef(false);

  const pushActivity = useCallback((entry: Omit<ActivityEntry, "id" | "ts">) => {
    setActivity((prev) => [{ ...entry, id: ++activitySeq, ts: new Date().toISOString() }, ...prev].slice(0, 60));
  }, []);

  // Initial load.
  useEffect(() => {
    void (async () => {
      try {
        const [h, t, f] = await Promise.all([fetchHealth(), fetchTools(), fetchFleet().catch(() => null)]);
        setConnected(h.connected);
        setTools(t);
        if (f) setFleet(f);
      } catch (err) {
        pushActivity({ kind: "error", title: "Failed to reach the BFF", detail: String(err) });
      }
    })();
  }, [pushActivity]);

  // Live telemetry stream.
  useEffect(() => {
    const off = subscribeFleet(
      (f) => {
        setFleet(f);
        setStreamLive(true);
        seenError.current = false;
      },
      () => {
        if (!seenError.current) {
          seenError.current = true;
          setStreamLive(false);
        }
      }
    );
    return off;
  }, []);

  const run = useCallback(
    async (tool: UiTool, args: Record<string, unknown>) => {
      setBusy(true);
      try {
        const result = await callTool(tool.name, args);
        if (result.confirmationRequired) {
          setPending({ tool, args, result });
        } else if (result.isError) {
          pushActivity({ kind: "error", title: `${tool.name} failed`, detail: result.text });
        } else {
          pushActivity({ kind: "ok", title: tool.name, detail: result.text, toolClass: tool.toolClass });
        }
      } catch (err) {
        pushActivity({ kind: "error", title: `${tool.name} failed`, detail: String(err) });
      } finally {
        setBusy(false);
      }
    },
    [pushActivity]
  );

  const approve = useCallback(async () => {
    if (!pending) return;
    const { tool, args } = pending;
    setPending(null);
    setBusy(true);
    try {
      const result = await callTool(tool.name, { ...args, confirm: true });
      if (result.isError) {
        pushActivity({ kind: "error", title: `${tool.name} failed`, detail: result.text });
      } else {
        pushActivity({ kind: "ok", title: `${tool.name} (approved)`, detail: result.text, toolClass: tool.toolClass });
      }
    } catch (err) {
      pushActivity({ kind: "error", title: `${tool.name} failed`, detail: String(err) });
    } finally {
      setBusy(false);
    }
  }, [pending, pushActivity]);

  const deny = useCallback(() => {
    if (pending) {
      pushActivity({ kind: "denied", title: `${pending.tool.name} denied`, detail: "Operator declined the confirmation." });
    }
    setPending(null);
  }, [pending, pushActivity]);

  const fleetStats = useMemo(() => {
    const rows = fleet?.rows ?? [];
    return {
      total: rows.length,
      warning: rows.filter((r) => r.health === "warning").length,
      critical: rows.filter((r) => r.health === "critical").length
    };
  }, [fleet]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▣</span>
          <span className="brandname">windows-mcp</span>
          <span className="brandsub">{view === "mission" ? "Mission Control" : "Tool Tester"}</span>
        </div>
        <nav className="viewnav">
          <button className={view === "mission" ? "active" : ""} onClick={() => setView("mission")}>
            Mission Control
          </button>
          <button className={view === "tester" ? "active" : ""} onClick={() => setView("tester")}>
            Tool Tester
          </button>
        </nav>
        <div className="status-cluster">
          <span className={`chip ${connected ? "chip-ok" : "chip-bad"}`}>
            {connected ? "MCP connected" : "MCP disconnected"}
          </span>
          <span className={`chip ${streamLive ? "chip-ok" : "chip-idle"}`}>
            {streamLive ? "● live" : "○ idle"}
          </span>
          <span className="chip chip-muted">{tools.length} tools</span>
          <span className="chip chip-muted">
            {fleetStats.total} entities
            {fleetStats.critical > 0 && <em className="chip-crit"> · {fleetStats.critical} crit</em>}
            {fleetStats.warning > 0 && <em className="chip-warn"> · {fleetStats.warning} warn</em>}
          </span>
        </div>
      </header>

      {view === "tester" ? (
        <ToolTester tools={tools} />
      ) : (
        <div className="layout">
          <aside className="zone zone-operator">
            <Operator tools={tools} busy={busy} onRun={run} />
          </aside>

          <main className="zone zone-canvas">
            <FleetPane fleet={fleet} />
          </main>

          <aside className="zone zone-rail">
            {pending && <ApprovalCard pending={pending} busy={busy} onApprove={approve} onDeny={deny} />}
            <ActivityRail entries={activity} />
          </aside>
        </div>
      )}
    </div>
  );
}
