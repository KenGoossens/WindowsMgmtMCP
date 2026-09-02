import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, jsonResult, errorResult, type ToolContext, type ToolSpec } from "../core/tools.js";
import type { OnboardingService } from "./service.js";

/**
 * Register the tenant-onboarding tools (P-SaaS access provisioning). All three
 * are read-only: producing a plan or checking status has no side effects on the
 * managed substrate. The actual grant is performed by the admin in the provider's
 * own consent/IAM surface — this server never holds keys-to-the-kingdom scopes.
 */
export function registerOnboardingTools(server: McpServer, ctx: ToolContext, svc: OnboardingService): void {
  const reg = <S extends z.ZodRawShape>(spec: ToolSpec<S>): void => registerTool(server, ctx, spec);

  // ── onboarding_list ──────────────────────────────────────────────────────────
  reg({
    name: "onboarding_list",
    title: "List onboardable providers",
    description: "List which providers support guided onboarding and the access-grant method each uses.",
    inputSchema: {},
    handler: () => jsonResult({ providers: svc.list() })
  });

  // ── onboarding_plan ──────────────────────────────────────────────────────────
  reg({
    name: "onboarding_plan",
    title: "Plan provider onboarding",
    description:
      "Produce the steps for an admin to grant this server least-privilege access to a provider — including the exact permissions requested and, where available, a one-click admin-consent URL. Read-only; nothing is created.",
    inputSchema: {
      providerId: z.string().min(1).describe("Provider to onboard, e.g. windows365, awsworkspaces, avd, citrix, horizon."),
      tenant: z.string().optional().describe("The admin's tenant id / domain (e.g. the Entra tenant), when known."),
      publicUrl: z.string().optional().describe("Override the server's public base URL used for the consent redirect.")
    },
    handler: (args) => {
      try {
        const plan = svc.plan(args.providerId, { tenant: args.tenant, publicUrl: args.publicUrl });
        return jsonResult(plan);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  });

  // ── onboarding_status ────────────────────────────────────────────────────────
  reg({
    name: "onboarding_status",
    title: "Verify provider onboarding",
    description:
      "Verify whether a provider has been onboarded by performing a single live read with the configured credentials. Reports configured/onboarded and the reason.",
    inputSchema: {
      providerId: z.string().min(1).describe("Provider to verify, e.g. windows365.")
    },
    handler: async (args) => {
      try {
        return jsonResult(await svc.status(args.providerId));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  });
}
