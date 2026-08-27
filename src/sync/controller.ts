import type { Dispatch } from "react";
import type { AppAction, AppState } from "../core/state/app/state";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import { stableStringify } from "../remote/revision";
import {
  SYNC_SNAPSHOT_SCHEMA_VERSION,
  type RegisteredSyncContributor,
  type RegisteredSyncTransport,
  type SyncBaselineStore,
  type SyncContributor,
  type SyncSnapshot,
  type SyncTransport,
} from "./types";

export type CloudSyncPhase = "idle" | "disabled" | "syncing" | "synced" | "error";

export interface CloudSyncStatus {
  phase: CloudSyncPhase;
  transportId: string | null;
  lastSyncAt: string | null;
  lastPullAt: string | null;
  revision: number | null;
  error: string | null;
}

interface SyncRuntime {
  getState: () => AppState;
  dispatch: Dispatch<AppAction>;
  tickerRepository: AppTickerRepositoryPort;
  getContributors: () => RegisteredSyncContributor[];
  getTransport: () => RegisteredSyncTransport | null;
  baselineStore?: SyncBaselineStore;
}

const CLIENT_ID_STORAGE_KEY = "gloomberb.sync.clientId";
const PUSH_DEBOUNCE_MS = 2500;

function nowIso(): string {
  return new Date().toISOString();
}

