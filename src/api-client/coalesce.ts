import { createConcurrencyLimiter } from "../utils/concurrency";
import { ApiRequestError } from "./errors";

/**
 * How long a read waits for others: long enough for a board's reads, which
 * reach the client through caches and routing a few at a time, to meet.
 */
const WINDOW_MS = 4;

/**
 * Reads asked in the same moment, sent as one request. A read waits a few
 * milliseconds (WINDOW_MS); the reads of one group gathered by then go out together
 * through `batch`, at most `max` at a time, each answered with its own item.
 * A lone read goes out on its own, as it always did. A service without the
 * batch route (404) is asked one read at a time from then on, at most
 * `fallbackConcurrency` of a group's reads at once, and so is every read of a
 * batch that failed or left it out.
 */
export function createReadCoalescer<Key, Result>(options: {
  max: number;
  fallbackConcurrency: number;
  group: (key: Key) => string;
  batch: (keys: Key[]) => Promise<Array<Result | undefined>>;
  single: (key: Key) => Promise<Result>;
}): { read: (key: Key) => Promise<Result> } {
  interface Waiting { key: Key; resolve: (result: Result) => void; reject: (error: unknown) => void }
  const pending = new Map<string, Waiting[]>();
  const limit = createConcurrencyLimiter(options.fallbackConcurrency);
  let unsupported = false;
  let scheduled = false;

  const one = (waiting: Waiting, limited: boolean) => {
    (limited ? limit(() => options.single(waiting.key)) : options.single(waiting.key)).then(waiting.resolve, waiting.reject);
  };

  const send = async (group: Waiting[]) => {
    if (group.length === 1 || unsupported) {
      for (const waiting of group) one(waiting, group.length > 1);
      return;
    }
    let results: Array<Result | undefined>;
    try {
      results = await options.batch(group.map((waiting) => waiting.key));
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) unsupported = true;
      for (const waiting of group) one(waiting, true);
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
