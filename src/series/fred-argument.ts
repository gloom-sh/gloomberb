import { isKnownExchangeCode } from "../utils/exchanges";

/**
 * The FRED series a typed `FRED:<id>` names (`FRED:T10Y2Y` is T10Y2Y), as the
 * catalog and `fn G` write a series: never the symbol FRED on a venue called
 * T10Y2Y. A venue the app knows (`FRED:TSXV`) is that listing, so null, as is
 * any other text.
 */
export function fredSeriesArgument(text: string): string | null {
  const id = /^FRED:([A-Z0-9_]+)$/i.exec(text.trim())?.[1]?.toUpperCase();
  return id && !isKnownExchangeCode(id) ? id : null;
}

/** What a command that reads listings says to `FRED:T10Y2Y`: it is a series, and where series are read. */
export function fredSeriesNotListing(id: string): { message: string; details: string } {
  return { message: `FRED:${id} is a FRED series, not a listing.`, details: `Chart it with gloom fn G FRED:${id}, or read it with gloom fred ${id}.` };
}
