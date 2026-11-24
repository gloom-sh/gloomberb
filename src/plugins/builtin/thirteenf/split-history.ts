import type { DataProvider } from "../../../types/data-provider";
import type { SplitHistory } from "../../../types/financials";
import { chunked, createConcurrencyLimiter, mapWithConcurrency } from "../../../utils/concurrency";
import { logFailure } from "../../../utils/log-failure";

/** Where a ticker's splits are read: a batch of bare symbols, else its corporate actions one at a time. */
export type SplitHistorySource = Pick<DataProvider, "getSplitHistoryBatch" | "getCorporateActions">;

/** Symbols in one batched read, so a fund's largest split candidates are answered while the rest are read. */
const BATCH_SIZE = 25;
/** Batched reads in flight at once. */
const BATCHES_IN_FLIGHT = 3;
/** Corporate-action reads in flight at once for symbols no batch answered, as many as a fund's split pass ran before batches. */
const SINGLE_READS_IN_FLIGHT = 6;
/** How long an answer stands: a split is announced weeks ahead, and a fund's quarter ends are months apart. */
const ANSWER_MS = 6 * 60 * 60_000;
/** A failed read is tried again after this, so the splits come back with the service. */
const RETRY_FAILED_AFTER_MS = 60_000;
/** How long asks gather before they go out together. */
const GATHER_MS = 10;

interface Entry {
  promise: Promise<SplitHistory | null>;
  settledAt: number | null;
  failed: boolean;
}

interface Asked {
  ticker: string;
  resolve(history: SplitHistory | null): void;
  reject(error: unknown): void;
}

interface Session {
  entries: Map<string, Entry>;
  gathered: Map<string, Asked>;
  timer: ReturnType<typeof setTimeout> | null;
  single: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * One session's answers per source: each ticker's splits are read once,
 * however many funds, reopens and refreshes ask for them.
 */
const sessions = new WeakMap<SplitHistorySource, Session>();

function sessionOf(source: SplitHistorySource): Session {
  let session = sessions.get(source);
  if (!session) {
    session = { entries: new Map(), gathered: new Map(), timer: null, single: createConcurrencyLimiter(SINGLE_READS_IN_FLIGHT) };
    sessions.set(source, session);
  }
  return session;
}

const standing = (entry: Entry) => entry.settledAt === null
  || Date.now() - entry.settledAt < (entry.failed ? RETRY_FAILED_AFTER_MS : ANSWER_MS);

/** A ticker's splits from its corporate actions, as the split check read them before batches; null without any. */
async function corporateActionSplits(source: SplitHistorySource, ticker: string): Promise<SplitHistory | null> {
  if (!source.getCorporateActions) return null;
  const actions = await source.getCorporateActions(ticker);
  return { symbol: actions.symbol, splits: actions.splits, coverage: actions.coverage?.splits === "unavailable" ? "unavailable" : "available" };
}

/**
 * Sends what has gathered: batches of BATCH_SIZE in the order asked, a few in
 * flight. A ticker a batch leaves out, or every one when the source cannot
 * batch, is read from its corporate actions, a few at a time.
 */
function send(source: SplitHistorySource, session: Session): Promise<unknown> {
  session.timer = null;
  const asked = [...session.gathered.values()];
  session.gathered.clear();
  return mapWithConcurrency(chunked(asked, BATCH_SIZE), BATCHES_IN_FLIGHT, async (chunk) => {
    const answers = source.getSplitHistoryBatch
      ? await source.getSplitHistoryBatch(chunk.map((one) => one.ticker))
        .catch(logFailure("thirteenf.split-history", "Batched split history read failed", null))
      : null;
    for (const one of chunk) {
      if (answers?.has(one.ticker)) one.resolve(answers.get(one.ticker) ?? null);
      else session.single(() => corporateActionSplits(source, one.ticker)).then(one.resolve, one.reject);
    }
  });
}

/**
 * A ticker's share splits (null when the source holds none for it), read once
 * a session: asks that arrive together go out as a few batched reads, and an
 * answer stands ANSWER_MS, a failure RETRY_FAILED_AFTER_MS.
 */
export function readSplitHistory(source: SplitHistorySource, ticker: string): Promise<SplitHistory | null> {
  const key = ticker.trim().toUpperCase();
  const session = sessionOf(source);
  const known = session.entries.get(key);
  if (known && standing(known)) return known.promise;
  let asked!: Asked;
  const promise = new Promise<SplitHistory | null>((resolve, reject) => { asked = { ticker: key, resolve, reject }; });
  const entry: Entry = { promise, settledAt: null, failed: false };
  promise.then(() => { entry.settledAt = Date.now(); }, () => {
    entry.settledAt = Date.now();
    entry.failed = true;
  });
  session.entries.set(key, entry);
  session.gathered.set(key, asked);
  session.timer ??= setTimeout(() => {
    void send(source, session).catch(logFailure("thirteenf.split-history", "Sending split history reads failed"));
  }, GATHER_MS);
  return promise;
}

/** Starts reading every ticker's splits at once, so they go out as a few batches before any is waited on. */
export function prefetchSplitHistories(source: SplitHistorySource, tickers: readonly string[]): void {
  for (const ticker of tickers) {
    readSplitHistory(source, ticker).catch(() => {
      // Intentional ignore: a failure is the reader's to handle; this only starts the read.
    });
  }
}
