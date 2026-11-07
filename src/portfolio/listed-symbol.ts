import type { TickerRecord } from "../types/ticker";
import { canonicalExchange, canonicalTickerKey, isUsEquityExchange, parsePublicTickerKey } from "../utils/exchanges";
import { classifyInstrumentType, kindFromListingSyntax } from "../tickers/instrument-kind";
import { listingSuffixVenue } from "../sources/listing-symbols";

/**
 * A saved symbol as the listing it is: its venue from its key (BA:LSE) or its
 * row, and a vendor's suffix the venue settles taken off (BA.L on LSE is BA).
 */
function venueListing(symbol: string, exchange: string | undefined): { symbol: string; exchange: string | undefined } {
  const parsed = parsePublicTickerKey(symbol);
  const venue = parsed.exchange ?? (exchange || undefined);
  return listingSuffixVenue(parsed.symbol, venue) ?? { symbol: parsed.symbol, exchange: venue };
}

/**
 * The market a row's listing trades in: every US venue is one market (US), as
 * is a broker's SMART routing, which names no venue; any other its venue (LSE, HKEX).
 */
function listingMarket(ticker: TickerRecord): string | null {
  const { metadata } = ticker;
  // An index, a pair, a future, a coin or a perpetual is no company's listing on a venue.
  if (kindFromListingSyntax(metadata.ticker, metadata.exchange)) return null;
  const kind = classifyInstrumentType(metadata.assetCategory);
  if (kind && kind !== "equity" && kind !== "fund") return null;
  const exchange = canonicalExchange(venueListing(metadata.ticker, metadata.exchange).exchange);
  if (!exchange) return null;
  return isUsEquityExchange(exchange) || exchange === "SMART" ? "US" : exchange;
}

/**
 * The market most of a list's listings trade in, its home: a list of US names
 * with BAE Systems among them is a US list. US on a tie, or when no row is a
 * listing on a venue.
 */
export function listHomeMarket(tickers: Iterable<TickerRecord>): string {
  const counts = new Map<string, number>();
  for (const ticker of tickers) {
    const market = listingMarket(ticker);
    if (market) counts.set(market, (counts.get(market) ?? 0) + 1);
  }
  let home = "US";
  let most = counts.get("US") ?? 0;
  for (const [market, count] of counts) {
    if (count > most) {
      home = market;
      most = count;
    }
  }
  return home;
}

/**
 * A row's symbol as a list shows it: with its venue (BA:LSE, RHM:XETRA,
 * 0005:HKEX) when it trades outside the list's home market, so BA on LSE never
 * reads as Boeing in a US list; else as `display` writes it.
 */
export function listedSymbol(ticker: TickerRecord, display: string, homeMarket: string | undefined): string {
  const market = listingMarket(ticker);
  if (!market || !homeMarket || market === homeMarket || display.includes(":")) return display;
  const listing = venueListing(ticker.metadata.ticker, ticker.metadata.exchange);
  return canonicalTickerKey(listing.symbol, listing.exchange);
}

/**
 * A listing as an export names it, always with its venue (BA:LSE, AAPL:NASDAQ), so a script never reads BA as
 * Boeing; an index, a pair, a future or a coin is its symbol (^HSI, CL=F), which no venue qualifies.
 */
export function exportedListingSymbol(symbol: string, exchange: string | undefined, instrumentType?: string | null): string {
  if (kindFromListingSyntax(symbol, exchange) || classifyInstrumentType(instrumentType) === "index") return parsePublicTickerKey(symbol).symbol;
  const listing = venueListing(symbol, exchange);
  return canonicalTickerKey(listing.symbol, listing.exchange);
}

/** A row's listing as an export names it (`exportedListingSymbol`). */
export function exportedListingKey(ticker: TickerRecord): string {
  return exportedListingSymbol(ticker.metadata.ticker, ticker.metadata.exchange, ticker.metadata.assetCategory);
}
