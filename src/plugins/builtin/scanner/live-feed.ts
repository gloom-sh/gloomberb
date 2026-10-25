import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../../../api-client";
import type { LiveScanPayload, LiveScanWireDefinition } from "../../../api-client/live-scan";
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

  setScan(definition: LiveScanWireDefinition | null, key: string): void {
    if (key === this.key) return;
    this.key = key;
    this.definition = definition;
    this.cancel();
    this.emit({ payload: null, error: null, loading: !!definition && this.enabled });
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
        this.emit({ payload, error: null, loading: false });
        this.schedule(nextLiveScanPoll(payload, false, this.now()));
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.emit({ payload: this.state.payload, error: errorMessage(error), loading: false });
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
): LiveScanFeedState & { reload: () => void } {
  const client = useContext(LiveScanClientContext) ?? apiClient;
  const [state, setState] = useState<LiveScanFeedState>({ payload: null, error: null, loading: !!definition && enabled });
  const pollerRef = useRef<LiveScanPoller | null>(null);
  const poller = useMemo(() => new LiveScanPoller(client, setState), [client]);
  pollerRef.current = poller;
  useEffect(() => () => poller.dispose(), [poller]);
  // The definition is read through its key.
  useEffect(() => {
    poller.setScan(definition, key);
  }, [poller, key]);
  useEffect(() => {
    poller.setEnabled(enabled);
  }, [poller, enabled]);
  return useMemo(() => ({ ...state, reload: () => pollerRef.current?.reload() }), [state]);
}
