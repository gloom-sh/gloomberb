import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import type { SearchRequestContext, DataProvider } from "../types/data-provider";
import type { TickerRecord } from "../types/ticker";
import {
  AmbiguousTickerError,
  normalizeTickerInput,
  findExactTickerSearchMatch,
  resolveTickerSearch,
  upsertTickerFromSearchResult,
} from "./search";
import { normalizeTickerSymbol } from "./search/ranking";
import type { TickerOpenTarget } from "./search/types";
import { parsePublicTickerKey } from "../utils/exchanges";
import { getYahooSymbol, tickerHasYahooSuffix } from "../sources/yahoo-finance/symbols";

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
  const requested = parsePublicTickerKey(symbol);
  const preserveListingKey = !!requested.exchange || tickerHasYahooSuffix(symbol);

  let resolved: Awaited<ReturnType<typeof resolveTickerSearch>> | null = null;
  try {
    resolved = await resolveTickerSearch({
      query: symbol,
      activeTicker: null,
      tickers,
      dataProvider,
      searchContext,
    });
  } catch (error) {
    if (error instanceof AmbiguousTickerError) throw error;
    resolved = null;
  }

  if (resolved?.kind === "local") {
    if (preserveListingKey && resolved.symbol !== symbol) {
      const metadata = resolved.ticker.metadata;
      const { ticker, created } = await upsertTickerFromSearchResult(tickerRepository, {
        providerId: dataProvider.id,
        symbol: resolved.symbol,
        exchange: metadata.exchange,
        currency: metadata.currency,
        name: metadata.name,
        type: metadata.assetCategory || "",
        brokerContract: metadata.broker_contracts?.[0],
      }, { tickerSymbol: symbol });
      return { symbol: ticker.metadata.ticker, ticker, created };
    }
    return { symbol: resolved.symbol, ticker: resolved.ticker, created: false };
  }

  if (resolved?.kind === "provider") {
    // Search validates the listing, but its provider symbol may omit the venue.
    // Keep the explicit key that an incoming layout and its followers reference.
    const { ticker, created } = await upsertTickerFromSearchResult(tickerRepository, resolved.result, {
      tickerSymbol: preserveListingKey ? symbol : undefined,
    });
    return { symbol: ticker.metadata.ticker, ticker, created };
  }

  try {
    const quote = await dataProvider.getQuote(symbol, "");
    const quoteExchange = quote.listingExchangeName ?? quote.exchangeName;
    if (preserveListingKey && quoteExchange) {
      const baseSymbol = requested.exchange ? requested.symbol : symbol.slice(0, symbol.lastIndexOf("."));
      if (!findExactTickerSearchMatch([{ label: baseSymbol, right: quoteExchange }], symbol)) return null;
    }
    if (preserveListingKey) {
      const yahooAlias = requested.exchange ? getYahooSymbol(requested.symbol, requested.exchange) : symbol;
      const explicitAliasMatches = tickerHasYahooSuffix(yahooAlias) && normalizeTickerSymbol(quote.symbol) === yahooAlias;
      if (!explicitAliasMatches && !findExactTickerSearchMatch([{ label: quote.symbol, right: quoteExchange }], symbol)) return null;
    }
    const quoteSymbol = preserveListingKey ? symbol : normalizeTickerSymbol(quote.symbol || symbol);
    const existing = await tickerRepository.loadTicker(quoteSymbol);
    if (existing) {
      return { symbol: existing.metadata.ticker, ticker: existing, created: false };
    }

    const ticker = await tickerRepository.createTicker({
      ticker: quoteSymbol,
      exchange: requested.exchange ?? quote.listingExchangeName ?? quote.exchangeName ?? "",
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
