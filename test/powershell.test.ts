import { describe, it, expect } from "vitest";
import { psQuote } from "../src/core/powershell.js";
import { buildCimQueryScript } from "../src/providers/local/wmi.js";

describe("psQuote", () => {
  it("wraps a value in single quotes", () => {
    expect(psQuote("Win32_OperatingSystem")).toBe("'Win32_OperatingSystem'");
  });

  it("escapes embedded single quotes by doubling them", () => {
    expect(psQuote("a'; Remove-Item 'b")).toBe("'a''; Remove-Item ''b'");
  });
});

describe("buildCimQueryScript", () => {
  it("builds a class-name query", () => {
    const script = buildCimQueryScript({ className: "Win32_OperatingSystem" });
    expect(script).toContain("Get-CimInstance -ClassName 'Win32_OperatingSystem'");
    expect(script).toContain("ConvertTo-Json");
  });

  it("builds a WQL query", () => {
    const script = buildCimQueryScript({ wql: "SELECT * FROM Win32_Service" });
    expect(script).toContain("Get-CimInstance -Query 'SELECT * FROM Win32_Service'");
  });

  it("escapes a namespace and filter safely", () => {
    const script = buildCimQueryScript({
      className: "Win32_Service",
      namespace: "root/cimv2",
      filter: "Name='Spooler'"
    });
    expect(script).toContain("-Namespace 'root/cimv2'");
    expect(script).toContain("-Filter 'Name=''Spooler'''");
  });

  it("throws when neither className nor wql is provided", () => {
    expect(() => buildCimQueryScript({})).toThrow();
  });
});
