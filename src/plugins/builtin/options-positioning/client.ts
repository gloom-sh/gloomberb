import { apiClient } from "../../../api-client";
import { usListingSymbol } from "../../../utils/sec";

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
  /** The instant it settles, when the venue states one: 08:00 UTC for Deribit's BTC and ETH options. */
  expiresAt?: string;
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

/** What one contract is: 1 BTC for Deribit's options, 100 shares for a US listing's (absent from US payloads). */
interface PositioningContract {
  size: number;
  unit: string;
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
  /** `close` when spot is a regular session's close at `spotAsOf`: a cash index outside its session. Absent from older servers. */
  spotBasis?: "close";
  delayed: boolean;
  expiries: ExpiryOpenInterest[];
  expiry: string | null;
  strikes: StrikeOpenInterest[];
  warnings: string[];
  /** When the counts were read, for a venue that publishes them live (Deribit); `oiDate` is then that UTC day. */
  oiAsOf?: string | null;
  /** The venue listing the options, when it is not the US exchanges: Deribit. */
  venue?: string;
  /** Open interest counts contracts of this size; absent means 100 shares. */
  contract?: PositioningContract;
}

export interface GammaStrike {
  strike: number;
  /** Dealer gamma from calls, in dollars of delta per 1% move. */
  calls: number;
  /** Dealer gamma from puts, short, as a positive number. */
  puts: number;
  net: number;
}

interface GammaExpiry {
  expiry: string;
  calls: number;
  /** Short, as a positive number. */
  puts: number;
  net: number;
  /** The expiry's strikes with the most call and put gamma; absent from older servers. */
  callWall?: number | null;
  putWall?: number | null;
}

export interface GammaPayload {
  version: 1;
  symbol: string;
  underlying: string;
  oiDate: string | null;
  spot: number | null;
  spotAsOf: string | null;
  /** `close` when spot is a regular session's close at `spotAsOf`: a cash index outside its session. Absent from older servers. */
  spotBasis?: "close";
  delayed: boolean;
  /** The one expiry measured, or null for all of them. */
  expiry: string | null;
  expiries: string[];
  /** Expiries left out because their quotes gave no volatility. */
  missing: string[];
  total: { calls: number; puts: number; net: number } | null;
  /** With box spreads left out (SPX, XSP). */
  band: { low: number; high: number; shareLow: number; shareHigh: number } | null;
  /** Strikes read as box spread legs, taken out of both sides; absent from older servers. */
  boxes?: Array<{ expiry: string; strike: number; contracts: number }>;
  /** The band with the box spreads counted, when there are any. */
  bandWithBoxes?: { low: number; high: number } | null;
  flip: number | null;
  strikes: GammaStrike[];
  /** Each priced expiry's totals, from the same legs as `total`; absent from older servers. */
  byExpiry?: GammaExpiry[];
  /** When the quotes behind the volatilities were taken: the expiry's own, or the newest priced one's for all. */
  quotesAsOf: string | null;
  /**
   * The instant gamma is evaluated at, which time to expiry runs from: now
   * while the quotes are current, the spot's time with a closed session's
   * quotes (before the open). Absent from older servers.
   */
  gammaAsOf?: string | null;
  warnings: string[];
  /** The venue listing the options, when it is not the US exchanges: Deribit. */
  venue?: string;
}

export type OptionsPositioningApi = Pick<typeof apiClient, "optionsPositioning">;

/**
 * A US listing key ("SPY:ARCX") keeps only its symbol; an index keeps its
 * caret (^SPX). A listing abroad is refused: its bare symbol's chain is
 * another company's (SAN:EPA's would be Banco Santander's).
 */
export const positioningSymbol = (symbol: string) => usListingSymbol(symbol, "Options data");

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
