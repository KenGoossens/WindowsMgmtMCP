import { describe, it, expect } from "vitest";
import { summarizeFidelity, type StateItem } from "../src/state/bundle.js";
import { buildCaptureScript, buildRestoreScript, mapCapture, type RawCapture } from "../src/state/capture.js";

describe("summarizeFidelity", () => {
  it("counts tiers and reports the weakest as overall", () => {
    const items: StateItem[] = [
      { tier: "osSettings", key: "a", label: "A", fidelity: "full", restorable: true },
      { tier: "appSettings", key: "b", label: "B", fidelity: "partial", restorable: true },
      { tier: "userData", key: "c", label: "C", fidelity: "referenced", restorable: false }
    ];
    const s = summarizeFidelity(items);
    expect(s).toMatchObject({ full: 1, partial: 1, referenced: 1, overall: "referenced" });
  });

  it("reports full when all items are full", () => {
    const s = summarizeFidelity([
      { tier: "osSettings", key: "a", label: "A", fidelity: "full", restorable: true },
      { tier: "osSettings", key: "b", label: "B", fidelity: "full", restorable: true }
    ]);
    expect(s.overall).toBe("full");
  });

  it("treats an empty capture as referenced", () => {
    expect(summarizeFidelity([]).overall).toBe("referenced");
  });
});

describe("buildCaptureScript", () => {
  it("gates each tier on the requested scope", () => {
    const osOnly = buildCaptureScript({ osSettings: true, appSettings: false, userData: false });
    expect(osOnly).toContain("if ($true)");
    expect(osOnly).toContain("Get-TimeZone");
    // apps + user tiers gated off
    expect(osOnly).toContain("if ($false)");
  });

  it("includes all tiers by default-ish full scope", () => {
    const all = buildCaptureScript({ osSettings: true, appSettings: true, userData: true });
    expect(all).toContain("Get-SmbMapping");
    expect(all).toContain("Get-Printer");
    expect(all).toContain("OneDrive");
  });
});

describe("mapCapture", () => {
  const raw: RawCapture = {
    os: { timeZoneId: "W. Europe Standard Time", culture: "nl-NL", powerPlan: "Balanced", wifiProfiles: ["Home", "Office"] },
    apps: {
      mappedDrives: [{ localPath: "Z:", remotePath: "\\\\srv\\share" }],
      printers: [{ name: "\\\\print\\HP", shareName: "HP", type: "Connection" }],
      defaultPrinter: "\\\\print\\HP"
    },
    user: { oneDriveConfigured: true, knownFolders: [{ name: "Desktop", path: "C:\\Users\\x\\Desktop" }], envVars: {} }
  };

  it("maps os settings with correct fidelity", () => {
    const { items, data } = mapCapture(raw, { osSettings: true, appSettings: false, userData: false });
    expect(data["os.timeZone"]).toBe("W. Europe Standard Time");
    expect(items.find((i) => i.key === "os.timeZone")?.fidelity).toBe("full");
    expect(items.find((i) => i.key === "os.wifiProfiles")?.fidelity).toBe("referenced");
  });

  it("maps known folders as referenced (never copies bytes)", () => {
    const { items } = mapCapture(raw, { osSettings: false, appSettings: false, userData: true });
    const kf = items.find((i) => i.key === "user.knownFolders");
    expect(kf?.fidelity).toBe("referenced");
    expect(kf?.restorable).toBe(false);
  });

  it("captures mapped drives as full and restorable", () => {
    const { items, data } = mapCapture(raw, { osSettings: false, appSettings: true, userData: false });
    expect((data["app.mappedDrives"] as unknown[]).length).toBe(1);
    expect(items.find((i) => i.key === "app.mappedDrives")?.fidelity).toBe("full");
  });
});

describe("buildRestoreScript", () => {
  it("applies time zone and mapped drives, escaping values", () => {
    const script = buildRestoreScript({
      "os.timeZone": "W. Europe Standard Time",
      "app.mappedDrives": [{ localPath: "Z:", remotePath: "\\\\srv\\share" }]
    });
    expect(script).toContain("Set-TimeZone -Id 'W. Europe Standard Time'");
    expect(script).toContain("New-SmbMapping -LocalPath 'Z:' -RemotePath '\\\\srv\\share'");
    expect(script).toContain("ConvertTo-Json");
  });

  it("only re-adds network (UNC) printers", () => {
    const script = buildRestoreScript({
      "app.printers": [{ name: "\\\\print\\HP" }, { name: "Local PDF" }]
    });
    expect(script).toContain("Add-Printer -ConnectionName '\\\\print\\HP'");
    expect(script).not.toContain("Local PDF");
  });
});
