import type { TickerRecord } from "../types/ticker";
import { canonicalExchange, canonicalTickerKey, isUsEquityExchange, parsePublicTickerKey } from "../utils/exchanges";
import { classifyInstrumentType, kindFromListingSyntax } from "../tickers/instrument-kind";

/** The market a row's listing trades in: every US venue is one market (US), any other its venue (LSE, HKEX). */
function listingMarket(ticker: TickerRecord): string | null {
  const { metadata } = ticker;
  // An index, a pair, a future, a coin or a perpetual is no company's listing on a venue.
  if (kindFromListingSyntax(metadata.ticker, metadata.exchange)) return null;
  const kind = classifyInstrumentType(metadata.assetCategory);
  if (kind && kind !== "equity" && kind !== "fund") return null;
  const exchange = canonicalExchange(parsePublicTickerKey(metadata.ticker).exchange ?? metadata.exchange);
  if (!exchange) return null;
  return isUsEquityExchange(exchange) ? "US" : exchange;
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
  return canonicalTickerKey(parsePublicTickerKey(ticker.metadata.ticker).symbol, ticker.metadata.exchange);
}

/**
 * A listing as an export names it, always with its venue (BA:LSE, AAPL:NASDAQ), so a script never reads BA as
 * Boeing; an index, a pair, a future or a coin is its symbol (^HSI, CL=F), which no venue qualifies.
 */
export function exportedListingSymbol(symbol: string, exchange: string | undefined, instrumentType?: string | null): string {
  if (kindFromListingSyntax(symbol, exchange) || classifyInstrumentType(instrumentType) === "index") return parsePublicTickerKey(symbol).symbol;
  return canonicalTickerKey(symbol, exchange || undefined);
}

/** A row's listing as an export names it (`exportedListingSymbol`). */
export function exportedListingKey(ticker: TickerRecord): string {
  return exportedListingSymbol(ticker.metadata.ticker, ticker.metadata.exchange, ticker.metadata.assetCategory);
}
