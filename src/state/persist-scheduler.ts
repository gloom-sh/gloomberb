import { logFailure } from "../utils/log-failure";

export const CONFIG_SAVE_DEBOUNCE_MS = 500;
/** For config fields that change on every cursor move (recent tickers, the live pane-state mirror). */
export const LOW_PRIORITY_CONFIG_SAVE_DEBOUNCE_MS = 5_000;
export const SESSION_SAVE_DEBOUNCE_MS = 1000;
export const PLUGIN_STATE_SAVE_DEBOUNCE_MS = 500;

const pendingFlushes = new Set<() => Promise<void>>();
const inFlightSaves = new Set<Promise<void>>();

/** Drain scheduled and running writes before a renderer suspends or exits. */
export async function flushPendingPersistence(): Promise<void> {
  while (pendingFlushes.size > 0 || inFlightSaves.size > 0) {
    const flushing = [...pendingFlushes].map((flush) => flush());
    await Promise.allSettled([...flushing, ...inFlightSaves]);
  }
}

export interface PersistSchedulerOptions<T> {
  delayMs: number;
  save: (value: T) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

export interface PersistScheduler<T> {
  /** A shorter `delayMs` than the pending one brings the write forward. */
  schedule(value: T, delayMs?: number): void;
  flush(): Promise<void>;
  cancel(): void;
  saveImmediately(value: T): Promise<void>;
}

export function createPersistScheduler<T>({
  delayMs,
  save,
  onError,
}: PersistSchedulerOptions<T>): PersistScheduler<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingDelayMs = Number.POSITIVE_INFINITY;
  let pendingValue: T | undefined;
  let hasPendingValue = false;
  let inFlight: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const enqueueSave = (value: T, reportError: boolean): Promise<void> => {
    const saveTask = inFlight.then(async () => {
      try {
        await save(value);
      } catch (error) {
        if (reportError) {
          if (onError) onError(error);
          else logFailure("persist", "Scheduled persistence failed")(error);
        }
        throw error;
      }
    });
    // A timer or immediate save may already have left the pending drain set
    // when the renderer exits. Track queued saves until their writes settle.
    inFlightSaves.add(saveTask);
    void saveTask.then(
      () => { inFlightSaves.delete(saveTask); },
      () => {
        // Intentional ignore: The returned saveTask or enqueueSave already reports this failure.
        inFlightSaves.delete(saveTask);
      },
    );
    // Keep the serialization chain usable after a failed immediate save while
    // still returning that failure to its caller.
    inFlight = saveTask.catch(() => { /* Intentional ignore: The returned saveTask reports to the caller; this rejection only keeps the queue usable. */ });
    return saveTask;
  };

  const drain = async () => {
    clearTimer();
    pendingFlushes.delete(drain);
    pendingDelayMs = Number.POSITIVE_INFINITY;
    if (!hasPendingValue) return inFlight;
    const value = pendingValue as T;
    pendingValue = undefined;
    hasPendingValue = false;
    return enqueueSave(value, true).catch(() => { /* Intentional ignore: enqueueSave reports scheduled errors before this drain consumes them. */ });
  };

  return {
    schedule(value: T, requestedDelayMs = delayMs): void {
      pendingValue = value;
      hasPendingValue = true;
      pendingFlushes.add(drain);
      // Still a debounce, but the shortest delay asked for since the last
      // write wins: a value scheduled with a long delay must not push back
      // one that asked to be written sooner.
      pendingDelayMs = Math.min(pendingDelayMs, Math.max(0, requestedDelayMs));
      clearTimer();
      timer = setTimeout(() => {
        void drain();
      }, pendingDelayMs);
    },
    flush(): Promise<void> {
      return drain();
    },
    cancel(): void {
      clearTimer();
      pendingFlushes.delete(drain);
      pendingDelayMs = Number.POSITIVE_INFINITY;
      pendingValue = undefined;
      hasPendingValue = false;
    },
    saveImmediately(value: T): Promise<void> {
      clearTimer();
      pendingFlushes.delete(drain);
      pendingDelayMs = Number.POSITIVE_INFINITY;
      pendingValue = undefined;
      hasPendingValue = false;
      return enqueueSave(value, false);
    },
  };
}
