import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import { isPermanentClientError } from "../../../api-client/errors";
import type { LiveScanPayload, LiveScanWireDefinition } from "../../../api-client/live-scan";
import { useCloudDisplayScope } from "../../../api-client/plan-access";
import { useSavedCopyFooter } from "../../../components/layout/pane/footer/registration";
import { deleteSavedCopy, readSavedCopy, writeSavedCopy, type SavedCopy, type SavedCopyKey } from "../../../data/pane-saved-copies";
import { errorMessage } from "../../../utils/errors";

/** Where a live scan pane reads its scans; absent, Gloom Cloud. */
export type LiveScanClient = Pick<typeof apiClient, "getLiveScan">;
export const LiveScanClientContext = createContext<LiveScanClient | null>(null);

/** Never ask more often than this, whatever the snapshot's refresh says. */
const MIN_POLL_MS = 5_000;
/** A scanner that is still warming up answers again soon. */
const STARTING_POLL_MS = 3_000;
/** Outside the session the matches do not move. */
const CLOSED_POLL_MS = 5 * 60_000;
const FAILED_POLL_MS = 30_000;

/**
 * When to ask again: when the snapshot behind the answer is next refreshed,
 * a little after so the next answer is a new one.
 */
export function nextLiveScanPoll(payload: LiveScanPayload | null, failed: boolean, now: number): number {
  if (failed || !payload) return FAILED_POLL_MS;
  if (payload.status === "starting") return STARTING_POLL_MS;
  if (payload.status === "closed") return CLOSED_POLL_MS;
  const refresh = Math.max(MIN_POLL_MS, payload.refreshMs || MIN_POLL_MS);
  if (payload.takenAt == null) return refresh;
  // One second after the next refresh lands, or a full interval when that is already past.
  const due = payload.takenAt + refresh + 1_000 - now;
  return due >= MIN_POLL_MS ? Math.min(due, refresh + 1_000) : refresh;
}

export interface LiveScanFeedState {
  payload: LiveScanPayload | null;
  /** The last refresh's failure; the last matches stay. */
  error: string | null;
  loading: boolean;
  savedAt?: number;
}

interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Runs one scan: asks, waits for the snapshot's next refresh, asks again.
 * A new definition drops the old answer and asks at once; stopping keeps the
 * last answer on screen. Only the newest request may answer.
 */
export class LiveScanPoller {
  private definition: LiveScanWireDefinition | null = null;
  private key = "";
  private savedKey: SavedCopyKey | null = null;
  private enabled = false;
  private timer: unknown = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private state: LiveScanFeedState = { payload: null, error: null, loading: false };

  constructor(
    private readonly client: LiveScanClient,
    private readonly onState: (state: LiveScanFeedState) => void,
    private readonly timers: Timers = realTimers,
    private readonly now: () => number = Date.now,
  ) {}

  setScan(definition: LiveScanWireDefinition | null, key: string, savedKey: SavedCopyKey | null = null, opening: SavedCopy<LiveScanPayload> | null = null): void {
    if (key === this.key) return;
    this.key = key;
    this.definition = definition;
    this.savedKey = savedKey;
    this.cancel();
    this.emit(opening
      ? { payload: opening.value, error: null, loading: false, savedAt: opening.fetchedAt }
      : { payload: null, error: null, loading: !!definition && this.enabled });
    if (this.enabled) this.ask();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.cancel();
      if (this.state.loading) this.emit({ ...this.state, loading: false });
      return;
    }
    this.ask();
  }

  /** Ask now, as `r` does. */
  reload(): void {
    if (this.enabled) this.ask();
  }

  dispose(): void {
    this.enabled = false;
    this.cancel();
  }

  private cancel(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    if (this.timer != null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private emit(next: LiveScanFeedState): void {
    this.state = next;
    this.onState(next);
  }

  private ask(): void {
    this.cancel();
    const definition = this.definition;
    if (!definition) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    if (!this.state.loading && !this.state.payload) this.emit({ ...this.state, loading: true });
    this.client.getLiveScan(definition, controller.signal).then(
      (payload) => {
        if (generation !== this.generation) return;
        if (payload.status === "live" || payload.status === "closed" || (payload.status === "degraded" && payload.takenAt != null)) {
          if (this.savedKey) writeSavedCopy(this.savedKey, payload, this.now(), MIN_POLL_MS);
          this.emit({ payload, error: null, loading: false });
        } else if (this.state.savedAt == null) {
          this.emit({ payload, error: null, loading: false });
        }
        this.schedule(nextLiveScanPoll(payload, false, this.now()));
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        if (isPermanentClientError(error)) {
          if (this.savedKey) deleteSavedCopy(this.savedKey);
          this.emit({ payload: null, error: errorMessage(error), loading: false });
        } else {
          this.emit({ ...this.state, error: errorMessage(error), loading: false });
        }
        this.schedule(nextLiveScanPoll(this.state.payload, true, this.now()));
      },
    );
  }

  private schedule(ms: number): void {
    if (!this.enabled) return;
    const generation = this.generation;
    this.timer = this.timers.set(() => {
      if (generation === this.generation) this.ask();
    }, ms);
  }
}

/**
 * The live answer to one scan while `enabled`. Leaving the pane on screen or
 * keeping its alerts on is the caller's call.
 */
export function useLiveScanFeed(
  definition: LiveScanWireDefinition | null,
  key: string,
  enabled: boolean,
): LiveScanFeedState & { identity: string; reload: () => void } {
  const override = useContext(LiveScanClientContext);
  const client = override ?? apiClient;
  const scope = useCloudDisplayScope();
  const identity = JSON.stringify([scope, key]);
  const savedKey = useMemo(() => !override && key && scope ? { key: ["live-scan", identity] } : null, [identity, key, override, scope]);
  const opening = useMemo(() => ({ copy: savedKey ? readSavedCopy<LiveScanPayload>(savedKey) : null }), [savedKey]);
  const [latest, setLatest] = useState<{ owner: LiveScanPoller; state: LiveScanFeedState } | null>(null);
  const poller = useMemo(() => {
    const owner = new LiveScanPoller(client, (state) => setLatest({ owner, state }));
    return owner;
  }, [client, identity]);
  useEffect(() => () => poller.dispose(), [poller]);
  useEffect(() => {
    poller.setScan(definition, identity, savedKey, opening.copy);
    opening.copy = null;
  }, [poller, identity, opening, savedKey]);
  useEffect(() => {
    poller.setEnabled(enabled);
  }, [poller, enabled]);
  const state = latest?.owner === poller ? latest.state : opening.copy
    ? { payload: opening.copy.value, error: null, loading: false, savedAt: opening.copy.fetchedAt }
    : { payload: null, error: null, loading: !!definition && enabled };
  useSavedCopyFooter(state.savedAt, enabled && state.error === null);
  return { ...state, identity, reload: () => poller.reload() };
}
