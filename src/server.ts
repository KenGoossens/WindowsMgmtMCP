import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./core/tools.js";
import { ProviderRegistry } from "./providers/provider.js";
import { LocalProvider } from "./providers/local/localProvider.js";
import { Windows365Provider } from "./providers/windows365/cloudPcProvider.js";
import { RemoteWindowsProvider } from "./providers/remoteWindows/remoteProvider.js";
import { AwsWorkspacesProvider } from "./providers/awsWorkspaces/awsWorkspacesProvider.js";
import { AvdProvider } from "./providers/avd/avdProvider.js";
import { CitrixProvider } from "./providers/citrix/citrixProvider.js";
import { HorizonProvider } from "./providers/horizon/horizonProvider.js";
import { HorizonCloudProvider } from "./providers/horizonCloud/cloudProvider.js";
import { Ws1Provider } from "./providers/ws1uem/ws1Provider.js";
import { registerReportingTools } from "./reporting/tools.js";
import { registerReportingResources } from "./reporting/stream.js";
import { registerStateTools } from "./state/tools.js";
import { registerMigrationTools } from "./orchestration/tools.js";
import { registerFailoverTools } from "./orchestration/failoverTools.js";
import { registerAgentTools } from "./agent/tools.js";
import { registerOnboardingTools } from "./onboarding/tools.js";

export const SERVER_NAME = "windows-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Build the provider registry once. Providers are stateless across sessions, so
 * a single registry is reused to register tools onto every MCP server instance
 * (one per stdio process, one per HTTP session).
 */
export function createProviderRegistry(ctx: ToolContext): ProviderRegistry {
  const registry = new ProviderRegistry(ctx.logger);
  registry.register(new LocalProvider(ctx.config, ctx.logger));
  registry.register(new Windows365Provider(ctx.config, ctx.logger));
  registry.register(new RemoteWindowsProvider(ctx.config, ctx.logger));
  registry.register(new AwsWorkspacesProvider(ctx.config, ctx.logger));
  registry.register(new AvdProvider(ctx.config, ctx.logger));
  registry.register(new CitrixProvider(ctx.config, ctx.logger));
  registry.register(new HorizonProvider(ctx.config, ctx.logger));
  registry.register(new HorizonCloudProvider(ctx.config, ctx.logger));
  registry.register(new Ws1Provider(ctx.config, ctx.logger));
  return registry;
}

/**
 * Create a fresh MCP server with all available providers' tools registered.
 * When the reporting subsystem is enabled, the telemetry tools and live MCP
 * resources are wired in as well.
 */
export async function buildMcpServer(ctx: ToolContext, registry: ProviderRegistry): Promise<McpServer> {
  const reportingEnabled = Boolean(ctx.reporting);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: reportingEnabled
        ? { tools: {}, resources: { subscribe: true, listChanged: true } }
        : { tools: {} }
    }
  );
  const { registered, skipped } = await registry.registerAvailable(server, ctx);

  if (ctx.reporting) {
    registerReportingTools(server, ctx, ctx.reporting);
    const off = registerReportingResources(server, ctx.reporting, ctx.logger);
    const prevOnClose = server.server.onclose;
    server.server.onclose = () => {
      off();
      prevOnClose?.();
    };
  }

  if (ctx.state) {
    registerStateTools(server, ctx, ctx.state);
  }
  if (ctx.migration) {
    registerMigrationTools(server, ctx, ctx.migration);
  }
  if (ctx.continuity) {
    registerFailoverTools(server, ctx, ctx.continuity);
  }
  if (ctx.agents) {
    registerAgentTools(server, ctx, ctx.agents);
  }
  if (ctx.onboarding) {
    registerOnboardingTools(server, ctx, ctx.onboarding);
  }

  ctx.logger.info(
    {
      registered,
      skipped,
      reporting: reportingEnabled,
      state: Boolean(ctx.state),
      migration: Boolean(ctx.migration),
      continuity: Boolean(ctx.continuity),
      agents: Boolean(ctx.agents)
    },
    "providers initialised"
  );
  return server;
}

