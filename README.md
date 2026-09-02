# Windows MCP Server

A production-grade **Model Context Protocol (MCP)** server that exposes Windows and
Windows 365 Cloud PC **management, diagnostics, and maintenance** to MCP-compatible AI
clients (VS Code, Claude Desktop, custom agents) and to SaaS backends over Streamable HTTP.

This repository implements the MVP defined in [`docs/technical-spec.md`](docs/technical-spec.md):

- **Local / host Windows management** — arbitrary PowerShell, WMI/CIM queries, service &
  process control, event logs, disk/network diagnostics, Windows Update, curated troubleshooters.
- **Windows 365 Cloud PC fleet management** — list, inspect, reboot, reprovision, restore,
  resize, rename, troubleshoot and end-grace-period via Microsoft Graph.
- **Extensible provider architecture** so future substrates (Remote Windows, Citrix, Horizon,
  AVD, AWS WorkSpaces) plug in without core changes.
- **Defensible security model** — bearer auth, loopback binding, Host-header validation,
  encoded-command execution, hard timeouts with process-tree kill, a **risk-aware execution
  gate**, destructive-op confirmation, and full audit logging.

## Requirements

- **Node.js >= 18.18**
- **Windows** with **PowerShell 7 (`pwsh`)** or **Windows PowerShell 5.1** for the local provider
- A Microsoft Entra app registration (for the Windows 365 provider)

## Setup

```powershell
npm install
cp .env.example .env   # then edit .env
npm run build
```

## Run

```powershell
# stdio (default) — for a local AI client
npm start

# Streamable HTTP — for remote / multi-client / SaaS use
npm run start:http
# or
node dist/index.js --transport http
```

HTTP exposes `GET /health` (unauthenticated liveness) and the MCP endpoint `POST/GET/DELETE /mcp`
(bearer-token protected, `127.0.0.1` by default, with DNS-rebinding protection).

## Mission-control web console

An optional browser console — a conversational/operator UI over the same MCP server — lives in
[`web/`](web) with a backend-for-frontend (BFF) in [`src/webui/`](src/webui). The BFF is itself an
MCP client: it connects to a running server over Streamable HTTP, then serves a small REST + SSE API
(and the built web app) to the browser. It shows a **unified live fleet** across every substrate,
a **tool operator** with schema-driven forms, and a **risk-gated approval card** (mutating tools are
previewed by the server's risk gate before anything executes).

```powershell
# 1. Start the MCP server in HTTP mode with a token (reporting is on by default)
$env:MCP_HTTP_TOKEN = "dev-token"; npm run start:http

# 2. Build the web app and start the BFF (serves it on http://127.0.0.1:4100)
cd web; npm install; npm run build; cd ..
$env:WEBUI_MCP_TOKEN = "dev-token"; npm run start:webui

# (dev mode) hot-reload UI with Vite, proxying the BFF:
cd web; npm run dev   # http://127.0.0.1:5173
```

| Variable | Purpose | Default |
|---|---|---|
| `WEBUI_PORT` / `WEBUI_HOST` | BFF bind | `4100` / `127.0.0.1` |
| `WEBUI_MCP_URL` | MCP server endpoint | `http://127.0.0.1:3000/mcp` |
| `WEBUI_MCP_TOKEN` | Bearer token presented to the MCP server | — |

The BFF binds loopback and is intended for a single local operator; expose it behind your own auth
before putting it on a network.

## Configuration

All configuration is environment-driven and validated at startup (fail-fast). See
[`.env.example`](.env.example) for the full list. Key variables:

| Variable | Purpose | Default |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` \| `http` | `stdio` |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | HTTP bind | `127.0.0.1` / `3000` |
| `MCP_HTTP_TOKEN` | Bearer token (required for http) | — |
| `MCP_TOOL_ALLOWLIST` | Comma-separated tool allow-list | all |
| `PS_EXECUTABLE` | `pwsh` \| `powershell.exe` | auto-detect |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | Entra app identity | — |

## Use with VS Code

A sample client wiring is provided in [`.vscode/mcp.json`](.vscode/mcp.json).

## Testing

```powershell
npm test          # unit tests (vitest)
npm run lint      # eslint
npm run inspect   # MCP Inspector over stdio
```

## Security

This server can execute **arbitrary PowerShell**, which makes it a high-value target. The HTTP
transport **requires a bearer token**, binds to loopback by default, validates the `Host` header,
and routes every state-changing operation through a risk gate plus an explicit `confirm` flag.
Never expose it to an untrusted network without auth. See Chapter 13 of the technical spec.

## License

MIT
