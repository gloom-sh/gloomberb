import type { Quote } from "../../types/financials";
import type { InstrumentRef } from "../request-types";
import { getServerClockOffsetMs } from "../quotes/clock";

/**
 * Converted totals use one USD rate per currency (USD per unit). Each rate is
 * streamed as the USD pair in its market convention: EUR, GBP, AUD and NZD
 * quote as XXX/USD, everything else as USD/XXX and is inverted. The symbols
 * use the Yahoo spelling the server already understands for FX pairs.
 */
const USD_QUOTED_CURRENCIES = new Set(["EUR", "GBP", "AUD", "NZD"]);
const STREAMABLE_CURRENCIES = new Set([
  "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD", "CNY", "CNH", "HKD", "SGD", "SEK", "NOK", "DKK",
  "ZAR", "INR", "BRL", "MXN", "KRW", "TWD", "ILS", "PLN", "TRY", "CZK", "HUF",
]);

/** A streamed rate further than this from the loaded one is a wrong pair or a bad print, not a move. */
export const FX_LIVE_RATE_MAX_DEVIATION = 0.2;
/** Smaller moves are not worth a re-render of every converted value. */
export const FX_LIVE_RATE_MIN_CHANGE = 0.00002;
/** An unchanged rate still refreshes its observation time this often. */
export const FX_LIVE_RATE_REFRESH_MS = 30_000;
/** A pair quote observed longer ago than this (a delayed feed, a quiet market) is not a live rate. */
export const FX_LIVE_RATE_MAX_OBSERVATION_AGE_MS = 2 * 60_000;
/** A streamed rate stops overriding loaded ones once its observation is this old. */
export const FX_LIVE_RATE_MAX_AGE_MS = 5 * 60_000;
/** Matches the staleness window of a loaded rate. */
export const FX_LIVE_RATE_STALE_MS = 60 * 60_000;

/** How long ago a server-stamped observation was, on the server's clock once it is measured. */
export function fxObservationAgeMs(observedAt: number, now = Date.now()): number {
  return Math.max(0, now + (getServerClockOffsetMs() ?? 0) - observedAt);
}

export interface FxLeg {
  currency: string;
  instrument: InstrumentRef;
  invert: boolean;
}

export function fxLegForCurrency(currency: string): FxLeg | null {
  const code = currency.trim().toUpperCase();
  if (!STREAMABLE_CURRENCIES.has(code)) return null;
  const usdQuoted = USD_QUOTED_CURRENCIES.has(code);
  return {
    currency: code,
    instrument: { symbol: usdQuoted ? `${code}USD=X` : `${code}=X`, exchange: "" },
    invert: !usdQuoted,
  };
}

/**
 * USD per unit of the leg's currency, from the quote's bid/ask midpoint or
 * last price. Pass the frame as received: a bid and ask retained from an
 * earlier quote would pin the midpoint while the price moves.
 */
export function fxRateFromLegQuote(leg: FxLeg, quote: Quote): number | null {
  const { bid, ask } = quote;
  const mid = typeof bid === "number" && typeof ask === "number" && Number.isFinite(bid) && Number.isFinite(ask)
    && bid > 0 && ask >= bid
    ? (bid + ask) / 2
    : quote.price;
  if (typeof mid !== "number" || !Number.isFinite(mid) || mid <= 0) return null;
  const rate = leg.invert ? 1 / mid : mid;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}
