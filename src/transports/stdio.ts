import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolContext } from "../core/tools.js";
import type { ProviderRegistry } from "../providers/provider.js";
import { buildMcpServer } from "../server.js";

export interface TransportHandle {
  close(): Promise<void>;
}

/**
 * Start the server over stdio (a single local client owns stdout for JSON-RPC).
 */
export async function startStdio(ctx: ToolContext, registry: ProviderRegistry): Promise<TransportHandle> {
  const server = await buildMcpServer(ctx, registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  ctx.logger.info("MCP server connected over stdio");

  return {
    close: async () => {
      await server.close();
    }
  };
}
