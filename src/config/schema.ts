import { z } from "zod";

/** Coerce common truthy string representations from environment variables. */
const envBool = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.toLowerCase());
  return false;
}, z.boolean());

/**
 * The full, validated application configuration. Loaded from the environment and
 * validated once at startup so misconfiguration fails fast with a clear message.
 */
export const configSchema = z
  .object({
    transport: z.enum(["stdio", "http"]).default("stdio"),
    httpHost: z.string().min(1).default("127.0.0.1"),
    httpPort: z.coerce.number().int().positive().max(65535).default(3000),
    httpToken: z.string().min(1).optional(),
    authMode: z.enum(["bearer", "oauth"]).default("bearer"),
    multiTenant: envBool.default(false),
    saasIntegrations: z.string().optional(),
    saasIntegrationsPath: z.string().optional(),
    oauthIssuer: z.string().min(1).optional(),
    oauthAudience: z.string().min(1).optional(),
    oauthJwksUri: z.string().url().optional(),
    quotaPerMinute: z.coerce.number().int().min(0).default(120),
    quotaPerDay: z.coerce.number().int().min(0).default(0),
    toolAllowlist: z
      .string()
      .optional()
      .transform((v) =>
        v
          ? v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined
      ),
    psExecutable: z.string().min(1).optional(),
    psDefaultTimeoutMs: z.coerce.number().int().positive().default(60_000),
    graphAuthMode: z.enum(["app", "delegated"]).default("app"),
    graphTenantId: z.string().min(1).optional(),
    graphClientId: z.string().min(1).optional(),
    graphClientSecret: z.string().min(1).optional(),
    reportingEnabled: envBool.default(true),
    reportingPollIntervalMs: z.coerce.number().int().min(1000).default(15_000),
    reportingRetentionMinutes: z.coerce.number().int().positive().default(360),
    reportingMaxSamples: z.coerce.number().int().positive().default(50_000),
    remoteTargets: z.string().optional(),
    remoteTargetsPath: z.string().optional(),
    remoteDefaultTimeoutMs: z.coerce.number().int().positive().default(90_000),
    awsRegion: z.string().min(1).optional(),
    awsWorkspacesDirectoryId: z.string().min(1).optional(),
    awsAccessKeyId: z.string().min(1).optional(),
    awsSecretAccessKey: z.string().min(1).optional(),
    awsProfile: z.string().min(1).optional(),
    avdSubscriptionId: z.string().min(1).optional(),
    avdResourceGroup: z.string().min(1).optional(),
    citrixApiBase: z.string().min(1).optional(),
    citrixCustomerId: z.string().min(1).optional(),
    citrixClientId: z.string().min(1).optional(),
    citrixClientSecret: z.string().min(1).optional(),
    citrixNotificationsEnabled: envBool.default(false),
    horizonApiBase: z.string().min(1).optional(),
    horizonDomain: z.string().min(1).optional(),
    horizonUsername: z.string().min(1).optional(),
    horizonPassword: z.string().min(1).optional(),
    horizonInsecureTls: envBool.default(false),
    horizonCloudApiBase: z.string().min(1).optional(),
    horizonCloudCspUrl: z.string().min(1).default("https://connect.omnissa.com"),
    horizonCloudOrgId: z.string().min(1).optional(),
    horizonCloudApiToken: z.string().min(1).optional(),
    horizonCloudClientId: z.string().min(1).optional(),
    horizonCloudClientSecret: z.string().min(1).optional(),
    ws1ApiHost: z.string().min(1).optional(),
    ws1TenantCode: z.string().min(1).optional(),
    ws1TokenUrl: z.string().min(1).optional(),
    ws1ClientId: z.string().min(1).optional(),
    ws1ClientSecret: z.string().min(1).optional(),
    ws1ApiVersion: z.string().min(1).default("1"),
    stateStoreUri: z.string().min(1).default("./state"),
    stateEncryptionKey: z.string().min(1).optional(),
    stateRetentionDays: z.coerce.number().int().positive().default(30),
    migrationRetainSource: envBool.default(true),
    continuityPrimary: z.string().min(1).optional(),
    continuitySecondary: z.string().min(1).optional(),
    failoverMode: z.enum(["manual", "policy"]).default("manual"),
    agentBrokerEnabled: envBool.default(false),
    agentEnrollmentToken: z.string().min(1).optional(),
    agentMaxAutonomy: z.enum(["L0", "L1", "L2", "L3"]).default("L1"),
    agentStaleSeconds: z.coerce.number().int().positive().default(90),
    onboardingPublicUrl: z.string().min(1).optional(),
    auditLogPath: z.string().min(1).default("./logs/audit.log"),
    logLevel: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info")
  })
  .superRefine((cfg, ctx) => {
    if (
      cfg.transport === "http" &&
      cfg.authMode === "bearer" &&
      !cfg.httpToken &&
      !cfg.saasIntegrations &&
      !cfg.saasIntegrationsPath
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["httpToken"],
        message:
          "MCP_HTTP_TOKEN is required for the http transport (unless MCP_AUTH_MODE=oauth or SAAS_INTEGRATIONS is configured)"
      });
    }
    if (cfg.graphAuthMode === "app" && cfg.graphTenantId && cfg.graphClientId && !cfg.graphClientSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["graphClientSecret"],
        message: "GRAPH_CLIENT_SECRET is required when GRAPH_AUTH_MODE=app and Graph is configured"
      });
    }
    if (cfg.authMode === "oauth") {
      if (!cfg.oauthIssuer) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["oauthIssuer"],
          message: "OAUTH_ISSUER is required when MCP_AUTH_MODE=oauth"
        });
      }
      if (!cfg.oauthAudience) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["oauthAudience"],
          message: "OAUTH_AUDIENCE is required when MCP_AUTH_MODE=oauth"
        });
      }
    }
  });

export type AppConfig = z.infer<typeof configSchema>;
