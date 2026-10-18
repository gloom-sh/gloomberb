import { logFailure } from "../utils/log-failure";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import type { SearchRequestContext, DataProvider } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import {
  AmbiguousTickerError,
  normalizeTickerInput,
  findExactTickerSearchMatch,
  resolveTickerSearch,
  upsertTickerFromSearchResult,
} from "./search";
import { tickerSelectionFromSearchResult } from "./selection";
import { normalizeTickerSymbol } from "./search/ranking";
import type { TickerOpenTarget } from "./search/types";
import { isSharedExchangeCode, parsePublicTickerKey, typedExchangeCode } from "../utils/exchanges";
import { getListingSymbol, tickerHasListingSuffix } from "../sources/listing-symbols";
import { settleTypedListingKey } from "./listing-venues";
import { isProviderBusy, type ProviderBusyError } from "../sources/provider-errors";

export type { TickerOpenTarget } from "./search/types";

/**
 * What an open that found nothing says: neither the key's own quote nor the
 * listing search found the listing. Opens from a board row, a link and the
 * command bar all say it the same way.
 */
export function tickerOpenFailureMessage(symbol: string): string {
  return `Could not open ${symbol}: no quote or listing found.`;
}

export async function resolveTickerOpenTarget({
  query,
  tickers,
  dataProvider,
  tickerRepository,
  searchContext,
  publicOnly = false,
}: {
  query: string;
  tickers: ReadonlyMap<string, TickerRecord>;
  dataProvider: DataProvider;
  tickerRepository: AppTickerRepositoryPort;
  searchContext?: SearchRequestContext;
  publicOnly?: boolean;
}): Promise<TickerOpenTarget | null> {
  const typed = normalizeTickerInput(null, query);
  if (!typed) return null;
  // A code that names several venues (7203:TSE, from a link, a chat message or
  // the command bar) opens the one its symbol trades on, under that listing's
  // own key (7203:JPX), as every command reads it. A symbol on several of them
  // is a choice; one nothing could read is left to search.
  const symbol = (await settleTypedListingKey(typed, {
    store: { loadTicker: (key) => tickerRepository.loadTicker(key), loadAllTickers: async () => [...tickers.values()] },
    dataProvider,
  })).toUpperCase();
  const requested = parsePublicTickerKey(symbol);
  const preserveListingKey = (!!requested.exchange && !isSharedExchangeCode(typedExchangeCode(symbol))) || tickerHasListingSuffix(symbol);

  let resolved: Awaited<ReturnType<typeof resolveTickerSearch>> | null = null;
  // Search too busy to answer: a quote may still vouch for the listing, else the open says search was busy.
  let busy: ProviderBusyError | null = null;
  try {
    resolved = publicOnly ? null : await resolveTickerSearch({
      query: symbol,
      activeTicker: null,
      tickers,
      dataProvider,
      searchContext,
    });
  } catch (error) {
    if (error instanceof AmbiguousTickerError) throw error;
    if (isProviderBusy(error)) busy = error;
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
    return { symbol: ticker.metadata.ticker, ticker, created, ...tickerSelectionFromSearchResult(resolved.result) };
  }

  let quote: Quote | null = null;
  try {
    quote = await dataProvider.getQuote(symbol, "", publicOnly ? { instrument: null } : undefined);
  } catch (error) {
    logFailure("tickers-open-target", "Could not load ticker target quote")(error);
  }
  const quoteExchange = quote ? quote.listingExchangeName ?? quote.exchangeName : undefined;
  // A public open (a board row, a link) skips search for its quote. When the
  // quote cannot vouch for the listing, because no source prices it right now
  // or the one that answers prices another venue, search still lists it as
  // the command bar reads it, and the pane shows the quote's own state.
  if (!quote || (preserveListingKey && !quoteNamesListing(quote))) {
    if (busy) throw busy;
    return publicOnly ? openListedPublicTarget() : null;
  }

  try {
    const quoteSymbol = preserveListingKey ? symbol : normalizeTickerSymbol(quote.symbol || symbol);
    const selection = publicOnly ? tickerSelectionFromSearchResult({ providerId: dataProvider.id, symbol: quoteSymbol,
      name: quote.name || quoteSymbol, exchange: requested.exchange ?? quoteExchange ?? "", currency: quote.currency, type: quote.instrumentType || "" }) : {};
    const existing = await tickerRepository.loadTicker(quoteSymbol);
    if (existing) {
      return { symbol: existing.metadata.ticker, ticker: existing, created: false, ...selection };
    }

    const ticker = await tickerRepository.createTicker({
      ticker: quoteSymbol,
      exchange: requested.exchange ?? quote.listingExchangeName ?? quote.exchangeName ?? "",
      currency: quote.currency || "",
      name: quote.name || quoteSymbol,
      assetCategory: undefined,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    });

    return { symbol: ticker.metadata.ticker, ticker, created: true, ...selection };
  } catch (error) {
    logFailure("tickers-open-target", "Could not persist ticker target")(error);
    return null;
  }

  /** Whether the quote answered for the listing the key names, not the same symbol on another venue. */
  function quoteNamesListing(answer: Quote): boolean {
    try {
      if (quoteExchange) {
        const baseSymbol = requested.exchange ? requested.symbol : symbol.slice(0, symbol.lastIndexOf("."));
        if (!findExactTickerSearchMatch([{ label: baseSymbol, right: quoteExchange }], symbol)) return false;
      }
      const listingAlias = requested.exchange ? getListingSymbol(requested.symbol, requested.exchange) : symbol;
      const explicitAliasMatches = tickerHasListingSuffix(listingAlias) && normalizeTickerSymbol(answer.symbol) === listingAlias;
      return explicitAliasMatches || !!findExactTickerSearchMatch([{ label: answer.symbol, right: quoteExchange }], symbol);
    } catch (error) {
      logFailure("tickers-open-target", "Could not verify quote listing")(error);
      return false;
    }
  }

  async function openListedPublicTarget(): Promise<TickerOpenTarget | null> {
    try {
      // Public listings only: no saved ticker or broker contract stands in for the key.
      const listed = await resolveTickerSearch({
        query: symbol,
        activeTicker: null,
        tickers: new Map(),
        dataProvider,
        searchContext: { ...searchContext, preferBroker: false },
      });
      if (listed?.kind !== "provider" || listed.result.brokerContract) return null;
      const { ticker, created } = await upsertTickerFromSearchResult(tickerRepository, listed.result, {
        tickerSymbol: preserveListingKey ? symbol : undefined,
      });
      return { symbol: ticker.metadata.ticker, ticker, created, ...tickerSelectionFromSearchResult(listed.result) };
    } catch (error) {
      if (error instanceof AmbiguousTickerError || isProviderBusy(error)) throw error;
      return null;
    }
  }
}
