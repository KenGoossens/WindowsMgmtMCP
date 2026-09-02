import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../core/errors.js";
import type { StateBundle, StateBundleManifest } from "./bundle.js";

export class StateStoreError extends AppError {}

const MAGIC = "WMCPSB1"; // Windows-MCP State Bundle, format 1
const SALT_LEN = 16;
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256

/**
 * Encrypted-at-rest StateBundle store (technical spec, Ch. 13 — StateBundles may
 * contain PII and must be encrypted in transit and at rest, minimized, and
 * retention-bound). The MVP store persists each bundle as a single file under the
 * configured directory; an external store can replace it behind the same shape.
 *
 * File layout (binary): MAGIC | salt(16) | iv(12) | authTag(16) | ciphertext.
 * The key is derived per-bundle from the configured secret + a random salt via
 * scrypt, so two bundles never share key material.
 */
export class StateStore {
  constructor(
    private readonly dir: string,
    private readonly secret: string,
    private readonly retentionDays: number
  ) {}

  private bundlePath(id: string): string {
    // Ids are server-generated UUIDs; still guard against path traversal.
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
    if (safe !== id) throw new StateStoreError(`Invalid bundle id: ${id}`);
    return path.join(this.dir, `${safe}.sb`);
  }

  private encrypt(plaintext: Buffer): Buffer {
    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const key = scryptSync(this.secret, salt, KEY_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from(MAGIC, "utf8"), salt, iv, tag, ciphertext]);
  }

  private decrypt(blob: Buffer): Buffer {
    const magic = Buffer.from(MAGIC, "utf8");
    const header = blob.subarray(0, magic.length);
    if (header.length !== magic.length || !timingSafeEqual(header, magic)) {
      throw new StateStoreError("Unrecognized or corrupt StateBundle file");
    }
    let offset = magic.length;
    const salt = blob.subarray(offset, (offset += SALT_LEN));
    const iv = blob.subarray(offset, (offset += IV_LEN));
    const tag = blob.subarray(offset, (offset += TAG_LEN));
    const ciphertext = blob.subarray(offset);
    const key = scryptSync(this.secret, salt, KEY_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new StateStoreError("Failed to decrypt StateBundle (wrong key or tampered file)");
    }
  }

  /** Persist a bundle (encrypted) and return its id. */
  async save(bundle: StateBundle): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true });
    const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
    const blob = this.encrypt(plaintext);
    await fs.writeFile(this.bundlePath(bundle.manifest.id), blob);
    return bundle.manifest.id;
  }

  /** Load and decrypt a bundle by id. */
  async load(id: string): Promise<StateBundle> {
    let blob: Buffer;
    try {
      blob = await fs.readFile(this.bundlePath(id));
    } catch {
      throw new StateStoreError(`StateBundle not found: ${id}`);
    }
    return JSON.parse(this.decrypt(blob).toString("utf8")) as StateBundle;
  }

  /** List manifests of all stored bundles, optionally filtered by subject. */
  async list(subject?: string): Promise<StateBundleManifest[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const manifests: StateBundleManifest[] = [];
    for (const file of files) {
      if (!file.endsWith(".sb")) continue;
      try {
        const bundle = await this.load(file.slice(0, -3));
        if (!subject || bundle.manifest.subject === subject) manifests.push(bundle.manifest);
      } catch {
        // Skip unreadable/foreign files rather than failing the whole list.
      }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Delete a bundle by id. */
  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.bundlePath(id));
    } catch {
      // already gone
    }
  }

  /** Purge bundles older than the retention window. Returns ids purged. */
  async purgeExpired(now: number = Date.now()): Promise<string[]> {
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    const manifests = await this.list();
    const purged: string[] = [];
    for (const m of manifests) {
      if (Date.parse(m.createdAt) < cutoff) {
        await this.delete(m.id);
        purged.push(m.id);
      }
    }
    return purged;
  }
}
