import { canonicalExchange, isKnownExchangeCode, isPredictionMarketExchange, parsePublicTickerKey } from "../utils/exchanges";

/**
 * A prediction market as a listing: its market id on its venue's code
 * (`KXGREENLAND-29` on `KALSHI`). Saved tickers carry it as `KALSHI:KXGREENLAND-29`,
 * as the bare id with the venue in the exchange, or, from before the venue was
 * read first, as the venue `KALSHI` with the market id in the exchange.
 */
export interface PredictionMarketListing {
  /** The market id: `KXGREENLAND-29`. */
  symbol: string;
  /** The venue's code: `KALSHI`. */
  exchange: string;
}

/** The prediction market a ticker names; null for a listing on any other venue. */
export function predictionMarketListing(symbol: string, exchange?: string | null): PredictionMarketListing | null {
  const parsed = parsePublicTickerKey(symbol);
  const venue = canonicalExchange(parsed.exchange ?? exchange ?? "");
  if (isPredictionMarketExchange(venue) && parsed.symbol) return { symbol: parsed.symbol, exchange: venue };
  // The venue read as the symbol and the market id as the exchange: the same market, saved the wrong way round.
  if (!parsed.exchange && isPredictionMarketExchange(parsed.symbol) && exchange && !isKnownExchangeCode(exchange)) {
    return { symbol: exchange.trim().toUpperCase(), exchange: canonicalExchange(parsed.symbol) };
  }
  return null;
}
