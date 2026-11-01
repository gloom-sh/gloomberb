/** Maps every item with at most `limit` calls in flight, keeping the input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** The items in consecutive groups of at most `size`. */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * One gate that every caller shares: at most `limit` tasks run at once, and
 * the rest wait in the order they came. Unlike mapWithConcurrency, separate
 * callers (two panes, a pane and a report) count against the same limit. A
 * finished task hands its slot straight to the next waiting one, so a caller
 * arriving in between never takes it.
 */
export function createConcurrencyLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const slots = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active < slots) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
