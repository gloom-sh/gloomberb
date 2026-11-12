import { logFailure } from "../utils/log-failure";
import type { DataProvider } from "../types/data-provider";
import { canonicalExchange, isUsListingExchange, isUsOtcVenue, parsePublicTickerKey } from "../utils/exchanges";
import { sameCompany } from "./company-name";
import { LISTING_SEARCH_LIMIT } from "./search";
import { classifyInstrumentKind } from "./search/ranking";

export interface UsListing {
  symbol: string;
  /** Canonical code of its US exchange. */
  exchange: string;
  name: string;
}

/**
 * A company's own listing on a US exchange, found by its name: Sanofi's SNY,
 * Toyota's TM. Funds and contracts that carry its name are not its listing.
 * With `otc`, a line over the counter counts when the company has none on an
 * exchange. Null when search knows no such US line of the company.
 */
export async function findUsListingOfCompany(
  dataProvider: Pick<DataProvider, "search">,
  company: string | null | undefined,
  { otc = false }: { otc?: boolean } = {},
): Promise<UsListing | null> {
  const name = company?.trim();
  if (!name) return null;
  const results = await dataProvider.search(name, { limit: LISTING_SEARCH_LIMIT }).catch(logFailure("tickers-us-listing", "Could not search US listing", []));
  let overTheCounter: UsListing | null = null;
  for (const result of results) {
    const exchange = canonicalExchange(result.exchange === "SMART" ? result.primaryExchange : result.exchange || result.primaryExchange);
    const kind = classifyInstrumentKind(result.brokerContract?.secType || result.type);
    const listed = isUsListingExchange(exchange);
    if (!(listed || (otc && isUsOtcVenue(exchange))) || kind === "fund" || kind === "derivative") continue;
    if (!sameCompany(result.name, name) || parsePublicTickerKey(result.symbol).exchange) continue;
    const line = { symbol: result.symbol.toUpperCase(), exchange, name: result.name };
    if (listed) return line;
    overTheCounter ??= line;
  }
  return overTheCounter;
}
