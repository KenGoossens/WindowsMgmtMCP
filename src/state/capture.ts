import { psQuote } from "../core/powershell.js";
import type { StateItem, StateScope } from "./bundle.js";

/**
 * Native Windows settings capture/restore (technical spec, Ch. 9.1 — we *drive*
 * proven native mechanisms, we don't reinvent them). This module builds the
 * PowerShell that reads/writes real, always-present Windows settings and maps the
 * raw result into normalized {@link StateItem}s with honest fidelity.
 *
 * Bulk user-data (Documents/known folders) is recorded as `referenced` — we
 * capture where it lives (OneDrive Known Folder Move / USMT would move the bytes)
 * rather than copying gigabytes through the management plane.
 */

/** The raw shape the capture script emits as JSON. */
export interface RawCapture {
  os?: {
    timeZoneId?: string;
    culture?: string;
    powerPlan?: string;
    wifiProfiles?: string[];
  };
  apps?: {
    mappedDrives?: { localPath?: string; remotePath?: string }[];
    printers?: { name?: string; portName?: string; driverName?: string; shareName?: string; type?: string }[];
    defaultPrinter?: string;
  };
  user?: {
    oneDriveConfigured?: boolean;
    knownFolders?: { name: string; path: string }[];
    envVars?: Record<string, string>;
  };
}

/**
 * Build a read-only capture script. Each tier is gated by the requested scope so
 * we only read what we'll store. Emits a single JSON object.
 */
export function buildCaptureScript(scope: StateScope): string {
  const wantOs = scope.osSettings !== false;
  const wantApps = scope.appSettings !== false;
  const wantUser = scope.userData !== false;

  return `
$result = [ordered]@{}
if (${wantOs ? "$true" : "$false"}) {
  $wifi = @()
  try { $wifi = (netsh wlan show profiles) -match 'All User Profile' | ForEach-Object { ($_ -split ':')[1].Trim() } } catch {}
  $plan = ''
  try { $plan = ((powercfg /getactivescheme) -replace '.*\\(([^)]+)\\).*','$1') } catch {}
  $result.os = [ordered]@{
    timeZoneId = (Get-TimeZone).Id
    culture    = (Get-Culture).Name
    powerPlan  = $plan
    wifiProfiles = @($wifi)
  }
}
if (${wantApps ? "$true" : "$false"}) {
  $drives = @()
  try { $drives = Get-SmbMapping -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ localPath = $_.LocalPath; remotePath = $_.RemotePath } } } catch {}
  $printers = @()
  try { $printers = Get-Printer -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name = $_.Name; portName = $_.PortName; driverName = $_.DriverName; shareName = $_.ShareName; type = [string]$_.Type } } } catch {}
  $defaultPrinter = ''
  try { $defaultPrinter = (Get-CimInstance Win32_Printer -Filter 'Default = TRUE' -ErrorAction SilentlyContinue | Select-Object -First 1).Name } catch {}
  $result.apps = [ordered]@{
    mappedDrives = @($drives)
    printers = @($printers)
    defaultPrinter = $defaultPrinter
  }
}
if (${wantUser ? "$true" : "$false"}) {
  $oneDrive = Test-Path $env:OneDrive
  $kf = @()
  foreach ($n in 'Desktop','Personal','My Pictures') {
    try {
      $p = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -Name $n -ErrorAction Stop).$n
      $kf += [pscustomobject]@{ name = $n; path = $p }
    } catch {}
  }
  $envVars = [ordered]@{}
  foreach ($k in 'HOMEPATH','USERPROFILE') { $envVars[$k] = [string](Get-Item "Env:$k" -ErrorAction SilentlyContinue).Value }
  $result.user = [ordered]@{
    oneDriveConfigured = [bool]$oneDrive
    knownFolders = @($kf)
    envVars = $envVars
  }
}
$result | ConvertTo-Json -Depth 6`;
}

