import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore, StateStoreError } from "../src/state/store.js";
import type { StateBundle } from "../src/state/bundle.js";

function bundle(id: string, subject: string, createdAt = new Date().toISOString()): StateBundle {
  return {
    manifest: {
      id,
      subject,
      sourceProviderId: "local",
      sourceEntity: "PC-1",
      scope: { osSettings: true, appSettings: true, userData: true },
      createdAt,
      items: [{ tier: "osSettings", key: "os.timeZone", label: "Time zone", fidelity: "full", restorable: true }],
      fidelity: { full: 1, partial: 0, referenced: 0, overall: "full" },
      version: 1
    },
    data: { "os.timeZone": "W. Europe Standard Time", secret: "value-that-must-be-encrypted" }
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wmcp-state-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("round-trips a bundle through encryption", async () => {
    const store = new StateStore(dir, "test-secret", 30);
    const id = await store.save(bundle("b1", "alice"));
    const loaded = await store.load(id);
    expect(loaded.manifest.subject).toBe("alice");
    expect(loaded.data.secret).toBe("value-that-must-be-encrypted");
  });

  it("encrypts at rest (plaintext is not on disk)", async () => {
    const store = new StateStore(dir, "test-secret", 30);
    await store.save(bundle("b2", "bob"));
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(path.join(dir, "b2.sb"));
    expect(raw.toString("utf8")).not.toContain("value-that-must-be-encrypted");
    expect(raw.toString("utf8").startsWith("WMCPSB1")).toBe(true);
  });

  it("fails to decrypt with the wrong key", async () => {
    const writer = new StateStore(dir, "right-key", 30);
    await writer.save(bundle("b3", "carol"));
    const reader = new StateStore(dir, "wrong-key", 30);
    await expect(reader.load("b3")).rejects.toBeInstanceOf(StateStoreError);
  });

  it("lists manifests filtered by subject, newest first", async () => {
    const store = new StateStore(dir, "k", 30);
    await store.save(bundle("b4", "alice", "2026-01-01T00:00:00.000Z"));
    await store.save(bundle("b5", "alice", "2026-02-01T00:00:00.000Z"));
    await store.save(bundle("b6", "dave", "2026-03-01T00:00:00.000Z"));
    const alice = await store.list("alice");
    expect(alice.map((m) => m.id)).toEqual(["b5", "b4"]);
    expect(await store.list()).toHaveLength(3);
  });

  it("purges bundles older than the retention window", async () => {
    const store = new StateStore(dir, "k", 30);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await store.save(bundle("old", "x", old));
    await store.save(bundle("new", "x"));
    const purged = await store.purgeExpired();
    expect(purged).toEqual(["old"]);
    expect((await store.list()).map((m) => m.id)).toEqual(["new"]);
  });

  it("rejects a not-found bundle", async () => {
    const store = new StateStore(dir, "k", 30);
    await expect(store.load("missing")).rejects.toBeInstanceOf(StateStoreError);
  });
});
