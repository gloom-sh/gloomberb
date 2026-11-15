import type { AppPluginStateStorePort } from "../../core/app-service-ports";
import { createPersistScheduler, type PersistScheduler } from "../../state/persist-scheduler";
import { fnv1aHex } from "../../utils/hash";
import { logFailure } from "../../utils/log-failure";
import { readVisitBaseline, type VisitBaseline, type VisitObservation } from "./model";

/**
 * The last visit's prices live in the app's local state store (SQLite in the
 * terminal and the desktop app, browser storage on the web), one row per
 * account, never in config.json, cloud sync or anything sent anywhere.
 */
const STATE_OWNER = "core.since-last-visit";
const KEY_PREFIX = "visit:";
/** Accounts whose last visit this device keeps; the one seen longest ago goes first. */
export const MAX_KEPT_SCOPES = 3;
/** How long a visit's newest prices wait before they are written, at most. */
const VISIT_SAVE_DELAY_MS = 5 * 60_000;

export interface VisitBaselineStore {
  load(scope: string): VisitBaseline | null;
  save(baseline: VisitBaseline): void;
  clear(): void;
}

type VisitStateStore = Pick<AppPluginStateStorePort, "get" | "set" | "delete" | "keys">;

function storeKey(scope: string): string {
  return `${KEY_PREFIX}${fnv1aHex(scope)}`;
}

export function createVisitBaselineStore(pluginState: VisitStateStore): VisitBaselineStore {
  const seenAtOf = (key: string): number => {
    const value = pluginState.get<{ seenAt?: unknown }>(STATE_OWNER, key)?.value;
    return typeof value?.seenAt === "number" ? value.seenAt : 0;
  };
  return {
    load(scope) {
      try {
        // The row names its account; one that hashed to the same key is not this one's.
        return readVisitBaseline(pluginState.get(STATE_OWNER, storeKey(scope))?.value, scope);
      } catch (error) {
        logFailure("since-last-visit", "Loading the last visit failed")(error);
        return null;
      }
    },
    save(baseline) {
      try {
        const key = storeKey(baseline.scope);
        pluginState.set(STATE_OWNER, key, baseline);
        const others = pluginState.keys(STATE_OWNER).filter((entry) => entry.startsWith(KEY_PREFIX) && entry !== key);
        if (others.length < MAX_KEPT_SCOPES) return;
        const oldestFirst = others.map((entry) => ({ entry, seenAt: seenAtOf(entry) })).sort((a, b) => a.seenAt - b.seenAt);
        for (const { entry } of oldestFirst.slice(0, others.length - (MAX_KEPT_SCOPES - 1))) {
          pluginState.delete(STATE_OWNER, entry);
        }
      } catch (error) {
        logFailure("since-last-visit", "Saving the visit failed")(error);
      }
    },
    clear() {
      try {
        for (const key of pluginState.keys(STATE_OWNER)) pluginState.delete(STATE_OWNER, key);
      } catch (error) {
        logFailure("since-last-visit", "Forgetting the last visits failed")(error);
      }
    },
  };
}

/**
 * One visit's prices for one account, from the moment it starts until it is
 * written for the next one. A price is kept only while the user is in the
 * app (`setPresent`): ticks that land while it is hidden or in the
 * background were never seen. The stored baseline is the only copy of the
 * last visit, so nothing is written over it until the return compared
 * against it (`allowSaving`); after that the visit is written at most every
 * `saveDelayMs`, when the user leaves, and when the app quits.
 */
export class VisitTracker {
  private scope: string | null = null;
  private previous: VisitBaseline | null = null;
  private readonly visit = new Map<string, VisitObservation>();
  private present = false;
  private lastPresentAt: number | null = null;
  private saving = false;
  private pending = false;
  private readonly saver: PersistScheduler<null>;
  private readonly now: () => number;

  constructor(
    private readonly store: VisitBaselineStore,
    { saveDelayMs = VISIT_SAVE_DELAY_MS, now = Date.now }: { saveDelayMs?: number; now?: () => number } = {},
  ) {
    this.now = now;
    this.saver = createPersistScheduler<null>({
      delayMs: saveDelayMs,
      save: () => this.write(),
      onError: logFailure("since-last-visit", "Saving the visit failed"),
    });
  }

  /**
   * Starts the visit for an account (`visitScope`), writing the one under way
   * for another account first. Returns the last visit stored for it, read
   * once when the account's visit starts: the baseline the return compares with.
   */
  begin(scope: string): VisitBaseline | null {
    if (scope === this.scope) return this.previous;
    this.flush();
    this.scope = scope;
    this.visit.clear();
    this.saving = false;
    this.previous = this.store.load(scope);
    this.lastPresentAt = this.present ? this.now() : null;
    return this.previous;
  }

  /** Whether the user is in the app; leaving writes the visit. */
  setPresent(present: boolean): void {
    if (present === this.present) return;
    this.lastPresentAt = this.now();
    this.present = present;
    if (!present) this.flush();
  }

  /** A price the user has on hand now, for a listing (`instrumentIdentityKey`). */
  observe(key: string, observation: VisitObservation): void {
    if (!this.scope || !this.present) return;
    this.visit.set(key, observation);
    this.lastPresentAt = this.now();
    this.schedule();
  }

  /** Drops the prices of listings no longer in the user's collections, so the next visit never names them. */
  retain(keys: ReadonlySet<string>): void {
    let changed = false;
    for (const key of this.visit.keys()) {
      if (keys.has(key)) continue;
      this.visit.delete(key);
      changed = true;
    }
    if (changed) this.schedule();
  }

  /** The return has been compared with the last visit (or had none to compare with): this one may now replace it. */
  allowSaving(): void {
    if (this.saving) return;
    this.saving = true;
    this.schedule();
  }

  /** Writes the visit now, when it may be written. */
  flush(): void {
    this.saver.cancel();
    this.write();
  }

  /** Writes what there is and stops: the app is going away. */
  stop(): void {
    this.setPresent(false);
    this.flush();
  }

  /**
   * Turned off: nothing pending is written, the visit is dropped and every
   * stored one is deleted. The next `begin` starts over.
   */
  forget(): void {
    this.saver.cancel();
    this.pending = false;
    this.visit.clear();
    this.saving = false;
    this.scope = null;
    this.previous = null;
    this.store.clear();
  }

  private schedule(): void {
    if (!this.saving || !this.scope || this.visit.size === 0 || this.pending) return;
    this.pending = true;
    this.saver.schedule(null);
  }

  private write(): void {
    this.pending = false;
    if (!this.saving || !this.scope || this.visit.size === 0) return;
    const seenAt = this.present ? this.now() : this.lastPresentAt;
    if (seenAt == null) return;
    this.store.save({ scope: this.scope, seenAt, observations: Object.fromEntries(this.visit) });
  }
}
