import type { Dispatch } from "react";
import type { AppAction, AppState } from "../core/state/app/state";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import { stableStringify } from "../utils/hash";
import { VERSION } from "../version";
import {
  SYNC_SNAPSHOT_SCHEMA_VERSION,
  SyncRevisionConflictError,
  type RegisteredSyncContributor,
  type RegisteredSyncTransport,
  type SyncBaselineStore,
  type SyncContributor,
  type SyncSnapshot,
  type SyncTransport,
} from "./types";
import type { LocalMarketDataLookup } from "./local-only";

type CloudSyncPhase = "idle" | "disabled" | "syncing" | "synced" | "error";

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
  /** Sources whose quotes and bars never leave this device (`BrokerAdapter.localMarketData`); none when absent. */
  isLocalMarketData?: LocalMarketDataLookup;
}

const CLIENT_ID_STORAGE_KEY = "gloomberb.sync.clientId";
const PUSH_DEBOUNCE_MS = 2500;
/** How soon after a change contributors date it, so an edit made just before quitting still is. */
const OBSERVE_DEBOUNCE_MS = 250;
/** Pushes refused because another device wrote first, each followed by a fresh pull, before giving up until the next sync. */
const MAX_CONFLICT_RETRIES = 3;

/** What one pull left behind: the stored revision it merged with (0 for none) and that copy's content. */
interface PullResult {
  revision: number | null;
  signature: string | null;
}

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

/**
 * The content of a snapshot as it reads once stored, so one assembled here
 * (with fields left undefined) compares equal to the same one pulled back.
 */
function snapshotContentSignature(snapshot: SyncSnapshot): string {
  return stableStringify(JSON.parse(JSON.stringify(Object.fromEntries(
    Object.entries(snapshot.contributors).map(([id, contributor]) => [
      id,
      { schemaVersion: contributor.schemaVersion, payload: contributor.payload },
    ]),
  ))));
}

export class CloudSyncController {
  private runtime: SyncRuntime | null = null;
  private contributors = new Map<string, RegisteredSyncContributor>();
  private transports = new Map<string, RegisteredSyncTransport>();
  private listeners = new Set<() => void>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private observeTimer: ReturnType<typeof setTimeout> | null = null;
  private observedSinceStart = false;
  private memos: Record<string, unknown> | null = null;
  private memosLoaded = false;
  private inFlight: Promise<void> | null = null;
  private syncQueued = false;
  private generation = 0;
  private clientId: string | null = null;
  private lastSignature: string | null = null;
  /**
   * The content signature of the cloud's copy, with the revision and the
   * write it belongs to. Each 15 s poll pulls the same copy again until a
   * device writes; working its signature out every time was a third of an
   * idle sync on a large workspace.
   */
  private cloudSignature: { transportId: string; revision: number; clientId: string; createdAt: string; signature: string } | null = null;
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

