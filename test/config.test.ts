import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { ConfigError } from "../src/core/errors.js";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("loadConfig", () => {
  it("defaults to the stdio transport on loopback", () => {
    const config = loadConfig(env({}));
    expect(config.transport).toBe("stdio");
    expect(config.httpHost).toBe("127.0.0.1");
    expect(config.httpPort).toBe(3000);
  });

  it("requires a bearer token for the http transport", () => {
    expect(() => loadConfig(env({ MCP_TRANSPORT: "http" }))).toThrow(ConfigError);
  });

  it("accepts the http transport when a token is set", () => {
    const config = loadConfig(env({ MCP_TRANSPORT: "http", MCP_HTTP_TOKEN: "secret" }));
    expect(config.transport).toBe("http");
    expect(config.httpToken).toBe("secret");
  });

  it("parses the tool allow-list", () => {
    const config = loadConfig(env({ MCP_TOOL_ALLOWLIST: "system_info, cloudpc_list ,wmi_query" }));
    expect(config.toolAllowlist).toEqual(["system_info", "cloudpc_list", "wmi_query"]);
  });

  it("parses boolean flags", () => {
    expect(loadConfig(env({ MCP_MULTI_TENANT: "true" })).multiTenant).toBe(true);
    expect(loadConfig(env({ MCP_MULTI_TENANT: "false" })).multiTenant).toBe(false);
    expect(loadConfig(env({})).multiTenant).toBe(false);
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig(env({ MCP_HTTP_PORT: "70000", MCP_TRANSPORT: "stdio" }))).toThrow(ConfigError);
  });
});
