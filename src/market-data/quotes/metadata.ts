import type { Quote, QuoteMetadata } from "../../types/financials";
import { canonicalExchange, parsePublicTickerKey } from "../../utils/exchanges";
import { getListingSymbolsToTry } from "../../sources/listing-symbols";
import { currencyPairCode } from "../../utils/currency-pair";
import { exchangeLineCoinListing } from "../../utils/crypto-pair";

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

/**
 * The venue a quote's price comes from: the board Gloom Cloud read it on
 * (247540:KRX on KOSDAQ), else its listing. The listing fields keep the venue
 * asked for, which is what a quote's identity is checked against.
 */
export function quoteTradingExchange(quote: Pick<Quote, "tradingExchangeName" | "listingExchangeName" | "exchangeName">): string {
  return canonicalExchange(quote.tradingExchangeName || quote.listingExchangeName || quote.exchangeName);
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

/** Qualified listings must agree; provider suffix spellings use the existing exact-listing normalizer. */
export function quoteMetadataMatchesTarget(metadata: QuoteMetadata, symbol: string, exchange?: string): boolean {
  // A crypto exchange's line of a pair (BTC/GBP on COINBASE PRO) is priced as the crypto venue's listing, BTC-GBP on
  // CCC, and a quote kept under the line's key is that listing's.
  const line = exchangeLineCoinListing(symbol, exchange);
  if (line) return quoteMetadataMatchesTarget(metadata, line.symbol, line.exchange);
  const quotedLine = exchangeLineCoinListing(metadata.symbol, parsePublicTickerKey(metadata.symbol).exchange ? undefined : metadata.listingExchangeName);
  if (quotedLine) metadata = { ...metadata, symbol: quotedLine.symbol, listingExchangeName: quotedLine.exchange };
  const target = parsePublicTickerKey(symbol);
  const actual = parsePublicTickerKey(metadata.symbol);
  // An index is one series whatever its venue is called: search files ^VIX under CXI and ^RUT under WCB, while
  // their quotes name CBOE INDICES and CHICAGO OPTIONS. Saved from search, the index must still match its quote.
  if (target.symbol.startsWith("^") && target.symbol === actual.symbol) return true;
  const requestedExchange = canonicalExchange(target.exchange || exchange);
  const symbolExchange = canonicalExchange(actual.exchange);
  const actualExchange = canonicalExchange(metadata.listingExchangeName) || symbolExchange;
  if (symbolExchange && actualExchange && symbolExchange !== actualExchange) return false;
  if (requestedExchange && actualExchange !== requestedExchange) return false;
  if (target.symbol === actual.symbol) return true;
  // Gloom Cloud answers a currency pair in one spelling however it was asked
  // for: EUR/USD and EURUSD:CCY come back as EURUSD=X on its currency venue.
  const pair = actualExchange === "CCY" ? currencyPairCode(actual.symbol, actualExchange) : null;
  if (pair && pair === currencyPairCode(target.symbol, requestedExchange)) return true;
  const listing = requestedExchange || actualExchange;
  if (!listing) return false;
  const candidates = getListingSymbolsToTry(target.symbol, listing, { exactExchange: true });
  return getListingSymbolsToTry(actual.symbol, listing, { exactExchange: true }).some((candidate) => candidates.includes(candidate));
}
