import { apiClient, type CloudNoteScope, type CloudThesis, type ThesisPatch, type ThesisSignal } from "../../../../api-client";
import type { AppNotificationDelivery, AppNotificationRequest, PluginPersistence } from "../../../../types/plugin";
import { computeHealth } from "./model";

interface ThesisStoreSnapshot {
  /** Every thesis the account can see: personal plus each team's. */
  theses: CloudThesis[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Set when the last refresh failed and the list shown is the on-device copy. */
  offline: boolean;
}

type Listener = (snapshot: ThesisStoreSnapshot) => void;
type Notifier = (request: AppNotificationRequest) => AppNotificationDelivery | void;

const CACHE_STATE_KEY = "thesis-cache";
const EMPTY: ThesisStoreSnapshot = { theses: [], loaded: false, loading: false, error: null, offline: false };

interface ThesisEventFrame {
  id?: string;
  actorId?: string | null;
  health?: string;
  title?: string;
  openSignals?: number;
  signalIds?: string[];
  /** A review (manual or scheduled) just finished; `open` is what it filed for a ruling. */
  review?: boolean;
  open?: number;
}

type ThesisStoreClient = Pick<
  typeof apiClient,
  | "isVerified"
  | "getCurrentUser"
  | "subscribeCurrentUser"
  | "subscribeCloudEvent"
  | "listTheses"
  | "getThesis"
  | "createThesis"
  | "updateThesis"
  | "deleteThesis"
  | "resolveThesisSignal"
  | "createThesisSignal"
  | "reviewThesis"
  | "draftThesis"
>;

/**
 * The theses the account can see, kept fresh from realtime frames and
 * readable offline from the last copy. Writes go through here so every pane
 * showing a thesis sees the saved version at once.
 */
class ThesisStore {
  constructor(private readonly client: ThesisStoreClient = apiClient) {}

  private snapshot: ThesisStoreSnapshot = EMPTY;
  private readonly listeners = new Set<Listener>();
  private persistence: PluginPersistence | null = null;
  private notifier: Notifier | null = null;
  private openThesis: ((thesisId: string) => void) | null = null;
  private disposers: Array<() => void> = [];
  private refreshPromise: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private readonly signalListeners = new Set<(thesisId: string) => void>();

  getSnapshot(): ThesisStoreSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fires when a thesis's signals changed, so an open detail refetches them. */
  onSignals(listener: (thesisId: string) => void): () => void {
    this.signalListeners.add(listener);
    return () => {
      this.signalListeners.delete(listener);
    };
  }

  attach(persistence: PluginPersistence): void {
    this.persistence = persistence;
    const cached = persistence.getState<CloudThesis[]>(CACHE_STATE_KEY);
    if (Array.isArray(cached) && cached.length > 0) {
      this.update({ theses: cached });
    }
  }

  setNotifier(notifier: Notifier | null, openThesis: ((thesisId: string) => void) | null): void {
    this.notifier = notifier;
    this.openThesis = openThesis;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const syncAuth = () => {
      if (this.client.isVerified()) {
        void this.refresh();
      } else if (this.snapshot.loaded || this.snapshot.theses.length > 0) {
        this.update({ ...EMPTY });
        this.persistence?.setState(CACHE_STATE_KEY, []);
      }
    };
    this.disposers.push(this.client.subscribeCurrentUser(syncAuth));
    this.disposers.push(this.client.subscribeCloudEvent("thesis.updated", (data) => this.receive("updated", data)));
    this.disposers.push(this.client.subscribeCloudEvent("thesis.deleted", (data) => this.receive("deleted", data)));
    this.disposers.push(this.client.subscribeCloudEvent("thesis.signals", (data) => this.receive("signals", data)));
    syncAuth();
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.started = false;
    this.refreshPromise = null;
  }

