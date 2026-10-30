import { ApiRequestError } from "../../../api-client/errors";
import type { FundBondFacts } from "../../../api-client/fund-facts";
import { createConcurrencyLimiter } from "../../../utils/concurrency";
import type { DividendData } from "./client";
import type { DividendRankingEntry } from "./ranking";

/** Tickers one ranking reads at most: `fn DVD`, `shot DVD` and the DVD pane alike. */
export const MAX_RANKED_SYMBOLS = 25;
/** Tickers read at once across every ranking in the process, so a ranking never floods Gloom Cloud. */
const RANKING_CONCURRENCY = 4;
/** A rate-limited read waits what the server asks, a second when it names nothing, and never longer than this. */
const RATE_LIMIT_WAIT_MS = 1_000;
const RATE_LIMIT_WAIT_MAX_MS = 5_000;

/** The one gate every ranking's reads pass through. */
const rankingReads = createConcurrencyLimiter(RANKING_CONCURRENCY);

/** How a ranking reads one ticker. */
export interface DividendRankingReads {
  loadData(symbol: string): Promise<DividendData>;
  /** A fund's bond facts, null for any other listing. It never rejects: without them the fund ranks as before. */
  loadBond?(symbol: string): Promise<FundBondFacts | null>;
}

interface RankingReadOptions {
  /** How the one retry of a rate-limited read waits; tests pass their own. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The 429 a read was refused with, wrapped or not; null for any other failure. */
function rateLimited(error: unknown): ApiRequestError | null {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    if (current instanceof ApiRequestError) return current.status === 429 ? current : null;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** A read Gloom Cloud refused with 429, asked once more after the wait it names; a second refusal is the row's error. */
async function retryRateLimitedOnce<T>(read: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const limited = rateLimited(error);
    if (!limited) throw error;
    await sleep(Math.min(Math.max(0, limited.retryAfterMs ?? RATE_LIMIT_WAIT_MS), RATE_LIMIT_WAIT_MAX_MS));
    return read();
  }
}

/**
 * Each ticker of a ranking, read into its entry in the order given: the first
 * 25, at most four at once through the gate every ranking shares, so `fn`,
 * `shot` and any open DVD pane together never ask Gloom Cloud for more. A
 * ticker that fails keeps its row with its error, after one more try when it
 * was rate limited.
 */
export function readDividendRanking(
  symbols: readonly string[],
  reads: DividendRankingReads,
  { sleep = wait }: RankingReadOptions = {},
): Promise<DividendRankingEntry[]> {
  return Promise.all(symbols.slice(0, MAX_RANKED_SYMBOLS).map((symbol) => rankingReads(async (): Promise<DividendRankingEntry> => {
    const bond = reads.loadBond?.(symbol) ?? null;
    try {
      return { symbol, data: await retryRateLimitedOnce(() => reads.loadData(symbol), sleep), bond: await bond };
    } catch (error) {
      return { symbol, error: error instanceof Error ? error.message : String(error) };
    }
  })));
}
