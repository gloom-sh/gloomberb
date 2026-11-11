import { apiClient } from "../../../api-client";
import { createPluginCache } from "../../../data/plugin-cache";
import { usListingSymbol } from "../../../utils/sec";
import { loadCloudResource, type CloudResource } from "../shared/cloud-resource";

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

/**
 * The last answer for each symbol and expiry, kept so OPX still shows it,
 * saying when it was saved, when the service cannot be reached. Every load
 * asks the service first: open interest and gamma move through the session.
 */
const cacheOptions = { source: "gloom-cloud", schemaVersion: 1, policy: { staleMs: 0, expireMs: 2 * 86_400_000 } };
export const openInterestCache = createPluginCache<OpenInterestPayload>({ ...cacheOptions, kind: "options-positioning-open-interest" });
export const gammaCache = createPluginCache<GammaPayload>({ ...cacheOptions, kind: "options-positioning-gamma" });

interface PositioningLoadOptions {
  signal?: AbortSignal;
  /** Ask the service even when another load of the same answer is under way. */
  force?: boolean;
}

/**
 * Every expiry's open interest, and one expiry's strikes (the server's pick
 * when none is asked for); the saved copy, with `savedAt`, when the service
 * cannot be reached.
 */
export function loadOpenInterest(
  symbol: string,
  expiry: string | null,
  options: PositioningLoadOptions = {},
  api: OptionsPositioningApi = apiClient,
): Promise<CloudResource<OpenInterestPayload>> {
  const key = query(symbol, expiry);
  return loadCloudResource(openInterestCache, key,
    () => api.optionsPositioning<OpenInterestPayload>(`open-interest?${key}`, { signal: options.signal }),
    { force: options.force, signal: options.signal });
}

/** Dealer gamma by strike across every expiry, or one; the saved copy, with `savedAt`, when the service cannot be reached. */
export function loadGamma(
  symbol: string,
  expiry: string | null,
  options: PositioningLoadOptions = {},
  api: OptionsPositioningApi = apiClient,
): Promise<CloudResource<GammaPayload>> {
  const key = query(symbol, expiry);
  return loadCloudResource(gammaCache, key,
    () => api.optionsPositioning<GammaPayload>(`gamma?${key}`, { signal: options.signal }),
    { force: options.force, signal: options.signal });
}
