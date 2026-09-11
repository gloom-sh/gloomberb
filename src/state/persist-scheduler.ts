export const CONFIG_SAVE_DEBOUNCE_MS = 500;
export const SESSION_SAVE_DEBOUNCE_MS = 1000;
export const PLUGIN_STATE_SAVE_DEBOUNCE_MS = 500;

const pendingFlushes = new Set<() => Promise<void>>();

/** Drain delayed writes before the browser suspends or discards this page. */
export async function flushPendingPersistence(): Promise<void> {
  await Promise.allSettled([...pendingFlushes].map((flush) => flush()));
}

export interface PersistSchedulerOptions<T> {
  delayMs: number;
  save: (value: T) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

export interface PersistScheduler<T> {
  schedule(value: T): void;
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
        if (reportError) onError?.(error);
        throw error;
      }
    });
    // Keep the serialization chain usable after a failed immediate save while
    // still returning that failure to its caller.
    inFlight = saveTask.catch(() => {});
    return saveTask;
  };

  const drain = async () => {
    clearTimer();
    pendingFlushes.delete(drain);
    if (!hasPendingValue) return inFlight;
    const value = pendingValue as T;
    pendingValue = undefined;
    hasPendingValue = false;
    return enqueueSave(value, true).catch(() => {});
  };

  return {
    schedule(value: T): void {
      pendingValue = value;
      hasPendingValue = true;
      pendingFlushes.add(drain);
      clearTimer();
      timer = setTimeout(() => {
        void drain();
      }, Math.max(0, delayMs));
    },
    flush(): Promise<void> {
      return drain();
    },
    cancel(): void {
      clearTimer();
      pendingFlushes.delete(drain);
      pendingValue = undefined;
      hasPendingValue = false;
    },
    saveImmediately(value: T): Promise<void> {
      clearTimer();
      pendingFlushes.delete(drain);
      pendingValue = undefined;
      hasPendingValue = false;
      return enqueueSave(value, false);
    },
  };
}
