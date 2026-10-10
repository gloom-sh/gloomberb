/**
 * Features for the layers on the map. Each layer asks for what the view
 * covers, waits for the view to settle before asking again, drops an answer a
 * newer request replaced, refreshes on its own cadence while the pane can be
 * seen, and asks nothing below its minimum zoom or while it is unavailable.
 */
import { ApiRequestError } from "../../../api-client/errors";
import {
  getGeoFeatures,
  GEO_FEATURE_LIMIT,
  type GeoCluster,
  type GeoFeature,
  type GeoLayerInfo,
  type GeoRequest,
} from "../../../api-client/geo";
import { geoViewKey, MAX_RENDERED_CLUSTERS, MAX_RENDERED_FEATURES, type GeoView } from "./layers";

type GeoLayerPhase = "loading" | "ready" | "error" | "zoom" | "unavailable" | "locked";

export interface GeoLayerState {
  layer: GeoLayerInfo;
  phase: GeoLayerPhase;
  /** Asking for a new view (or the first one); a timed refresh stays quiet. */
  loading: boolean;
  features: GeoFeature[];
  clusters: GeoCluster[];
  truncated: boolean;
  asOf: string | null;
  fetchedAt: number | null;
  error: string | null;
  /** The server's words for a layer that cannot serve right now. */
  note: string | null;
}

interface Timers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

interface FeedEntry {
  state: GeoLayerState;
  /** View the drawn features (or the request in flight) belong to. */
  key: string | null;
  controller: AbortController | null;
  debounce: unknown;
  refresh: unknown;
  /** After a 429, nothing is asked before this time. */
  blockedUntil: number;
}

export interface GeoFeedOptions {
  debounceMs?: number;
  timers?: Partial<Timers>;
  /** Whether this viewer may read a layer; a Pro layer without Pro is drawn as locked. */
  canAccess?: (layer: GeoLayerInfo) => boolean;
}

const DEFAULT_TIMERS: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

function isAbort(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : (error as { name?: string } | null)?.name === "AbortError";
}

export class GeoLayerFeed {
  private readonly entries = new Map<string, FeedEntry>();
  private readonly timers: Timers;
  private readonly debounceMs: number;
  private readonly canAccess: (layer: GeoLayerInfo) => boolean;
  private view: GeoView | null = null;
  private active = true;
  private snapshotCache: GeoLayerState[] | null = null;

  constructor(
    private readonly request: GeoRequest,
    private readonly onChange: () => void,
    options: GeoFeedOptions = {},
  ) {
    this.timers = { ...DEFAULT_TIMERS, ...options.timers };
    this.debounceMs = options.debounceMs ?? 250;
    this.canAccess = options.canAccess ?? (() => true);
  }

  /** The layers on, in drawing order. */
  snapshot(): GeoLayerState[] {
    this.snapshotCache ??= [...this.entries.values()].map((entry) => entry.state);
    return this.snapshotCache;
  }

  update(layers: readonly GeoLayerInfo[], view: GeoView, active: boolean): void {
    const viewChanged = !this.view || geoViewKey(this.view) !== geoViewKey(view);
    const resumed = active && !this.active;
    this.view = view;
    this.active = active;
    const ids = new Set(layers.map((layer) => layer.id));
    for (const [id, entry] of this.entries) {
      if (ids.has(id)) continue;
      this.stop(entry);
      this.entries.delete(id);
      this.changed();
    }
    for (const layer of layers) {
      const existing = this.entries.get(layer.id);
      const entry = existing ?? this.create(layer);
      if (!existing) this.entries.set(layer.id, entry);
      entry.state = { ...entry.state, layer };
      this.plan(entry, view, { fresh: !existing, viewChanged, resumed });
    }
    this.reorder(layers);
    this.changed();
  }

  /** Aborts and forgets everything; a later update starts over. */
  dispose(): void {
    for (const entry of this.entries.values()) this.stop(entry);
    this.entries.clear();
    this.view = null;
    this.snapshotCache = null;
  }

  private create(layer: GeoLayerInfo): FeedEntry {
    return {
      state: { layer, phase: "loading", loading: false, features: [], clusters: [], truncated: false, asOf: layer.asOf, fetchedAt: null, error: null, note: null },
      key: null,
      controller: null,
      debounce: null,
      refresh: null,
      blockedUntil: 0,
    };
  }

  private reorder(layers: readonly GeoLayerInfo[]): void {
    const ordered = layers.map((layer) => [layer.id, this.entries.get(layer.id)!] as const);
    this.entries.clear();
    for (const [id, entry] of ordered) this.entries.set(id, entry);
  }