  get(id: string | null | undefined): CloudThesis | null {
    if (!id) return null;
    return this.snapshot.theses.find((thesis) => thesis.id === id) ?? null;
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.update({ loading: true, error: null });
    this.refreshPromise = (async () => {
      try {
        const theses = await this.client.listTheses({ scope: "all" });
        this.update({ theses, loaded: true, loading: false, error: null, offline: false });
        this.persistence?.setState(CACHE_STATE_KEY, theses);
      } catch (error) {
        this.update({
          loading: false,
          loaded: true,
          error: error instanceof Error ? error.message : "Could not load theses.",
          offline: this.snapshot.theses.length > 0,
        });
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  async create(input: Parameters<ThesisStoreClient["createThesis"]>[0]): Promise<CloudThesis> {
    const thesis = await this.client.createThesis(input);
    this.upsert(thesis);
    return thesis;
  }

  async save(id: string, patch: ThesisPatch, expectedRevision?: number): Promise<CloudThesis> {
    const thesis = await this.client.updateThesis(id, patch, expectedRevision);
    this.upsert(thesis);
    return thesis;
  }

  async remove(id: string): Promise<void> {
    await this.client.deleteThesis(id);
    this.update({ theses: this.snapshot.theses.filter((thesis) => thesis.id !== id) });
    this.persistence?.setState(CACHE_STATE_KEY, this.snapshot.theses);
  }

  async loadDetail(id: string): Promise<{ thesis: CloudThesis; signals: ThesisSignal[] } | null> {
    const detail = await this.client.getThesis(id);
    if (!detail) return null;
    const { signals, ...thesis } = detail;
    this.upsert(thesis);
    return { thesis, signals };
  }

  async resolveSignal(
    thesisId: string,
    signalId: string,
    input: { status: "accepted" | "dismissed" | "snoozed"; note?: string | null; snoozeDays?: number },
  ): Promise<{ signal: ThesisSignal; thesis: CloudThesis }> {
    const result = await this.client.resolveThesisSignal(thesisId, signalId, input);
    this.upsert(result.thesis);
    return result;
  }

  async challenge(
    thesisId: string,
    input: Parameters<ThesisStoreClient["createThesisSignal"]>[1],
  ): Promise<ThesisSignal> {
    const signal = await this.client.createThesisSignal(thesisId, input);
    const current = this.get(thesisId);
    if (current && signal.status === "open") this.upsert({ ...current, openSignals: current.openSignals + 1 });
    return signal;
  }

  draft(input: Parameters<ThesisStoreClient["draftThesis"]>[0]) {
    return this.client.draftThesis(input);
  }

  review(thesisId: string) {
    return this.client.reviewThesis(thesisId);
  }

  /** Applies a thesis the server just returned, keeping health consistent. */
  upsert(thesis: CloudThesis): void {
    const next = { ...thesis, health: computeHealth(thesis.document) };
    const others = this.snapshot.theses.filter((entry) => entry.id !== thesis.id);
    this.update({ theses: [...others, next] });
    this.persistence?.setState(CACHE_STATE_KEY, this.snapshot.theses);
  }

  scopeFor(thesis: CloudThesis): CloudNoteScope {
    return thesis.owner.kind === "team" ? { scope: "team", teamId: thesis.owner.id } : { scope: "user" };
  }

  private receive(kind: "updated" | "deleted" | "signals", data: unknown): void {
    const frame = (data ?? {}) as ThesisEventFrame;
    if (kind === "deleted" && typeof frame.id === "string") {
      this.update({ theses: this.snapshot.theses.filter((thesis) => thesis.id !== frame.id) });
    }
    this.scheduleRefresh();
    if (kind === "signals" && typeof frame.id === "string") {
      for (const listener of this.signalListeners) listener(frame.id);
      this.notifySignals(frame);
    }
  }

  /** Frames arrive in bursts; one refetch shortly after the last is enough. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 400);
  }

  private update(patch: Partial<ThesisStoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private notifySignals(frame: ThesisEventFrame): void {
    if (!this.notifier) return;
    const self = this.client.getCurrentUser()?.id ?? null;
    const title = frame.title ?? this.get(frame.id)?.title ?? "Thesis";
    const id = frame.id;
    const action = id && this.openThesis ? { action: { label: "Open", onClick: () => this.openThesis?.(id) } } : {};
    if (frame.review) {
      // A review ran in the background; say how it went, whoever asked for it.
      const open = frame.open ?? 0;
      this.notifier({
        title: `Thesis: ${title}`,
        body: open === 0 ? "Reviewed: nothing challenges the thesis." : `Reviewed: ${open} ${open === 1 ? "signal" : "signals"} to rule on.`,
        type: open === 0 ? "success" : "info",
        desktop: "when-inactive",
        ...action,
      });
      return;
    }
    // Your own challenge shows in the pane; only other people's and the
    // server's scans deserve a card.
    if (frame.actorId && frame.actorId === self) return;
    const count = frame.signalIds?.length ?? 0;
    if (count === 0) return;
    this.notifier({
      title: `Thesis: ${title}`,
      body: count === 1 ? "1 new signal to rule on." : `${count} new signals to rule on.`,
      type: "info",
      desktop: "when-inactive",
      ...action,
    });
  }
}

export const thesisStore = new ThesisStore();
