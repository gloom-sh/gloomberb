import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import type { SearchRequestContext, DataProvider } from "../types/data-provider";
import type { TickerRecord } from "../types/ticker";
import {
  normalizeTickerInput,
  resolveTickerSearch,
  upsertTickerFromSearchResult,
} from "./search";
import { normalizeTickerSymbol } from "./search/ranking";
import type { TickerOpenTarget } from "./search/types";

export type { TickerOpenTarget } from "./search/types";

export async function resolveTickerOpenTarget({
  query,
  tickers,
  dataProvider,
  tickerRepository,
  searchContext,
}: {
  query: string;
  tickers: ReadonlyMap<string, TickerRecord>;
  dataProvider: DataProvider;
  tickerRepository: AppTickerRepositoryPort;
  searchContext?: SearchRequestContext;
}): Promise<TickerOpenTarget | null> {
  const symbol = normalizeTickerInput(null, query);
  if (!symbol) return null;

  let resolved: Awaited<ReturnType<typeof resolveTickerSearch>> | null = null;
  try {
    resolved = await resolveTickerSearch({
      query: symbol,
      activeTicker: null,
      tickers,
      dataProvider,
      searchContext,
    });
  } catch {
    resolved = null;
  }

  if (resolved?.kind === "local") {
    return { symbol: resolved.symbol, ticker: resolved.ticker, created: false };
  }

  if (resolved?.kind === "provider") {
    const { ticker, created } = await upsertTickerFromSearchResult(tickerRepository, resolved.result);
    return { symbol: ticker.metadata.ticker, ticker, created };
  }

  try {
    const quote = await dataProvider.getQuote(symbol, "");
    const quoteSymbol = normalizeTickerSymbol(quote.symbol || symbol);
    const existing = await tickerRepository.loadTicker(quoteSymbol);
    if (existing) {
      return { symbol: existing.metadata.ticker, ticker: existing, created: false };
    }

    const ticker = await tickerRepository.createTicker({
      ticker: quoteSymbol,
      exchange: quote.listingExchangeName ?? quote.exchangeName ?? "",
      currency: quote.currency || "USD",
      name: quote.name || quoteSymbol,
      assetCategory: undefined,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    });

    return { symbol: ticker.metadata.ticker, ticker, created: true };
  } catch {
    return null;
  }
}
