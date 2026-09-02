import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * A remote Windows target. Secrets are referenced by environment-variable NAME
 * (`passwordEnv`) or key file path (`privateKeyPath`) — never inlined — so the
 * target catalog itself contains no plaintext credentials.
 */
export const remoteTargetSchema = z
  .object({
    id: z.string().min(1),
    host: z.string().min(1),
    method: z.enum(["winrm", "ssh"]),
    port: z.coerce.number().int().positive().max(65535).optional(),
    username: z.string().min(1).optional(),
    /** Name of the environment variable holding this target's password. */
    passwordEnv: z.string().min(1).optional(),
    /** Path to an SSH private key (ssh method). */
    privateKeyPath: z.string().min(1).optional(),
    /** Name of the environment variable holding the key passphrase (ssh). */
    passphraseEnv: z.string().min(1).optional(),
    /** Use HTTPS for WinRM (winrm method). */
    useSsl: z.boolean().optional(),
    /** Optional human-friendly label. */
    label: z.string().optional()
  })
  .superRefine((t, ctx) => {
    if (t.method === "ssh" && !t.passwordEnv && !t.privateKeyPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ssh target '${t.id}' needs either passwordEnv or privateKeyPath`
      });
    }
  });

export type RemoteTarget = z.infer<typeof remoteTargetSchema>;

export const remoteTargetsSchema = z.array(remoteTargetSchema);

export interface LoadTargetsInput {
  inlineJson?: string;
  filePath?: string;
}

/**
 * Load and validate the remote-target catalog from inline JSON and/or a JSON
 * file. Duplicate ids are rejected. Returns an empty list when nothing is
 * configured (the provider then reports itself unavailable).
 */
export function loadRemoteTargets(input: LoadTargetsInput): RemoteTarget[] {
  const sources: unknown[] = [];

  if (input.filePath) {
    const text = readFileSync(input.filePath, "utf8");
    sources.push(...parseArray(text, `REMOTE_TARGETS_PATH (${input.filePath})`));
  }
  if (input.inlineJson && input.inlineJson.trim()) {
    sources.push(...parseArray(input.inlineJson, "REMOTE_TARGETS"));
  }

  const parsed = remoteTargetsSchema.safeParse(sources);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid remote targets: ${issues}`);
  }

  const seen = new Set<string>();
  for (const t of parsed.data) {
    if (seen.has(t.id)) throw new Error(`Duplicate remote target id: '${t.id}'`);
    seen.add(t.id);
  }
  return parsed.data;
}

function parseArray(text: string, label: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a JSON array of targets`);
  }
  return value;
}

/** Resolve a target's secret from its referenced environment variable. */
export function resolveSecret(envName: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!envName) return undefined;
  return env[envName];
}
