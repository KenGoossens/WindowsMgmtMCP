import { describe, it, expect } from "vitest";
import { loadRemoteTargets, resolveSecret, remoteTargetSchema } from "../src/providers/remoteWindows/targets.js";

describe("loadRemoteTargets", () => {
  it("returns an empty list when nothing is configured", () => {
    expect(loadRemoteTargets({})).toEqual([]);
    expect(loadRemoteTargets({ inlineJson: "  " })).toEqual([]);
  });

  it("parses a valid inline winrm target", () => {
    const targets = loadRemoteTargets({
      inlineJson: JSON.stringify([{ id: "web01", host: "10.0.0.5", method: "winrm", username: "admin", passwordEnv: "W" }])
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: "web01", host: "10.0.0.5", method: "winrm" });
  });

  it("rejects an ssh target without a credential", () => {
    expect(() =>
      loadRemoteTargets({ inlineJson: JSON.stringify([{ id: "x", host: "h", method: "ssh", username: "u" }]) })
    ).toThrow(/passwordEnv or privateKeyPath/);
  });

  it("accepts an ssh target with a private key", () => {
    const targets = loadRemoteTargets({
      inlineJson: JSON.stringify([{ id: "lin01", host: "h", method: "ssh", username: "u", privateKeyPath: "/k.pem" }])
    });
    expect(targets[0].method).toBe("ssh");
  });

  it("rejects duplicate ids", () => {
    const dup = JSON.stringify([
      { id: "a", host: "h1", method: "winrm" },
      { id: "a", host: "h2", method: "winrm" }
    ]);
    expect(() => loadRemoteTargets({ inlineJson: dup })).toThrow(/Duplicate remote target id/);
  });

  it("rejects non-array JSON", () => {
    expect(() => loadRemoteTargets({ inlineJson: '{"id":"a"}' })).toThrow(/must be a JSON array/);
  });

  it("rejects invalid JSON", () => {
    expect(() => loadRemoteTargets({ inlineJson: "not json" })).toThrow(/not valid JSON/);
  });

  it("rejects an unknown method via the schema", () => {
    const result = remoteTargetSchema.safeParse({ id: "a", host: "h", method: "telnet" });
    expect(result.success).toBe(false);
  });
});

describe("resolveSecret", () => {
  it("resolves a secret from the provided environment", () => {
    expect(resolveSecret("MY_PWD", { MY_PWD: "s3cret" } as NodeJS.ProcessEnv)).toBe("s3cret");
  });
  it("returns undefined for a missing or unnamed secret", () => {
    expect(resolveSecret(undefined)).toBeUndefined();
    expect(resolveSecret("NOPE", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
