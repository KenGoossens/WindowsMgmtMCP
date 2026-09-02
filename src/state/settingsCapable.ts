import type { RawCapture } from "./capture.js";
import type { StateScope } from "./bundle.js";

/**
 * Structural capability implemented by substrates that can capture/restore native
 * settings on an endpoint (currently the Windows substrates — local & remote).
 * The {@link StatePortabilityService} discovers it at runtime, keeping providers
 * decoupled from the StateBundle store and encryption.
 */
export interface SettingsCapable {
  /** Read native settings for the requested scope. `entity` selects a remote target. */
  captureSettings(scope: StateScope, entity?: string): Promise<{ entity: string; raw: RawCapture }>;
  /** Re-apply restorable settings from a bundle's data payload. */
  restoreSettings(data: Record<string, unknown>, entity?: string): Promise<Record<string, unknown>>;
}

/** Runtime guard: does this provider expose the settings-capture capability? */
export function isSettingsCapable(provider: unknown): provider is SettingsCapable {
  const p = provider as Partial<SettingsCapable>;
  return typeof p.captureSettings === "function" && typeof p.restoreSettings === "function";
}
