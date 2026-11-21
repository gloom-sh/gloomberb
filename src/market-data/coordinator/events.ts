import { measurePerf } from "../../utils/perf-marks";
import { marketDataFrames, type DataFrameScheduler } from "../frame-scheduler";

const uniqueKeyLists = new WeakMap<readonly string[], readonly string[]>();

/**
 * `keys` without repeats. React reads a hook's version on every store change
 * and every render, always with the same memoized list, so its de-duplicated
 * copy is kept with it rather than built each time.
 */
function uniqueKeys(keys: readonly string[]): readonly string[] {
  let unique = uniqueKeyLists.get(keys);
  if (!unique) {
    unique = [...new Set(keys)];
    uniqueKeyLists.set(keys, unique);
  }
  return unique;
}

/** Hears when a key gains its first listener and loses its last. */
export interface KeyWatchHooks {
  watched?(key: string): void;
  released?(key: string): void;
}

/**
 * Store writes mark their keys changed; listeners hear about every change of
 * a frame in one pass after that frame's stream quotes are applied, so a
 * batch of ticks costs one React commit. The frame driver sets the pace.
 * Ticks a frame folded into a key without changing what it stores reach only
 * that key's tick listeners (`markTicks`): no version moves, nothing renders.
 */
export class MarketDataCoordinatorEvents {
  private version = 0;
  private versionChanged = false;
  private pendingChangedKeys = new Set<string>();
  private pendingTickKeys = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly keyListeners = new Map<string, Set<() => void>>();
  private readonly tickListeners = new Map<string, Set<() => void>>();
  private readonly keyVersions = new Map<string, number>();
  private readonly notifyFrame = () => this.flushNotify();

  constructor(
    private readonly frames: DataFrameScheduler = marketDataFrames,
    private readonly watchHooks: KeyWatchHooks = {},
  ) {}

  bump(changeKey?: string): void {
    this.versionChanged = true;
    if (changeKey) this.pendingChangedKeys.add(changeKey);
    this.frames.request(this.notifyFrame, { phase: "notify" });
  }

  /** This frame applied ticks of `key` its tick listeners have not heard. */
  markTicks(key: string): void {
    this.pendingTickKeys.add(key);
    this.frames.request(this.notifyFrame, { phase: "notify" });
  }

  /** Hears, with the frame's other notifications, when a frame applied ticks of these keys. */
  subscribeTicks(keys: readonly string[], listener: () => void): () => void {
    const uniqueKeys = [...new Set(keys)];
    for (const key of uniqueKeys) {
      const listeners = this.tickListeners.get(key);
      if (listeners) listeners.add(listener);
      else this.tickListeners.set(key, new Set([listener]));
    }
    return () => {
      for (const key of uniqueKeys) {
        const listeners = this.tickListeners.get(key);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.tickListeners.delete(key);
      }
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeKeys(keys: readonly string[], listener: () => void): () => void {
    const uniqueKeys = [...new Set(keys)];
    for (const key of uniqueKeys) {
      const listeners = this.keyListeners.get(key);
      if (listeners) listeners.add(listener);
      else {
        this.keyListeners.set(key, new Set([listener]));
        this.watchHooks.watched?.(key);
      }
    }
    return () => {
      for (const key of uniqueKeys) {
        const listeners = this.keyListeners.get(key);
        listeners?.delete(listener);
        if (listeners?.size === 0) {
          this.keyListeners.delete(key);
          this.watchHooks.released?.(key);
        }
      }
    };
  }

  getVersion(): number {
    return this.version;
  }

  /** True while a mounted pane is subscribed to this key. */
  hasKeyListeners(key: string): boolean {
    return (this.keyListeners.get(key)?.size ?? 0) > 0;
  }

  getKeyVersion(key: string): number {
    return this.keyVersions.get(key) ?? 0;
  }

  getKeysVersion(keys: readonly string[]): number {
    let version = 0;
    for (const key of uniqueKeys(keys)) {
      version += this.getKeyVersion(key);
    }
    return version;
  }

  dispose(): void {
    this.frames.remove(this.notifyFrame);
  }

  private flushNotify(): void {
    const changedKeys = this.pendingChangedKeys;
    const tickKeys = this.pendingTickKeys;
    const versionChanged = this.versionChanged;
    this.pendingChangedKeys = new Set();
    this.pendingTickKeys = new Set();
    this.versionChanged = false;
    measurePerf("market-data.notify", () => {
      const listeners = new Set<() => void>();
      if (versionChanged) {
        this.version += 1;
        for (const listener of this.listeners) listeners.add(listener);
      }
      for (const key of changedKeys) {
        this.keyVersions.set(key, (this.keyVersions.get(key) ?? 0) + 1);
        for (const listener of this.keyListeners.get(key) ?? []) {
          listeners.add(listener);
        }
      }
      // One listener on a key's ticks and on the key itself hears once.
      for (const key of tickKeys) {
        for (const listener of this.tickListeners.get(key) ?? []) {
          listeners.add(listener);
        }
      }
      for (const listener of listeners) {
        listener();
      }
    }, { changedKeyCount: changedKeys.size });
  }
}
