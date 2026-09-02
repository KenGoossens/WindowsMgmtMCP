import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { callTool, type JsonSchemaProp, type ToolResult, type UiTool } from "../api";

type ArgMode = "form" | "json";
type ResultTab = "result" | "raw" | "request";

interface HistoryEntry {
  id: number;
  name: string;
  args: Record<string, unknown>;
  status: "ok" | "error" | "confirm";
  durationMs?: number;
  ts: string;
  result: ToolResult;
}

const CLASS_FILTERS: Array<{ key: "all" | UiTool["toolClass"]; label: string }> = [
  { key: "all", label: "All" },
  { key: "read", label: "Read" },
  { key: "mutating", label: "Mutating" },
  { key: "destructive", label: "Destructive" }
];

let historySeq = 0;

/** Coerce a single string form value to the type its schema declares. */
function coerceValue(prop: JsonSchemaProp | undefined, raw: string): unknown {
  if (raw === undefined || raw === "") return undefined;
  const t = prop?.type;
  if (t === "number" || t === "integer") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (t === "boolean") return raw === "true";
  if (t === "array") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* fall through to comma-split */
      }
    }
    const parts = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return prop?.items?.type === "number" || prop?.items?.type === "integer" ? parts.map(Number) : parts;
  }
  return raw;
}

/** Build the argument object from the form's string values (skips empties + confirm). */
function buildArgs(tool: UiTool, values: Record<string, string>): Record<string, unknown> {
  const props = tool.inputSchema?.properties ?? {};
  const args: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (key === "confirm") continue;
    const v = coerceValue(prop, values[key] ?? "");
    if (v !== undefined) args[key] = v;
  }
  return args;
}

function statusOf(result: ToolResult): "ok" | "error" | "confirm" {
  if (result.confirmationRequired) return "confirm";
  if (result.isError) return "error";
  return "ok";
}

