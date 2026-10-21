import { listingSuffixExchange } from "../../../sources/listing-symbols";
import type { TickerFinancials } from "../../../types/financials";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { safeExternalUrl } from "../../../utils/external-url";
import { listingAbroadVenue } from "../../../utils/sec";

/** A fund listed abroad as its profile names it: its name, its page at its issuer, and where its description is from. */
export interface FundAbroadProfile {
  name?: string;
  page?: string;
  descriptionSource?: { publisher: string; url: string };
}

/** The venue abroad a listing names, by its key (3042:HKEX) or its symbol's suffix (3042.HK, VUSA.L); null for a US listing. */
export function venueAbroad(key: string): string | null {
  const keyed = listingAbroadVenue(key);
  if (keyed) return keyed;
  const { symbol, exchange } = parsePublicTickerKey(key);
  const suffixed = exchange ? undefined : listingSuffixExchange(symbol);
  return suffixed ? listingAbroadVenue(`${symbol}:${suffixed}`) : null;
}

/** What ETF says of a fund listed abroad, from its quote and profile; only links that are safe to open. */
export function fundAbroadProfile(financials: Pick<TickerFinancials, "quote" | "profile"> | null | undefined): FundAbroadProfile {
  const page = financials?.profile?.website ? safeExternalUrl(financials.profile.website) : null;
  const source = financials?.profile?.descriptionSource;
  return {
    ...(financials?.quote?.name ? { name: financials.quote.name } : {}),
    ...(page ? { page } : {}),
    ...(source?.publisher && safeExternalUrl(source.url) ? { descriptionSource: source } : {}),
  };
}
