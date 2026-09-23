import { measurePerf } from "../../utils/perf-marks";
import { marketDataFrames, type DataFrameScheduler } from "../frame-scheduler";

/**
 * Store writes mark their keys changed; listeners hear about every change of
 * a frame in one pass after that frame's stream quotes are applied, so a
 * batch of ticks costs one React commit. The frame driver sets the pace.
 */
export class MarketDataCoordinatorEvents {
  private version = 0;
  private pendingChangedKeys = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly keyListeners = new Map<string, Set<() => void>>();
  private readonly keyVersions = new Map<string, number>();
  private readonly notifyFrame = () => this.flushNotify();

  constructor(private readonly frames: DataFrameScheduler = marketDataFrames) {}

  bump(changeKey?: string): void {
    if (changeKey) this.pendingChangedKeys.add(changeKey);
    this.frames.request(this.notifyFrame, { phase: "notify" });
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
      if (!this.keyListeners.has(key)) this.keyListeners.set(key, new Set());
      this.keyListeners.get(key)!.add(listener);
    }
    return () => {
      for (const key of uniqueKeys) {
        const listeners = this.keyListeners.get(key);
        listeners?.delete(listener);
        if (listeners?.size === 0) {
          this.keyListeners.delete(key);
        }
      }
    };
  }

  getVersion(): number {
    return this.version;
  }

  getKeysVersion(keys: readonly string[]): number {
    let version = 0;
    for (const key of new Set(keys)) {
      version += this.keyVersions.get(key) ?? 0;
    }
    return version;
  }

  dispose(): void {
    this.frames.remove(this.notifyFrame);
  }

  private flushNotify(): void {
    const changedKeys = this.pendingChangedKeys;
    this.pendingChangedKeys = new Set();
    measurePerf("market-data.notify", () => {
      this.version += 1;
      const listeners = new Set(this.listeners);
      for (const key of changedKeys) {
        this.keyVersions.set(key, (this.keyVersions.get(key) ?? 0) + 1);
        for (const listener of this.keyListeners.get(key) ?? []) {
          listeners.add(listener);
        }
      }
      for (const listener of listeners) {
        listener();
      }
    }, { changedKeyCount: changedKeys.size });
  }
}
