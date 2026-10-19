import type { FuturesContractTermsPayload } from "../api-client/futures-curve";
import type { DataProvider } from "../types/data-provider";
import { loadFuturesContractTermsCached } from "../market-data/futures-contract";
import type { PricePoint } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import { logFailure } from "../utils/log-failure";
import {
  futuresContractSize,
  isFuturesTicker,
  portfolioFuturesTerms,
  type FuturesContractSize,
  type PortfolioFuturesTerms,
} from "./futures-positions";

/** Where a portfolio reads its futures' terms and, for the move into a settlement, their daily bars. */
export interface PortfolioFuturesSources {
  /** A symbol's contract terms and settlement; null when the server has none. Defaults to Gloom Cloud's, cached. */
  terms?: (symbol: string) => Promise<FuturesContractTermsPayload | null>;
  /** A month of daily bars, whose confirmed closes are settlements. */
  history?: (symbol: string, exchange: string) => Promise<PricePoint[]>;
}

/**
 * A month of a symbol's daily bars from `provider`: asked for by resolution,
 * since a month's default history can be intraday bars, whose closes are no
 * settlements. Bars a source says are of another cadence are none at all.
 */
export function dailyFuturesHistory(
  provider: Pick<DataProvider, "getPriceHistory" | "getPriceHistoryForResolutionWithMetadata">,
): NonNullable<PortfolioFuturesSources["history"]> {
  return async (symbol, exchange) => {
    if (!provider.getPriceHistoryForResolutionWithMetadata) return provider.getPriceHistory(symbol, exchange, "1M");
    const result = await provider.getPriceHistoryForResolutionWithMetadata(symbol, exchange, "1M", "1d");
    return result.resolution == null || result.resolution === "1d" ? result.points : [];
  };
}

/**
 * Each futures holding's contract size and settlement, by symbol, as `quote`
 * reads its terms. The settlement before the latest, which the day's move at
 * the close measures from, is read from the daily bars only when `settlement`
 * is asked for. A future whose terms cannot be read maps to no size and no
 * settlement; any other ticker is left out.
 */
export async function loadPortfolioFuturesTerms(
  tickers: readonly TickerRecord[],
  { settlement = false, sources = {} }: { settlement?: boolean; sources?: PortfolioFuturesSources } = {},
): Promise<Map<string, PortfolioFuturesTerms>> {
  const loadTerms = sources.terms ?? ((symbol: string) => loadFuturesContractTermsCached(symbol));
  const futures = tickers.filter(isFuturesTicker);
  const entries = await Promise.all(futures.map(async (ticker) => {
    const symbol = ticker.metadata.ticker;
    const terms = await loadTerms(symbol).catch(logFailure("portfolio-futures", "Read futures contract terms failed", null));
    const history = settlement && terms?.settlement && sources.history
      ? await sources.history(symbol, ticker.metadata.exchange).catch(logFailure("portfolio-futures", "Read futures settlement history failed", null))
      : null;
    return [symbol, portfolioFuturesTerms(terms, history)] as const;
  }));
  return new Map(entries);
}

/**
 * The contract size a new futures lot is entered at, from its terms, so the
 * lot is stored with its multiplier as an option's is. Null for any other
 * holding, or a future whose terms cannot be read: the lot is then saved
 * unsized and shown as such, never valued at one unit a contract.
 */
export async function loadFuturesEntrySize(
  ticker: TickerRecord,
  load: (symbol: string) => Promise<FuturesContractTermsPayload | null> = loadFuturesContractTermsCached,
): Promise<FuturesContractSize | null> {
  if (!isFuturesTicker(ticker)) return null;
  const terms = await load(ticker.metadata.ticker).catch(logFailure("portfolio-futures", "Read futures contract terms failed", null));
  return futuresContractSize(terms?.spec);
}
