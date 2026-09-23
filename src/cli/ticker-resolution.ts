import type { DataProvider } from "../types/data-provider";
import type { TickerRecord } from "../types/ticker";
import type { TickerRepository } from "../data/ticker-repository";
import { resolveTickerSearch, upsertTickerFromSearchResult } from "../tickers/search";
import { canonicalExchange } from "../utils/exchanges";

export async function resolveTickerForCli(
  symbol: string,
  store: TickerRepository,
  dataProvider: DataProvider,
): Promise<TickerRecord> {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) {
    throw new Error("Ticker symbol is required.");
  }

  const localTicker = await store.loadTicker(normalized);
  if (localTicker) return localTicker;

  const localTickers = new Map(
    (await store.loadAllTickers()).map((ticker) => [ticker.metadata.ticker.toUpperCase(), ticker] as const),
  );
  const resolved = await resolveTickerSearch({
    query: normalized,
    activeTicker: null,
    tickers: localTickers,
    dataProvider,
  });

  if (!resolved) {
    throw new Error(`No ticker match found for "${normalized}".`);
  }

  if (resolved.kind === "local") {
    return resolved.ticker;
  }

  const { ticker, created } = await upsertTickerFromSearchResult(store, resolved.result);
  return created ? nameFromListingQuote(ticker, store, dataProvider) : ticker;
}

/**
 * Search catalogues can file a listing under another company's name: Twelve
 * Data names BAE Systems' London line (BA:LSE) after Boeing. The listing's own
 * quote names the security it prices, which is the name the ticker command
 * shows, so a record created here takes it.
 */
async function nameFromListingQuote(
  ticker: TickerRecord,
  store: TickerRepository,
  dataProvider: DataProvider,
): Promise<TickerRecord> {
  const { metadata } = ticker;
  try {
    const quote = await dataProvider.getQuote(metadata.ticker, metadata.exchange);
    const name = quote.name?.trim();
    // A quote that names no listing may be another venue's line served from cache.
    const quoteExchange = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
    if (!name || name === metadata.name || !quoteExchange || quoteExchange !== canonicalExchange(metadata.exchange)) {
      return ticker;
    }
    const named: TickerRecord = { ...ticker, metadata: { ...metadata, name } };
    await store.saveTicker(named);
    return named;
  } catch {
    // Without a quote the catalogue name stands.
    return ticker;
  }
}
