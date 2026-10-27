import { apiClient } from "../../../api-client";
import type {
  CloudSessionMoversCategory,
  CloudSessionMoversPayload,
  CloudSessionMoversSide,
} from "../../../api-client/market-movers";
import type { DataProvider } from "../../../types/data-provider";
import { logFailure } from "../../../utils/log-failure";
import {
  CATEGORY_MAP,
  moverRegularSession,
  rankMoverQuotes,
  screenerQuoteFromQuote,
  type MoverQuote,
  type MoverRankBasis,
  type MoverRanking,
  type ScreenerTabId,
} from "./model";
import {
  fetchPreferredMarketMovers,
  fetchTrendingResult,
  type CachedResult,
  type MarketMoversResult,
  type PreferredMoversOptions,
  type TrendingSymbol,
} from "./screener";
import { meetsMinFloat } from "./min-float";

export interface MarketMoverTabResult extends MarketMoversResult {
  tab: ScreenerTabId;
  /** In the list's order; Last and Chg% the regular session, as `ticker` reads them. */
  quotes: MoverQuote[];
  /** What the list is ranked by; absent for trending, which keeps its source's order. */
  rankedBy?: MoverRanking;
  /** Requested trending names whose quotes did not load. */
  unavailableSymbols?: string[];
}

/** Rows a list shows. */
const LIST_ROWS = 25;
/**
 * Rows a Gainers or Losers list asks for. After the close it keeps only the
 * rows whose regular session moved its way, so it reads more than it shows.
 */
export const MOVER_CANDIDATES = 50;

export interface MarketMoverTabDependencies {
  fetchPreferred(
    category: "day_gainers" | "day_losers" | "most_actives",
    count: number,
    options?: PreferredMoversOptions,
  ): Promise<MarketMoversResult>;
  fetchTrending(count: number, options?: { forceRefresh?: boolean }): Promise<CachedResult<TrendingSymbol[]>>;
}

const defaultDependencies: MarketMoverTabDependencies = {
  fetchPreferred: (category, count, options) => fetchPreferredMarketMovers(category, count, options),
  fetchTrending: (count, options) => fetchTrendingResult(count, undefined, options),
};

async function hydrateTrending(
  trending: readonly TrendingSymbol[],
  provider: DataProvider | null,
): Promise<Pick<MarketMoverTabResult, "quotes" | "unavailableSymbols">> {
  const symbols = trending.slice(0, LIST_ROWS).map(({ symbol }) => symbol);
  const bySymbol = new Map<string, MoverQuote>();
  if (symbols.length === 0) return { quotes: [] };
  if (provider?.getQuotesBatch) {
    try {
      const results = await provider.getQuotesBatch(symbols.map((symbol) => ({ symbol, exchange: "" })));
      for (const result of results) {
        if (result.quote) bySymbol.set(result.target.symbol, screenerQuoteFromQuote(result.target.symbol, result.quote));
      }
    } catch (error) {
      logFailure("market-movers", "Trending quote batch failed")(error);
    }
  } else if (provider) {
    await Promise.all(symbols.map(async (symbol) => {
      try {
        const quote = await provider.getQuote(symbol, "");
        bySymbol.set(symbol, screenerQuoteFromQuote(symbol, quote));
      } catch (error) {
        logFailure("market-movers", "Trending quote failed")(error);
      }
    }));
  }
  const unavailableSymbols = [...new Set(symbols.filter((symbol) => !bySymbol.has(symbol)))];
  return {
    quotes: symbols.flatMap((symbol) => {
      const quote = bySymbol.get(symbol);
      return quote ? [quote] : [];
    }),
    ...(unavailableSymbols.length ? { unavailableSymbols } : {}),
  };
}

export function marketMoverQuoteError(result: Pick<MarketMoverTabResult, "unavailableSymbols">): string | null {
  return result.unavailableSymbols?.length ? `Quotes unavailable: ${result.unavailableSymbols.join(", ")}.` : null;
}

export async function loadMarketMoverTab(
  tab: ScreenerTabId,
  provider: DataProvider | null,
  options?: Pick<PreferredMoversOptions, "forceRefresh" | "metadataWaitMs"> & {
    basis?: MoverRankBasis;
    /** Keep the rows with a float of at least this many shares. Trending carries no float and ignores it. */
    minFloat?: number | null;
  },
  dependencies: MarketMoverTabDependencies = defaultDependencies,
): Promise<MarketMoverTabResult> {
  const { basis, minFloat = null, ...fetchOptions } = options ?? {};
  if (tab === "trending") {
    const trending = await dependencies.fetchTrending(LIST_ROWS, fetchOptions);
    const hydrated = await hydrateTrending(trending.data, provider);
    return {
      tab,
      ...hydrated,
      source: "gloom",
      stale: trending.stale || !!hydrated.unavailableSymbols?.length,
    };
  }
  const category = CATEGORY_MAP[tab];
  // The server picks the candidates on the basis the list ranks by, so after the close they are the session's movers.
  // A minimum float drops rows, so Most Active then reads as many candidates as the price lists.
  const result = await dependencies.fetchPreferred(category, category === "most_actives" && minFloat == null ? LIST_ROWS : MOVER_CANDIDATES, {
    ...fetchOptions,
    session: basis ?? "regular",
  });
  // Each row read as `ticker` reads it, then ranked by the move its Chg% shows.
  const { quotes, rankedBy } = rankMoverQuotes(category, result.quotes.map(moverRegularSession), basis);
  const kept = quotes.filter((quote) => meetsMinFloat(quote.floatShares, minFloat));
  return { ...result, quotes: kept.slice(0, LIST_ROWS), rankedBy, tab };
}

/** The server refused the list for the account's plan (gaps, without Pro). */
export class SessionMoversAccessError extends Error {
  constructor() {
    super("Gap lists need Pro");
    this.name = "SessionMoversAccessError";
  }
}

export async function loadSessionMovers(
  view: CloudSessionMoversCategory,
  side: CloudSessionMoversSide,
  options?: { forceRefresh?: boolean; minFloat?: number | null },
): Promise<CloudSessionMoversPayload> {
  const minFloat = options?.minFloat ?? null;
  // A minimum float drops rows, so it reads the most the server lists.
  const response = await apiClient.getCloudMarketScreener(view, minFloat == null ? LIST_ROWS : MOVER_CANDIDATES, options?.forceRefresh ? "refresh" : "cache-first", side);
  if (response.reasonCode === "PRO_REQUIRED") throw new SessionMoversAccessError();
  if ((response.status === "success" || response.status === "partial") && response.data) {
    const payload = response.stale ? { ...response.data, stale: true } : response.data;
    return minFloat == null ? payload : { ...payload, items: withMinFloat(payload.items, minFloat) };
  }
  throw new Error("Session movers temporarily unavailable");
}

/** The rows with a float of at least `minFloat`, the first LIST_ROWS of them, ranked again from 1. */
export function withMinFloat<T extends { rank: number; floatShares: number | null }>(items: readonly T[], minFloat: number): T[] {
  return items
    .filter((item) => meetsMinFloat(item.floatShares, minFloat))
    .slice(0, LIST_ROWS)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}
