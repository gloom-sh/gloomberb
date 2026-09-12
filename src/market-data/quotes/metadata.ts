import type { Quote, QuoteMetadata } from "../../types/financials";
import { canonicalExchange, parsePublicTickerKey } from "../../utils/exchanges";
import { getYahooSymbolsToTry } from "../../sources/yahoo-finance/symbols";

export function quoteMetadataFromQuote(quote: Quote): QuoteMetadata {
  return {
    symbol: quote.symbol,
    currency: quote.currency || undefined,
    instrumentType: quote.instrumentType,
    listingExchangeName: quote.listingExchangeName || quote.exchangeName,
    source: {
      providerId: quote.providerId,
      lastUpdated: Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0 ? quote.lastUpdated : undefined,
      stale: quote.stale,
      provenance: quote.provenance,
    },
  };
}

/** Keep known fields and their source when optional enrichment is incomplete. */
export function mergeQuoteMetadata(known: QuoteMetadata | null | undefined, loaded: QuoteMetadata | null | undefined): QuoteMetadata | undefined {
  if (!known) return loaded ?? undefined;
  if (!loaded) return known;
  const fields = { ...known.fieldSources };
  const merged = { ...known };
  for (const field of ["currency", "instrumentType"] as const) {
    if (!known[field] && loaded[field]) {
      merged[field] = loaded[field];
      fields[field] = loaded.fieldSources?.[field] ?? loaded.source;
    }
  }
  return Object.keys(fields).length ? { ...merged, fieldSources: fields } : merged;
}

/** A provider's listing name establishes identity, not a session calendar. */
function metadataExchange(value?: string): string {
  const exchange = canonicalExchange(value);
  return exchange === "NY MERCANTILE" ? "NYMEX" : exchange;
}

/** Qualified listings must agree; provider suffix spellings use the existing exact-listing normalizer. */
export function quoteMetadataMatchesTarget(metadata: QuoteMetadata, symbol: string, exchange?: string): boolean {
  const target = parsePublicTickerKey(symbol);
  const actual = parsePublicTickerKey(metadata.symbol);
  const requestedExchange = metadataExchange(target.exchange || exchange);
  const symbolExchange = metadataExchange(actual.exchange);
  const actualExchange = metadataExchange(metadata.listingExchangeName) || symbolExchange;
  if (symbolExchange && actualExchange && symbolExchange !== actualExchange) return false;
  if (requestedExchange && actualExchange !== requestedExchange) return false;
  if (target.symbol === actual.symbol) return true;
  const listing = requestedExchange || actualExchange;
  if (!listing) return false;
  const candidates = getYahooSymbolsToTry(target.symbol, listing, { exactExchange: true });
  return getYahooSymbolsToTry(actual.symbol, listing, { exactExchange: true }).some((candidate) => candidates.includes(candidate));
}