  private plan(entry: FeedEntry, view: GeoView, change: { fresh: boolean; viewChanged: boolean; resumed: boolean }): void {
    const { layer } = entry.state;
    if (layer.status === "unavailable" || !this.canAccess(layer)) {
      this.stop(entry);
      entry.key = null;
      entry.state = { ...entry.state, phase: layer.status === "unavailable" ? "unavailable" : "locked", loading: false, features: [], clusters: [], truncated: false, error: null };
      return;
    }
    if (layer.minZoom !== undefined && view.zoom < layer.minZoom) {
      this.stop(entry);
      entry.key = null;
      entry.state = { ...entry.state, phase: "zoom", loading: false, features: [], clusters: [], truncated: false, error: null };
      return;
    }
    const key = geoViewKey(view);
    if (!this.active) {
      // Hidden: keep what is drawn, ask nothing, and catch up on return.
      this.clearRefresh(entry);
      return;
    }
    if (entry.key === key && !change.resumed) return;
    if (entry.key === key && change.resumed) {
      if (this.isDue(entry)) this.fetch(entry, key, true);
      else this.scheduleRefresh(entry);
      return;
    }
    // A new view supersedes whatever was in flight for the old one.
    this.abort(entry);
    this.clearRefresh(entry);
    if (entry.debounce !== null) this.timers.clearTimeout(entry.debounce);
    entry.debounce = null;
    entry.key = key;
    // A layer just turned on asks at once; a moving view waits until it settles.
    if (change.fresh || !change.viewChanged) {
      this.fetch(entry, key);
      return;
    }
    entry.state = { ...entry.state, loading: true };
    entry.debounce = this.timers.setTimeout(() => {
      entry.debounce = null;
      this.fetch(entry, key);
    }, this.debounceMs);
  }

  private isDue(entry: FeedEntry): boolean {
    const seconds = entry.state.layer.refreshSeconds;
    if (!seconds || entry.state.fetchedAt === null) return entry.state.fetchedAt === null;
    return this.timers.now() - entry.state.fetchedAt >= seconds * 1000;
  }

  private fetch(entry: FeedEntry, key: string, silent = false): void {
    const view = this.view;
    if (!view) return;
    this.abort(entry);
    this.clearRefresh(entry);
    const wait = entry.blockedUntil - this.timers.now();
    if (wait > 0) {
      entry.refresh = this.timers.setTimeout(() => {
        entry.refresh = null;
        if (entry.key === key) this.fetch(entry, key, silent);
      }, wait);
      return;
    }
    const controller = new AbortController();
    entry.controller = controller;
    if (!silent || entry.state.fetchedAt === null) {
      entry.state = { ...entry.state, loading: true, phase: entry.state.fetchedAt === null ? "loading" : entry.state.phase };
      this.changed();
    }
    const layerId = entry.state.layer.id;
    getGeoFeatures(this.request, layerId, { bbox: view.bbox, zoom: view.zoom, limit: GEO_FEATURE_LIMIT }, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted || entry.controller !== controller || entry.key !== key) return;
        entry.controller = null;
        // A layer the catalog listed can still answer that it cannot serve (no positions yet).
        if (payload.status === "unavailable") {
          entry.state = { ...entry.state, phase: "unavailable", loading: false, features: [], clusters: [], truncated: false, fetchedAt: this.timers.now(), error: null, note: payload.statusNote ?? null };
          this.scheduleRefresh(entry);
          this.changed();
          return;
        }
        entry.state = {
          ...entry.state,
          phase: "ready",
          loading: false,
          note: payload.status === "partial" ? payload.statusNote ?? null : null,
          features: (payload.features ?? []).slice(0, MAX_RENDERED_FEATURES),
          clusters: (payload.clusters ?? []).slice(0, MAX_RENDERED_CLUSTERS),
          truncated: payload.truncated === true || (payload.features?.length ?? 0) > MAX_RENDERED_FEATURES,
          asOf: payload.asOf ?? entry.state.layer.asOf,
          fetchedAt: this.timers.now(),
          error: null,
        };
        this.scheduleRefresh(entry);
        this.changed();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || entry.controller !== controller || isAbort(error)) return;
        entry.controller = null;
        if (error instanceof ApiRequestError && error.status === 403) {
          entry.state = { ...entry.state, phase: "locked", loading: false, features: [], clusters: [], truncated: false, error: null };
          this.changed();
          return;
        }
        // Keep drawn features through a failed refresh; the footer says it failed.
        entry.state = {
          ...entry.state,
          phase: entry.state.fetchedAt === null ? "error" : entry.state.phase,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        };
        // Over the request limit: wait as long as the server asks before trying again.
        const backoff = error instanceof ApiRequestError && error.status === 429 ? error.retryAfterMs ?? 30_000 : null;
        if (backoff !== null) entry.blockedUntil = this.timers.now() + backoff;
        this.scheduleRefresh(entry, backoff);
        this.changed();
      });
  }

  private scheduleRefresh(entry: FeedEntry, retryAfterMs: number | null = null): void {
    this.clearRefresh(entry);
    const seconds = entry.state.layer.refreshSeconds;
    if ((!seconds && retryAfterMs === null) || !this.active) return;
    const key = entry.key;
    entry.refresh = this.timers.setTimeout(() => {
      entry.refresh = null;
      if (key && entry.key === key) this.fetch(entry, key, true);
    }, Math.max(retryAfterMs ?? 0, (seconds ?? 0) * 1000));
  }

  private clearRefresh(entry: FeedEntry): void {
    if (entry.refresh !== null) this.timers.clearTimeout(entry.refresh);
    entry.refresh = null;
  }

  private abort(entry: FeedEntry): void {
    entry.controller?.abort();
    entry.controller = null;
  }

  private stop(entry: FeedEntry): void {
    this.abort(entry);
    this.clearRefresh(entry);
    if (entry.debounce !== null) this.timers.clearTimeout(entry.debounce);
    entry.debounce = null;
  }

  private changed(): void {
    this.snapshotCache = null;
    this.onChange();
  }
}
