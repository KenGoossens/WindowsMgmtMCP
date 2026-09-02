import { randomUUID } from "node:crypto";
import type { Logger } from "../core/logger.js";
import { AppError } from "../core/errors.js";
import type { ProviderRegistry } from "../providers/provider.js";
import { mapCapture } from "./capture.js";
import {
  FULL_SCOPE,
  summarizeFidelity,
  type StateBundle,
  type StateBundleManifest,
  type StateScope
} from "./bundle.js";
import { isSettingsCapable } from "./settingsCapable.js";
import type { StateStore } from "./store.js";

export class StateError extends AppError {}

/** Reference to an endpoint whose state is being captured/restored. */
export interface EndpointRef {
  providerId: string;
  /** Substrate-specific entity id (remote target id; omitted for the local host). */
  entity?: string;
}

/**
 * Substrate-agnostic state & settings portability facade (technical spec, Ch. 9.1).
 * It composes a settings-capable provider (the *what*-reader) with the encrypted
 * {@link StateStore} (the *where*), producing normalized StateBundles with an
 * honest fidelity manifest. Migration and failover orchestration build on this.
 */
export class StatePortabilityService {
  constructor(
    private readonly store: StateStore,
    private readonly registry: ProviderRegistry,
    private readonly logger: Logger
  ) {}

  private resolveCapable(providerId: string) {
    const provider = this.registry.list().find((p) => p.id === providerId);
    if (!provider) throw new StateError(`Unknown provider: '${providerId}'`);
    if (!isSettingsCapable(provider)) {
      throw new StateError(`Provider '${providerId}' does not support state capture (Windows substrates only).`);
    }
    return provider;
  }

  /** Build a StateBundle from a live capture (without persisting it). */
  async buildBundle(ref: EndpointRef, scope: StateScope, subject?: string): Promise<StateBundle> {
    const provider = this.resolveCapable(ref.providerId);
    const effectiveScope: StateScope = { ...FULL_SCOPE, ...scope };
    const { entity, raw } = await provider.captureSettings(effectiveScope, ref.entity);
    const { items, data } = mapCapture(raw, effectiveScope);
    const manifest: StateBundleManifest = {
      id: randomUUID(),
      subject: subject ?? entity,
      sourceProviderId: ref.providerId,
      sourceEntity: entity,
      scope: effectiveScope,
      createdAt: new Date().toISOString(),
      items,
      fidelity: summarizeFidelity(items),
      version: 1
    };
    return { manifest, data };
  }

  /** Capture and persist a StateBundle; returns its manifest. */
  async capture(ref: EndpointRef, scope: StateScope = {}, subject?: string): Promise<StateBundleManifest> {
    const bundle = await this.buildBundle(ref, scope, subject);
    await this.store.save(bundle);
    this.logger.info(
      { bundleId: bundle.manifest.id, subject: bundle.manifest.subject, fidelity: bundle.manifest.fidelity.overall },
      "state captured"
    );
    return bundle.manifest;
  }

  /** Export a settings subset inline (no persistence) — the read-only path. */
  async exportSettings(ref: EndpointRef, scope: StateScope = {}, subject?: string): Promise<StateBundle> {
    return this.buildBundle(ref, scope, subject);
  }

  /** Restore a stored bundle onto a target endpoint. */
  async restore(ref: EndpointRef, bundleId: string): Promise<{ manifest: StateBundleManifest; outcome: Record<string, unknown> }> {
    const provider = this.resolveCapable(ref.providerId);
    const bundle = await this.store.load(bundleId);
    const outcome = await provider.restoreSettings(bundle.data, ref.entity);
    this.logger.info({ bundleId, providerId: ref.providerId, entity: ref.entity }, "state restored");
    return { manifest: bundle.manifest, outcome };
  }

  /** Import a settings payload directly (no stored bundle) onto a target. */
  async importSettings(ref: EndpointRef, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const provider = this.resolveCapable(ref.providerId);
    return provider.restoreSettings(data, ref.entity);
  }

  /** List stored bundle manifests, optionally filtered by subject. */
  async list(subject?: string): Promise<StateBundleManifest[]> {
    return this.store.list(subject);
  }

  /** Load a single bundle manifest (no payload) by id. */
  async getManifest(bundleId: string): Promise<StateBundleManifest> {
    return (await this.store.load(bundleId)).manifest;
  }
}