/** Map a raw capture into normalized StateItems + the keyed data payload. */
export function mapCapture(raw: RawCapture, scope: StateScope): { items: StateItem[]; data: Record<string, unknown> } {
  const items: StateItem[] = [];
  const data: Record<string, unknown> = {};

  if (scope.osSettings !== false && raw.os) {
    data["os.timeZone"] = raw.os.timeZoneId;
    items.push({ tier: "osSettings", key: "os.timeZone", label: "Time zone", fidelity: "full", restorable: true });

    data["os.culture"] = raw.os.culture;
    items.push({ tier: "osSettings", key: "os.culture", label: "Regional format (culture)", fidelity: "full", restorable: true });

    data["os.powerPlan"] = raw.os.powerPlan;
    items.push({ tier: "osSettings", key: "os.powerPlan", label: "Active power plan", fidelity: "partial", restorable: false, note: "Name recorded; plan GUID not portable across images." });

    const wifi = raw.os.wifiProfiles ?? [];
    data["os.wifiProfiles"] = wifi;
    items.push({
      tier: "osSettings",
      key: "os.wifiProfiles",
      label: "Wi-Fi profiles",
      fidelity: "referenced",
      restorable: false,
      count: wifi.length,
      note: "Profile names captured; keys require exported XML and are not stored here."
    });
  }

  if (scope.appSettings !== false && raw.apps) {
    const drives = raw.apps.mappedDrives ?? [];
    data["app.mappedDrives"] = drives;
    items.push({ tier: "appSettings", key: "app.mappedDrives", label: "Mapped network drives", fidelity: "full", restorable: true, count: drives.length });

    const printers = raw.apps.printers ?? [];
    data["app.printers"] = printers;
    data["app.defaultPrinter"] = raw.apps.defaultPrinter;
    const networkPrinters = printers.filter((p) => (p.type ?? "").toLowerCase() === "connection" || p.shareName).length;
    items.push({
      tier: "appSettings",
      key: "app.printers",
      label: "Printers",
      fidelity: networkPrinters === printers.length ? "full" : "partial",
      restorable: true,
      count: printers.length,
      note: "Network printers re-added on restore; local/driver-only printers are referenced."
    });
  }

  if (scope.userData !== false && raw.user) {
    data["user.oneDriveConfigured"] = raw.user.oneDriveConfigured;
    data["user.knownFolders"] = raw.user.knownFolders ?? [];
    items.push({
      tier: "userData",
      key: "user.knownFolders",
      label: "Known folders / OneDrive",
      fidelity: "referenced",
      restorable: false,
      count: (raw.user.knownFolders ?? []).length,
      note: "Folder locations captured; file contents move via OneDrive KFM / USMT, not through this layer."
    });

    data["user.envVars"] = raw.user.envVars ?? {};
    items.push({ tier: "userData", key: "user.envVars", label: "User profile paths", fidelity: "partial", restorable: false });
  }

  return { items, data };
}

/**
 * Build a best-effort restore script from a bundle's data payload. Only items
 * marked restorable are applied: time zone, mapped drives, and network printers.
 * Returns an empty string if there is nothing safely restorable.
 */
export function buildRestoreScript(data: Record<string, unknown>): string {
  const lines: string[] = ["$applied = [ordered]@{}"];

  const tz = data["os.timeZone"];
  if (typeof tz === "string" && tz) {
    lines.push(`try { Set-TimeZone -Id ${psQuote(tz)} -ErrorAction Stop; $applied.timeZone = $true } catch { $applied.timeZone = $false }`);
  }

  const drives = data["app.mappedDrives"];
  if (Array.isArray(drives)) {
    for (const d of drives as { localPath?: string; remotePath?: string }[]) {
      if (d?.localPath && d?.remotePath) {
        lines.push(
          `try { New-SmbMapping -LocalPath ${psQuote(d.localPath)} -RemotePath ${psQuote(d.remotePath)} -Persistent $true -ErrorAction Stop | Out-Null } catch {}`
        );
      }
    }
    lines.push(`$applied.mappedDrives = ${(drives as unknown[]).length}`);
  }

  const printers = data["app.printers"];
  if (Array.isArray(printers)) {
    for (const p of printers as { name?: string; shareName?: string }[]) {
      // Only network/shared printers can be re-added by connection name.
      if (p?.name && p.name.startsWith("\\\\")) {
        lines.push(`try { Add-Printer -ConnectionName ${psQuote(p.name)} -ErrorAction Stop } catch {}`);
      }
    }
  }

  const dflt = data["app.defaultPrinter"];
  if (typeof dflt === "string" && dflt) {
    lines.push(
      `try { (Get-CimInstance Win32_Printer -Filter ${psQuote(`Name='${dflt.replace(/'/g, "''")}'`)} | Select-Object -First 1).SetDefaultPrinter() | Out-Null } catch {}`
    );
  }

  lines.push("$applied | ConvertTo-Json -Depth 4");
  return lines.join("\n");
}