function ToolCatalog({
  tools,
  selected,
  onSelect
}: {
  tools: UiTool[];
  selected: string | null;
  onSelect: (name: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | UiTool["toolClass"]>("all");

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = tools.filter((t) => {
      if (filter !== "all" && t.toolClass !== filter) return false;
      if (!q) return true;
      return t.name.includes(q) || t.title.toLowerCase().includes(q) || t.group.toLowerCase().includes(q);
    });
    const map = new Map<string, UiTool[]>();
    for (const t of filtered) {
      const arr = map.get(t.group) ?? [];
      arr.push(t);
      map.set(t.group, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tools, query, filter]);

  return (
    <div className="tt-catalog">
      <input
        className="search"
        placeholder="Search tools…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="tt-filters">
        {CLASS_FILTERS.map((f) => (
          <button
            key={f.key}
            className={`tt-filter ${filter === f.key ? "active" : ""} f-${f.key}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="tt-tool-list">
        {grouped.map(([group, items]) => (
          <div className="tt-group" key={group}>
            <div className="group-name">
              {group} <span className="group-count">{items.length}</span>
            </div>
            {items.map((tool) => (
              <button
                key={tool.name}
                className={`tt-tool ${selected === tool.name ? "selected" : ""}`}
                onClick={() => onSelect(tool.name)}
              >
                <span className={`tag tag-${tool.toolClass}`}>{tool.toolClass[0].toUpperCase()}</span>
                <span className="tool-name mono">{tool.name}</span>
              </button>
            ))}
          </div>
        ))}
        {grouped.length === 0 && <p className="empty-sub">No tools match.</p>}
      </div>
    </div>
  );
}

function ArgField({
  name,
  prop,
  required,
  value,
  onChange
}: {
  name: string;
  prop: JsonSchemaProp;
  required: boolean;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const common = { value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
  return (
    <label className="field">
      <span className="field-label">
        {name}
        {required && <em className="req">*</em>}
        <span className="field-type">{prop.type === "array" ? `array<${prop.items?.type ?? "string"}>` : prop.type ?? "string"}</span>
        {prop.description && <span className="field-hint">{prop.description}</span>}
      </span>
      {prop.enum ? (
        <select {...common}>
          <option value="">—</option>
          {prop.enum.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : prop.type === "boolean" ? (
        <select {...common}>
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : prop.type === "array" ? (
        <input {...common} placeholder="comma,separated or JSON array" />
      ) : (
        <input
          {...common}
          type={prop.type === "number" || prop.type === "integer" ? "number" : "text"}
          placeholder={prop.type ?? "string"}
        />
      )}
    </label>
  );
}

function ResponsePanel({
  result,
  args,
  running,
  onConfirm
}: {
  result: ToolResult | null;
  args: Record<string, unknown>;
  running: boolean;
  onConfirm: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<ResultTab>("result");

  if (running && !result) {
    return (
      <div className="tt-response">
        <div className="tt-status running">running…</div>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="tt-response">
        <p className="empty-sub">No response yet. Fill in arguments and run the tool.</p>
      </div>
    );
  }

  const status = statusOf(result);
  const pretty =
    result.data !== undefined ? JSON.stringify(result.data, null, 2) : result.text || "(empty response)";

  return (
    <div className="tt-response">
      <div className="tt-status-row">
        <span className={`tt-status ${status}`}>
          {status === "ok" ? "OK" : status === "error" ? "ERROR" : "CONFIRM REQUIRED"}
        </span>
        {result.durationMs !== undefined && <span className="tt-dur">{result.durationMs} ms</span>}
      </div>

      {result.confirmationRequired && (
        <div className="tt-confirm">
          <div className="tt-confirm-head">
            <span className="risk-badge risk-high">
              {result.risk?.level ?? "destructive"}
              {result.risk?.score !== undefined && <em> · {result.risk.score}</em>}
            </span>
            <span className="tt-confirm-msg">The risk gate previewed this and did not execute it.</span>
          </div>
          {result.risk?.reasons && result.risk.reasons.length > 0 && (
            <ul className="reasons">
              {result.risk.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          <button className="run-btn run-destructive" disabled={running} onClick={onConfirm}>
            {running ? "Executing…" : "Confirm & execute"}
          </button>
        </div>
      )}

      <div className="tt-tabs">
        {(["result", "raw", "request"] as ResultTab[]).map((t) => (
          <button key={t} className={`tt-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <pre className="tt-output">
        {tab === "result" ? pretty : tab === "raw" ? result.text || "(empty)" : JSON.stringify(args, null, 2)}
      </pre>
    </div>
  );
}

export function ToolTester({ tools }: { tools: UiTool[] }): JSX.Element {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [mode, setMode] = useState<ArgMode>("form");
  const [values, setValues] = useState<Record<string, string>>({});
  const [jsonText, setJsonText] = useState("{}");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [result, setResult] = useState<ToolResult | null>(null);
  const [lastArgs, setLastArgs] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const lastSelected = useRef<string | null>(null);

  const tool = useMemo(() => tools.find((t) => t.name === selectedName) ?? null, [tools, selectedName]);

  // Reset the editor whenever a different tool is selected.
  useEffect(() => {
    if (selectedName !== lastSelected.current) {
      lastSelected.current = selectedName;
      setValues({});
      setJsonText("{}");
      setJsonError(null);
      setResult(null);
      setMode("form");
    }
  }, [selectedName]);

  const currentArgs = useCallback((): Record<string, unknown> => {
    if (!tool) return {};
    if (mode === "json") {
      try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        return parsed ?? {};
      } catch {
        return {};
      }
    }
    return buildArgs(tool, values);
  }, [tool, mode, jsonText, values]);

  // Round-trip when toggling Form <-> JSON.
  const switchMode = (next: ArgMode): void => {
    if (next === mode || !tool) return;
    if (next === "json") {
      setJsonText(JSON.stringify(buildArgs(tool, values), null, 2));
      setJsonError(null);
    } else {
      try {
        const obj = JSON.parse(jsonText) as Record<string, unknown>;
        const next2: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj ?? {})) {
          next2[k] = Array.isArray(v) || typeof v === "object" ? JSON.stringify(v) : String(v);
        }
        setValues(next2);
      } catch {
        /* keep existing form values if JSON is invalid */
      }
    }
    setMode(next);
  };

  const execute = useCallback(
    async (argsOverride?: Record<string, unknown>) => {
      if (!tool) return;
      const args = argsOverride ?? currentArgs();
      if (mode === "json" && !argsOverride) {
        try {
          JSON.parse(jsonText);
          setJsonError(null);
        } catch (e) {
          setJsonError(e instanceof Error ? e.message : "Invalid JSON");
          return;
        }
      }
      setRunning(true);
      setLastArgs(args);
      try {
        const res = await callTool(tool.name, args);
        setResult(res);
        setHistory((prev) =>
          [
            {
              id: ++historySeq,
              name: tool.name,
              args,
              status: statusOf(res),
              durationMs: res.durationMs,
              ts: new Date().toISOString(),
              result: res
            },
            ...prev
          ].slice(0, 50)
        );
      } catch (err) {
        setResult({ confirmationRequired: false, isError: true, text: String(err) });
      } finally {
        setRunning(false);
      }
    },
    [tool, currentArgs, mode, jsonText]
  );

  const confirmExecute = useCallback(() => {
    void execute({ ...lastArgs, confirm: true });
  }, [execute, lastArgs]);

  const replay = (entry: HistoryEntry): void => {
    setSelectedName(entry.name);
    // Defer until after the tool-change reset effect runs.
    setTimeout(() => {
      setMode("json");
      setJsonText(JSON.stringify(entry.args, null, 2));
      setResult(entry.result);
      setLastArgs(entry.args);
    }, 0);
  };

  const props = tool?.inputSchema?.properties ?? {};
  const required = new Set(tool?.inputSchema?.required ?? []);
  const fields = Object.entries(props).filter(([k]) => k !== "confirm");

  return (
    <div className="tt">
      <ToolCatalog tools={tools} selected={selectedName} onSelect={setSelectedName} />

      <div className="tt-center">
        {!tool ? (
          <div className="tt-empty">
            <h2>MCP Tool Tester</h2>
            <p className="empty-sub">
              Select a tool from the catalogue to inspect its schema, fill in arguments, and execute it against the
              live MCP server. State-changing tools return a risk-gate preview first — confirm to run.
            </p>
          </div>
        ) : (
          <>
            <div className="tt-tool-head">
              <div className="tt-tool-title">
                <span className={`tag tag-${tool.toolClass}`}>{tool.toolClass}</span>
                <span className="tt-name mono">{tool.name}</span>
                <span className="tt-group">{tool.group}</span>
              </div>
              <p className="tt-desc">{tool.description || "No description."}</p>
            </div>

            <div className="tt-arg-head">
              <span className="tt-arg-title">Arguments</span>
              <div className="tt-mode">
                <button className={mode === "form" ? "active" : ""} onClick={() => switchMode("form")}>
                  Form
                </button>
                <button className={mode === "json" ? "active" : ""} onClick={() => switchMode("json")}>
                  JSON
                </button>
              </div>
            </div>

            {mode === "form" ? (
              <div className="tt-form">
                {fields.length === 0 && <p className="tool-noargs">No parameters.</p>}
                {fields.map(([key, prop]) => (
                  <ArgField
                    key={key}
                    name={key}
                    prop={prop}
                    required={required.has(key)}
                    value={values[key] ?? ""}
                    onChange={(v) => setValues((cur) => ({ ...cur, [key]: v }))}
                  />
                ))}
              </div>
            ) : (
              <div className="tt-json">
                <textarea
                  className={`tt-json-input ${jsonError ? "err" : ""}`}
                  value={jsonText}
                  spellCheck={false}
                  onChange={(e) => {
                    setJsonText(e.target.value);
                    setJsonError(null);
                  }}
                />
                {jsonError && <div className="tt-json-err">{jsonError}</div>}
              </div>
            )}

            <div className="tt-actions">
              <button
                className={`run-btn run-${tool.toolClass}`}
                disabled={running}
                onClick={() => void execute()}
              >
                {running ? "Running…" : tool.toolClass === "read" ? "Execute" : "Execute…"}
              </button>
              {tool.toolClass !== "read" && (
                <span className="tt-hint">State-changing — you'll get a risk preview before anything runs.</span>
              )}
            </div>
          </>
        )}
      </div>

      <div className="tt-right">
        <div className="pane-head">
          <h2>Response</h2>
        </div>
        <ResponsePanel result={result} args={lastArgs} running={running} onConfirm={confirmExecute} />

        <div className="pane-head tt-history-head">
          <h2>History</h2>
          <span className="pane-sub">{history.length}</span>
        </div>
        {history.length === 0 ? (
          <p className="empty-sub">No calls yet.</p>
        ) : (
          <ul className="tt-history">
            {history.map((h) => (
              <li key={h.id} className={`tt-hist tt-hist-${h.status}`}>
                <button className="tt-hist-row" onClick={() => replay(h)}>
                  <span className={`act-dot act-dot-${h.status === "confirm" ? "denied" : h.status}`} />
                  <span className="tt-hist-name mono">{h.name}</span>
                  {h.durationMs !== undefined && <span className="tt-hist-dur">{h.durationMs}ms</span>}
                  <time className="act-time">{new Date(h.ts).toLocaleTimeString()}</time>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
