import { describe, it, expect, vi } from "vitest";
import { WinRmExecutor } from "../src/providers/remoteWindows/winrm.js";
import { SshExecutor } from "../src/providers/remoteWindows/ssh.js";
import type { RemoteTarget } from "../src/providers/remoteWindows/targets.js";
import type { PowerShellEngine } from "../src/core/powershell.js";

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

function decodeUtf16Base64(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf16le");
}

describe("WinRmExecutor.buildEnv", () => {
  const ps = {} as PowerShellEngine;

  it("encodes the script and host without credentials when no username", () => {
    const target: RemoteTarget = { id: "w", host: "host1", method: "winrm" };
    const env = new WinRmExecutor(ps, target).buildEnv("Get-Date");
    expect(env.WMCP_HOST).toBe("host1");
    expect(decodeUtf16Base64(env.WMCP_RS)).toBe("Get-Date");
    expect(env.WMCP_USER).toBeUndefined();
    expect(env.WMCP_PWD).toBeUndefined();
  });

  it("includes port and ssl flags when configured", () => {
    const target: RemoteTarget = { id: "w", host: "h", method: "winrm", port: 5986, useSsl: true };
    const env = new WinRmExecutor(ps, target).buildEnv("x");
    expect(env.WMCP_PORT).toBe("5986");
    expect(env.WMCP_SSL).toBe("1");
  });

  it("resolves the credential from the referenced env var", () => {
    process.env.__TEST_WINRM_PWD = "p@ss";
    const target: RemoteTarget = { id: "w", host: "h", method: "winrm", username: "DOMAIN\\admin", passwordEnv: "__TEST_WINRM_PWD" };
    const env = new WinRmExecutor(ps, target).buildEnv("x");
    expect(env.WMCP_USER).toBe("DOMAIN\\admin");
    expect(env.WMCP_PWD).toBe("p@ss");
    delete process.env.__TEST_WINRM_PWD;
  });

  it("throws when a username is set but the password env var is empty", () => {
    const target: RemoteTarget = { id: "w", host: "h", method: "winrm", username: "admin", passwordEnv: "__MISSING__" };
    expect(() => new WinRmExecutor(ps, target).buildEnv("x")).toThrow(/empty/);
  });

  it("delegates to the PowerShell engine with the built env", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0, timedOut: false, durationMs: 5 });
    const fakePs = { run } as unknown as PowerShellEngine;
    const target: RemoteTarget = { id: "w", host: "h", method: "winrm" };
    const res = await new WinRmExecutor(fakePs, target).exec("Get-Date", 1000);
    expect(res.exitCode).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    const [, opts] = run.mock.calls[0];
    expect(opts.env.WMCP_HOST).toBe("h");
    expect(opts.timeoutMs).toBe(1000);
  });
});

describe("SshExecutor", () => {
  it("builds an encoded PowerShell command", () => {
    const target: RemoteTarget = { id: "s", host: "h", method: "ssh", username: "u", privateKeyPath: "/k.pem" };
    const cmd = new SshExecutor(target, silentLogger).buildCommand("Get-Date");
    expect(cmd).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand /);
    const b64 = cmd.split(" ").pop()!;
    expect(decodeUtf16Base64(b64)).toBe("Get-Date");
  });

  it("uses a password credential from the referenced env var", () => {
    process.env.__TEST_SSH_PWD = "sshpw";
    const target: RemoteTarget = { id: "s", host: "h", method: "ssh", username: "u", passwordEnv: "__TEST_SSH_PWD", port: 2222 };
    const cfg = new SshExecutor(target, silentLogger).buildConnectConfig();
    expect(cfg.host).toBe("h");
    expect(cfg.port).toBe(2222);
    expect(cfg.password).toBe("sshpw");
    delete process.env.__TEST_SSH_PWD;
  });

  it("throws when no usable credential is available", () => {
    const target: RemoteTarget = { id: "s", host: "h", method: "ssh", username: "u", passwordEnv: "__MISSING__" };
    expect(() => new SshExecutor(target, silentLogger).buildConnectConfig()).toThrow(/no usable credential/);
  });
});
