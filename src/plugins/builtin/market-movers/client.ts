import type { DataProvider } from "../../../types/data-provider";
import { CATEGORY_MAP, screenerQuoteFromQuote, type TabId } from "./model";
import {
  fetchPreferredMarketMovers,
  fetchTrending,
  type MarketMoversResult,
  type ScreenerQuote,
  type TrendingSymbol,
} from "./screener";

export interface MarketMoverTabResult extends MarketMoversResult {
  tab: TabId;
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
  tab: TabId,
  provider: DataProvider | null,
  options?: { forceRefresh?: boolean },
  dependencies: MarketMoverTabDependencies = defaultDependencies,
): Promise<MarketMoverTabResult> {
  if (tab === "trending") {
    const trending = await dependencies.fetchTrending(25, options);
    return {
      tab,
      quotes: await hydrateTrending(trending, provider),
      source: "yahoo",
      stale: false,
    };
  }
  const result = await dependencies.fetchPreferred(CATEGORY_MAP[tab], 25, options);
  return { ...result, tab };
}