function resolveClientId(): string {
  const storage = globalThis.localStorage;
  const existing = storage?.getItem(CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;
  const id = `client_${crypto.randomUUID()}`;
  storage?.setItem(CLIENT_ID_STORAGE_KEY, id);
  return id;
}

function snapshotContentSignature(snapshot: SyncSnapshot): string {
  return stableStringify(Object.fromEntries(
    Object.entries(snapshot.contributors).map(([id, contributor]) => [
      id,
      { schemaVersion: contributor.schemaVersion, payload: contributor.payload },
    ]),
  ));
}

export class CloudSyncController {
  private runtime: SyncRuntime | null = null;
  private contributors = new Map<string, RegisteredSyncContributor>();
  private transports = new Map<string, RegisteredSyncTransport>();
  private listeners = new Set<() => void>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private syncQueued = false;
  private clientId: string | null = null;
  private lastSignature: string | null = null;
  private baseline: Record<string, unknown> | null = null;
  private baselineLoaded = false;
  private pulledContributors: SyncSnapshot["contributors"] = {};
  private appliedRevision: number | null = null;
  private status: CloudSyncStatus = {
    phase: "idle",
    transportId: null,
    lastSyncAt: null,
    lastPullAt: null,
    revision: null,
    error: null,
  };

  registerContributor(pluginId: string, contributor: SyncContributor): () => void {
    this.contributors.set(contributor.id, { pluginId, contributor });
    this.emit();
    return () => {
      const current = this.contributors.get(contributor.id);
      if (current?.contributor === contributor) {
        this.contributors.delete(contributor.id);
        this.emit();
      }
    };
  }

  registerTransport(pluginId: string, transport: SyncTransport): () => void {
    this.transports.set(transport.id, { pluginId, transport });
    this.emit();
    return () => {
      const current = this.transports.get(transport.id);
      if (current?.transport === transport) {
        this.transports.delete(transport.id);
        this.emit();
      }
    };
  }

  getRegisteredContributors(): RegisteredSyncContributor[] {
    return [...this.contributors.values()];
  }

  getRegisteredTransports(): RegisteredSyncTransport[] {
    return [...this.transports.values()];
  }

  setRuntime(runtime: SyncRuntime): () => void {
    if (this.runtime !== runtime) {
      this.resetOperations();
      this.runtime = runtime;
      this.updateAvailability();
    }
    return () => this.clearRuntime(runtime);
  }

  clearRuntime(runtime?: SyncRuntime): void {
    if (runtime && this.runtime !== runtime) return;
    this.runtime = null;
    this.resetOperations();
    this.setStatus({ phase: "disabled", transportId: null, error: null });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): CloudSyncStatus {
    return this.status;
  }

  schedulePush(reason: string): void {
    const runtime = this.runtime;
    if (!runtime) return;
    const registration = runtime.getTransport();
    if (!registration?.transport.isAvailable()) {
      this.setStatus({
        phase: "disabled",
        transportId: registration?.transport.id ?? null,
        error: null,
      });
      return;
    }
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.requestSync({ reason });
    }, PUSH_DEBOUNCE_MS);
  }

  async requestSync(options: { reason?: string; force?: boolean } = {}): Promise<void> {
    if (this.inFlight) {
      this.syncQueued = true;
      return this.inFlight;
    }
    const run = this.syncOnce(options).finally(async () => {
      if (this.inFlight !== run) return;
      this.inFlight = null;
      if (!this.syncQueued) return;
      this.syncQueued = false;
      await this.requestSync({ reason: "queued-state-change" });
    });
    this.inFlight = run;
    return run;
  }

  private async syncOnce(options: { reason?: string; force?: boolean }): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const registration = runtime.getTransport();
    if (!registration?.transport.isAvailable()) {
      this.setStatus({
        phase: "disabled",
        transportId: registration?.transport.id ?? null,
        error: null,
      });
      return;
    }
    const transport = registration.transport;

    // Always pull before push. Another device (TUI, browser, phone) may have
    // written since this process last synced, and contributors already merge
    // so local-only edits survive the apply.
    if (!await this.runPull(runtime, transport)) return;
    if (!this.isCurrent(runtime, transport)) return;

    const snapshot = await this.assembleSnapshot(runtime);
    if (!this.isCurrent(runtime, transport)) return;
    const signature = snapshotContentSignature(snapshot);
    if (!options.force && signature === this.lastSignature) return;

    this.setStatus({ phase: "syncing", transportId: transport.id, error: null });
    try {
      const result = await transport.pushSnapshot(snapshot, { baseRevision: this.status.revision });
      if (!this.isCurrent(runtime, transport)) return;
      this.lastSignature = signature;
      this.appliedRevision = result.revision;
      this.saveBaseline(runtime, snapshot);
      this.setStatus({
        phase: "synced",
        transportId: transport.id,
        revision: result.revision,
        lastSyncAt: result.updatedAt,
        error: null,
      });
    } catch (error) {
      if (!this.isCurrent(runtime, transport)) return;
      this.setStatus({
        phase: "error",
        transportId: transport.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runPull(runtime: SyncRuntime, transport: SyncTransport): Promise<boolean> {
    const baselineState = runtime.getState();
    this.setStatus({ phase: "syncing", transportId: transport.id, error: null });
    try {
      const response = await transport.pullSnapshot();
      if (!this.isCurrent(runtime, transport)) return false;

      if (response.snapshot && this.shouldApplyPulledRevision(response.revision)) {
        this.assertSnapshotCompatible(response.snapshot, runtime.getContributors());
        this.pulledContributors = response.snapshot.contributors;
        for (const entry of runtime.getContributors()) {
          if (!this.isCurrent(runtime, transport)) return false;
          const contributorPayload = response.snapshot.contributors[entry.contributor.id];
          if (!contributorPayload || !entry.contributor.apply) continue;
          await entry.contributor.apply(contributorPayload.payload, {
            snapshot: response.snapshot,
            baselineState,
            baselinePayload: this.loadBaseline(runtime)?.[entry.contributor.id] ?? null,
            state: runtime.getState(),
            getState: runtime.getState,
            isCurrent: () => this.isCurrent(runtime, transport),
            dispatch: runtime.dispatch,
            tickerRepository: runtime.tickerRepository,
          });
        }
        if (response.revision != null) this.appliedRevision = response.revision;
      }

      if (!this.isCurrent(runtime, transport)) return false;
      this.setStatus({
        phase: response.snapshot ? "synced" : "idle",
        transportId: transport.id,
        revision: this.newerRevision(response.revision),
        lastPullAt: response.updatedAt ?? nowIso(),
        lastSyncAt: response.updatedAt ?? this.status.lastSyncAt,
        error: null,
      });
      return true;
    } catch (error) {
      if (!this.isCurrent(runtime, transport)) return false;
      this.setStatus({
        phase: "error",
        transportId: transport.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private assertSnapshotCompatible(
    snapshot: SyncSnapshot,
    contributors: RegisteredSyncContributor[],
  ): void {
    if (snapshot.appId !== "gloomberb") {
      throw new Error(`Unsupported sync snapshot app: ${String(snapshot.appId)}`);
    }
    if (snapshot.schemaVersion !== SYNC_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported sync snapshot schema version ${String(snapshot.schemaVersion)}; expected ${SYNC_SNAPSHOT_SCHEMA_VERSION}`,
      );
    }
    for (const entry of contributors) {
      const payload = snapshot.contributors[entry.contributor.id];
      if (!payload || !entry.contributor.apply) continue;
      if (payload.schemaVersion !== entry.contributor.schemaVersion) {
        throw new Error(
          `Unsupported sync contributor schema for ${entry.contributor.id}: ${payload.schemaVersion}; expected ${entry.contributor.schemaVersion}`,
        );
      }
    }
  }

  private async assembleSnapshot(runtime: SyncRuntime): Promise<SyncSnapshot> {
    const contributors = runtime.getContributors();
    const createdAt = nowIso();
    // The snapshot replaces the stored one wholesale, so data owned by a
    // contributor this client does not run (disabled plugin, older build) is
    // carried over instead of being deleted for every other device.
    const payloads: SyncSnapshot["contributors"] = { ...this.pulledContributors };
    for (const entry of contributors) {
      const payload = await entry.contributor.collect({ state: runtime.getState() });
      payloads[entry.contributor.id] = {
        schemaVersion: entry.contributor.schemaVersion,
        updatedAt: createdAt,
        payload,
      };
    }
    return {
      schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
      appId: "gloomberb",
      clientId: this.clientId ??= resolveClientId(),
      createdAt,
      contributors: payloads,
    };
  }

  private loadBaseline(runtime: SyncRuntime): Record<string, unknown> | null {
    if (!this.baselineLoaded) {
      this.baselineLoaded = true;
      this.baseline = runtime.baselineStore?.load() ?? null;
    }
    return this.baseline;
  }

  private saveBaseline(runtime: SyncRuntime, snapshot: SyncSnapshot): void {
    const payloads = Object.fromEntries(
      Object.entries(snapshot.contributors).map(([id, contributor]) => [id, contributor.payload]),
    );
    this.baseline = payloads;
    this.baselineLoaded = true;
    runtime.baselineStore?.save(payloads);
  }

  private isCurrent(runtime: SyncRuntime, transport: SyncTransport): boolean {
    return this.runtime === runtime && runtime.getTransport()?.transport === transport;
  }

  private shouldApplyPulledRevision(revision: number | null): boolean {
    return revision == null || this.appliedRevision == null || revision > this.appliedRevision;
  }

  private newerRevision(revision: number | null): number | null {
    if (revision == null) return this.status.revision;
    if (this.status.revision == null || revision > this.status.revision) return revision;
    return this.status.revision;
  }

  private resetOperations(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.inFlight = null;
    this.syncQueued = false;
    this.lastSignature = null;
    this.appliedRevision = null;
    this.baseline = null;
    this.baselineLoaded = false;
    this.pulledContributors = {};
  }

  private updateAvailability(): void {
    const transport = this.runtime?.getTransport() ?? null;
    if (!transport) {
      this.setStatus({ phase: "disabled", transportId: null, error: null });
      return;
    }
    if (!transport.transport.isAvailable()) {
      this.setStatus({ phase: "disabled", transportId: transport.transport.id, error: null });
      return;
    }
    if (
      this.status.transportId === transport.transport.id &&
      this.status.phase !== "disabled" &&
      this.status.phase !== "idle"
    ) {
      return;
    }
    this.setStatus({
      phase: "idle",
      transportId: transport.transport.id,
      error: null,
    });
  }

  private setStatus(patch: Partial<CloudSyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const cloudSyncController = new CloudSyncController();
