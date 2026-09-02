import { describe, it, expect } from "vitest";
import type { Server } from "node:http";
import { createWebUiServer } from "../src/webui/server.js";
import type { WebUiMcpClient } from "../src/webui/mcpClient.js";
import {
  classifyTool,
  toolGroup,
  toUiTool,
  deriveHealth,
  toFleetRows,
  parseToolResult,
  type RawTool,
  type RawAlert
} from "../src/webui/normalize.js";
import type { SeriesAggregate } from "../src/reporting/metrics.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;

function series(over: Partial<SeriesAggregate>): SeriesAggregate {
  return {
    providerId: "awsworkspaces",
    entity: "eu-west-1",
    metric: "sessionCount",
    unit: "count",
    count: 1,
    last: 0,
    min: 0,
    max: 0,
    avg: 0,
    lastTs: "2026-06-13T00:00:00.000Z",
    ...over
  };
}

describe("classifyTool", () => {
  it("maps annotations to read / mutating / destructive", () => {
    const read: RawTool = { name: "workspace_list", annotations: { readOnlyHint: true } };
    const mut: RawTool = { name: "workspace_start", annotations: { readOnlyHint: false } };
    const des: RawTool = { name: "workspace_terminate", annotations: { readOnlyHint: false, destructiveHint: true } };
    expect(classifyTool(read)).toBe("read");
    expect(classifyTool(mut)).toBe("mutating");
    expect(classifyTool(des)).toBe("destructive");
  });

  it("defaults to read when annotations are absent", () => {
    expect(classifyTool({ name: "whatever" })).toBe("read");
  });
});

describe("toolGroup", () => {
  it("infers the provider/subsystem from the name prefix", () => {
    expect(toolGroup("workspace_pool_list")).toBe("AWS WorkSpaces");
    expect(toolGroup("horizoncloud_pool_list")).toBe("Horizon Cloud");
    expect(toolGroup("horizon_session_logoff")).toBe("Omnissa Horizon");
    expect(toolGroup("device_wipe")).toBe("Workspace ONE UEM");
    expect(toolGroup("failover_initiate")).toBe("Continuity");
    expect(toolGroup("powershell_run")).toBe("Local Windows");
  });
});

describe("toUiTool", () => {
  it("builds the UI view model with title fallback and class", () => {
    const ui = toUiTool({ name: "device_wipe", description: "wipe", annotations: { readOnlyHint: false, destructiveHint: true } });
    expect(ui).toMatchObject({ name: "device_wipe", title: "device_wipe", toolClass: "destructive", group: "Workspace ONE UEM" });
  });
});

describe("deriveHealth", () => {
  it("is critical when an unacknowledged alert exists", () => {
    const alerts: RawAlert[] = [{ providerId: "p", entity: "e", metric: "loadIndex", value: 5, threshold: 1, condition: ">" }];
    expect(deriveHealth([{ metric: "loadIndex", value: 0 }], alerts)).toBe("critical");
  });

  it("is warning when loadIndex > 0 and no alert", () => {
    expect(deriveHealth([{ metric: "loadIndex", value: 2 }], [])).toBe("warning");
  });

  it("is ok when loadIndex is 0", () => {
    expect(deriveHealth([{ metric: "loadIndex", value: 0 }], [])).toBe("ok");
  });

  it("is unknown when there are no metrics", () => {
    expect(deriveHealth([], [])).toBe("unknown");
  });
});

describe("toFleetRows", () => {
  it("folds per-series aggregates into one row per provider::entity with health", () => {
    const rows = toFleetRows(
      [
        series({ providerId: "citrix", entity: "Sales", metric: "sessionCount", last: 3 }),
        series({ providerId: "citrix", entity: "Sales", metric: "loadIndex", last: 1, unit: "index" }),
        series({ providerId: "awsworkspaces", entity: "eu-west-1", metric: "sessionCount", last: 10 }),
        series({ providerId: "awsworkspaces", entity: "eu-west-1", metric: "loadIndex", last: 0, unit: "index" })
      ],
      []
    );
    expect(rows).toHaveLength(2);
    const sales = rows.find((r) => r.entity === "Sales")!;
    expect(sales.providerLabel).toBe("Citrix DaaS");
    expect(sales.substrate).toBe("daas");
    expect(sales.health).toBe("warning"); // loadIndex 1
    expect(sales.metrics).toHaveLength(2);
    const aws = rows.find((r) => r.entity === "eu-west-1")!;
    expect(aws.health).toBe("ok"); // loadIndex 0
  });

  it("escalates a row to critical when an alert targets it", () => {
    const rows = toFleetRows(
      [series({ providerId: "horizon", entity: "horizon", metric: "loadIndex", last: 0, unit: "index" })],
      [{ providerId: "horizon", entity: "horizon", metric: "loadIndex", value: 9, threshold: 1, condition: ">" }]
    );
    expect(rows[0].health).toBe("critical");
  });
});

