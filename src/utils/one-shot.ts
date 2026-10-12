/**
 * A held key, a held menu accelerator and a double press all trigger an action
 * again when it was meant to run once. A one-shot refuses a trigger while the
 * run it started is still going and for a cooldown after the last trigger.
 *
 * Every trigger counts, refused ones too, so a key held down stays refused
 * until it has been up for a whole cooldown. A refused trigger is dropped, not
 * queued: nothing runs after the key is released.
 */

/** Longer than the delay before a held key starts repeating on the usual keyboard settings. */
export const ONE_SHOT_COOLDOWN_MS = 600;

/** A run that never reports back stops blocking its action after this long. */
const MAX_RUN_MS = 30_000;

export interface OneShot {
  /**
   * Whether a trigger now is refused. Refusing counts as a trigger, so it extends the cooldown.
   * A trigger that says it is a key repeat is always refused, however long the repeat delay was.
   */
  refuses(trigger?: { repeat?: boolean }): boolean;
  /** Begins a run that ends in `end()`; further triggers are refused until then. */
  start(): void;
  /** Ends a run begun with `start()`, or records one that ran at once. The cooldown counts from here. */
  end(): void;
}

interface OneShotOptions {
  cooldownMs?: number;
  now?: () => number;
}

export function createOneShot({ cooldownMs = ONE_SHOT_COOLDOWN_MS, now = Date.now }: OneShotOptions = {}): OneShot {
  let runStartedAt: number | null = null;
  let lastTriggerAt = Number.NEGATIVE_INFINITY;
  return {
    refuses(trigger) {
      const at = now();
      const running = runStartedAt !== null && at - runStartedAt < MAX_RUN_MS;
      if (!running && at - lastTriggerAt >= cooldownMs && trigger?.repeat !== true) return false;
      lastTriggerAt = at;
      return true;
    },
    start() {
      runStartedAt = now();
      lastTriggerAt = runStartedAt;
    },
    end() {
      runStartedAt = null;
      lastTriggerAt = now();
    },
  };
}

/** One cooldown per action id, for a handler that dispatches several actions. */
export interface OneShots {
  get(id: string): OneShot;
}

export function createOneShots(options?: OneShotOptions): OneShots {
  const shots = new Map<string, OneShot>();
  return {
    get(id) {
      let shot = shots.get(id);
      if (!shot) {
        shot = createOneShot(options);
        shots.set(id, shot);
      }
      return shot;
    },
  };
}
