import { config as loadDotenv } from "dotenv";
import { ConfigError } from "../core/errors.js";
import { configSchema, type AppConfig } from "./schema.js";

/**
 * Load and validate configuration from the environment. When the default
 * `process.env` is used, `.env` is loaded first. Throws {@link ConfigError}
 * on the first invalid/missing value so the process fails fast at startup.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    loadDotenv();
  }

  const raw = {
    transport: env.MCP_TRANSPORT,
    httpHost: env.MCP_HTTP_HOST,
    httpPort: env.MCP_HTTP_PORT,
    httpToken: env.MCP_HTTP_TOKEN,
    authMode: env.MCP_AUTH_MODE,
    multiTenant: env.MCP_MULTI_TENANT,
    saasIntegrations: env.SAAS_INTEGRATIONS,
    saasIntegrationsPath: env.SAAS_INTEGRATIONS_PATH,
    oauthIssuer: env.OAUTH_ISSUER,
    oauthAudience: env.OAUTH_AUDIENCE,
    oauthJwksUri: env.OAUTH_JWKS_URI,
    quotaPerMinute: env.SAAS_QUOTA_PER_MINUTE,
    quotaPerDay: env.SAAS_QUOTA_PER_DAY,
    toolAllowlist: env.MCP_TOOL_ALLOWLIST,
    psExecutable: env.PS_EXECUTABLE,
    psDefaultTimeoutMs: env.PS_DEFAULT_TIMEOUT_MS,
    graphAuthMode: env.GRAPH_AUTH_MODE,
    graphTenantId: env.GRAPH_TENANT_ID,
    graphClientId: env.GRAPH_CLIENT_ID,
    graphClientSecret: env.GRAPH_CLIENT_SECRET,
    reportingEnabled: env.REPORTING_ENABLED,
    reportingPollIntervalMs: env.REPORTING_POLL_INTERVAL_MS,
    reportingRetentionMinutes: env.REPORTING_RETENTION_MINUTES,
    reportingMaxSamples: env.REPORTING_MAX_SAMPLES,
    remoteTargets: env.REMOTE_TARGETS,
    remoteTargetsPath: env.REMOTE_TARGETS_PATH,
    remoteDefaultTimeoutMs: env.REMOTE_DEFAULT_TIMEOUT_MS,
    awsRegion: env.AWS_REGION,
    awsWorkspacesDirectoryId: env.AWS_WORKSPACES_DIRECTORY_ID,
    awsAccessKeyId: env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    awsProfile: env.AWS_PROFILE,
    avdSubscriptionId: env.AVD_SUBSCRIPTION_ID,
    avdResourceGroup: env.AVD_RESOURCE_GROUP,
    citrixApiBase: env.CITRIX_API_BASE,
    citrixCustomerId: env.CITRIX_CUSTOMER_ID,
    citrixClientId: env.CITRIX_CLIENT_ID,
    citrixClientSecret: env.CITRIX_CLIENT_SECRET,
    citrixNotificationsEnabled: env.CITRIX_NOTIFICATIONS_ENABLED,
    horizonApiBase: env.HORIZON_API_BASE,
    horizonDomain: env.HORIZON_DOMAIN,
    horizonUsername: env.HORIZON_USERNAME,
    horizonPassword: env.HORIZON_PASSWORD,
    horizonInsecureTls: env.HORIZON_INSECURE_TLS,
    horizonCloudApiBase: env.HORIZON_CLOUD_API_BASE,
    horizonCloudCspUrl: env.HORIZON_CLOUD_CSP_URL,
    horizonCloudOrgId: env.HORIZON_CLOUD_ORG_ID,
    horizonCloudApiToken: env.HORIZON_CLOUD_API_TOKEN,
    horizonCloudClientId: env.HORIZON_CLOUD_CLIENT_ID,
    horizonCloudClientSecret: env.HORIZON_CLOUD_CLIENT_SECRET,
    ws1ApiHost: env.WS1_API_HOST,
    ws1TenantCode: env.WS1_TENANT_CODE,
    ws1TokenUrl: env.WS1_TOKEN_URL,
    ws1ClientId: env.WS1_CLIENT_ID,
    ws1ClientSecret: env.WS1_CLIENT_SECRET,
    ws1ApiVersion: env.WS1_API_VERSION,
    stateStoreUri: env.STATE_STORE_URI,
    stateEncryptionKey: env.STATE_ENCRYPTION_KEY,
    stateRetentionDays: env.STATE_RETENTION_DAYS,
    migrationRetainSource: env.MIGRATION_RETAIN_SOURCE,
    continuityPrimary: env.CONTINUITY_PRIMARY,
    continuitySecondary: env.CONTINUITY_SECONDARY,
    failoverMode: env.FAILOVER_MODE,
    agentBrokerEnabled: env.AGENT_BROKER_ENABLED,
    agentEnrollmentToken: env.AGENT_ENROLLMENT_TOKEN,
    agentMaxAutonomy: env.AGENT_MAX_AUTONOMY,
    agentStaleSeconds: env.AGENT_STALE_SECONDS,
    onboardingPublicUrl: env.ONBOARDING_PUBLIC_URL,
    auditLogPath: env.AUDIT_LOG_PATH,
    logLevel: env.LOG_LEVEL
  };

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
