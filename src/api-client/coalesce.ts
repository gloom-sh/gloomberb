import { createConcurrencyLimiter } from "../utils/concurrency";
import { ApiRequestError } from "./errors";

/**
 * How long a read waits for others: long enough for a board's reads, which
 * reach the client through caches and routing a few at a time, to meet.
 */
const WINDOW_MS = 4;

/**
 * How long a batch route the service answered 404 is left alone before it is
 * asked again: an app that updated before its service, or that reached an
 * instance a deploy had not replaced yet, gets its batches once the service
 * has them.
 */
export const BATCH_ROUTE_REPROBE_MS = 15 * 60_000;

/**
 * Statuses that refuse a batch as asked (no such route, a request too large or
 * not understood), which the reads it carried may each get past alone. A rate
 * limit, an overloaded service or no answer at all is the same for single
 * requests, and more of them is more of what it refused.
 */
const ASKED_ALONE_AFTER = new Set([400, 404, 413, 422]);

/** Whether a batch route's 404 still stands: it is asked again once BATCH_ROUTE_REPROBE_MS has passed. */
export function createMissingRouteLatch(): { missing(): boolean; refused(error: unknown): void } {
  let until = 0;
  return {
    missing: () => Date.now() < until,
    refused: (error) => {
      if (error instanceof ApiRequestError && error.status === 404) until = Date.now() + BATCH_ROUTE_REPROBE_MS;
    },
  };
}

/**
 * Reads asked in the same moment, sent as batch requests. A read waits a few
 * milliseconds (WINDOW_MS); the reads of one group gathered by then go out
 * together through `batch`, at most `max` a request, each answered with its
 * own item. A lone read goes out on its own, as it always did.
 *
 * A batch refused as asked (ASKED_ALONE_AFTER) has its reads asked one at a
 * time, at most `fallbackConcurrency` at once, and so has every read a batch
 * left out; a 404 (a service without the route) sends every read that way
 * until the route is asked again (BATCH_ROUTE_REPROBE_MS). Any other failure
 * fails every read of the batch with it.
 */
export function createReadCoalescer<Key, Result>(options: {
  max: number;
  fallbackConcurrency: number;
  group: (key: Key) => string;
  batch: (keys: Key[]) => Promise<Array<Result | undefined>>;
  single: (key: Key) => Promise<Result>;
}): {
  read: (key: Key) => Promise<Result>;
  /** Whether reads asked together now go out in batches: false while the route's 404 stands. */
  batching: () => boolean;
} {
  interface Waiting { key: Key; resolve: (result: Result) => void; reject: (error: unknown) => void }
  const pending = new Map<string, Waiting[]>();
  const limit = createConcurrencyLimiter(options.fallbackConcurrency);
  const route = createMissingRouteLatch();
  let scheduled = false;

  const one = (waiting: Waiting, limited: boolean) => {
    (limited ? limit(() => options.single(waiting.key)) : options.single(waiting.key)).then(waiting.resolve, waiting.reject);
  };

  const send = async (group: Waiting[]) => {
    if (group.length === 1 || route.missing()) {
      for (const waiting of group) one(waiting, group.length > 1);
      return;
    }
    let results: Array<Result | undefined>;
    try {
      results = await options.batch(group.map((waiting) => waiting.key));
    } catch (error) {
      route.refused(error);
      const alone = error instanceof ApiRequestError && ASKED_ALONE_AFTER.has(error.status ?? 0);
      for (const waiting of group) {
        if (alone) one(waiting, true);
        else waiting.reject(error);
      }
      return;
    }
    group.forEach((waiting, index) => {
      const result = results[index];
      if (result === undefined) one(waiting, true);
      else waiting.resolve(result);
    });
  };

  const flush = () => {
    scheduled = false;
    const groups = [...pending.values()];
    pending.clear();
    for (const group of groups) {
      for (let start = 0; start < group.length; start += options.max) void send(group.slice(start, start + options.max));
    }
  };

  return {
    batching: () => !route.missing(),
    read(key) {
      return new Promise<Result>((resolve, reject) => {
        const group = options.group(key);
        const waiting = pending.get(group);
        if (waiting) waiting.push({ key, resolve, reject });
        else pending.set(group, [{ key, resolve, reject }]);
        if (!scheduled) {
          scheduled = true;
          setTimeout(flush, WINDOW_MS);
        }
      });
    },
  };
}
