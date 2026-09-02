import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerTool,
  jsonResult,
  type ToolContext,
  type ToolSpec
} from "../../core/tools.js";
import { PowerShellEngine, psQuote } from "../../core/powershell.js";
import {
  SYSTEM_INFO_SCRIPT,
  buildServiceControlScript,
  buildEventLogScript
} from "../windowsScripts.js";
import { buildCimQueryScript } from "./wmi.js";

/**
 * Register the Local Windows provider's tools. Each tool builds a PowerShell
 * script (interpolating only escaped values), runs it through the engine, and
 * returns the structured result.
 */
export function registerLocalTools(server: McpServer, ctx: ToolContext, ps: PowerShellEngine): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── powershell_run ─────────────────────────────────────────────────────────
  reg({
    name: "powershell_run",
    title: "Run PowerShell",
    description:
      "Execute an arbitrary PowerShell script on the host. The risk gate statically analyses the script: read-only scripts run directly, while state-changing or irreversible scripts require \"confirm\": true.",
    mutating: true,
    inputSchema: {
      script: z.string().min(1).describe("The PowerShell script to execute."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe("Hard timeout in milliseconds (process-tree killed on expiry)."),
      workingDir: z.string().optional().describe("Working directory for the invocation.")
    },
    handler: async (args) => {
      const res = await ps.run(args.script, {
        timeoutMs: args.timeoutMs,
        workingDir: args.workingDir
      });
      return jsonResult({
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        durationMs: res.durationMs,
        stdout: res.stdout,
        stderr: res.stderr
      });
    }
  });

  // ── wmi_query ───────────────────────────────────────────────────────────────
  reg({
    name: "wmi_query",
    title: "Query WMI / CIM",
    description: "Query WMI/CIM via Get-CimInstance, by class name (with optional WQL filter) or a full WQL query.",
    inputSchema: {
      className: z.string().optional().describe("CIM class name, e.g. Win32_OperatingSystem."),
      wql: z.string().optional().describe("A full WQL query (alternative to className)."),
      namespace: z.string().optional().describe("CIM namespace, e.g. root/cimv2."),
      filter: z.string().optional().describe("WQL filter clause used with className."),
      depth: z.number().int().min(1).max(10).optional().describe("ConvertTo-Json depth (default 4).")
    },
    handler: async (args) => {
      const script = buildCimQueryScript(args);
      const data = await ps.runJson(script);
      return jsonResult(data);
    }
  });

  // ── system_info ─────────────────────────────────────────────────────────────
  reg({
    name: "system_info",
    title: "System information",
    description: "Return an OS/hardware summary: OS version, CPU, memory, uptime, and current user.",
    inputSchema: {},
    handler: async () => {
      return jsonResult(await ps.runJson(SYSTEM_INFO_SCRIPT));
    }
  });

  // ── service_list ────────────────────────────────────────────────────────────
  reg({
    name: "service_list",
    title: "List services",
    description: "Enumerate Windows services, optionally filtered by name/display name and run state.",
    inputSchema: {
      filter: z.string().optional().describe("Substring matched against service name or display name."),
      status: z.enum(["Running", "Stopped"]).optional().describe("Filter by run state.")
    },
    handler: async (args) => {
      const conds: string[] = [];
      if (args.status) conds.push(`$_.State -eq ${psQuote(args.status)}`);
      if (args.filter) {
        const like = psQuote(`*${args.filter}*`);
        conds.push(`($_.Name -like ${like} -or $_.DisplayName -like ${like})`);
      }
      const where = conds.length ? `| Where-Object { ${conds.join(" -and ")} } ` : "";
      const script = `Get-CimInstance Win32_Service ${where}| Select-Object Name, DisplayName, State, StartMode, ProcessId | Sort-Object Name | ConvertTo-Json -Depth 3`;
      return jsonResult(await ps.runJson(script));
    }
  });

  // ── service_control ─────────────────────────────────────────────────────────
  reg({
    name: "service_control",
    title: "Control a service",
    description: "Start, stop, or restart a Windows service.",
    mutating: true,
    inputSchema: {
      name: z.string().min(1).describe("Service name (not display name)."),
      action: z.enum(["start", "stop", "restart"]).describe("The control action to perform.")
    },
    handler: async (args) => {
      const script = buildServiceControlScript(args.name, args.action);
      return jsonResult(await ps.runJson(script, { timeoutMs: 120_000 }));
    }
  });

  // ── process_list ────────────────────────────────────────────────────────────
  reg({
    name: "process_list",
    title: "List processes",
    description: "List running processes sorted by CPU time, optionally filtered by name.",
    inputSchema: {
      filter: z.string().optional().describe("Substring matched against the process name."),
      top: z.number().int().min(1).max(500).optional().describe("Maximum processes to return (default 25).")
    },
    handler: async (args) => {
      const top = args.top ?? 25;
      const where = args.filter
        ? `| Where-Object { $_.ProcessName -like ${psQuote(`*${args.filter}*`)} } `
        : "";
      const script = `Get-Process ${where}| Sort-Object CPU -Descending | Select-Object -First ${top} Id, ProcessName, @{n='cpuSeconds';e={[math]::Round($_.CPU,2)}}, @{n='memMB';e={[math]::Round($_.WorkingSet64/1MB,2)}} | ConvertTo-Json -Depth 3`;
      return jsonResult(await ps.runJson(script));
    }
  });

  // ── process_kill ────────────────────────────────────────────────────────────
  reg({
    name: "process_kill",
    title: "Kill a process",
    description: "Terminate a process by PID or by name.",
    mutating: true,
    destructive: true,
    inputSchema: {
      pidOrName: z.string().min(1).describe("A numeric PID or a process name.")
    },
    handler: async (args) => {
      const value = args.pidOrName.trim();
      const target = /^\d+$/.test(value) ? `-Id ${Number.parseInt(value, 10)}` : `-Name ${psQuote(value)}`;
      const script = `$ErrorActionPreference='Stop'; Stop-Process ${target} -Force; @{ target=${psQuote(value)}; success=$true } | ConvertTo-Json`;
      return jsonResult(await ps.runJson(script));
    }
  });

  // ── eventlog_query ──────────────────────────────────────────────────────────
  reg({
    name: "eventlog_query",
    title: "Query event log",
    description: "Query a Windows event log with optional level, start time, and result cap.",
    inputSchema: {
      logName: z.string().min(1).describe("Log name, e.g. System, Application, Security."),
      level: z.enum(["Critical", "Error", "Warning", "Information", "Verbose"]).optional(),
      since: z.string().optional().describe("ISO start time, e.g. 2026-01-01T00:00:00."),
      max: z.number().int().min(1).max(1000).optional().describe("Maximum events (default 50).")
    },
    handler: async (args) => {
      const script = buildEventLogScript({
        logName: args.logName,
        level: args.level,
        since: args.since,
        max: args.max
      });
      return jsonResult(await ps.runJson(script));
    }
  });

  // ── disk_info ───────────────────────────────────────────────────────────────
  reg({
    name: "disk_info",
    title: "Disk information",
    description: "Report volumes (size, free space, health) and physical disks (media type, SMART health).",
    inputSchema: {},
    handler: async () => {
      const script = `
$vols = Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter } | ForEach-Object {
  [pscustomobject]@{
    drive        = [string]$_.DriveLetter
    label        = $_.FileSystemLabel
    fileSystem   = $_.FileSystem
    sizeGB       = [math]::Round($_.Size/1GB, 2)
    freeGB       = [math]::Round($_.SizeRemaining/1GB, 2)
    healthStatus = [string]$_.HealthStatus
  }
}
$disks = Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    number            = $_.DeviceId
    friendlyName      = $_.FriendlyName
    mediaType         = [string]$_.MediaType
    healthStatus      = [string]$_.HealthStatus
    operationalStatus = [string]$_.OperationalStatus
    sizeGB            = [math]::Round($_.Size/1GB, 2)
  }
}
[pscustomobject]@{ volumes = @($vols); physicalDisks = @($disks) } | ConvertTo-Json -Depth 5`;
      return jsonResult(await ps.runJson(script));
    }
  });

  // ── network_info ────────────────────────────────────────────────────────────
  reg({
    name: "network_info",
    title: "Network information",
    description: "Report active adapters and IP addresses, with an optional connectivity test to a target.",
    inputSchema: {
      target: z.string().optional().describe("Optional host/IP to ping-test for reachability.")
    },
    handler: async (args) => {
      const targetAssign = args.target ? `$target = ${psQuote(args.target)}` : "$target = $null";
      const script = `
${targetAssign}
$adapters = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  [pscustomobject]@{ name=$_.Name; description=$_.InterfaceDescription; mac=$_.MacAddress; linkSpeed=[string]$_.LinkSpeed }
}
$ips = Get-NetIPAddress -ErrorAction SilentlyContinue | Where-Object { $_.AddressState -eq 'Preferred' } | ForEach-Object {
  [pscustomobject]@{ interface=$_.InterfaceAlias; family=[string]$_.AddressFamily; ip=$_.IPAddress; prefixLength=$_.PrefixLength }
}
$conn = $null
if ($target) {
  $reachable = Test-Connection $target -Count 2 -Quiet -ErrorAction SilentlyContinue
  $conn = [pscustomobject]@{ target=$target; reachable=[bool]$reachable }
}
[pscustomobject]@{ adapters=@($adapters); addresses=@($ips); connectivity=$conn } | ConvertTo-Json -Depth 5`;
      return jsonResult(await ps.runJson(script, { timeoutMs: 60_000 }));
    }
  });

  // ── windows_update ──────────────────────────────────────────────────────────
  reg({
    name: "windows_update",
    title: "Windows Update",
    description:
      "Scan/list pending Windows updates, or install them. Installing requires \"confirm\": true and may take several minutes and reboot.",
    inputSchema: {
      action: z.enum(["scan", "list", "install"]).default("scan").describe("scan/list pending updates, or install."),
      confirm: z.boolean().optional().describe("Required (true) for action=install.")
    },
    handler: async (args) => {
      if (args.action === "install") {
        if (args.confirm !== true) {
          return jsonResult({
            status: "confirmation_required",
            tool: "windows_update",
            message: 'Installing updates is a state-changing operation. Re-invoke with "confirm": true.'
          });
        }
        const installScript = `
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("IsInstalled=0 and IsHidden=0")
if ($result.Updates.Count -eq 0) { @{ installed = 0; message = 'No applicable updates' } | ConvertTo-Json; return }
$coll = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $result.Updates) { try { $u.AcceptEula() } catch {}; [void]$coll.Add($u) }
$downloader = $session.CreateUpdateDownloader(); $downloader.Updates = $coll; [void]$downloader.Download()
$installer = $session.CreateUpdateInstaller(); $installer.Updates = $coll
$res = $installer.Install()
@{ resultCode = $res.ResultCode; rebootRequired = [bool]$res.RebootRequired; count = $coll.Count } | ConvertTo-Json`;
        return jsonResult(await ps.runJson(installScript, { timeoutMs: 600_000 }));
      }

      const scanScript = `
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("IsInstalled=0 and IsHidden=0")
@($result.Updates | ForEach-Object {
  [pscustomobject]@{ title=$_.Title; severity=[string]$_.MsrcSeverity; kb=(($_.KBArticleIDs) -join ','); rebootRequired=[bool]$_.RebootRequired }
}) | ConvertTo-Json -Depth 4`;
      return jsonResult(await ps.runJson(scanScript, { timeoutMs: 180_000 }));
    }
  });

  // ── diagnostics_run ─────────────────────────────────────────────────────────
  reg({
    name: "diagnostics_run",
    title: "Run diagnostics",
    description:
      "Run curated, read-only troubleshooters: 'sfc' (verify-only), 'dism' (ScanHealth), 'connectivity', or 'all'.",
    inputSchema: {
      check: z.enum(["sfc", "dism", "connectivity", "all"]).default("connectivity")
    },
    handler: async (args) => {
      const scripts: Record<string, string> = {
        sfc: "sfc /verifyonly",
        dism: "DISM /Online /Cleanup-Image /ScanHealth",
        connectivity:
          "Write-Output '--- ping 8.8.8.8 ---'; Test-Connection 8.8.8.8 -Count 2 -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-String; Write-Output '--- DNS ---'; Resolve-DnsName microsoft.com -ErrorAction SilentlyContinue | Select-Object Name, Type, IPAddress | Format-Table -AutoSize | Out-String"
      };
      const order = args.check === "all" ? ["sfc", "dism", "connectivity"] : [args.check];
      const sections: string[] = [];
      for (const c of order) {
        const res = await ps.run(scripts[c], { timeoutMs: 600_000 });
        sections.push(`===== ${c} =====\n${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`);
      }
      return { content: [{ type: "text", text: sections.join("\n\n") }] };
    }
  });
}
