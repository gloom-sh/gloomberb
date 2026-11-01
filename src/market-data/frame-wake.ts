import { useRef, useSyncExternalStore } from "react";
import { marketDataFrames, type DataFrameScheduler, type DataFrameTask } from "./frame-scheduler";

export interface DataFrameWake {
  /** The market data clock (monotonic, in ms). */
  now(): number;
  /**
   * Renders the component again in the first market data frame at or after
   * `time` on that clock, waiting up to one frame interval longer for a frame
   * that brings quotes. Booked twice, the earlier time wins; a component that
   * still needs one after it renders books again.
   */
  wakeAt(time: number): void;
  /** Drops a booked render that is no longer needed. */
  cancel(): void;
}

interface WakeStore extends DataFrameWake {
  version: number;
  booked: boolean;
  listener: (() => void) | null;
  task: DataFrameTask;
  subscribe(listener: () => void): () => void;
  getVersion(): number;
}

function createWakeStore(frames: DataFrameScheduler): WakeStore {
  const store: WakeStore = {
    version: 0,
    booked: false,
    listener: null,
    task: () => {
      store.booked = false;
      store.version += 1;
      store.listener?.();
    },
    subscribe(listener) {
      store.listener = listener;
      return () => {
        store.listener = null;
        store.cancel();
      };
    },
    getVersion: () => store.version,
    now: () => frames.now(),
    wakeAt(time) {
      store.booked = true;
      // Due at `time`, it waits up to a frame for one that carries quotes.
      frames.request(store.task, { phase: "notify", notBefore: time, rideUntil: time + frames.frameIntervalMs() });
    },
    cancel() {
      if (!store.booked) return;
      store.booked = false;
      frames.remove(store.task);
    },
  };
  return store;
}

/**
 * A re-render booked on the market data clock, in the same React pass as the
 * store updates that frame delivers. A flash ending or a throttled total
 * catching up then rides along with the next quotes instead of costing a
 * commit, and in the terminal a full redraw, of its own.
 */
export function useDataFrameWake(frames: DataFrameScheduler = marketDataFrames): DataFrameWake {
  const storeRef = useRef<{ frames: DataFrameScheduler; store: WakeStore } | null>(null);
  if (storeRef.current?.frames !== frames) storeRef.current = { frames, store: createWakeStore(frames) };
  const { store } = storeRef.current;
  // A store notification is a sync-lane update, as every market data hook's is,
  // so React folds it into the same render as the frame's other updates.
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store;
}
