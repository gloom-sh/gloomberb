import { apiClient } from "../../../api-client";
import type {
  CloudSessionMoversCategory,
  CloudSessionMoversPayload,
  CloudSessionMoversSide,
} from "../../../api-client/market-movers";
import type { DataProvider } from "../../../types/data-provider";
import { CATEGORY_MAP, screenerQuoteFromQuote, type ScreenerTabId } from "./model";
import {
  fetchPreferredMarketMovers,
  fetchTrending,
  type MarketMoversResult,
  type ScreenerQuote,
  type TrendingSymbol,
} from "./screener";

export interface MarketMoverTabResult extends MarketMoversResult {
  tab: ScreenerTabId;
}

export interface MarketMoverTabDependencies {
  fetchPreferred(
    category: "day_gainers" | "day_losers" | "most_actives",
    count: number,
    options?: { forceRefresh?: boolean },
  ): Promise<MarketMoversResult>;
  fetchTrending(count: number, options?: { forceRefresh?: boolean }): Promise<TrendingSymbol[]>;
}

const defaultDependencies: MarketMoverTabDependencies = {
  fetchPreferred: (category, count, options) => fetchPreferredMarketMovers(category, count, options),
  fetchTrending: (count, options) => fetchTrending(count, undefined, options),
};

async function hydrateTrending(
  trending: readonly TrendingSymbol[],
  provider: DataProvider | null,
): Promise<ScreenerQuote[]> {
  const symbols = trending.slice(0, 25).map(({ symbol }) => symbol);
  const bySymbol = new Map<string, ScreenerQuote>();
  if (!provider) return [];
  if (provider.getQuotesBatch) {
    const results = await provider.getQuotesBatch(
      symbols.map((symbol) => ({ symbol, exchange: "" })),
    ).catch(() => []);
    for (const result of results) {
      if (result.quote) bySymbol.set(result.target.symbol, screenerQuoteFromQuote(result.target.symbol, result.quote));
    }
  } else {
    await Promise.all(symbols.map(async (symbol) => {
      try {
        const quote = await provider.getQuote(symbol, "");
        bySymbol.set(symbol, screenerQuoteFromQuote(symbol, quote));
      } catch {
        // Missing quotes are omitted from a ranked list.
      }
    }));
  }
  return symbols.flatMap((symbol) => {
    const quote = bySymbol.get(symbol);
    return quote ? [quote] : [];
  });
}

export async function loadMarketMoverTab(
  tab: ScreenerTabId,
  provider: DataProvider | null,
  options?: { forceRefresh?: boolean },
  dependencies: MarketMoverTabDependencies = defaultDependencies,
): Promise<MarketMoverTabResult> {
  if (tab === "trending") {
    const trending = await dependencies.fetchTrending(25, options);
    return {
      tab,
      quotes: await hydrateTrending(trending, provider),
      source: "gloom",
      stale: false,
    };
  }
  const result = await dependencies.fetchPreferred(CATEGORY_MAP[tab], 25, options);
  return { ...result, tab };
}

/** The server refused the list for the account's plan. */
export class SessionMoversAccessError extends Error {
  constructor() {
    super("Pre-market, after-hours and gap lists need Pro");
    this.name = "SessionMoversAccessError";
  }
}

export async function loadSessionMovers(
  view: CloudSessionMoversCategory,
  side: CloudSessionMoversSide,
  options?: { forceRefresh?: boolean },
): Promise<CloudSessionMoversPayload> {
  const response = await apiClient.getCloudMarketScreener(view, 25, options?.forceRefresh ? "refresh" : "cache-first", side);
  if (response.reasonCode === "PRO_REQUIRED") throw new SessionMoversAccessError();
  if ((response.status === "success" || response.status === "partial") && response.data) {
    return response.stale ? { ...response.data, stale: true } : response.data;
  }
  throw new Error("Session movers temporarily unavailable");
}