  /** Account revisions, merge baselines and edit provenance never carry into another account. */
  resetAccount(): void {
    this.resetOperations();
    this.baseline = {};
    this.baselineLoaded = true;
    this.memos = {};
    this.memosLoaded = true;
    this.runtime?.baselineStore?.save({});
    this.runtime?.baselineStore?.saveMemos?.({});
    this.setStatus({ phase: "idle", transportId: null, lastSyncAt: null, lastPullAt: null, revision: null, error: null });
    this.updateAvailability();
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
    this.scheduleObserve(runtime);
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
    const generation = this.generation;
    this.observe(runtime);
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

    for (let attempt = 0; ; attempt += 1) {
      // Always pull before push. Another device (TUI, browser, phone) may have
      // written since this process last synced, and contributors already merge
      // so local-only edits survive the apply.
      const pulled = await this.runPull(runtime, transport, generation);
      if (!pulled || !this.isCurrent(runtime, transport, generation)) return;

      const snapshot = await this.assembleSnapshot(runtime, generation);
      if (!snapshot || !this.isCurrent(runtime, transport, generation)) return;
      const signature = snapshotContentSignature(snapshot);
      if (!options.force && signature === this.lastSignature) return;
      if (!options.force && signature === pulled.signature) {
        // The cloud already holds exactly this: pushing it back would only
        // bump the revision under another device's next push.
        this.lastSignature = signature;
        this.saveBaseline(runtime, snapshot);
        return;
      }

      this.setStatus({ phase: "syncing", transportId: transport.id, error: null });
      try {
        // The revision this snapshot was merged with. The cloud refuses the
        // write if another device wrote since, instead of losing that write.
        const result = await transport.pushSnapshot(snapshot, { baseRevision: pulled.revision });
        if (!this.isCurrent(runtime, transport, generation)) return;
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
        return;
      } catch (error) {
        if (!this.isCurrent(runtime, transport, generation)) return;
        if (error instanceof SyncRevisionConflictError && attempt < MAX_CONFLICT_RETRIES) {
          // Pull whatever the other device wrote, even an older revision than
          // this process last saw, such as a restored snapshot.
          this.appliedRevision = null;
          continue;
        }
        this.setStatus({
          phase: "error",
          transportId: transport.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }

  private async runPull(runtime: SyncRuntime, transport: SyncTransport, generation: number): Promise<PullResult | null> {
    const baselineState = runtime.getState();
    this.setStatus({ phase: "syncing", transportId: transport.id, error: null });
    try {
      const response = await transport.pullSnapshot();
      if (!this.isCurrent(runtime, transport, generation)) return null;

      if (response.snapshot && this.shouldApplyPulledRevision(response.revision)) {
        this.assertSnapshotCompatible(response.snapshot, runtime.getContributors());
        this.pulledContributors = response.snapshot.contributors;
        for (const entry of runtime.getContributors()) {
          if (!this.isCurrent(runtime, transport, generation)) return null;
          const contributorPayload = response.snapshot.contributors[entry.contributor.id];
          if (!contributorPayload || !entry.contributor.apply) continue;
          await entry.contributor.apply(contributorPayload.payload, {
            snapshot: response.snapshot,
            baselineState,
            baselinePayload: this.loadBaseline(runtime)?.[entry.contributor.id] ?? null,
            state: runtime.getState(),
            getState: runtime.getState,
            isCurrent: () => this.isCurrent(runtime, transport, generation),
            dispatch: runtime.dispatch,
            tickerRepository: runtime.tickerRepository,
            memo: this.memoFor(runtime, entry.contributor.id),
          });
          if (!this.isCurrent(runtime, transport, generation)) return null;
        }
        if (response.revision != null) this.appliedRevision = response.revision;
      }

      if (!this.isCurrent(runtime, transport, generation)) return null;
      this.setStatus({
        phase: response.snapshot ? "synced" : "idle",
        transportId: transport.id,
        revision: this.newerRevision(response.revision),
        lastPullAt: response.updatedAt ?? nowIso(),
        lastSyncAt: response.updatedAt ?? this.status.lastSyncAt,
        error: null,
      });
      return {
        revision: response.snapshot ? response.revision : 0,
        signature: response.snapshot ? this.pulledSignature(transport, response.revision, response.snapshot) : null,
      };
    } catch (error) {
      if (!this.isCurrent(runtime, transport, generation)) return null;
      this.setStatus({
        phase: "error",
        transportId: transport.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
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

  private async assembleSnapshot(runtime: SyncRuntime, generation: number): Promise<SyncSnapshot | null> {
    const contributors = runtime.getContributors();
    const createdAt = nowIso();
    // The snapshot replaces the stored one wholesale, so data owned by a
    // contributor this client does not run (disabled plugin, older build) is
    // carried over instead of being deleted for every other device.
    const payloads: SyncSnapshot["contributors"] = { ...this.pulledContributors };
    for (const entry of contributors) {
      if (this.runtime !== runtime || this.generation !== generation) return null;
      const payload = await entry.contributor.collect({
        state: runtime.getState(),
        baselinePayload: this.loadBaseline(runtime)?.[entry.contributor.id] ?? null,
        memo: this.memoFor(runtime, entry.contributor.id),
        isLocalMarketData: runtime.isLocalMarketData,
      });
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
      appVersion: VERSION,
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

  private scheduleObserve(runtime: SyncRuntime): void {
    if (this.observeTimer) clearTimeout(this.observeTimer);
    this.observeTimer = setTimeout(() => {
      this.observeTimer = null;
      if (this.runtime === runtime) this.observe(runtime);
    }, OBSERVE_DEBOUNCE_MS);
  }

  /** Lets contributors date local edits as they happen, whether or not the cloud is reachable. */
  private observe(runtime: SyncRuntime): void {
    const launch = !this.observedSinceStart;
    this.observedSinceStart = true;
    for (const entry of runtime.getContributors()) {
      if (!entry.contributor.observe) continue;
      try {
        entry.contributor.observe({
          state: runtime.getState(),
          baselinePayload: this.loadBaseline(runtime)?.[entry.contributor.id] ?? null,
          memo: this.memoFor(runtime, entry.contributor.id),
          launch,
        });
      } catch {
        // A contributor that cannot date an edit leaves it undated, which only
        // makes it lose a conflict it might have won.
      }
    }
  }

  private memoFor(runtime: SyncRuntime, contributorId: string) {
    const generation = this.generation;
    return {
      get: () => this.loadMemos(runtime)[contributorId] ?? null,
      set: (value: unknown) => {
        if (this.runtime !== runtime || this.generation !== generation) return;
        const memos = { ...this.loadMemos(runtime), [contributorId]: value };
        this.memos = memos;
        runtime.baselineStore?.saveMemos?.(memos);
      },
    };
  }

  private loadMemos(runtime: SyncRuntime): Record<string, unknown> {
    if (!this.memosLoaded) {
      this.memosLoaded = true;
      this.memos = runtime.baselineStore?.loadMemos?.() ?? null;
    }
    return this.memos ?? {};
  }

  private saveBaseline(runtime: SyncRuntime, snapshot: SyncSnapshot): void {
    const payloads = Object.fromEntries(
      Object.entries(snapshot.contributors).map(([id, contributor]) => [id, contributor.payload]),
    );
    this.baseline = payloads;
    this.baselineLoaded = true;
    runtime.baselineStore?.save(payloads);
  }

  private isCurrent(runtime: SyncRuntime, transport: SyncTransport, generation: number): boolean {
    return this.generation === generation && this.runtime === runtime && runtime.getTransport()?.transport === transport;
  }

  private pulledSignature(transport: SyncTransport, revision: number | null, snapshot: SyncSnapshot): string {
    const kept = this.cloudSignature;
    if (revision != null && kept && kept.transportId === transport.id && kept.revision === revision
      && kept.clientId === snapshot.clientId && kept.createdAt === snapshot.createdAt) {
      return kept.signature;
    }
    const signature = snapshotContentSignature(snapshot);
    this.cloudSignature = revision == null
      ? null
      : { transportId: transport.id, revision, clientId: snapshot.clientId, createdAt: snapshot.createdAt, signature };
    return signature;
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
    this.generation += 1;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    if (this.observeTimer) clearTimeout(this.observeTimer);
    this.observeTimer = null;
    this.observedSinceStart = false;
    this.memos = null;
    this.memosLoaded = false;
    this.inFlight = null;
    this.syncQueued = false;
    this.lastSignature = null;
    this.cloudSignature = null;
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
