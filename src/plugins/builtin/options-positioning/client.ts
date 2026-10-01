import { apiClient } from "../../../api-client";
import { parsePublicTickerKey } from "../../../utils/exchanges";

export interface ExpiryOpenInterest {
  date: string;
  /** Calendar days from today in New York. */
  days: number;
  callOI: number;
  putOI: number;
  putCallRatio: number | null;
  maxPain: number | null;
  /** Change since `previousOiDate`; null without a stored session to compare with. */
  callChange: number | null;
  putChange: number | null;
}

export interface StrikeOpenInterest {
  strike: number;
  callOI: number | null;
  putOI: number | null;
  callChange: number | null;
  putChange: number | null;
  /** What the expiry would pay holders if the underlying settled here, in dollars. */
  payout: number | null;
}

export interface OpenInterestPayload {
  version: 1;
  symbol: string;
  underlying: string;
  /** The session whose close the counts reflect. */
  oiDate: string | null;
  previousOiDate: string | null;
  tracked: boolean;
  spot: number | null;
  spotAsOf: string | null;
  delayed: boolean;
  expiries: ExpiryOpenInterest[];
  expiry: string | null;
  strikes: StrikeOpenInterest[];
  warnings: string[];
}

export interface GammaStrike {
  strike: number;
  /** Dealer gamma from calls, in dollars of delta per 1% move. */
  calls: number;
  /** Dealer gamma from puts, short, as a positive number. */
  puts: number;
  net: number;
}

export interface GammaPayload {
  version: 1;
  symbol: string;
  underlying: string;
  oiDate: string | null;
  spot: number | null;
  spotAsOf: string | null;
  delayed: boolean;
  /** The one expiry measured, or null for all of them. */
  expiry: string | null;
  expiries: string[];
  /** Expiries left out because their quotes gave no volatility. */
  missing: string[];
  total: { calls: number; puts: number; net: number } | null;
  band: { low: number; high: number; shareLow: number; shareHigh: number } | null;
  flip: number | null;
  strikes: GammaStrike[];
  quotesAsOf: string | null;
  warnings: string[];
}

export type OptionsPositioningApi = Pick<typeof apiClient, "optionsPositioning">;

/** A listing key ("SPY:ARCX") keeps only its symbol; an index keeps its caret (^SPX). */
export const positioningSymbol = (symbol: string) => parsePublicTickerKey(symbol.trim()).symbol.toUpperCase();

const query = (symbol: string, expiry: string | null) =>
  new URLSearchParams({ symbol: positioningSymbol(symbol), ...(expiry ? { expiry } : {}) }).toString();

/** Every expiry's open interest, and one expiry's strikes (the server's pick when none is asked for). */
export function loadOpenInterest(
  symbol: string,
  expiry: string | null,
  options: { signal?: AbortSignal } = {},
  api: OptionsPositioningApi = apiClient,
) {
  return api.optionsPositioning<OpenInterestPayload>(`open-interest?${query(symbol, expiry)}`, { signal: options.signal });
}

/** Dealer gamma by strike across every expiry, or one. */
export function loadGamma(
  symbol: string,
  expiry: string | null,
  options: { signal?: AbortSignal } = {},
  api: OptionsPositioningApi = apiClient,
) {
  return api.optionsPositioning<GammaPayload>(`gamma?${query(symbol, expiry)}`, { signal: options.signal });
}
