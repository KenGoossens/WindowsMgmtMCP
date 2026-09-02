import type { AppConfig } from "../config/schema.js";
import type { OnboardingPlan, OnboardingPlanInput } from "./types.js";

/**
 * Pure, side-effect-free onboarding plan builders. Each returns exactly what an
 * admin must do to grant least-privilege access to a substrate, plus the precise
 * permissions involved. Kept pure so they are trivially unit-testable and can be
 * produced before any credentials exist.
 */

function resolvePublicUrl(config: AppConfig, input: OnboardingPlanInput): string | undefined {
  return (input.publicUrl ?? config.onboardingPublicUrl)?.replace(/\/+$/, "");
}

function redirectUri(publicUrl: string | undefined): string | undefined {
  return publicUrl ? `${publicUrl}/onboarding/callback` : undefined;
}

/**
 * Entra admin-consent — the one true "log in → consent → done" flow. The admin
 * opens the consent URL, reviews the permissions, and grants tenant-wide consent;
 * Entra then auto-creates the enterprise application (service principal) with
 * exactly those permissions. We never create anything ourselves.
 */
export function buildEntraConsentPlan(config: AppConfig, input: OnboardingPlanInput): OnboardingPlan {
  const clientId = config.graphClientId;
  const tenant = input.tenant ?? config.graphTenantId ?? "organizations";
  const publicUrl = resolvePublicUrl(config, input);
  const redirect = redirectUri(publicUrl);
  const warnings: string[] = [];

  let actionUrl: string | undefined;
  if (clientId) {
    const params = new URLSearchParams({ client_id: clientId });
    if (redirect) params.set("redirect_uri", redirect);
    actionUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/adminconsent?${params.toString()}`;
  } else {
    warnings.push(
      "No GRAPH_CLIENT_ID configured. Register a multi-tenant Entra application once, then set GRAPH_CLIENT_ID to enable the consent URL."
    );
  }
  if (!redirect) {
    warnings.push("Set ONBOARDING_PUBLIC_URL so the consent flow can redirect back to a verifiable callback.");
  }

  return {
    providerId: "windows365",
    displayName: "Windows 365 (Microsoft Entra)",
    method: "admin-consent",
    summary:
      "Sign in as a tenant admin and grant tenant-wide consent. Entra automatically creates the enterprise application (service principal) with the reviewed permissions — nothing is created by this server.",
    actionUrl,
    permissions: [
      { name: "CloudPC.ReadWrite.All", reason: "List, inspect, reboot, reprovision, restore, resize and troubleshoot Cloud PCs" },
      { name: "Directory.Read.All", reason: "Resolve users and groups when assigning provisioning policies" }
    ],
    steps: [
      "Register a multi-tenant Entra app once (the operator does this; reused for all customer tenants).",
      clientId ? "Open the consent URL below as a Privileged Role Administrator or Cloud Application Administrator." : "Set GRAPH_CLIENT_ID, then re-run onboarding_plan to get the consent URL.",
      "Carefully review the requested permissions, then select Grant admin consent.",
      "Run onboarding_status to verify the server can now read the tenant's Cloud PCs."
    ],
    warnings,
    verifiable: true
  };
}

/**
 * AWS WorkSpaces — guided least-privilege IAM. We can't host a one-click
 * CloudFormation template here, so we emit the exact least-privilege policy and
 * the steps to attach it to a role/user whose credentials the server then uses
 * (standard AWS credential chain). The admin sees precisely what is granted.
 */
export function buildAwsGuidedPlan(config: AppConfig, _input: OnboardingPlanInput): OnboardingPlan {
  const region = config.awsRegion ?? "<your-region>";
  const policy = JSON.stringify(
    {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "WindowsMcpWorkSpacesManage",
          Effect: "Allow",
          Action: [
            "workspaces:DescribeWorkspaces",
            "workspaces:DescribeWorkspacesConnectionStatus",
            "workspaces:DescribeWorkspaceSnapshots",
            "workspaces:DescribeWorkspacesPools",
            "workspaces:DescribeWorkspacesPoolSessions",
            "workspaces:StartWorkspaces",
            "workspaces:StopWorkspaces",
            "workspaces:RebootWorkspaces",
            "workspaces:RebuildWorkspaces",
            "workspaces:RestoreWorkspace",
            "workspaces:MigrateWorkspace",
            "workspaces:ModifyWorkspaceProperties",
            "workspaces:TerminateWorkspaces",
            "workspaces:CreateWorkspaces",
            "workspaces:CreateStandbyWorkspaces",
            "workspaces:StartWorkspacesPool",
            "workspaces:StopWorkspacesPool",
            "workspaces:TerminateWorkspacesPoolSession"
          ],
          Resource: "*"
        }
      ]
    },
    null,
    2
  );

  return {
    providerId: "awsworkspaces",
    displayName: "AWS WorkSpaces",
    method: "guided",
    summary:
      "Create a least-privilege IAM identity (role or user) with the policy below, then provide its credentials (keys, profile, or an assumed role) to the server. No broad or wildcard permissions are requested.",
    permissions: [
      { name: "workspaces:Describe*", reason: "List and inspect WorkSpaces, pools, sessions, and snapshots" },
      { name: "workspaces:Start/Stop/Reboot/RebuildWorkspaces", reason: "Power and recover WorkSpaces" },
      { name: "workspaces:Restore/Migrate/ModifyWorkspaceProperties", reason: "Restore, migrate, and resize WorkSpaces" },
      { name: "workspaces:TerminateWorkspaces", reason: "Decommission WorkSpaces" },
      {
        name: "workspaces:Create/CreateStandbyWorkspaces",
        reason: "Provision a WorkSpace or cross-region standby (failover target)"
      },
      { name: "workspaces:*WorkspacesPool*", reason: "Operate WorkSpaces Pools and their sessions" }
    ],
    artifact: { kind: "iam-policy", label: "Least-privilege IAM policy", content: policy },
    steps: [
      "In the AWS IAM console, create a customer-managed policy from the JSON below.",
      "Attach it to a dedicated IAM role (preferred) or user scoped to WorkSpaces.",
      `Provide credentials to the server (AWS_ACCESS_KEY_ID/SECRET, AWS_PROFILE, or an IAM role) and set AWS_REGION=${region}.`,
      "Run onboarding_status to verify the server can DescribeWorkspaces."
    ],
    warnings: [
      "Use a dedicated identity scoped to WorkSpaces — never reuse an administrator credential.",
      "If you use a cross-account role, add an ExternalId condition to the trust policy to prevent the confused-deputy problem."
    ],
    verifiable: true
  };
}

/**
 * Azure Virtual Desktop — Azure RBAC role assignment (not a Graph consent). The
 * existing Entra app's service principal is granted a desktop-virtualization role
 * at the resource-group scope. We emit the exact `az` command and the role name.
 */
export function buildAzureRbacPlan(config: AppConfig, _input: OnboardingPlanInput): OnboardingPlan {
  const sub = config.avdSubscriptionId ?? "<subscription-id>";
  const rg = config.avdResourceGroup ?? "<resource-group>";
  const clientId = config.graphClientId ?? "<app-client-id>";
  const command = [
    "az role assignment create \\",
    `  --assignee "${clientId}" \\`,
    '  --role "Desktop Virtualization Contributor" \\',
    `  --scope "/subscriptions/${sub}/resourceGroups/${rg}"`
  ].join("\n");

  return {
    providerId: "avd",
    displayName: "Azure Virtual Desktop",
    method: "azure-rbac",
    summary:
      "Assign a built-in Azure RBAC role to the server's service principal at the AVD resource-group scope. This is an Azure Resource Manager role assignment, not a Graph consent.",
    permissions: [
      { name: "Desktop Virtualization Contributor (RBAC role)", reason: "Manage host pools, session hosts, and user sessions" }
    ],
    artifact: { kind: "cli-command", label: "Azure CLI role assignment", content: command },
    steps: [
      "Ensure the Entra app (GRAPH_CLIENT_ID) and its service principal exist in the tenant.",
      "Run the az command below as an Owner/User Access Administrator on the resource group.",
      "Set AVD_SUBSCRIPTION_ID and AVD_RESOURCE_GROUP on the server.",
      "Run onboarding_status to verify the server can list AVD host pools."
    ],
    warnings: [
      "Scope the assignment to the resource group, not the whole subscription, for least privilege.",
      "Desktop Virtualization Contributor cannot manage the underlying session-host VMs; VM power needs a separate compute role."
    ],
    verifiable: true
  };
}

/** Citrix DaaS — create an API "Secure Client" in Citrix Cloud (guided). */
export function buildCitrixGuidedPlan(config: AppConfig, _input: OnboardingPlanInput): OnboardingPlan {
  return {
    providerId: "citrix",
    displayName: "Citrix DaaS",
    method: "guided",
    summary:
      "Create an API Secure Client in Citrix Cloud under Identity and Access Management, scoped to a least-privilege administrator, and provide its client id/secret to the server.",
    permissions: [
      { name: "Read-Only Administrator (+ delivery-group/session scope)", reason: "List delivery groups, catalogs, machines and sessions" },
      { name: "Full/Custom Administrator (session + power scope)", reason: "Session control, machine power, and maintenance mode" }
    ],
    steps: [
      "In Citrix Cloud → Identity and Access Management → API Access, create a Secure Client.",
      "Assign the client a least-privilege custom administrator role (avoid Full Administrator if not needed).",
      "Set CITRIX_CUSTOMER_ID, CITRIX_CLIENT_ID and CITRIX_CLIENT_SECRET on the server.",
      "Run onboarding_status to verify the server can list delivery groups."
    ],
    warnings: [
      "Citrix has no tenant-consent URL; the Secure Client is created manually by a Citrix Cloud admin.",
      `Customer id ${config.citrixCustomerId ? "is configured" : "is not yet configured"} on the server.`
    ],
    verifiable: true
  };
}

/** Omnissa Horizon — create a dedicated service account (manual, on-prem). */
export function buildHorizonManualPlan(_config: AppConfig, _input: OnboardingPlanInput): OnboardingPlan {
  return {
    providerId: "horizon",
    displayName: "Omnissa Horizon",
    method: "manual",
    summary:
      "Create a dedicated Active Directory service account and grant it a least-privilege Horizon administrator role, then provide its credentials to the server. Horizon is on-prem and has no cloud consent flow.",
    permissions: [
      { name: "Horizon Administrators (Read-only) role", reason: "List pools, farms, machines and sessions" },
      { name: "Horizon Inventory Administrator role", reason: "Session control and machine maintenance" }
    ],
    steps: [
      "Create a dedicated AD service account for the server (do not reuse a personal admin).",
      "In the Horizon Console, assign it a least-privilege administrator role at the appropriate access group.",
      "Set HORIZON_API_BASE, HORIZON_DOMAIN, HORIZON_USERNAME and HORIZON_PASSWORD on the server.",
      "Run onboarding_status to verify the server can log in and list desktop pools."
    ],
    warnings: [
      "Use HORIZON_INSECURE_TLS only for lab Connection Servers with self-signed certificates.",
      "Rotate the service-account password on a schedule; it is a standing credential, not a consent grant."
    ],
    verifiable: true
  };
}

/** Omnissa Horizon Cloud (next-gen) — create a CSP API token / OAuth app (guided). */
export function buildHorizonCloudPlan(config: AppConfig, _input: OnboardingPlanInput): OnboardingPlan {
  return {
    providerId: "horizoncloud",
    displayName: "Omnissa Horizon Cloud",
    method: "guided",
    summary:
      "Create a Cloud Services Portal (CSP) API token, or an OAuth app with the Horizon Cloud service role, scoped to a least-privilege administrator, then provide its credentials to the server.",
    permissions: [
      { name: "Horizon Cloud Administrator (read)", reason: "List templates (pools), VMs, images and sessions" },
      { name: "Horizon Cloud Administrator (session/VM action)", reason: "Session logoff/disconnect and VM restart" }
    ],
    steps: [
      "In the CSP (connect.omnissa.com), under your account → API Tokens, generate a new API token with the Horizon Cloud service role; OR create an OAuth app and note its id/secret.",
      "Set HORIZON_CLOUD_API_BASE to your regional Horizon Cloud host (e.g. https://cloud-sg.horizon.omnissa.com) and HORIZON_CLOUD_ORG_ID to your CSP organization id.",
      "Set HORIZON_CLOUD_API_TOKEN (API-token flow) or HORIZON_CLOUD_CLIENT_ID/SECRET (OAuth-app flow) on the server.",
      "Run onboarding_status to verify the server can list Horizon Cloud pools."
    ],
    warnings: [
      "Scope the API token / OAuth app to a least-privilege role — avoid Organization Owner.",
      `Organization id ${config.horizonCloudOrgId ? "is configured" : "is not yet configured"} on the server.`
    ],
    verifiable: true
  };
}

/** Workspace ONE UEM — create an OAuth client + REST API key (guided). */
export function buildWs1GuidedPlan(config: AppConfig, _input: OnboardingPlanInput): OnboardingPlan {
  return {
    providerId: "ws1uem",
    displayName: "Workspace ONE UEM",
    method: "guided",
    summary:
      "Create an OAuth client (client-credentials) in the Workspace ONE UEM console and capture the tenant REST API key, scoped to a least-privilege admin role, then provide them to the server.",
    permissions: [
      { name: "REST API – Devices (read)", reason: "List and inspect enrolled devices and compliance" },
      { name: "REST API – Devices (commands)", reason: "Lock, clear passcode, query, and enterprise-wipe devices" }
    ],
    steps: [
      "In the UEM console → Groups & Settings → Configurations → OAuth Client Management, add a client (client-credentials) and note its id/secret.",
      "Under Groups & Settings → All Settings → System → Advanced → API → REST API, copy the API key (aw-tenant-code) and the API server host (asXXXX).",
      "From the Datacenter & Token URLs reference, copy the region-specific OAuth token URL.",
      "Set WS1_API_HOST, WS1_TENANT_CODE, WS1_TOKEN_URL, WS1_CLIENT_ID and WS1_CLIENT_SECRET on the server.",
      "Run onboarding_status to verify the server can search devices."
    ],
    warnings: [
      "Assign the OAuth client a dedicated, least-privilege REST API admin role — device wipe is destructive.",
      `Tenant code ${config.ws1TenantCode ? "is configured" : "is not yet configured"} on the server.`
    ],
    verifiable: true
  };
}