describe("parseToolResult", () => {
  it("detects the risk-gate confirmation preview", () => {
    const preview = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "confirmation_required",
            tool: "workspace_terminate",
            riskLevel: "irreversible",
            riskScore: 95,
            reasons: ["destroys both volumes"]
          })
        }
      ]
    };
    const parsed = parseToolResult(preview);
    expect(parsed.confirmationRequired).toBe(true);
    expect(parsed.risk).toMatchObject({ level: "irreversible", score: 95 });
    expect(parsed.risk?.reasons).toEqual(["destroys both volumes"]);
  });

  it("parses a normal JSON result", () => {
    const ok = { content: [{ type: "text", text: JSON.stringify({ count: 2, workspaces: [] }) }] };
    const parsed = parseToolResult(ok);
    expect(parsed.confirmationRequired).toBe(false);
    expect(parsed.isError).toBe(false);
    expect((parsed.data as { count: number }).count).toBe(2);
  });

  it("tolerates non-JSON text and flags errors", () => {
    const err = { isError: true, content: [{ type: "text", text: "PowerShell error: boom" }] };
    const parsed = parseToolResult(err);
    expect(parsed.isError).toBe(true);
    expect(parsed.data).toBeUndefined();
    expect(parsed.text).toContain("boom");
  });
});

describe("createWebUiServer routes", () => {
  /** A minimal fake of the MCP client the BFF depends on. */
  function fakeClient(over: Partial<WebUiMcpClient> = {}): WebUiMcpClient {
    return {
      isConnected: () => true,
      listTools: async () => [
        { name: "system_info", title: "System info", description: "", toolClass: "read", group: "Local Windows" }
      ],
      callTool: async (_name: string, args: Record<string, unknown>) =>
        args.confirm
          ? { confirmationRequired: false, isError: false, data: { status: "ok" }, text: "{}" }
          : {
              confirmationRequired: true,
              isError: false,
              risk: { level: "destructive", score: 80, reasons: ["needs confirm"] },
              data: { status: "confirmation_required" },
              text: "{}"
            },
      fleet: async () => ({ ts: "2026-06-13T00:00:00.000Z", rows: [] }),
      alerts: async () => ({ ts: "2026-06-13T00:00:00.000Z", active: [] }),
      ...over
    } as unknown as WebUiMcpClient;
  }

  async function withServer(
    client: WebUiMcpClient,
    fn: (base: string) => Promise<void>
  ): Promise<void> {
    const server = createWebUiServer({ client, logger: silentLogger });
    const http: Server = await server.listen("127.0.0.1", 0);
    const addr = http.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  it("serves the tool catalogue", async () => {
    await withServer(fakeClient(), async (base) => {
      const res = await fetch(`${base}/api/tools`);
      const body = (await res.json()) as { tools: { name: string }[] };
      expect(res.status).toBe(200);
      expect(body.tools[0].name).toBe("system_info");
    });
  });

  it("returns a confirmation preview with durationMs, then executes on confirm", async () => {
    await withServer(fakeClient(), async (base) => {
      const preview = await (
        await fetch(`${base}/api/tools/process_kill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pidOrName: "x" })
        })
      ).json();
      expect(preview.confirmationRequired).toBe(true);
      expect(preview.risk.score).toBe(80);
      expect(typeof preview.durationMs).toBe("number");

      const done = await (
        await fetch(`${base}/api/tools/process_kill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pidOrName: "x", confirm: true })
        })
      ).json();
      expect(done.confirmationRequired).toBe(false);
      expect(done.isError).toBe(false);
    });
  });

  it("maps a client failure to a 502", async () => {
    const client = fakeClient({
      callTool: async () => {
        throw new Error("mcp down");
      }
    });
    await withServer(client, async (base) => {
      const res = await fetch(`${base}/api/tools/system_info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toContain("mcp down");
    });
  });
});
