import { EventEmitter } from "node:events";
import type { Logger } from "../core/logger.js";
import type { MetricSample, MetricScope } from "../providers/provider.js";
import { TelemetryStore } from "./store.js";
import { AlertEngine, type ActiveAlert } from "./alerts.js";

/** A provider (or agent) that can emit normalized telemetry. */
export interface MetricSource {
  id: string;
  displayName: string;
  getMetrics(scope?: MetricScope): Promise<MetricSample[]>;
}

/** A destination that receives newly-fired alerts (e.g. an admin console). */
export interface AlertSink {
  id: string;
  onAlerts(alerts: ActiveAlert[]): Promise<void>;
}

export interface CollectResult {
  samples: MetricSample[];
  firedAlerts: ActiveAlert[];
  ts: string;
  errors: { providerId: string; error: string }[];
}

export interface SnapshotResult {
  ts: string;
  providers: {
    providerId: string;
    displayName: string;
    available: boolean;
    sampleCount: number;
    error?: string;
  }[];
  samples: MetricSample[];
  activeAlerts: ActiveAlert[];
}

export interface ReportingOptions {
  pollIntervalMs: number;
  retentionMinutes: number;
  maxSamples: number;
}

/**
 * The reporting subsystem: a shared, server-wide singleton that owns the
 * telemetry {@link TelemetryStore} and {@link AlertEngine}, periodically pulls
 * normalized metrics from registered sources, evaluates alerts, and emits an
 * `update` event consumers (the resource layer) use to push live notifications.
 */
export class ReportingService {
  readonly store: TelemetryStore;
  readonly alerts: AlertEngine;

  private readonly emitter = new EventEmitter();
  private sources: MetricSource[] = [];
  private sinks: AlertSink[] = [];
  private timer?: NodeJS.Timeout;
  private collecting = false;

  constructor(
    private readonly options: ReportingOptions,
    private readonly logger: Logger
  ) {
    this.store = new TelemetryStore(options.maxSamples, options.retentionMinutes * 60_000);
    this.alerts = new AlertEngine();
    this.emitter.setMaxListeners(0);
  }

  setSources(sources: MetricSource[]): void {
    this.sources = sources;
  }

  /** Register an outbound sink that receives newly-fired alerts (best-effort). */
  addAlertSink(sink: AlertSink): void {
    this.sinks.push(sink);
  }

  /** Begin periodic collection. No-op if already running or no sources. */
  start(): void {
    if (this.timer) return;
    this.logger.info(
      { intervalMs: this.options.pollIntervalMs, sources: this.sources.map((s) => s.id) },
      "reporting collector started"
    );
    this.timer = setInterval(() => {
      void this.collectOnce();
    }, this.options.pollIntervalMs);
    // Kick off an immediate first collection without blocking startup.
    void this.collectOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.emitter.removeAllListeners();
  }

  /** Subscribe to collection updates. Returns an unsubscribe function. */
  onUpdate(cb: (result: CollectResult) => void): () => void {
    this.emitter.on("update", cb);
    return () => this.emitter.off("update", cb);
  }

  /** Pull from every source once, store, evaluate alerts, and emit an update. */
  async collectOnce(): Promise<CollectResult> {
    if (this.collecting) {
      return { samples: [], firedAlerts: [], ts: new Date().toISOString(), errors: [] };
    }
    this.collecting = true;
    const ts = new Date().toISOString();
    const samples: MetricSample[] = [];
    const errors: { providerId: string; error: string }[] = [];

    try {
      const results = await Promise.allSettled(this.sources.map((s) => s.getMetrics()));
      results.forEach((res, i) => {
        const src = this.sources[i];
        if (res.status === "fulfilled") {
          samples.push(...res.value);
        } else {
          const error = res.reason instanceof Error ? res.reason.message : String(res.reason);
          errors.push({ providerId: src.id, error });
          this.logger.warn({ provider: src.id, error }, "telemetry collection failed");
        }
      });

      this.store.append(samples);
      const firedAlerts = this.alerts.evaluate(this.store.latest());
      if (firedAlerts.length > 0 && this.sinks.length > 0) {
        void this.dispatchAlerts(firedAlerts);
      }
      const result: CollectResult = { samples, firedAlerts, ts, errors };
      this.emitter.emit("update", result);
      return result;
    } finally {
      this.collecting = false;
    }
  }

  /** Fan newly-fired alerts out to every registered sink without blocking collection. */
  private async dispatchAlerts(alerts: ActiveAlert[]): Promise<void> {
    await Promise.allSettled(
      this.sinks.map(async (sink) => {
        try {
          await sink.onAlerts(alerts);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.logger.warn({ sink: sink.id, error }, "alert sink delivery failed");
        }
      })
    );
  }

  /** Live point-in-time snapshot: pull every source now (independent of cadence). */
  async snapshot(scope?: MetricScope): Promise<SnapshotResult> {
    const ts = new Date().toISOString();
    const providers: SnapshotResult["providers"] = [];
    const samples: MetricSample[] = [];

    const results = await Promise.allSettled(this.sources.map((s) => s.getMetrics(scope)));
    results.forEach((res, i) => {
      const src = this.sources[i];
      if (res.status === "fulfilled") {
        samples.push(...res.value);
        providers.push({
          providerId: src.id,
          displayName: src.displayName,
          available: true,
          sampleCount: res.value.length
        });
      } else {
        providers.push({
          providerId: src.id,
          displayName: src.displayName,
          available: false,
          sampleCount: 0,
          error: res.reason instanceof Error ? res.reason.message : String(res.reason)
        });
      }
    });

    // Feed the snapshot into history too, so on-demand snapshots enrich trends.
    this.store.append(samples);

    return { ts, providers, samples, activeAlerts: this.alerts.listActive() };
  }
}
