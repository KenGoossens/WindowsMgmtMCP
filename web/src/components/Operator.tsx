import { useMemo, useState } from "react";
import type { JsonSchemaProp, UiTool } from "../api";

const CLASS_LABEL: Record<UiTool["toolClass"], string> = {
  read: "read",
  mutating: "mutating",
  destructive: "destructive"
};

/** A minimal schema-driven form for a tool's top-level input properties. */
function ToolForm({
  tool,
  busy,
  onRun
}: {
  tool: UiTool;
  busy: boolean;
  onRun: (tool: UiTool, args: Record<string, unknown>) => void;
}): JSX.Element {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const fields = Object.entries(props).filter(([k]) => k !== "confirm");
  const [values, setValues] = useState<Record<string, string>>({});

  const setField = (key: string, value: string): void => setValues((v) => ({ ...v, [key]: value }));

  const coerce = (key: string, prop: JsonSchemaProp): unknown => {
    const raw = values[key];
    if (raw === undefined || raw === "") return undefined;
    if (prop.type === "number" || prop.type === "integer") return Number(raw);
    if (prop.type === "boolean") return raw === "true";
    return raw;
  };

  const submit = (): void => {
    const args: Record<string, unknown> = {};
    for (const [key, prop] of fields) {
      const v = coerce(key, prop);
      if (v !== undefined) args[key] = v;
    }
    onRun(tool, args);
  };

  return (
    <div className="tool-form">
      <p className="tool-desc">{tool.description}</p>
      {fields.length === 0 && <p className="tool-noargs">No parameters.</p>}
      {fields.map(([key, prop]) => (
        <label className="field" key={key}>
          <span className="field-label">
            {key}
            {required.has(key) && <em className="req">*</em>}
            {prop.description && <span className="field-hint">{prop.description}</span>}
          </span>
          {prop.enum ? (
            <select value={values[key] ?? ""} onChange={(e) => setField(key, e.target.value)}>
              <option value="">—</option>
              {prop.enum.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : prop.type === "boolean" ? (
            <select value={values[key] ?? ""} onChange={(e) => setField(key, e.target.value)}>
              <option value="">—</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              type={prop.type === "number" || prop.type === "integer" ? "number" : "text"}
              value={values[key] ?? ""}
              onChange={(e) => setField(key, e.target.value)}
              placeholder={prop.type ?? "string"}
            />
          )}
        </label>
      ))}
      <button className={`run-btn run-${tool.toolClass}`} disabled={busy} onClick={submit}>
        {tool.toolClass === "read" ? "Run" : tool.toolClass === "destructive" ? "Run (destructive)…" : "Run…"}
      </button>
      {tool.toolClass !== "read" && (
        <p className="run-note">State-changing — you'll get a risk preview to approve before anything executes.</p>
      )}
    </div>
  );
}

export function Operator({
  tools,
  busy,
  onRun
}: {
  tools: UiTool[];
  busy: boolean;
  onRun: (tool: UiTool, args: Record<string, unknown>) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [openTool, setOpenTool] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? tools.filter((t) => t.name.includes(q) || t.title.toLowerCase().includes(q) || t.group.toLowerCase().includes(q))
      : tools;
    const map = new Map<string, UiTool[]>();
    for (const t of filtered) {
      const arr = map.get(t.group) ?? [];
      arr.push(t);
      map.set(t.group, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tools, query]);

  return (
    <section className="operator">
      <div className="pane-head">
        <h2>Operator</h2>
        <span className="pane-sub">call any tool — safely</span>
      </div>
      <input
        className="search"
        placeholder="Search tools…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="tool-groups">
        {grouped.map(([group, items]) => (
          <div className="tool-group" key={group}>
            <div className="group-name">{group}</div>
            {items.map((tool) => (
              <div className="tool-item" key={tool.name}>
                <button
                  className={`tool-row ${openTool === tool.name ? "open" : ""}`}
                  onClick={() => setOpenTool((cur) => (cur === tool.name ? null : tool.name))}
                >
                  <span className={`tag tag-${tool.toolClass}`}>{CLASS_LABEL[tool.toolClass]}</span>
                  <span className="tool-name mono">{tool.name}</span>
                </button>
                {openTool === tool.name && <ToolForm tool={tool} busy={busy} onRun={onRun} />}
              </div>
            ))}
          </div>
        ))}
        {grouped.length === 0 && <p className="empty-sub">No tools match.</p>}
      </div>
    </section>
  );
}
