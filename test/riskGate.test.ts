import { describe, it, expect } from "vitest";
import { RiskGate } from "../src/core/riskGate.js";

const gate = new RiskGate();

describe("RiskGate", () => {
  it("allows a read-only PowerShell script", () => {
    const d = gate.evaluate({
      tool: "powershell_run",
      args: { script: "Get-Process | Select-Object -First 5" }
    });
    expect(d.disposition).toBe("allow");
    expect(d.level).toBe("read");
  });

  it("requires confirmation for a mutating script", () => {
    const d = gate.evaluate({
      tool: "powershell_run",
      args: { script: "Stop-Service -Name Spooler" }
    });
    expect(d.disposition).toBe("confirm");
    expect(d.level).toBe("mutate");
  });

  it("flags irreversible scripts with a high score", () => {
    const d = gate.evaluate({
      tool: "powershell_run",
      args: { script: "Format-Volume -DriveLetter D" }
    });
    expect(d.level).toBe("irreversible");
    expect(d.score).toBeGreaterThanOrEqual(90);
    expect(d.disposition).toBe("confirm");
  });

  it("requires confirmation for declarative mutating tools", () => {
    const d = gate.evaluate({ tool: "service_control", mutating: true, args: {} });
    expect(d.disposition).toBe("confirm");
    expect(d.level).toBe("mutate");
  });

  it("escalates declarative destructive tools", () => {
    const d = gate.evaluate({ tool: "process_kill", mutating: true, destructive: true, args: {} });
    expect(d.disposition).toBe("confirm");
    expect(d.level).toBe("destructive");
    expect(d.score).toBeGreaterThan(70);
  });

  it("allows declarative read-only tools", () => {
    const d = gate.evaluate({ tool: "system_info", args: {} });
    expect(d.disposition).toBe("allow");
    expect(d.level).toBe("read");
  });
});
