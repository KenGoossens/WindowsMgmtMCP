import pino, { type Logger } from "pino";

/**
 * Create the application logger.
 *
 * IMPORTANT: logs are written to **stderr** (fd 2). The stdio MCP transport owns
 * stdout for JSON-RPC framing, so anything written there would corrupt the protocol.
 */
export function createLogger(level: string): Logger {
  return pino(
    {
      level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime
    },
    pino.destination({ dest: 2, sync: false })
  );
}

export type { Logger };
