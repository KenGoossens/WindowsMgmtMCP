import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../core/logger.js";
import { TELEMETRY_ALERTS_URI, TELEMETRY_SNAPSHOT_URI } from "../reporting/resources.js";
import type { SeriesAggregate } from "../reporting/metrics.js";
import {
  toUiTool,
  toFleetRows,
  parseToolResult,
  type UiTool,
  type FleetRow,
  type RawAlert,
  type RawTool,
  type RawToolResult,
  type ParsedToolResult
} from "./normalize.js";

export interface WebUiMcpOptions {
  /** The MCP server's Streamable HTTP endpoint, e.g. http://127.0.0.1:3000/mcp. */
  url: string;
  /** Bearer token presented to the MCP server. */
  token?: string;
  logger: Logger;
}

/** A reading of a telemetry resource, already JSON-decoded. */
function readJson<T>(text: string | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Extract the text body of the first resource content entry (ignores blob parts). */
function firstText(contents: ReadonlyArray<{ text?: string; blob?: string }> | undefined): string | undefined {
  const first = contents?.[0];
  return first && typeof first.text === "string" ? first.text : undefined;
}

/**
 * A thin MCP client the BFF uses to talk to the windows-mcp server: connect over
 * Streamable HTTP with a bearer token, list/call tools, read the telemetry
 * resources, and fan resource-update notifications out to a local listener.
 */
export class WebUiMcpClient {
  private client?: Client;
  private connected = false;

  constructor(private readonly opts: WebUiMcpOptions) {}

  isConnected(): boolean {
    return this.connected;
  }

  /** Connect and subscribe to the live telemetry resources. */
  async connect(onTelemetryChanged?: (uri: string) => void): Promise<void> {
    const client = new Client(
      { name: "windows-mcp-webui", version: "0.1.0" },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: this.opts.token
        ? { headers: { Authorization: `Bearer ${this.opts.token}` } }
        : undefined
    });

    if (onTelemetryChanged) {
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        onTelemetryChanged(n.params.uri);
      });
    }

    await client.connect(transport);
    this.client = client;
    this.connected = true;
    this.opts.logger.info({ url: this.opts.url }, "webui connected to MCP server");

    // Best-effort: subscribe to the live telemetry resources. If reporting is
    // disabled on the server these will fail; the UI still works on-demand.
    for (const uri of [TELEMETRY_SNAPSHOT_URI, TELEMETRY_ALERTS_URI]) {
      try {
        await client.subscribeResource({ uri });
      } catch (err) {
        this.opts.logger.warn({ err, uri }, "webui telemetry subscribe failed (reporting may be disabled)");
      }
    }
  }

  private require(): Client {
    if (!this.client || !this.connected) {
      throw new Error("MCP client is not connected.");
    }
    return this.client;
  }

  /** List the tools the authenticated principal is allowed to see, as UI models. */
  async listTools(): Promise<UiTool[]> {
    const res = await this.require().listTools();
    return (res.tools as RawTool[]).map(toUiTool).sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  }

  /** Call a tool and parse the result (detecting the confirmation-required preview). */
  async callTool(name: string, args: Record<string, unknown>): Promise<ParsedToolResult> {
    const res = (await this.require().callTool({ name, arguments: args })) as RawToolResult;
    return parseToolResult(res);
  }

  /** Read the live fleet snapshot resource and fold it into UI rows. */
  async fleet(): Promise<{ ts: string; rows: FleetRow[] }> {
    const client = this.require();
    const snapRes = await client.readResource({ uri: TELEMETRY_SNAPSHOT_URI });
    const alertRes = await client.readResource({ uri: TELEMETRY_ALERTS_URI }).catch(() => undefined);

    const snapText = firstText(snapRes.contents);
    const snap = readJson<{ ts: string; series: SeriesAggregate[] }>(snapText, {
      ts: new Date().toISOString(),
      series: []
    });
    const alertText = firstText(alertRes?.contents);
    const alerts = readJson<{ active: RawAlert[] }>(alertText, { active: [] });

    return { ts: snap.ts, rows: toFleetRows(snap.series, alerts.active) };
  }

  /** Read the live active-alerts resource. */
  async alerts(): Promise<{ ts: string; active: RawAlert[] }> {
    const res = await this.require().readResource({ uri: TELEMETRY_ALERTS_URI });
    const text = firstText(res.contents);
    return readJson<{ ts: string; active: RawAlert[] }>(text, { ts: new Date().toISOString(), active: [] });
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } finally {
      this.connected = false;
    }
  }
}

export { TELEMETRY_SNAPSHOT_URI, TELEMETRY_ALERTS_URI };
