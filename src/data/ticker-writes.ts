interface TickerWrites {
  revisions: Map<string, number>;
  tails: Map<string, Promise<unknown>>;
  pending: Set<Promise<unknown>>;
}

const repositories = new WeakMap<object, TickerWrites>();

function writesFor(repository: object): TickerWrites {
  let writes = repositories.get(repository);
  if (!writes) {
    writes = { revisions: new Map(), tails: new Map(), pending: new Set() };
    repositories.set(repository, writes);
  }
  return writes;
}

function tickerKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** Reserve writes when requested, including ones waiting for an earlier acknowledgement. */
export function runTickerWrite<Result>(
  repository: object,
  symbols: string | readonly string[],
  write: () => Result | PromiseLike<Result>,
): Promise<Result> {
  const writes = writesFor(repository);
  const keys = [...new Set((typeof symbols === "string" ? [symbols] : symbols).map(tickerKey))];
  const previous = [...new Set(keys.flatMap((key) => {
    const tail = writes.tails.get(key);
    return tail ? [tail] : [];
  }))];
  let resolve!: (value: Result | PromiseLike<Result>) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<Result>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  for (const key of keys) {
    writes.revisions.set(key, (writes.revisions.get(key) ?? 0) + 1);
    writes.tails.set(key, result);
  }
  writes.pending.add(result);
  const finished = () => {
    writes.pending.delete(result);
    for (const key of keys) {
      if (writes.tails.get(key) === result) writes.tails.delete(key);
    }
  };
  void result.then(finished, finished);
  const start = () => {
    try {
      resolve(write());
    } catch (error) {
      reject(error);
    }
  };
  if (previous.length) void Promise.allSettled(previous).then(start);
  else start();
  return result;
}

/** Changes immediately when a save or deletion is requested, before its acknowledgement. */
export function tickerWriteRevision(repository: object, symbol: string): number {
  return repositories.get(repository)?.revisions.get(tickerKey(symbol)) ?? 0;
}

/** Whether a write arrived after a caller last waited for acknowledgements. */
export function hasPendingTickerWrites(repository: object): boolean {
  return (repositories.get(repository)?.pending.size ?? 0) > 0;
}

/** Let save-await callers publish their edits before cleanup reads the current rows. */
export async function settleTickerWrites(repository: object): Promise<void> {
  const writes = writesFor(repository);
  do {
    // Each writer handles its own failure; cleanup still needs the last published row.
    await Promise.allSettled([...writes.pending]);
  } while (writes.pending.size);
}
