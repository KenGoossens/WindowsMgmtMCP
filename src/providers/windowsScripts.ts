import { psQuote } from "../core/powershell.js";

/**
 * Reusable PowerShell scripts shared by the Local and Remote Windows providers,
 * so an operation (system info, host metrics, service control, event log) is
 * defined once and behaves identically whether it runs on the host or on a
 * remote target via WinRM/SSH. Every interpolated value is single-quote escaped.
 */

/** OS / hardware / uptime summary, emitted as JSON. */
export const SYSTEM_INFO_SCRIPT = `
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$boot = $os.LastBootUpTime
[pscustomobject]@{
  hostname          = $env:COMPUTERNAME
  os                = $os.Caption
  version           = $os.Version
  build             = $os.BuildNumber
  architecture      = $os.OSArchitecture
  manufacturer      = $cs.Manufacturer
  model             = $cs.Model
  cpu               = $cpu.Name
  logicalProcessors = $cs.NumberOfLogicalProcessors
  totalMemoryGB     = [math]::Round($cs.TotalPhysicalMemory / 1GB, 2)
  freeMemoryGB      = [math]::Round($os.FreePhysicalMemory * 1KB / 1GB, 2)
  lastBootTime      = $boot.ToString('o')
  uptime            = ((Get-Date) - $boot).ToString()
  currentUser       = "$env:USERDOMAIN\\$env:USERNAME"
} | ConvertTo-Json -Depth 4`;

/** Live CPU / memory / disk utilisation (percentages), emitted as JSON. */
export const HOST_METRICS_SCRIPT = `
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$memUsedPct = if ($os.TotalVisibleMemorySize) { [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 1) } else { 0 }
$sys = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
$diskUsedPct = if ($sys -and $sys.Size) { [math]::Round((($sys.Size - $sys.FreeSpace) / $sys.Size) * 100, 1) } else { 0 }
[pscustomobject]@{ cpu = [double]($cpu); memory = [double]$memUsedPct; disk = [double]$diskUsedPct } | ConvertTo-Json`;

/** Start / stop / restart a service by name and return its resulting state. */
export function buildServiceControlScript(name: string, action: "start" | "stop" | "restart"): string {
  const cmd = { start: "Start-Service", stop: "Stop-Service", restart: "Restart-Service" }[action];
  const quoted = psQuote(name);
  return `$ErrorActionPreference='Stop'; ${cmd} -Name ${quoted}; Get-Service -Name ${quoted} | Select-Object Name, Status, StartType | ConvertTo-Json -Depth 3`;
}

const EVENT_LEVELS = { Critical: 1, Error: 2, Warning: 3, Information: 4, Verbose: 5 } as const;
export type EventLevel = keyof typeof EVENT_LEVELS;

export interface EventLogQueryInput {
  logName: string;
  level?: EventLevel;
  since?: string;
  max?: number;
}

/** Query a Windows event log with optional level, start time and result cap. */
export function buildEventLogScript(input: EventLogQueryInput): string {
  const parts = [`LogName = ${psQuote(input.logName)}`];
  if (input.level) parts.push(`Level = ${EVENT_LEVELS[input.level]}`);
  if (input.since) parts.push(`StartTime = [datetime]${psQuote(input.since)}`);
  const max = input.max ?? 50;
  return `Get-WinEvent -FilterHashtable @{ ${parts.join("; ")} } -MaxEvents ${max} -ErrorAction SilentlyContinue | Select-Object TimeCreated, Id, @{n='level';e={$_.LevelDisplayName}}, ProviderName, @{n='message';e={$_.Message}} | ConvertTo-Json -Depth 4`;
}

export interface HostMetrics {
  cpu: number;
  memory: number;
  disk: number;
}
