import { canonicalExchange, isUsListingExchange, parsePublicTickerKey } from "../utils/exchanges";

/**
 * `/cloud/bond-trades`: US corporate bond prints Gloom Cloud keeps, read by
 * CUSIP or by company. A bond read here that its store did not keep yet is
 * kept from then on, with the history the source still publishes for it;
 * `keptSince` says from when prints are held, and nothing before it is.
 * Gloom Pro.
 */

export interface StoredBondPrint {
  date: string;
  /** New York time, as published. */
  time: string | null;
  status: "trade" | "cancel" | "correction";
  /** A later cancel names this print. */
  cancelled: boolean;
  price: number | null;
  yield: number | null;
  /** Par amount; with `quantityCapped`, published only as at least this much. */
  quantity: number | null;
  quantityCapped: boolean;
  /** Whether the reporting dealer bought or sold. */
  side: "buy" | "sell" | null;
}

/** A day's last trade standing: the history the price chart draws. A zero price is null. */
export interface StoredBondDay {
  date: string;
  prints: number;
  price: number | null;
  yield: number | null;
}

export interface StoredBondPayload {
  cusip: string;
  issuerName: string;
  coupon: number | null;
  maturity: string | null;
  issuer: { symbol: string; name: string };
  from: string;
  to: string;
  /** Newest first. */
  trades: StoredBondPrint[];
  truncated: boolean;
  /** The first date prints are held from; null before any day was read. */
  keptSince: string | null;
  /** The source's own history of the bond is still to be read: prints are held from the day it was first looked up until then. */
  backfillPending: boolean;
  /** Oldest first. */
  days: StoredBondDay[];
}

export interface StoredIssuerBondsPayload {
  symbol: string;
  name: string;
  keptSince: string | null;
  backfillPending: boolean;
}

/** A company's live bonds by CUSIP, as Gloom Cloud links them to it: open to anyone, unlike the kept prints. */
export interface IssuerBondIssuesPayload {
  /** The company's primary listing. */
  symbol: string;
  name: string;
  cusips: string[];
}

/**
 * The listing a company's bonds are asked by, as Gloom Cloud writes its
 * companies' listings: the bare ticker on a US venue or none, SYMBOL:EXCHANGE
 * elsewhere (`2318:HKEX`).
 */
export function bondIssuerListing(symbol: string, exchange?: string): string {
  const parsed = parsePublicTickerKey(symbol);
  const venue = parsed.exchange ?? canonicalExchange(exchange);
  const code = parsed.symbol.toUpperCase();
  return venue && !isUsListingExchange(venue) ? `${code}:${venue}` : code;
}

export const BOND_HISTORY_MAX_DAYS = 1100;
